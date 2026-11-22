const { randomBytes, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const { HttpError } = require('./input');

const PAIRING_MS = 5 * 60 * 1000;
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 16;
const COOKIE = 'tablet_session';
const PAIRING_CODE = /^[a-f0-9]{32}$/;
const SESSION_TOKEN = /^[a-f0-9]{64}$/;

function getRequestOrigin(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host)) {
    return null;
  }
  try {
    return new URL('http://' + host);
  } catch {
    return null;
  }
}

function isPcRequest(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const host = getRequestOrigin(req)?.hostname;
  return (peer === '::1' || (isIP(peer) === 4 && peer.startsWith('127.'))) &&
    (host === 'localhost' || host === '[::1]' || (isIP(host || '') === 4 && host.startsWith('127.')));
}

function isSameOrigin(req) {
  const origin = getRequestOrigin(req);
  return Boolean(origin && req.headers.origin === origin.origin);
}

function createAccessControl() {
  let pairing;
  const sessions = new Map();

  function getPairing() {
    if (!pairing || pairing.expiresAt <= Date.now()) {
      pairing = { code: randomBytes(16).toString('hex'), expiresAt: Date.now() + PAIRING_MS };
    }
    return pairing;
  }

  function getSession(token) {
    const session = sessions.get(token);
    if (session && session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session || null;
  }

  function getTabletSession(req) {
    const cookie = (req.headers.cookie || '').split(';').find(part => part.trimStart().startsWith(COOKIE + '='));
    const token = cookie?.trim().slice(COOKIE.length + 1);
    return SESSION_TOKEN.test(token || '') ? getSession(token) : null;
  }

  function pairTablet(code, previousSession) {
    if (typeof code !== 'string' || !PAIRING_CODE.test(code) ||
        !timingSafeEqual(Buffer.from(code, 'hex'), Buffer.from(getPairing().code, 'hex'))) {
      throw new HttpError(403, '配对链接无效或已过期，请在 PC 控制台重新扫码');
    }
    for (const token of sessions.keys()) getSession(token);
    if (!previousSession && sessions.size >= MAX_SESSIONS) {
      throw new HttpError(409, '配对名额已满，请在 PC 控制台解除已有配对');
    }
    pairing = null;
    if (previousSession) return previousSession;
    const token = randomBytes(32).toString('hex');
    const session = { token, expiresAt: Date.now() + SESSION_MS, projectIds: new Set() };
    sessions.set(token, session);
    return session;
  }

  function grantProject(session, projectId) {
    session.projectIds.delete(projectId);
    session.projectIds.add(projectId);
    if (session.projectIds.size > 20) session.projectIds.delete(session.projectIds.values().next().value);
  }

  return {
    getPairing,
    getSession,
    getTabletSession,
    pairTablet,
    grantProject,
    sessionCookie: session => COOKIE + '=' + session.token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
      Math.ceil((session.expiresAt - Date.now()) / 1000),
    clearProjects: () => { for (const session of sessions.values()) session.projectIds.clear(); },
    revokeAll: () => { sessions.clear(); pairing = null; }
  };
}

module.exports = { createAccessControl, getRequestOrigin, isPcRequest, isSameOrigin };
