const MAX_JSON_BYTES = 60 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_EDGE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PROJECT_ID = /^proj_\d{1,16}_(?:[a-f0-9]{8}|[a-f0-9]{16}|[a-z0-9]{1,4})$/;
const STROKE_ID = /^[a-z0-9_-]{1,80}$/i;
const COLOR = /^#[a-f0-9]{6}$/i;
const CONTINUOUS_TOOLS = new Set(['pen', 'eraser', 'highlighter', 'polyline']);
const SHAPE_TOOLS = new Set(['line', 'arrow', 'rect', 'circle']);
const POINT_TOOLS = new Set(['badge', 'text', 'fill']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireInput(condition, field) {
  if (!condition) throw new HttpError(400, '参数无效：' + field);
}

function requireProjectId(value) {
  requireInput(typeof value === 'string' && PROJECT_ID.test(value), 'projectId');
  return value;
}

function parseJson(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
  requireInput(body !== null && typeof body === 'object' && !Array.isArray(body), 'JSON 请求体');
  return body;
}

function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      reject(new HttpError(415, '请求必须使用 application/json'));
      return;
    }
    if (Number(req.headers['content-length']) > maxBytes) {
      req.resume();
      reject(new HttpError(413, '请求体过大'));
      return;
    }
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= maxBytes) {
        chunks.push(chunk);
      } else {
        chunks.length = 0;
        reject(new HttpError(413, '请求体过大'));
      }
    });
    req.on('end', () => {
      if (bytes > maxBytes) return;
      try {
        resolve(parseJson(Buffer.concat(chunks, bytes).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function decodeDataUrl(value, field, prefix = 'data:image/png;base64,') {
  requireInput(typeof value === 'string' && value.startsWith(prefix), field);
  const encoded = value.slice(prefix.length);
  requireInput(encoded.length > 0 && encoded.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), field);
  return Buffer.from(encoded, 'base64');
}

function readPng(value, field) {
  if (typeof value === 'string' && value.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 22) {
    throw new HttpError(413, 'PNG 文件过大：' + field);
  }
  const data = decodeDataUrl(value, field);
  if (data.length > MAX_PNG_BYTES) throw new HttpError(413, 'PNG 文件过大：' + field);
  requireInput(data.length >= 57 && data.subarray(0, 8).equals(PNG_SIGNATURE) &&
    data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR', field);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new HttpError(413, '图像尺寸过大：' + field);
  }
  requireInput(width > 0 && height > 0, field);
  let hasImageData = false;
  for (let offset = 33; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    offset += length + 12;
    requireInput(offset <= data.length && type !== 'IHDR', field);
    if (type === 'IDAT' && length > 0) hasImageData = true;
    if (type === 'IEND') {
      requireInput(hasImageData && length === 0 && offset === data.length, field);
      return { width, height };
    }
  }
  throw new HttpError(400, 'PNG 文件不完整：' + field);
}

function mediaType(data) {
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpeg';
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (data.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (data.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/.test(data.toString('ascii', 8, 12))) return 'avif';
  if (data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'x-icon';
  return null;
}

function decodeStoredImage(value) {
  const prefix = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,/.exec(value)?.[0];
  requireInput(Boolean(prefix), '图像格式');
  return decodeDataUrl(value, '图像数据', prefix);
}

function encodeStoredImage(data) {
  const type = mediaType(data) || 'png';
  return 'data:image/' + type + ';base64,' + data.toString('base64');
}

function boundedString(value, max, field) {
  requireInput(typeof value === 'string' && value.length <= max && !value.includes('\0'), field);
  return value;
}

function integer(value, min, max, field) {
  requireInput(Number.isInteger(value) && value >= min && value <= max, field);
  return value;
}

function boolean(value, field) {
  requireInput(typeof value === 'boolean', field);
  return value;
}

function point(value, field) {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Number.isFinite(value.x) && Math.abs(value.x) <= 1e6 &&
    Number.isFinite(value.y) && Math.abs(value.y) <= 1e6, field);
  const position = { x: value.x, y: value.y };
  if (value.pressure !== undefined) {
    requireInput(Number.isFinite(value.pressure) && value.pressure >= 0 && value.pressure <= 1, field + '.pressure');
    position.pressure = value.pressure;
  }
  return position;
}

function strokeId(record, field) {
  requireInput(record !== null && typeof record === 'object' && !Array.isArray(record) &&
    typeof record.id === 'string' && STROKE_ID.test(record.id), field + '.id');
  return record.id;
}

function list(value, max, field) {
  if (value === undefined) return [];
  requireInput(Array.isArray(value) && value.length <= max, field);
  return value;
}

function validateStrokes(value) {
  let totalPoints = 0;
  const ids = new Set();
  return list(value, 4096, 'strokeRecords').map((record, index) => {
    const field = 'strokeRecords[' + index + ']';
    const id = strokeId(record, field);
    requireInput(!ids.has(id), field + '.id');
    ids.add(id);
    const { tool, color } = record;
    const continuous = CONTINUOUS_TOOLS.has(tool);
    const shape = SHAPE_TOOLS.has(tool);
    requireInput(continuous || shape || POINT_TOOLS.has(tool), field + '.tool');
    requireInput(typeof color === 'string' && COLOR.test(color), field + '.color');
    const clean = { id, tool, color, label: boundedString(record.label ?? tool, 4120, field + '.label') };
    if (tool !== 'fill') clean.size = integer(record.size, 1, 120, field + '.size');
    if (continuous) {
      const points = list(record.points, 20000, field + '.points');
      totalPoints += points.length;
      requireInput(points.length >= (tool === 'polyline' ? 2 : 1) && totalPoints <= 200000, field + '.points');
      clean.points = points.map(value => point(value, field + '.points'));
      if (tool === 'polyline') clean.closeLoop = boolean(record.closeLoop ?? false, field + '.closeLoop');
    } else if (shape) {
      clean.p1 = point(record.p1, field + '.p1');
      clean.p2 = point(record.p2, field + '.p2');
    } else {
      Object.assign(clean, point(record, field));
      if (tool === 'fill') clean.tolerance = integer(record.tolerance ?? 32, 0, 120, field + '.tolerance');
      if (tool === 'badge') clean.num = integer(record.num, 1, 100000, field + '.num');
      if (tool === 'text') {
        clean.text = boundedString(record.text, 4096, field + '.text');
        clean.withBg = boolean(record.withBg ?? true, field + '.withBg');
      }
    }
    return clean;
  });
}

function validateAnnotations(value) {
  return list(value, 4096, 'annotations').map((item, index) => {
    const field = 'annotations[' + index + ']';
    const id = strokeId(item, field);
    const { type } = item;
    requireInput(type === 'badge' || type === 'text', field + '.type');
    const position = point(item, field);
    return type === 'text'
      ? { id, type, ...position, text: boundedString(item.text, 4096, field + '.text') }
      : { id, type, ...position, num: integer(item.num, 1, 100000, field + '.num'),
          symbol: boundedString(item.symbol, 20, field + '.symbol') };
  });
}

function validateImagePayload(body) {
  const { dataUrl, baseDataUrl, drawDataUrl } = body;
  const { width, height } = readPng(dataUrl, 'dataUrl');
  requireInput((body.width === undefined || body.width === width) &&
    (body.height === undefined || body.height === height), '图像尺寸');
  for (const [field, layer] of [['baseDataUrl', baseDataUrl], ['drawDataUrl', drawDataUrl]]) {
    if (layer == null) continue;
    const size = layer === dataUrl ? { width, height } : readPng(layer, field);
    requireInput(size.width === width && size.height === height, field + ' 尺寸');
  }
  return {
    dataUrl,
    baseDataUrl,
    drawDataUrl,
    width,
    height,
    strokeRecords: validateStrokes(body.strokeRecords),
    annotations: validateAnnotations(body.annotations),
    badgeCounter: integer(body.badgeCounter ?? 1, 1, 100001, 'badgeCounter'),
    source: boundedString(body.source ?? '', 256, 'source'),
    promptHint: boundedString(body.promptHint ?? '', 128 * 1024, 'promptHint'),
    auto: boolean(body.auto ?? false, 'auto')
  };
}

module.exports = {
  MAX_JSON_BYTES, HttpError, requireInput, requireProjectId, parseJson, readJsonBody, readPng,
  decodeStoredImage, encodeStoredImage, validateImagePayload
};
