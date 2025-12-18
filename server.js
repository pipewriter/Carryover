'use strict';

/**
 * Streaks: Overload
 *
 * A tiny Node.js server (no dependencies) + single-page HTML UI.
 *
 * Start:
 *   node server.js
 *
 * Open:
 *   http://localhost:3000
 *
 * What it does:
 * - Create daily tasks (optionally with a thumbnail image)
 * - Each task has a "hopper" (a number where 1.0 == 100%)
 * - Add any amount to the hopper (0.1, 1.0, 5.7, etc)
 * - Once per day, when the hopper reaches >= 1.0, the streak increments
 * - At midnight rollover:
 *     - If the day was never secured (never reached >= 1.0), streak resets to 0
 *     - Hopper decays by 10% (multiplied by 0.9) — matches the sketch
 *     - If hopper is still >= 1.0 at rollover, the NEW day auto-secures (\"1.0 rollover\")
 * - Upload a page background image
 *
 * Data:
 *   ./data.json (auto-created)
 * Uploads:
 *   ./uploads/  (auto-created)
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3003);

const ROOT_DIR = __dirname;
const INDEX_HTML_PATH = path.join(ROOT_DIR, 'index.html');
const DATA_PATH = path.join(ROOT_DIR, 'data.json');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');

const DAILY_THRESHOLD = 1.0;        // 1.0 == 100%
const DAILY_DECAY_MULTIPLIER = 0.9; // 0.9 == deduct 10% each day at midnight rollover
const EPS = 1e-9;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_MULTIPART_BYTES = 15 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let STATE = {
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  backgroundUrl: null,
  tasks: [],
};

let saveChain = Promise.resolve();

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dateKeyFromUTCDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDaysKey(dateKey, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return localDateKey();
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, da));
  d.setUTCDate(d.getUTCDate() + days);
  return dateKeyFromUTCDate(d);
}

function dayNumberUTC(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return Math.floor(Date.now() / 86400000);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  return Math.floor(Date.UTC(y, mo - 1, da) / 86400000);
}

function dayDiff(fromKey, toKey) {
  return dayNumberUTC(toKey) - dayNumberUTC(fromKey);
}

function roundTo(n, digits = 6) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function asSafeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isLikelyImageMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

function guessExtFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  if (m.includes('svg')) return '.svg';
  return '';
}

function safeExt(originalName, mime) {
  const extFromName = path.extname(originalName || '').toLowerCase();
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
  if (allowed.has(extFromName)) return extFromName;
  const extFromMime = guessExtFromMime(mime);
  if (allowed.has(extFromMime)) return extFromMime;
  return '.bin';
}

function uploadsFilePathFromUrl(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith('/uploads/')) return null;
  const base = path.basename(url);
  const full = path.resolve(UPLOAD_DIR, base);
  const uploadsRoot = path.resolve(UPLOAD_DIR) + path.sep;
  if (!full.startsWith(uploadsRoot)) return null;
  return full;
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    // ignore
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function serveFile(res, filePath, extraHeaders = {}) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      sendText(res, 404, 'Not found');
      return;
    }
    console.error('serveFile error:', err);
    sendText(res, 500, 'Internal server error');
  }
}

function normalizeTask(raw) {
  const now = Date.now();
  const t = (raw && typeof raw === 'object') ? raw : {};
  return {
    id: (typeof t.id === 'string' && t.id) ? t.id : crypto.randomUUID(),
    name: (typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : 'Untitled task',
    thumbnailUrl: (typeof t.thumbnailUrl === 'string' && t.thumbnailUrl.startsWith('/uploads/')) ? t.thumbnailUrl : null,
    hopper: roundTo(asSafeNumber(t.hopper, 0)),
    streak: Number.isInteger(t.streak) ? t.streak : 0,
    dayKey: (typeof t.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dayKey)) ? t.dayKey : localDateKey(),
    securedToday: typeof t.securedToday === 'boolean' ? t.securedToday : false,
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : now,
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : now,
    lastSecuredAt: Number.isFinite(t.lastSecuredAt) ? t.lastSecuredAt : null,
    lastSecuredReason: (typeof t.lastSecuredReason === 'string') ? t.lastSecuredReason : null,
  };
}

function normalizeState(raw) {
  const now = Date.now();
  const s = (raw && typeof raw === 'object') ? raw : {};
  const tasks = Array.isArray(s.tasks) ? s.tasks.map(normalizeTask) : [];
  const backgroundUrl = (typeof s.backgroundUrl === 'string' && s.backgroundUrl.startsWith('/uploads/')) ? s.backgroundUrl : null;
  return {
    version: 1,
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : now,
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : now,
    backgroundUrl,
    tasks,
  };
}

async function loadStateFromDisk() {
  try {
    const raw = await fsp.readFile(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return normalizeState(null);
    }
    console.error('Failed to load state:', err);
    return normalizeState(null);
  }
}

async function saveStateToDisk(state) {
  const tmp = DATA_PATH + '.tmp';
  const text = JSON.stringify(state, null, 2);
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, DATA_PATH);
}

function queueSave() {
  // serialize saves to avoid interleaving writes
  saveChain = saveChain
    .then(() => saveStateToDisk(STATE))
    .catch((err) => console.error('Save error:', err));
  return saveChain;
}

function trySecureToday(task, reason) {
  if (task.securedToday) return false;
  if (task.hopper >= DAILY_THRESHOLD - EPS) {
    task.securedToday = true;
    task.streak = (Number.isInteger(task.streak) ? task.streak : 0) + 1;
    task.lastSecuredAt = Date.now();
    task.lastSecuredReason = reason;
    return true;
  }
  return false;
}

function processTaskToToday(task, todayKey) {
  let changed = false;

  if (typeof task.dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.dayKey)) {
    task.dayKey = todayKey;
    task.securedToday = false;
    changed = true;
  }

  // If the clock changes backwards, clamp to today to avoid huge loops.
  if (task.dayKey > todayKey) {
    task.dayKey = todayKey;
    task.securedToday = false;
    changed = true;
  }

  const diff = dayDiff(task.dayKey, todayKey);
  if (diff <= 0) {
    // same day, nothing to roll
    return changed;
  }

  for (let i = 0; i < diff; i++) {
    // 1) End-of-day check: if not secured, streak breaks
    if (!task.securedToday && task.streak !== 0) {
      task.streak = 0;
      changed = true;
    } else if (!task.securedToday && task.streak === 0) {
      // still a \"change\" in terms of moving to next day, so keep changed as-is
    }

    // 2) Daily decay (10% deducted)
    // const newHopper = roundTo(task.hopper * DAILY_DECAY_MULTIPLIER);
    const newHopper = task.hopper - 1;
    if (newHopper !== task.hopper) changed = true;
    task.hopper = Math.max(0, newHopper);

    // 3) Move to next day
    task.dayKey = addDaysKey(task.dayKey, 1);
    task.securedToday = false;
    changed = true;

    // 4) Auto-secure new day if hopper already >= 1.0 at rollover
    if (trySecureToday(task, 'rollover')) changed = true;
  }

  return changed;
}

function processAllToToday() {
  const todayKey = localDateKey();
  let changed = false;
  for (const task of STATE.tasks) {
    if (processTaskToToday(task, todayKey)) {
      task.updatedAt = Date.now();
      changed = true;
    }
    // ensure valid numbers
    if (!Number.isFinite(task.hopper) || task.hopper < 0) {
      task.hopper = 0;
      task.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) {
    STATE.updatedAt = Date.now();
  }
  return changed;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readRequestBody(req, MAX_JSON_BYTES);
  const text = body.toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
}

function parsePartHeaders(rawHeaders) {
  const headers = {};
  const lines = rawHeaders.split('\r\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}

// Minimal multipart/form-data parser (loads whole body into memory, capped by MAX_MULTIPART_BYTES)
async function readMultipart(req) {
  const contentType = String(req.headers['content-type'] || '');
  const m = /boundary=(?:(\"[^\"]+\")|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('Missing multipart boundary');
  const boundaryStr = (m[1] ? m[1].slice(1, -1) : m[2]).trim();
  if (!boundaryStr) throw new Error('Invalid multipart boundary');

  const bodyBuf = await readRequestBody(req, MAX_MULTIPART_BYTES);
  const boundary = `--${boundaryStr}`;
  const body = bodyBuf.toString('latin1'); // latin1 keeps byte-for-byte mapping

  const sections = body.split(boundary);

  const fields = {};
  const files = {};

  for (let sec of sections) {
    if (!sec) continue;
    // discard final marker
    if (sec === '--\r\n' || sec === '--') continue;

    // Each part starts with \\r\\n
    if (sec.startsWith('\r\n')) sec = sec.slice(2);

    // Remove trailing \\r\\n
    if (sec.endsWith('\r\n')) sec = sec.slice(0, -2);

    // The final boundary ends with --, which can bleed into last split chunk
    if (sec.endsWith('--')) sec = sec.slice(0, -2);

    const headerEndIdx = sec.indexOf('\r\n\r\n');
    if (headerEndIdx === -1) continue;

    const rawHeaders = sec.slice(0, headerEndIdx);
    const rawContent = sec.slice(headerEndIdx + 4);

    const headers = parsePartHeaders(rawHeaders);
    const disp = headers['content-disposition'] || '';
    const nameMatch = /name=\"([^\"]+)\"/i.exec(disp);
    const fieldName = nameMatch ? nameMatch[1] : null;
    if (!fieldName) continue;

    const filenameMatch = /filename=\"([^\"]*)\"/i.exec(disp);
    const isFile = Boolean(filenameMatch && filenameMatch[1] !== '');

    if (isFile) {
      const originalName = filenameMatch ? filenameMatch[1] : 'upload.bin';
      const mime = headers['content-type'] || 'application/octet-stream';
      const data = Buffer.from(rawContent, 'latin1');
      files[fieldName] = { originalName, mime, data };
    } else {
      fields[fieldName] = rawContent;
    }
  }

  return { fields, files };
}

function matchRoute(pathname, re) {
  const m = re.exec(pathname);
  if (!m) return null;
  return m;
}

function jsonTaskView(task) {
  return {
    id: task.id,
    name: task.name,
    thumbnailUrl: task.thumbnailUrl,
    hopper: task.hopper,
    streak: task.streak,
    dayKey: task.dayKey,
    securedToday: task.securedToday,
    lastSecuredAt: task.lastSecuredAt,
    lastSecuredReason: task.lastSecuredReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function handleApi(req, res, pathname) {
  // Always bring state up-to-date before mutating / reporting
  const rolled = processAllToToday();
  if (rolled) await queueSave();

  // GET /api/state
  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, {
      now: Date.now(),
      today: localDateKey(),
      config: {
        dailyThreshold: DAILY_THRESHOLD,
        dailyDecayMultiplier: DAILY_DECAY_MULTIPLIER,
      },
      backgroundUrl: STATE.backgroundUrl,
      tasks: STATE.tasks.map(jsonTaskView),
    });
    return;
  }

  // POST /api/tasks (multipart: name + thumbnail?)
  if (req.method === 'POST' && pathname === '/api/tasks') {
    let mp;
    try {
      mp = await readMultipart(req);
    } catch (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }

    const name = String(mp.fields.name || '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'Missing field: name' });
      return;
    }

    const id = crypto.randomUUID();
    const todayKey = localDateKey();

    let thumbnailUrl = null;

    const file = mp.files.thumbnail;
    if (file) {
      if (!isLikelyImageMime(file.mime)) {
        sendJson(res, 400, { error: 'Thumbnail must be an image' });
        return;
      }
      const ext = safeExt(file.originalName, file.mime);
      const filename = `thumb-${id}-${Date.now()}${ext}`;
      const outPath = path.join(UPLOAD_DIR, filename);
      await fsp.writeFile(outPath, file.data);
      thumbnailUrl = `/uploads/${filename}`;
    }

    const task = {
      id,
      name,
      thumbnailUrl,
      hopper: 0,
      streak: 0,
      dayKey: todayKey,
      securedToday: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSecuredAt: null,
      lastSecuredReason: null,
    };

    STATE.tasks.push(task);
    STATE.updatedAt = Date.now();
    await queueSave();
    sendJson(res, 201, { task: jsonTaskView(task) });
    return;
  }

  // POST /api/tasks/:id/add  (json: { amount })
  {
    const m = matchRoute(pathname, /^\/api\/tasks\/([^\/]+)\/add$/);
    if (req.method === 'POST' && m) {
      const id = m[1];
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        sendJson(res, 400, { error: String(err.message || err) });
        return;
      }

      const amount = asSafeNumber(body.amount, NaN);
      // if (!Number.isFinite(amount) || amount <= 0) {
      //   sendJson(res, 400, { error: 'amount must be a positive number (e.g. 0.1, 1.0, 5.7)' });
      //   return;
      // }
      if (amount > 1_000_000) {
        sendJson(res, 400, { error: 'amount too large' });
        return;
      }

      const task = STATE.tasks.find((t) => t.id === id);
      if (!task) {
        sendJson(res, 404, { error: 'Task not found' });
        return;
      }

      task.hopper = roundTo(task.hopper + amount);
      task.updatedAt = Date.now();

      const secured = trySecureToday(task, 'add');
      if (secured) task.updatedAt = Date.now();

      STATE.updatedAt = Date.now();
      await queueSave();
      sendJson(res, 200, { task: jsonTaskView(task), secured });
      return;
    }
  }

  // DELETE /api/tasks/:id
  {
    const m = matchRoute(pathname, /^\/api\/tasks\/([^\/]+)$/);
    if (req.method === 'DELETE' && m) {
      const id = m[1];
      const idx = STATE.tasks.findIndex((t) => t.id === id);
      if (idx === -1) {
        sendJson(res, 404, { error: 'Task not found' });
        return;
      }
      const [task] = STATE.tasks.splice(idx, 1);

      // Best-effort delete thumbnail
      await safeUnlink(uploadsFilePathFromUrl(task.thumbnailUrl));

      STATE.updatedAt = Date.now();
      await queueSave();
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // POST /api/background (multipart: background image)
  if (req.method === 'POST' && pathname === '/api/background') {
    let mp;
    try {
      mp = await readMultipart(req);
    } catch (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }

    const file = mp.files.background;
    if (!file) {
      sendJson(res, 400, { error: 'Missing file field: background' });
      return;
    }
    if (!isLikelyImageMime(file.mime)) {
      sendJson(res, 400, { error: 'Background must be an image' });
      return;
    }

    const ext = safeExt(file.originalName, file.mime);
    const filename = `background-${Date.now()}-${crypto.randomUUID()}${ext}`;
    const outPath = path.join(UPLOAD_DIR, filename);
    await fsp.writeFile(outPath, file.data);

    // delete previous background (best effort)
    await safeUnlink(uploadsFilePathFromUrl(STATE.backgroundUrl));
    STATE.backgroundUrl = `/uploads/${filename}`;
    STATE.updatedAt = Date.now();

    await queueSave();
    sendJson(res, 200, { backgroundUrl: STATE.backgroundUrl });
    return;
  }

  // POST /api/background/clear
  if (req.method === 'POST' && pathname === '/api/background/clear') {
    await safeUnlink(uploadsFilePathFromUrl(STATE.backgroundUrl));
    STATE.backgroundUrl = null;
    STATE.updatedAt = Date.now();
    await queueSave();
    sendJson(res, 200, { backgroundUrl: null });
    return;
  }

  sendJson(res, 404, { error: 'Unknown API route' });
}

async function handleRequest(req, res) {
  // Basic CORS for convenience if you ever open index.html directly (optional)
  // (When served from this server, it isn't needed.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let urlObj;
  try {
    urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  const pathname = urlObj.pathname;

  // API
  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  // Static: index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    await serveFile(res, INDEX_HTML_PATH, { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }

  // Static: uploads
  if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
    const base = path.basename(pathname); // prevents directory traversal
    const filePath = path.resolve(UPLOAD_DIR, base);
    const uploadsRoot = path.resolve(UPLOAD_DIR) + path.sep;
    if (!filePath.startsWith(uploadsRoot)) {
      sendText(res, 400, 'Bad path');
      return;
    }
    await serveFile(res, filePath);
    return;
  }

  // Optional: favicon
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  sendText(res, 404, 'Not found');
}

async function ensureDirs() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

async function main() {
  await ensureDirs();
  STATE = await loadStateFromDisk();

  // Normalize / rollover once at start, then save if needed.
  const changed = processAllToToday();
  if (changed) await queueSave();

  // Background day rollover ticker: process shortly after midnight even if no requests hit the server.
  let lastDayKey = localDateKey();
  setInterval(async () => {
    const nowKey = localDateKey();
    if (nowKey !== lastDayKey) {
      lastDayKey = nowKey;
      const didChange = processAllToToday();
      if (didChange) await queueSave();
    }
  }, 30_000);

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('Unhandled error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(PORT, () => {
    console.log(`Streaks: Overload running on http://localhost:${PORT}`);
    console.log(`Data: ${DATA_PATH}`);
    console.log(`Uploads: ${UPLOAD_DIR}`);
  });
}

main().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});
