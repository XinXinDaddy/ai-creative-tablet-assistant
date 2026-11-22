const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { createAccessControl, getRequestOrigin, isPcRequest, isSameOrigin } = require('./access');
const {
  MAX_JSON_BYTES, HttpError, requireInput, requireProjectId, parseJson, readJsonBody, readPng,
  decodeStoredImage, encodeStoredImage, validateImagePayload
} = require('./input');

const PORT = Number(process.env.PORT ?? 3680);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_DIR = path.join(__dirname, 'history');
const PROJECTS_DIR = path.join(HISTORY_DIR, 'projects');
const INDEX_FILE = path.join(HISTORY_DIR, 'index.json');
const LATEST_RETURN_FILE = path.join(HISTORY_DIR, 'latest-returned.png');

const access = createAccessControl();
checkDirectory(HISTORY_DIR, true);
checkDirectory(PROJECTS_DIR, true);

// ==========================================
// 1. 局域网 IP 探测与排序
// ==========================================
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const lowerName = name.toLowerCase();
        const isVirtual =
          lowerName.includes('vethernet') ||
          lowerName.includes('wsl') ||
          lowerName.includes('vmware') ||
          lowerName.includes('virtualbox') ||
          lowerName.includes('docker') ||
          lowerName.includes('vbox') ||
          lowerName.includes('hyper-v') ||
          lowerName.includes('meta') ||
          lowerName.includes('clash') ||
          lowerName.includes('tun') ||
          addr.address.startsWith('169.254.') ||
          addr.address.startsWith('198.18.');

        let score = 0;
        if (!isVirtual) score += 100;
        if (lowerName.includes('wlan') || lowerName.includes('wi-fi') || lowerName.includes('无线')) score += 50;
        if (lowerName.includes('ethernet') || lowerName.includes('以太网')) score += 30;
        if (addr.address.startsWith('192.168.')) score += 20;
        else if (addr.address.startsWith('10.')) score += 15;
        else if (addr.address.startsWith('172.')) score += 10;

        candidates.push({
          name,
          address: addr.address,
          isVirtual,
          score
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) {
    candidates.push({ name: 'localhost', address: '127.0.0.1', isVirtual: false, score: 1 });
  }
  return candidates;
}

// ==========================================
// 2. 常驻 PowerShell 剪贴板桥接进程
// ==========================================
class ClipboardBridge {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.reqCounter = 0;
    this.buffer = '';
    this.ready = false;
    this.start();
  }

  start() {
    const scriptPath = path.join(__dirname, 'clipboard-bridge.ps1');
    this.proc = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'READY') {
            this.ready = true;
            continue;
          }
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, timer } = this.pending.get(msg.id);
            clearTimeout(timer);
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch (err) {
          // 忽略非 JSON 输出
        }
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (errText) => {
      console.error('[ClipboardBridge stderr]:', errText.trim());
    });

    this.proc.on('exit', (code) => {
      console.warn(`[ClipboardBridge] 进程退出 (${code})，2秒后自动重启...`);
      this.ready = false;
      for (const [, { reject, timer }] of this.pending.entries()) {
        clearTimeout(timer);
        reject(new Error('Clipboard bridge exited'));
      }
      this.pending.clear();
      setTimeout(() => this.start(), 2000);
    });
  }

  sendCommand(cmdObj, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin.writable) {
        return reject(new Error('剪贴板桥接进程未就绪'));
      }
      const id = `req_${++this.reqCounter}_${Date.now()}`;
      const payload = JSON.stringify({ ...cmdObj, id }) + '\n';
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`剪贴板操作超时 (${cmdObj.cmd})`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload, 'utf8');
    });
  }

  async getClipboardImage(lastHash = '', lastSeq = 0) {
    return this.sendCommand({ cmd: 'GET_IMAGE', lastHash, lastSeq });
  }

  async setClipboardImageFromFile(filePath) {
    return this.sendCommand({ cmd: 'SET_IMAGE', filePath });
  }

  async startScreenClip() {
    return this.sendCommand({ cmd: 'SCREENCLIP' });
  }
}

const clipboard = new ClipboardBridge();

// ==========================================
// 3. 分层工程文件存储与全局状态管理
// ==========================================
// 目录结构设计:
// history/
// ├── index.json                         (工程历史索引列表)
// └── projects/
//     └── proj_<timestamp>_<hash8>/      (单个图像的分层工程目录)
//         ├── base.png                   (1. 原始纯净底图 - 绝不混入手绘像素)
//         ├── draw.png                   (2. 额外绘制层 - 透明通道 PNG，仅含笔画/填充/标记)
//         ├── merged.png                 (3. 叠加合成图 - base+draw，专用于写入系统剪贴板)
//         └── meta.json                  (4. 元数据与独立笔画/标记对象栈 strokeRecords)

