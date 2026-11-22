const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const vm = require('node:vm');
const WebSocket = require('ws');
const { createAccessControl } = require('../access');

const ROOT = path.resolve(__dirname, '..');
const TEMP_ROOT = fs.realpathSync(os.tmpdir());
const temp = fs.mkdtempSync(path.join(TEMP_ROOT, 'tablet-assistant-p0-'));
const sockets = new Set();
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xZuoAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(png.split(',')[1], 'base64');
const editedPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY/jvyvAfAAXPAkRYAO2MAAAAAElFTkSuQmCC';
const editedPngBytes = Buffer.from(editedPng.split(',')[1], 'base64');
const annotated = {
  dataUrl: editedPng,
  baseDataUrl: png,
  drawDataUrl: editedPng,
  width: 1,
  height: 1,
  badgeCounter: 1,
  strokeRecords: [{
    id: 'st_example', tool: 'text', label: '字面标注 <示例>', color: '#ef4444', size: 6,
    text: '<示例>', withBg: true, x: 0, y: 0
  }],
  annotations: [{ id: 'st_example', type: 'text', text: '<示例>', x: 0, y: 0 }],
  promptHint: '测试草稿'
};
let app;
let port;

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('Server startup timed out: ' + output));
    }, 10000);
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /http:\/\/localhost:(\d+)\/pc/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error('Server exited (' + code + '): ' + output));
    });
  });
}