const state = {
  autoSyncClipboard: false,
  lastObservedClipboardHash: '',
  lastObservedClipboardSeq: 0,
  lastReturnedFromTabletHash: '',
  lastReturnedClipboardSeq: 0,
  suppressClipboardPollUntil: 0,
  currentImage: null,
  latestReturnedImage: null,
  latestTabletImage: null,
  history: [], // 最近 20 个分层工程记录
  awaitingSnip: false
};

function checkDirectory(dir, create = false) {
  let stats = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stats && create) {
    fs.mkdirSync(dir);
    stats = fs.lstatSync(dir);
  }
  if (stats && !stats.isDirectory()) throw new Error('工程目录无效');
  return Boolean(stats);
}

function isRegularFile(filePath) {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats && (!stats.isFile() || stats.nlink !== 1)) throw new Error('工程文件类型无效');
  return Boolean(stats);
}

function getProjectPaths(projectId, create = false) {
  requireProjectId(projectId);
  if (!checkDirectory(HISTORY_DIR, create) || !checkDirectory(PROJECTS_DIR, create)) return null;
  const projDir = path.resolve(PROJECTS_DIR, projectId);
  if (path.dirname(projDir) !== PROJECTS_DIR || !checkDirectory(projDir, create)) return null;
  return {
    basePath: path.join(projDir, 'base.png'),
    drawPath: path.join(projDir, 'draw.png'),
    mergedPath: path.join(projDir, 'merged.png'),
    metaPath: path.join(projDir, 'meta.json')
  };
}

function createProjectId() {
  return 'proj_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
}

function persistHistoryIndex() {
  try {
    const indexData = state.history.map((item) => ({
      projectId: item.projectId,
      id: item.id,
      direction: item.direction,
      source: item.source,
      timestamp: item.timestamp
    }));
    checkDirectory(HISTORY_DIR);
    isRegularFile(INDEX_FILE);
    fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData, null, 2), 'utf8');
  } catch (e) {
    console.error('[PersistIndex Error]:', e.message);
  }
}

function saveLayeredProjectToDisk(item) {
  const { projectId } = item;
  const base = decodeStoredImage(item.baseDataUrl);
  const draw = item.drawDataUrl ? decodeStoredImage(item.drawDataUrl) : null;
  const merged = item.dataUrl === item.baseDataUrl ? base : decodeStoredImage(item.dataUrl);
  const { basePath, drawPath, mergedPath, metaPath } = getProjectPaths(projectId, true);
  [basePath, mergedPath, metaPath].forEach(isRegularFile);
  const hasOldDraw = isRegularFile(drawPath);

  // 1. 保存纯净底图 base.png
  fs.writeFileSync(basePath, base);

  // 2. 保存额外绘制透明图层 draw.png
  if (draw) {
    fs.writeFileSync(drawPath, draw);
  } else if (hasOldDraw) {
    fs.unlinkSync(drawPath);
  }

  // 3. 保存叠加合成图 merged.png (用于剪贴板与总览)
  const mergedHash = crypto.createHash('sha256').update(merged).digest('hex');
  fs.writeFileSync(mergedPath, merged);

  // 4. 保存元数据与独立笔画记录 meta.json
  const meta = {
    projectId,
    id: item.id,
    width: item.width || 0,
    height: item.height || 0,
    source: item.source || '',
    direction: item.direction || 'pc-to-tablet',
    hasDrawLayer: Boolean(item.drawDataUrl),
    badgeCounter: item.badgeCounter || 1,
    annotations: Array.isArray(item.annotations) ? item.annotations : [],
    strokeRecords: Array.isArray(item.strokeRecords) ? item.strokeRecords : [],
    promptHint: item.promptHint || '',
    timestamp: item.timestamp || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    files: {
      base: `history/projects/${projectId}/base.png`,
      draw: item.drawDataUrl ? `history/projects/${projectId}/draw.png` : null,
      merged: `history/projects/${projectId}/merged.png`,
      meta: `history/projects/${projectId}/meta.json`
    }
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  item.files = meta.files;
  item.hasDrawLayer = meta.hasDrawLayer;

  return { mergedPath, mergedHash, merged };
}

function loadProjectFromDisk(projectId) {
  try {
    const files = getProjectPaths(projectId);
    if (!files) return null;
    const { basePath, drawPath, mergedPath, metaPath } = files;
    if (!isRegularFile(metaPath) || !isRegularFile(mergedPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const mergedDataUrl = encodeStoredImage(fs.readFileSync(mergedPath));
    const hasBaseFile = isRegularFile(basePath);
    const baseDataUrl = hasBaseFile
      ? encodeStoredImage(fs.readFileSync(basePath))
      : mergedDataUrl;
    const drawDataUrl = isRegularFile(drawPath)
      ? encodeStoredImage(fs.readFileSync(drawPath))
      : null;

    return {
      ...meta,
      id: projectId,
      projectId,
      hasBaseFile,
      dataUrl: mergedDataUrl,
      baseDataUrl,
      drawDataUrl,
      hasDrawLayer: Boolean(drawDataUrl)
    };
  } catch (e) {
    return null;
  }
}

function loadHistoryFromDiskOnStartup() {
  try {
    if (!isRegularFile(INDEX_FILE)) return;
    const list = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const pid = entry?.projectId || entry?.id;
      if (!pid) continue;
      const proj = loadProjectFromDisk(pid);
      if (proj) {
        state.history.push(proj);
      }
    }
    if (state.history.length > 0) {
      state.currentImage = state.history[0];
      state.latestReturnedImage = state.history.find(x => x.direction === 'tablet-to-pc') || null;
    }
  } catch (_) {}
}

function upsertProjectHistory(item) {
  const idx = state.history.findIndex(x => x.projectId === item.projectId);
  if (idx !== -1) {
    state.history.splice(idx, 1);
  }
  state.history.unshift(item);
  if (state.history.length > 20) {
    state.history.pop();
  }
  persistHistoryIndex();
}

function createTabletImageSnapshot(data, contentType, hash = crypto.createHash('sha256').update(data).digest('hex')) {
  return { data, contentType, etag: '"' + hash + '"' };
}

function loadLatestTabletImage() {
  try {
    if (isRegularFile(LATEST_RETURN_FILE)) {
      return createTabletImageSnapshot(fs.readFileSync(LATEST_RETURN_FILE), 'image/png');
    }
  } catch (error) {
    console.error('[LatestTabletImage Load Error]:', error.message);
  }
  const dataUrl = state.latestReturnedImage?.dataUrl;
  if (!dataUrl) return null;
  const contentType = dataUrl.slice('data:'.length, dataUrl.indexOf(';'));
  return createTabletImageSnapshot(decodeStoredImage(dataUrl), contentType);
}

function rememberLatestTabletImage(data, hash) {
  state.latestTabletImage = createTabletImageSnapshot(data, 'image/png', hash);
  const temporary = path.join(HISTORY_DIR, '_latest-return-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try {
    checkDirectory(HISTORY_DIR);
    isRegularFile(LATEST_RETURN_FILE);
    const file = fs.openSync(temporary, 'wx');
    try {
      try {
        fs.writeFileSync(file, data);
      } finally {
        fs.closeSync(file);
      }
      fs.renameSync(temporary, LATEST_RETURN_FILE);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  } catch (error) {
    console.error('[LatestTabletImage Save Error]:', error.message);
  }
}

loadHistoryFromDiskOnStartup();
state.latestTabletImage = loadLatestTabletImage();

// ==========================================
// 4. HTTP 与 WebSocket 服务
// ==========================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

const PC_ROUTES = new Set([
  '/pc', '/pc.html', '/api/info', '/api/pairing/revoke', '/api/settings',
  '/api/clipboard/push', '/api/clipboard/snip-and-push', '/api/clipboard/copy-dataurl',
  '/api/image/push', '/api/image/latest-returned', '/api/project/push-to-tablet', '/api/history/clear'
]);
const STATIC_PAGES = new Map([
  ['/', 'tablet.html'],
  ['/tablet', 'tablet.html'],
  ['/tablet.html', 'tablet.html'],
  ['/pc', 'pc.html'],
  ['/pc.html', 'pc.html'],
  ['/manifest.json', 'manifest.json']
]);

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const origin = getRequestOrigin(req);
    if (!origin) throw new HttpError(400, '无效的访问地址');
    const parsedUrl = new URL(req.url, origin);
    const pathname = parsedUrl.pathname;
    if (PC_ROUTES.has(pathname) && !isPcRequest(req)) {
      throw new HttpError(403, '请在 Windows 本机打开 PC 控制台');
    }
    if (req.method === 'POST' && !isSameOrigin(req)) {
      throw new HttpError(403, '请求来源无效');
    }

    if (req.method === 'GET' && pathname === '/api/pair') {
      return sendJson(res, 200, { ok: true, paired: Boolean(access.getTabletSession(req)) });
    }
    if (req.method === 'POST' && pathname === '/api/pair') {
      const { code } = await readJsonBody(req, 1024);
      const session = access.pairTablet(code, access.getTabletSession(req));
      res.setHeader('Set-Cookie', access.sessionCookie(session));
      broadcastToPc({ type: 'PAIRING_UPDATED' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/pairing/revoke') {
      access.revokeAll();
      for (const [ws, client] of clients) {
        if (client.role === 'tablet') ws.close(4001, 'Pairing revoked');
      }
      broadcastToPc({ type: 'PAIRING_UPDATED' });
      broadcastClientsStatus();
      return sendJson(res, 200, { ok: true });
    }

    // API: 获取服务器状态、局域网 IP 与二维码
    if (req.method === 'GET' && pathname === '/api/info') {
      const ips = getLanAddresses();
      const selectedIp = parsedUrl.searchParams.get('ip') || ips[0].address;
      requireInput(ips.some(candidate => candidate.address === selectedIp), 'ip');
      const pairing = access.getPairing();
      const port = server.address().port;
      const tabletUrl = `http://${selectedIp}:${port}/tablet`;
      const pairingPath = `/tablet#pair=${pairing.code}`;
      const pairingUrl = `${tabletUrl}#pair=${pairing.code}`;
      const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
        width: 280,
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' }
      });

      return sendJson(res, 200, {
        ok: true,
        port,
        ips,
        selectedIp,
        tabletUrl,
        pairingUrl,
        pairingPath,
        pairingExpiresAt: pairing.expiresAt,
        qrDataUrl,
        autoSyncClipboard: state.autoSyncClipboard,
        clients: getConnectedClientsSummary()
      });
    }

    // API: 切换自动同步剪贴板设置
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req, 1024);
      requireInput(typeof body.autoSyncClipboard === 'boolean', 'autoSyncClipboard');
      state.autoSyncClipboard = body.autoSyncClipboard;
      if (state.autoSyncClipboard) {
        // 开启自动同步时，先记录当前剪贴板 Hash 作为基线，防止误推旧图
        try {
          const cur = await clipboard.getClipboardImage();
          if (cur && cur.seq) state.lastObservedClipboardSeq = cur.seq;
          if (cur && cur.hasImage && cur.hash) state.lastObservedClipboardHash = cur.hash;
        } catch (_) {}
      }
      broadcastToPc({
        type: 'SETTINGS_UPDATED',
        autoSyncClipboard: state.autoSyncClipboard
      });
      return sendJson(res, 200, { ok: true, autoSyncClipboard: state.autoSyncClipboard });
    }

    // API: 立即读取 PC 系统剪贴板并发送到平板
    if (req.method === 'POST' && pathname === '/api/clipboard/push') {
      const clipRes = await clipboard.getClipboardImage('');
      if (!clipRes.ok || !clipRes.hasImage) {
        return sendJson(res, 400, {
          ok: false,
          error: '当前 Windows 剪贴板中没有检测到图片！请先截图 (Win+Shift+S) 或复制任意图片。'
        });
      }
      state.lastObservedClipboardHash = clipRes.hash;
      const item = pushImageToTablet({
        dataUrl: clipRes.dataUrl,
        width: clipRes.width,
        height: clipRes.height,
        source: 'PC系统剪贴板'
      });
      return sendJson(res, 200, { ok: true, item });
    }

    // API: 触发系统截图 (Win+Shift+S) 并在截图完成后自动推送到平板
    if (req.method === 'POST' && pathname === '/api/clipboard/snip-and-push') {
      // 先记录截图前的剪贴板 Hash
      try {
        const before = await clipboard.getClipboardImage('');
        state.lastObservedClipboardHash = before && before.hasImage ? before.hash : 'EMPTY';
      } catch (_) {
        state.lastObservedClipboardHash = 'EMPTY';
      }
      state.awaitingSnip = true;
      await clipboard.startScreenClip();
      // 启动高频检测 25 秒，一旦剪贴板图片变化立刻推送到平板
      watchSnipCompletion();
      return sendJson(res, 200, { ok: true, message: '已唤起系统区域截图，框选完成后将自动发送到平板！' });
    }

    // API: 直接从 PC 端上传/粘贴/生成图片推送到平板
    if (req.method === 'POST' && pathname === '/api/image/push') {
      const body = await readJsonBody(req);
      requireInput(body.projectId == null || body.projectId === '', 'projectId');
      const item = pushImageToTablet(validateImagePayload(body));
      return sendJson(res, 200, { ok: true, item });
    }

    // API: 将已保存的分层工程再次同步到平板（可选保留或剥离之前添加的笔画与标记）
    if (req.method === 'POST' && pathname === '/api/project/push-to-tablet') {
      const body = await readJsonBody(req, 1024);
      const projectId = requireProjectId(body.projectId);
      requireInput(body.stripDrawLayer === undefined || typeof body.stripDrawLayer === 'boolean', 'stripDrawLayer');
      const stripDrawLayer = body.stripDrawLayer === true;
      const proj = loadProjectFromDisk(projectId);
      if (!proj) {
        return sendJson(res, 404, { ok: false, error: '未找到该分层工程记录' });
      }
      if (stripDrawLayer && (!proj.hasBaseFile || !proj.baseDataUrl)) {
        throw new HttpError(409, '该工程缺少独立底图，无法发送纯底图');
      }

      const item = pushImageToTablet({
        projectId: stripDrawLayer ? undefined : proj.projectId,
        dataUrl: stripDrawLayer ? proj.baseDataUrl : proj.dataUrl,
        baseDataUrl: proj.baseDataUrl,
        drawDataUrl: stripDrawLayer ? null : proj.drawDataUrl,
        strokeRecords: stripDrawLayer ? [] : (proj.strokeRecords || []),
        annotations: stripDrawLayer ? [] : (proj.annotations || []),
        badgeCounter: stripDrawLayer ? 1 : (proj.badgeCounter || 1),
        width: proj.width || 0,
        height: proj.height || 0,
        source: stripDrawLayer ? 'PC重发(已剥离旧笔画)' : 'PC分层同步(可擦除/移除旧笔画)'
      });
      return sendJson(res, 200, { ok: true, item });
    }

    // API: 平板端将编辑后的图片发送回 PC 并自动写入系统剪贴板
    if (req.method === 'POST' && pathname === '/api/image/return') {
      const session = access.getTabletSession(req);
      if (!session) throw new HttpError(401, '请先配对平板');
      const body = await readJsonBody(req);
      const result = await returnImageForSession(body, session);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/image/latest-returned') {
      const image = state.latestTabletImage;
      if (!image) throw new HttpError(404, '还没有平板回传图像');
      res.writeHead(200, {
        'Content-Type': image.contentType,
        'Content-Length': image.data.length,
        'Cache-Control': 'no-store',
        ETag: image.etag
      });
      return res.end(req.method === 'HEAD' ? undefined : image.data);
    }

    // API: 将指定图片重新写入 PC 系统剪贴板
    if (req.method === 'POST' && pathname === '/api/clipboard/copy-dataurl') {
      const body = await readJsonBody(req);
      readPng(body.dataUrl, 'dataUrl');
      const setRes = await copyPngToClipboard(body.dataUrl);
      if (!setRes.ok) {
        return sendJson(res, 500, { ok: false, error: setRes.error || '写入剪贴板失败' });
      }
      if (setRes.seq) {
        state.lastReturnedClipboardSeq = setRes.seq;
        state.lastObservedClipboardSeq = setRes.seq;
      }
      state.lastReturnedFromTabletHash = setRes.hash;
      state.lastObservedClipboardHash = setRes.hash;
      state.suppressClipboardPollUntil = Date.now() + 1800;
      return sendJson(res, 200, { ok: true, hash: setRes.hash, seq: setRes.seq });
    }

    // API: 清空 PC 端历史记录及磁盘工程文件
    if (req.method === 'POST' && pathname === '/api/history/clear') {
      state.history = [];
      state.currentImage = null;
      state.latestReturnedImage = null;
      state.latestTabletImage = null;
      access.clearProjects();

      try {
        checkDirectory(HISTORY_DIR);
        if (checkDirectory(PROJECTS_DIR)) {
          fs.rmSync(PROJECTS_DIR, { recursive: true, force: true });
          fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        }
        const entries = fs.readdirSync(HISTORY_DIR);
        for (const name of entries) {
          if (name === 'projects') continue;
          const fullPath = path.join(HISTORY_DIR, name);
          if (fs.lstatSync(fullPath).isFile()) {
            fs.unlinkSync(fullPath);
          }
        }
        isRegularFile(INDEX_FILE);
        fs.writeFileSync(INDEX_FILE, '[]', 'utf8');
      } catch (e) {
        console.error('[ClearHistory Error]:', e.message);
      }

      broadcastToPc({ type: 'HISTORY_CLEARED' });
      return sendJson(res, 200, { ok: true });
    }

    const page = STATIC_PAGES.get(pathname);
    if (page && (req.method === 'GET' || req.method === 'HEAD')) {
      const content = fs.readFileSync(path.join(PUBLIC_DIR, page));
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(page)],
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[HTTP Error]:', err);
    sendJson(res, err.status || 500, { ok: false, error: err instanceof HttpError ? err.message : '服务器操作失败' });
  }
});