async function startApp() {
  app = spawn(process.execPath, ['--require', path.join(__dirname, 'fake-clipboard.js'), 'server.js'], {
    cwd: temp,
    env: { ...process.env, PORT: '0', NODE_PATH: path.join(ROOT, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  port = await waitForStartup(app);
}

async function stopApp() {
  for (const socket of sockets) socket.terminate();
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    const exited = once(app, 'exit');
    app.kill();
    await exited;
  }
}

before(async () => {
  for (const file of ['server.js', 'access.js', 'input.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(temp, file));
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(temp, 'public'), { recursive: true });
  await startApp();
});

after(async () => {
  await stopApp();
  assert.equal(path.dirname(fs.realpathSync(temp)), TEMP_ROOT);
  assert.ok(path.basename(temp).startsWith('tablet-assistant-p0-'));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

function request(route, options = {}) {
  const { method = 'GET', body, cookie, hostname = '127.0.0.1', host = hostname + ':' + port } = options;
  const origin = Object.hasOwn(options, 'origin') ? options.origin : 'http://' + host;
  const headers = { Host: host };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: route, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        const isJson = (res.headers['content-type'] || '').startsWith('application/json');
        resolve({ status: res.statusCode, body: isJson ? JSON.parse(text) : text, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out: ' + route)));
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

function post(route, body, options) {
  return request(route, { ...options, method: 'POST', body });
}

function openSocket(role, options = {}) {
  const { cookie, hostname = '127.0.0.1', host = hostname + ':' + port } = options;
  const origin = options.origin ?? 'http://' + host;
  const headers = { Host: host };
  if (cookie) headers.Cookie = cookie;
  const socket = new WebSocket('ws://' + hostname + ':' + port + '/?role=' + role, {
    origin, headers, handshakeTimeout: 5000
  });
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  const messages = [];
  const waiters = new Set();
  socket.on('message', raw => {
    messages.push(JSON.parse(raw.toString()));
    for (const run of waiters) run();
  });
  function expectMessage(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(find);
        reject(new Error('WebSocket message not received: ' + type));
      }, 5000);
      function find() {
        const index = messages.findIndex(message => message.type === type);
        if (index === -1) return;
        waiters.delete(find);
        clearTimeout(timer);
        resolve(messages.splice(index, 1)[0]);
      }
      waiters.add(find);
      find();
    });
  }
  const status = new Promise((resolve, reject) => {
    socket.once('open', () => resolve(101));
    socket.once('unexpected-response', (req, response) => {
      response.resume();
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.once('error', reject);
  });
  return { socket, status, expectMessage };
}

async function pairingCode() {
  const info = await request('/api/info');
  assert.equal(info.status, 200);
  assert.match(info.body.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(info.body.pairingExpiresAt > Date.now());
  return new URL(info.body.pairingUrl).hash.slice('#pair='.length);
}

async function pair(host = 'tablet.lan:' + port) {
  const code = await pairingCode();
  const result = await post('/api/pair', { code }, { host });
  assert.equal(result.status, 200);
  const session = result.headers['set-cookie'][0];
  assert.match(session, /; HttpOnly; SameSite=Strict; Max-Age=\d+/);
  return { cookie: session.split(';')[0], code, host };
}

function projectDirectory(id) {
  return path.join(temp, 'history', 'projects', id);
}

function projectFiles(id) {
  const directory = projectDirectory(id);
  return Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name))]));
}

test('PC endpoints require a local peer, local Host, and same-origin writes', async () => {
  assert.equal((await request('/pc')).status, 200);
  assert.equal((await request('/tablet', { host: 'tablet.lan:' + port })).status, 200);
  for (const route of ['/pc', '/pc.html', '/api/info', '/api/image/latest-returned']) {
    assert.equal((await request(route, { host: 'tablet.lan:' + port })).status, 403);
  }
  assert.equal((await request('/api/image/latest-returned')).status, 404);
  assert.equal((await request('/history/index.json')).status, 404);
  assert.equal((await post('/api/history/clear', undefined, { origin: 'http://other.test' })).status, 403);
  assert.equal((await post('/api/clipboard/push', undefined, { origin: null })).status, 403);
  assert.equal((await openSocket('pc', { origin: 'http://other.test' }).status), 403);
  assert.equal((await openSocket('pc', { host: 'tablet.lan:' + port }).status), 403);
  const info = (await request('/api/info')).body;
  const lanIp = info.ips.find(candidate => candidate.address !== '127.0.0.1')?.address;
  if (lanIp) {
    assert.equal((await request('/api/info', { hostname: lanIp, host: 'localhost:' + port })).status, 403);
    assert.equal((await openSocket('pc', { hostname: lanIp, host: 'localhost:' + port }).status), 403);
  }
});

test('pairing is one-use, limits tablet capabilities, and revokes live sockets', async () => {
  const host = 'tablet.lan:' + port;
  assert.equal((await request('/api/pair', { host })).body.paired, false);
  assert.equal((await openSocket('tablet', { host }).status), 403);
  assert.equal((await post('/api/image/return', annotated, { host })).status, 401);
  const code = await pairingCode();
  assert.equal((await post('/api/pair', { code }, { host, origin: 'http://other.test' })).status, 403);
  assert.equal((await post('/api/pair', { code: 'a'.repeat(2048) }, { host })).status, 413);
  const session = await pair(host);
  assert.equal(session.code, code);
  assert.equal((await post('/api/pair', { code }, { host })).status, 403);
  assert.notEqual(await pairingCode(), code);
  assert.equal((await request('/api/pair', session)).body.paired, true);
  assert.equal((await openSocket('tablet', { ...session, origin: 'http://other.test' }).status), 403);
  for (const route of ['/api/settings', '/api/image/push', '/api/project/push-to-tablet',
    '/api/clipboard/push', '/api/clipboard/snip-and-push', '/api/clipboard/copy-dataurl',
    '/api/history/clear', '/api/pairing/revoke']) {
    assert.equal((await post(route, {}, session)).status, 403, route);
  }
  const tablet = openSocket('tablet', session);
  assert.equal(await tablet.status, 101);
  const initial = await tablet.expectMessage('INIT_STATE');
  assert.deepEqual(Object.keys(initial).sort(), ['currentImage', 'type']);

  const pc = openSocket('pc');
  assert.equal(await pc.status, 101);
  assert.ok(Array.isArray((await pc.expectMessage('INIT_STATE')).history));
  pc.socket.send(JSON.stringify({ type: 'RETURN_IMAGE_TO_PC', ...annotated }));
  assert.equal((await pc.expectMessage('RETURN_ACK')).status, 403);
  pc.socket.close();

  const closed = once(tablet.socket, 'close');
  assert.equal((await post('/api/pairing/revoke')).status, 200);
  assert.equal((await closed)[0], 4001);
  assert.equal((await request('/api/pair', session)).body.paired, false);
  assert.equal((await post('/api/image/return', annotated, session)).status, 401);
});

test('pairing codes and tablet sessions expire', () => {
  const now = Date.now;
  let time = now();
  Date.now = () => time;
  try {
    const access = createAccessControl();
    const expired = access.getPairing();
    time = expired.expiresAt;
    assert.throws(() => access.pairTablet(expired.code), { status: 403 });
    const session = access.pairTablet(access.getPairing().code);
    const req = { headers: { cookie: access.sessionCookie(session).split(';')[0] } };
    assert.equal(access.getTabletSession(req), session);
    time = session.expiresAt;
    assert.equal(access.getTabletSession(req), null);
  } finally {
    Date.now = now;
  }
});

test('reject invalid project paths, image headers, and drawing metadata before writing', async () => {
  const session = await pair();
  const invalidIds = ['../outside', '..\\outside', 'proj_123_deadbeef/extra', 123];
  for (const projectId of invalidIds) {
    assert.equal((await post('/api/project/push-to-tablet', { projectId })).status, 400);
    assert.equal((await post('/api/image/return', { ...annotated, projectId }, session)).status, 400);
  }
  assert.equal((await post('/api/image/push', { dataUrl: png, projectId: 'proj_123_deadbeef' })).status, 400);
  assert.equal((await post('/api/project/push-to-tablet', { projectId: 'proj_123_deadbeef', stripDrawLayer: 'false' })).status, 400);
  assert.equal((await post('/api/image/push', '{')).status, 400);
  assert.equal((await post('/api/image/push', annotated, { contentType: 'text/plain' })).status, 415);
  assert.equal((await post('/api/image/push', { dataUrl: 'data:image/png;base64,YWJj' })).status, 400);
  assert.equal((await post('/api/image/push', { dataUrl: png.replace('image/png', 'image/svg+xml') })).status, 400);
  assert.equal((await post('/api/image/push', { dataUrl: png, width: 2 })).status, 400);

  const oversized = Buffer.from(pngBytes);
  oversized.writeUInt32BE(9000, 16);
  const dataUrl = 'data:image/png;base64,' + oversized.toString('base64');
  assert.equal((await post('/api/image/push', { dataUrl })).status, 413);
  const badStroke = { ...annotated.strokeRecords[0], color: 'blue' };
  assert.equal((await post('/api/image/return', { ...annotated, strokeRecords: [badStroke] }, session)).status, 400);

  const tablet = openSocket('tablet', session);
  assert.equal(await tablet.status, 101);
  tablet.socket.send(JSON.stringify({
    type: 'RETURN_IMAGE_TO_PC', ...annotated, strokeRecords: [{ ...badStroke, color: '#abcdef', tool: 'unknown' }]
  }));
  assert.equal((await tablet.expectMessage('RETURN_ACK')).status, 400);
  tablet.socket.close();
  assert.equal(fs.existsSync(path.join(temp, 'mock-clipboard.png')), false);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'history', 'projects')), []);
});