// ==========================================
// 5. WebSocket 实时双向通讯
// ==========================================
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_JSON_BYTES
});

const clients = new Map();

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const role = url.searchParams.get('role') || 'tablet';
  const tabletSession = role === 'tablet' ? access.getTabletSession(req) : null;
  const allowed = role === 'pc' ? isPcRequest(req) : Boolean(tabletSession);
  if (!isSameOrigin(req) || url.pathname !== '/' || !allowed) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, role, tabletSession, url));
});

function getConnectedClientsSummary() {
  const tablets = [];
  let pcCount = 0;
  for (const info of clients.values()) {
    if (info.role === 'tablet' && access.getSession(info.token)) {
      tablets.push({
        id: info.id,
        deviceName: info.deviceName,
        ip: info.ip,
        connectedAt: info.connectedAt
      });
    } else if (info.role === 'pc') {
      pcCount++;
    }
  }
  return { pcCount, tabletCount: tablets.length, tablets };
}

function broadcastToPc(payload) {
  const msg = JSON.stringify(payload);
  for (const [ws, client] of clients) {
    if (client.role === 'pc' && ws.readyState === 1) ws.send(msg);
  }
}

function tabletProjectView(item) {
  if (!item) return null;
  const { projectId, baseDataUrl, drawDataUrl, strokeRecords, annotations, badgeCounter, source } = item;
  return { projectId, baseDataUrl, drawDataUrl, strokeRecords, annotations, badgeCounter, source };
}

function broadcastProjectToTablets(item) {
  const message = JSON.stringify({ type: 'IMAGE_TO_TABLET', item: tabletProjectView(item) });
  for (const [ws, client] of clients) {
    if (client.role !== 'tablet' || ws.readyState !== 1) continue;
    const session = access.getSession(client.token);
    if (!session) continue;
    access.grantProject(session, item.projectId);
    ws.send(message);
  }
}

function broadcastClientsStatus() {
  broadcastToPc({
    type: 'CLIENTS_STATUS',
    clients: getConnectedClientsSummary()
  });
}

function pushImageToTablet({
  projectId,
  dataUrl,
  baseDataUrl,
  drawDataUrl = null,
  strokeRecords = [],
  annotations = [],
  badgeCounter = 1,
  width,
  height,
  source
}) {
  const cleanBase = baseDataUrl || dataUrl;
  const pid = projectId || createProjectId();

  const item = {
    id: pid,
    projectId: pid,
    dataUrl: dataUrl || cleanBase,
    baseDataUrl: cleanBase,
    drawDataUrl: drawDataUrl || null,
    hasDrawLayer: Boolean(drawDataUrl),
    strokeRecords: Array.isArray(strokeRecords) ? strokeRecords : [],
    annotations: Array.isArray(annotations) ? annotations : [],
    badgeCounter: badgeCounter || 1,
    width: width || 0,
    height: height || 0,
    source: source || 'PC推送',
    direction: 'pc-to-tablet',
    timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };

  saveLayeredProjectToDisk(item);
  state.currentImage = item;
  upsertProjectHistory(item);

  broadcastToPc({
    type: 'IMAGE_TO_TABLET',
    item
  });
  broadcastProjectToTablets(item);
  return item;
}