test('pure-base resend creates a new project and preserves the original bytes', async () => {
  const first = (await post('/api/image/push', { dataUrl: png })).body.item;
  const current = (await post('/api/image/push', { dataUrl: png })).body.item;
  const session = await pair();
  const tablet = openSocket('tablet', session);
  assert.equal(await tablet.status, 101);
  assert.equal((await tablet.expectMessage('INIT_STATE')).currentImage.projectId, current.projectId);
  assert.equal((await post('/api/image/return', { ...annotated, projectId: first.projectId }, session)).status, 403);

  const full = await post('/api/project/push-to-tablet', { projectId: first.projectId, stripDrawLayer: false });
  assert.equal(full.body.item.projectId, first.projectId);
  assert.equal((await tablet.expectMessage('IMAGE_TO_TABLET')).item.projectId, first.projectId);
  tablet.socket.send(JSON.stringify({ type: 'RETURN_IMAGE_TO_PC', ...annotated, projectId: first.projectId }));
  assert.equal((await tablet.expectMessage('RETURN_ACK')).clipboardWritten, true);
  const original = projectFiles(first.projectId);
  assert.deepEqual(Object.keys(original).sort(), ['base.png', 'draw.png', 'merged.png', 'meta.json']);
  assert.deepEqual(original['base.png'], pngBytes);
  assert.deepEqual(original['merged.png'], editedPngBytes);

  const clean = await post('/api/project/push-to-tablet', { projectId: first.projectId, stripDrawLayer: true });
  assert.equal(clean.status, 200);
  const copyId = clean.body.item.projectId;
  assert.notEqual(copyId, first.projectId);
  assert.equal(clean.body.item.dataUrl, png);
  assert.equal(clean.body.item.drawDataUrl, null);
  assert.deepEqual(clean.body.item.strokeRecords, []);
  assert.deepEqual(clean.body.item.annotations, []);
  const received = await tablet.expectMessage('IMAGE_TO_TABLET');
  assert.equal(received.item.projectId, copyId);
  assert.equal(received.item.baseDataUrl, png);
  assert.deepEqual(projectFiles(first.projectId), original);
  assert.equal(fs.existsSync(path.join(projectDirectory(copyId), 'draw.png')), false);

  assert.equal((await post('/api/image/return', { ...annotated, projectId: copyId }, session)).status, 200);
  assert.deepEqual(projectFiles(first.projectId), original);
  assert.deepEqual(fs.readFileSync(path.join(temp, 'mock-clipboard.png')), editedPngBytes);
  const pc = openSocket('pc');
  assert.equal(await pc.status, 101);
  const { history } = await pc.expectMessage('INIT_STATE');
  assert.ok(history.some(item => item.projectId === first.projectId && item.strokeRecords.length === 1));
  assert.ok(history.some(item => item.projectId === copyId));
  tablet.socket.close();
  pc.socket.close();
});