function returnImageForSession(body, session) {
  if (!access.getSession(session.token)) throw new HttpError(401, '请重新配对平板');
  const projectId = body.projectId === '' || body.projectId === undefined ? undefined : requireProjectId(body.projectId);
  if (projectId && !session.projectIds.has(projectId)) {
    throw new HttpError(403, '当前平板没有编辑该工程的权限');
  }
  const payload = validateImagePayload(body);
  if (projectId) {
    const project = getProjectPaths(projectId);
    if (!project || !isRegularFile(project.metaPath)) throw new HttpError(404, '该工程已不存在');
    if (!payload.baseDataUrl && isRegularFile(project.basePath)) {
      payload.baseDataUrl = encodeStoredImage(fs.readFileSync(project.basePath));
    }
  }
  const id = projectId || createProjectId();
  access.grantProject(session, id);
  return handleTabletReturnImage({ ...payload, projectId: id });
}

async function copyPngToClipboard(dataUrl) {
  checkDirectory(HISTORY_DIR);
  const tempPath = path.join(HISTORY_DIR, '_clipboard_' + crypto.randomBytes(12).toString('hex') + '.png');
  fs.writeFileSync(tempPath, decodeStoredImage(dataUrl), { flag: 'wx' });
  state.suppressClipboardPollUntil = Date.now() + 3000;
  try {
    return await clipboard.setClipboardImageFromFile(tempPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[Clipboard Temp Error]:', error);
    }
  }
}