test('missing or linked project files cannot be used as a pure base', async () => {
  const { item } = (await post('/api/image/push', { dataUrl: png })).body;
  const project = projectDirectory(item.projectId);
  const base = path.join(project, 'base.png');
  fs.unlinkSync(base);
  assert.equal((await post('/api/project/push-to-tablet', { projectId: item.projectId, stripDrawLayer: true })).status, 409);

  const otherFile = path.join(temp, 'unrelated.png');
  fs.writeFileSync(otherFile, pngBytes);
  fs.linkSync(otherFile, base);
  assert.equal((await post('/api/project/push-to-tablet', { projectId: item.projectId, stripDrawLayer: true })).status, 404);
  assert.deepEqual(fs.readFileSync(otherFile), pngBytes);
});

test('the local ComfyUI image endpoint tracks only tablet returns and survives a restart', async () => {
  const session = await pair();
  const latestUrl = () => 'http://127.0.0.1:' + port + '/api/image/latest-returned';
  const first = (await post('/api/image/return', { dataUrl: png }, session)).body.item;
  const firstHead = await fetch(latestUrl(), { method: 'HEAD' });
  assert.equal(firstHead.status, 200);
  const firstVersion = firstHead.headers.get('etag');
  assert.match(firstVersion, /^"[a-f0-9]{64}"$/);
  assert.equal((await firstHead.arrayBuffer()).byteLength, 0);

  assert.equal((await post('/api/image/push', { dataUrl: editedPng })).status, 200);
  assert.equal((await fetch(latestUrl(), { method: 'HEAD' })).headers.get('etag'), firstVersion);

  const tablet = openSocket('tablet', session);
  assert.equal(await tablet.status, 101);
  await tablet.expectMessage('INIT_STATE');
  assert.equal((await post('/api/project/push-to-tablet', { projectId: first.projectId })).status, 200);
  await tablet.expectMessage('IMAGE_TO_TABLET');
  const update = await post('/api/image/return', { ...annotated, projectId: first.projectId }, session);
  assert.equal(update.status, 200);
  const changed = await fetch(latestUrl());
  assert.equal(changed.headers.get('content-type'), 'image/png');
  assert.equal(changed.headers.get('cache-control'), 'no-store');
  const secondVersion = changed.headers.get('etag');
  assert.notEqual(secondVersion, firstVersion);
  assert.deepEqual(Buffer.from(await changed.arrayBuffer()), editedPngBytes);
  assert.equal((await request('/api/image/latest-returned', session)).status, 403);

  // Resending the same project updates its history direction, while the last return remains available.
  assert.equal((await post('/api/project/push-to-tablet', { projectId: first.projectId })).status, 200);
  await stopApp();
  await startApp();
  const restored = await fetch(latestUrl());
  assert.equal(restored.headers.get('etag'), secondVersion);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), editedPngBytes);

  assert.equal((await post('/api/history/clear')).status, 200);
  assert.equal((await fetch(latestUrl())).status, 404);
  assert.equal(fs.existsSync(path.join(temp, 'history', 'latest-returned.png')), false);
});

function renderFromPage(file, functionName, nextMarker, globals) {
  class Element {
    constructor() {
      this.children = [];
      this.fields = new Map();
      this.style = {};
      this.classList = { add() {} };
    }
    appendChild(node) { this.children.push(node); }
    addEventListener() {}
    remove() {}
    querySelector(selector) {
      if (!this.fields.has(selector)) this.fields.set(selector, new Element());
      return this.fields.get(selector);
    }
  }
  const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  const start = html.indexOf('    function ' + functionName + '() {');
  const end = html.indexOf(nextMarker, start);
  assert.ok(start !== -1 && end > start);
  const container = new Element();
  vm.runInNewContext(html.slice(start, end) + '\n' + functionName + '();', {
    document: { createElement: () => new Element() },
    historyContainer: container,
    strokeListContainer: container,
    btnStrokeList: new Element(),
    ...globals
  });
  return container.children[0];
}

test('history and stroke labels are rendered as literal text', () => {
  const text = '<em>字面文本</em>';
  const history = renderFromPage('pc.html', 'renderHistory', '    // WebSocket', {
    historyList: [{ dataUrl: png, timestamp: text }]
  });
  assert.equal(history.querySelector('img').src, png);
  assert.equal(history.querySelector('.history-time').textContent, text);
  assert.ok(!history.innerHTML.includes(text));

  const stroke = renderFromPage('tablet.html', 'updateStrokeListUI', '    // ==========================================', {
    strokeRecords: [{ label: text, color: 'blue' }]
  });
  assert.equal(stroke.querySelector('.stroke-item-name').textContent, '#1 ' + text);
  assert.equal(stroke.querySelector('.stroke-color-dot').style.backgroundColor, '#ef4444');
  assert.ok(!stroke.innerHTML.includes(text));
});