async function handleTabletReturnImage({
  projectId,
  dataUrl,
  baseDataUrl,
  drawDataUrl,
  strokeRecords,
  badgeCounter,
  width,
  height,
  annotations,
  promptHint,
  auto
}) {
  const item = {
    id: projectId,
    projectId,
    dataUrl, // 叠加合成后的版本 merged.png (用于写入剪贴板和总览)
    baseDataUrl: baseDataUrl || dataUrl,
    drawDataUrl: drawDataUrl || null, // 额外绘制的独立透明层 draw.png
    hasDrawLayer: Boolean(drawDataUrl),
    strokeRecords: Array.isArray(strokeRecords) ? strokeRecords : [],
    badgeCounter: badgeCounter || 1,
    width: width || 0,
    height: height || 0,
    source: auto ? '平板实时同步(已分层保存)' : '平板回传(已分层保存)',
    direction: 'tablet-to-pc',
    auto: Boolean(auto),
    annotations: Array.isArray(annotations) ? annotations : [],
    promptHint: promptHint || '',
    timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };

  // 分层写入磁盘: base.png (原图) + draw.png (额外绘制层) + merged.png (合成图) + meta.json
  const saved = saveLayeredProjectToDisk(item);
  rememberLatestTabletImage(saved.merged, saved.mergedHash);

  // 写入剪贴板期间暂停自动轮询，防止竞态回环
  state.suppressClipboardPollUntil = Date.now() + 3000;

  // 将叠加绘制后的版本 (merged.png) 写入 Windows 系统剪贴板
  const setRes = await clipboard.setClipboardImageFromFile(saved.mergedPath);

  const clipboardHash = (setRes && setRes.hash) || saved.mergedHash;
  if (setRes.ok) {
    if (setRes.seq) {
      state.lastReturnedClipboardSeq = setRes.seq;
      state.lastObservedClipboardSeq = setRes.seq;
    }
    if (clipboardHash) {
      state.lastReturnedFromTabletHash = clipboardHash;
      state.lastObservedClipboardHash = clipboardHash;
    }
    console.log(`[Tablet->PC] pid=${projectId} auto=${Boolean(auto)} seq=${setRes.seq} hash=${clipboardHash.slice(0, 8)}`);
  } else {
    console.warn(`[Tablet->PC] 写入剪贴板失败:`, setRes && setRes.error);
  }
  state.suppressClipboardPollUntil = Date.now() + 1800;

  item.clipboardWritten = Boolean(setRes.ok);
  item.width = item.width || setRes.width || 0;
  item.height = item.height || setRes.height || 0;

  state.currentImage = item;
  state.latestReturnedImage = item;
  upsertProjectHistory(item);

  broadcastToPc({
    type: 'IMAGE_RETURNED_TO_PC',
    item
  });

  return { item, clipboardWritten: Boolean(setRes.ok) };
}

wss.on('connection', (ws, req, role, session, parsedUrl) => {
  const requestedDevice = parsedUrl.searchParams.get('device') || '';
  const deviceName = requestedDevice.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) ||
    (role === 'tablet' ? '平板' : 'PC 控制台');
  const rawIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const clientInfo = {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role,
    token: session?.token,
    deviceName,
    ip: rawIp,
    connectedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };
  clients.set(ws, clientInfo);
  broadcastClientsStatus();

  if (session && state.currentImage) access.grantProject(session, state.currentImage.projectId);
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    ...(role === 'pc' ? {
      autoSyncClipboard: state.autoSyncClipboard,
      clients: getConnectedClientsSummary(),
      currentImage: state.currentImage,
      latestReturnedImage: state.latestReturnedImage,
      history: state.history
    } : { currentImage: tabletProjectView(state.currentImage) })
  }));

  ws.on('message', async (raw, isBinary) => {
    try {
      if (session && !access.getSession(session.token)) {
        ws.close(4001, 'Pairing expired');
        return;
      }
      if (isBinary) throw new HttpError(400, '只接受 JSON 消息');
      const msg = parseJson(raw.toString());
      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
      } else if (msg.type === 'RETURN_IMAGE_TO_PC') {
        if (!session) throw new HttpError(403, '只有已配对平板可以回传画布');
        const res = await returnImageForSession(msg, session);
        ws.send(JSON.stringify({
          type: 'RETURN_ACK',
          ok: true,
          auto: Boolean(msg.auto),
          clipboardWritten: res.clipboardWritten,
          itemId: res.item.id
        }));
      } else {
        throw new HttpError(400, '未知的消息类型');
      }
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('[WS Message Error]:', e);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'RETURN_ACK',
          ok: false,
          status: e.status || 500,
          error: e instanceof HttpError ? e.message : '服务器操作失败'
        }));
      }
    }
  });

  ws.on('error', error => console.warn('[WebSocket Error]:', error.message));
  ws.on('close', () => {
    clients.delete(ws);
    broadcastClientsStatus();
  });
});

setInterval(() => {
  for (const [ws, client] of clients) {
    if (client.role === 'tablet' && !access.getSession(client.token)) ws.close(4001, 'Pairing expired');
  }
}, 30000);

// ==========================================
// 6. 剪贴板自动监听与截图完成检测
// ==========================================
let isPollingClipboard = false;

async function pollClipboardOnce(forcePushOnNew = false) {
  if (isPollingClipboard || !clipboard.ready) return false;
  if (!forcePushOnNew && state.suppressClipboardPollUntil && Date.now() < state.suppressClipboardPollUntil) {
    return false;
  }
  isPollingClipboard = true;
  try {
    const res = await clipboard.getClipboardImage(
      state.lastObservedClipboardHash,
      forcePushOnNew ? 0 : state.lastObservedClipboardSeq
    );
    if (res && res.ok) {
      if (res.seq) {
        if (!forcePushOnNew && state.lastReturnedClipboardSeq && res.seq === state.lastReturnedClipboardSeq) {
          state.lastObservedClipboardSeq = res.seq;
          return false;
        }
        state.lastObservedClipboardSeq = res.seq;
      }
      if (!res.hasImage) {
        // 剪贴板变为非图片内容（如复制了文本），清空上次图片 Hash 以便再次复制同图时能被识别
        state.lastObservedClipboardHash = '';
      } else if (!res.unchanged && res.hash) {
        // 如果跟刚刚从平板回传写入剪贴板的图片 Hash 相同，跳过，避免死循环
        if (res.hash === state.lastReturnedFromTabletHash) {
          state.lastObservedClipboardHash = res.hash;
          return false;
        }
        state.lastObservedClipboardHash = res.hash;
        if (forcePushOnNew || state.autoSyncClipboard) {
          console.log(`[PC->Tablet] 检测到新剪贴板图片 seq=${res.seq} hash=${res.hash.slice(0, 8)} (lastReturnedHash=${state.lastReturnedFromTabletHash.slice(0, 8)}, lastReturnedSeq=${state.lastReturnedClipboardSeq})`);
          pushImageToTablet({
            dataUrl: res.dataUrl,
            width: res.width,
            height: res.height,
            source: forcePushOnNew ? 'PC区域截图自动同步' : 'PC剪贴板自动同步'
          });
          return true;
        }
      }
    }
  } catch (_) {
    // 忽略偶发剪贴板被其他程序占用
  } finally {
    isPollingClipboard = false;
  }
  return false;
}

// 常驻自动同步轮询 (每 1.2 秒检测一次)
setInterval(() => {
  if (state.autoSyncClipboard && !state.awaitingSnip) {
    pollClipboardOnce(false);
  }
}, 1200);

// 唤醒 Win+Shift+S 后的快速检测器
function watchSnipCompletion() {
  let attempts = 0;
  const maxAttempts = 50; // 50 * 500ms = 25s
  const timer = setInterval(async () => {
    attempts++;
    if (!state.awaitingSnip || attempts > maxAttempts) {
      state.awaitingSnip = false;
      clearInterval(timer);
      return;
    }
    const pushed = await pollClipboardOnce(true);
    if (pushed) {
      state.awaitingSnip = false;
      clearInterval(timer);
    }
  }, 500);
}

// ==========================================
// 7. 启动服务并打印终端引导
// ==========================================
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanAddresses();
  const primaryIp = ips[0].address;
  const port = server.address().port;
  const pcUrl = `http://localhost:${port}/pc`;
  const tabletUrl = `http://${primaryIp}:${port}/tablet`;

  console.log('\n============================================================');
  console.log('🎨 AI 创作平板助手 (PC + Android 平板协同工作台) 已启动！');
  console.log('============================================================');
  console.log(`💻 PC 端控制台地址   : ${pcUrl}`);
  console.log(`📱 安卓平板端画布地址 : ${tabletUrl}`);
  if (ips.length > 1) {
    console.log('\n🌐 检测到的所有局域网网卡 IP:');
    ips.forEach((item) => {
      console.log(`   - ${item.name}: http://${item.address}:${port}/tablet ${item.isVirtual ? '(虚拟网卡)' : '(推荐)'}`);
    });
  }
  console.log('============================================================\n');
  console.log('📱 请在本机 PC 控制台获取一次性配对二维码。');
});
