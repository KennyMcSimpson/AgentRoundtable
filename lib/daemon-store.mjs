// Zero-dependency persistent room registry & daemon metadata store for multi-room daemon mode.
// Lives in <roomsRoot>/.room-daemon-rooms.json and <roomsRoot>/.room-daemon.json so it NEVER
// writes extra files inside any <roomDir> (preserving room-dev's write-log contract).
// Never stores adminToken, lobbyToken or any seat token.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, randomHex, nowIso, pidAlive } from './common.mjs';

export const REGISTRY_FILE = '.room-daemon-rooms.json';
export const DAEMON_META_FILE = '.room-daemon.json';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

function readFileRetry(filePath) {
  let delay = 15;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, missing: true, text: null };
      if (!e || !RETRY_CODES.has(e.code) || attempt === 3) return { ok: false, error: e };
      sleepSync(delay);
      delay *= 2;
    }
  }
  return { ok: false, error: new Error('read retries exhausted') };
}

function atomicReplaceSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomHex(3)}`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    let delay = 10;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (e) {
        if (!e || !RETRY_CODES.has(e.code) || attempt === 5) throw e;
        sleepSync(delay);
        delay = Math.min(delay * 2, 80);
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

function emptyRegistry() {
  return { version: 1, rooms: Object.create(null) };
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_ID = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && !RESERVED_KEYS.has(id);

function sanitizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || !raw.rooms || typeof raw.rooms !== 'object' || Array.isArray(raw.rooms)) {
    return null;
  }
  const rooms = Object.create(null);
  for (const [id, entry] of Object.entries(raw.rooms)) {
    if (!VALID_ID(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.roomDir !== 'string' || !entry.roomDir) continue;
    const rec = {
      roomDir: entry.roomDir,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : nowIso(),
    };
    if (Array.isArray(entry.defaultOrder) && entry.defaultOrder.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]+$/.test(x))) {
      rec.defaultOrder = entry.defaultOrder.slice();
    }
    rooms[id] = rec;
  }
  return { version: 1, rooms };
}

export function createDaemonStore(roomsRoot, { log = () => {} } = {}) {
  const root = path.resolve(roomsRoot);
  const regPath = path.join(root, REGISTRY_FILE);
  const metaPath = path.join(root, DAEMON_META_FILE);
  let state = emptyRegistry();
  let readable = true;
  let dirty = false;
  let writeChain = Promise.resolve();
  let queuedWrite = false;

  function load() {
    const r = readFileRetry(regPath);
    if (!r.ok) {
      // Never overwrite an unreadable registry file.
      readable = false;
      log(`[daemon-store] registry unreadable (${r.error && (r.error.code || r.error.message)}); keeping disk file untouched`);
      return { ok: false, state, error: r.error };
    }
    readable = true;
    if (r.missing) {
      state = emptyRegistry();
      return { ok: true, state, recovered: false };
    }
    let parsed = null;
    try { parsed = sanitizeRegistry(JSON.parse(r.text)); } catch { parsed = null; }
    if (!parsed) {
      const hash = sha256(r.text || '').slice(0, 12);
      const bakPath = `${regPath}.${hash}.bak`;
      try {
        if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, r.text, 'utf8');
      } catch (e) {
        log(`[daemon-store] backup failed: ${e && e.message}`);
      }
      state = emptyRegistry();
      dirty = true;
      log(`[daemon-store] corrupt registry backed up to ${path.basename(bakPath)} and reset`);
      return { ok: true, state, recovered: true, backupPath: bakPath };
    }
    state = parsed;
    return { ok: true, state, recovered: false };
  }

  function snapshotObj() {
    const rooms = Object.create(null);
    for (const id of Object.keys(state.rooms).sort()) {
      const e = state.rooms[id];
      rooms[id] = { roomDir: e.roomDir, ...(e.defaultOrder ? { defaultOrder: e.defaultOrder.slice() } : {}), updatedAt: e.updatedAt };
    }
    return { version: 1, rooms };
  }

  function flushNow() {
    if (!readable || !dirty) return;
    atomicReplaceSync(regPath, `${JSON.stringify(snapshotObj(), null, 2)}\n`);
    dirty = false;
  }

  function scheduleFlush() {
    if (!readable) return writeChain;
    dirty = true;
    if (queuedWrite) return writeChain;
    queuedWrite = true;
    writeChain = writeChain.then(() => {
      queuedWrite = false;
      try { flushNow(); } catch (e) { log(`[daemon-store] registry write failed: ${e && (e.code || e.message)}`); }
    });
    return writeChain;
  }

  function getRoom(id) {
    return VALID_ID(id) && Object.prototype.hasOwnProperty.call(state.rooms, id) ? state.rooms[id] : null;
  }

  function listEntries() {
    return Object.keys(state.rooms).sort().map((id) => ({ id, ...state.rooms[id] }));
  }

  function upsertRoom(id, { roomDir, defaultOrder } = {}) {
    if (!VALID_ID(id)) return Promise.resolve();
    const prev = getRoom(id);
    const next = {
      roomDir: roomDir || (prev && prev.roomDir) || path.join(root, id),
      updatedAt: nowIso(),
    };
    const order = Array.isArray(defaultOrder) ? defaultOrder : (prev && prev.defaultOrder);
    if (Array.isArray(order) && order.length) next.defaultOrder = order.slice();
    state.rooms[id] = next;
    return scheduleFlush();
  }

  function removeRoom(id) {
    if (!VALID_ID(id) || !Object.prototype.hasOwnProperty.call(state.rooms, id)) return Promise.resolve();
    delete state.rooms[id];
    return scheduleFlush();
  }

  function writeMeta({ pid = process.pid, port, mode = 'daemon', startedAt = nowIso() }) {
    const payload = { version: 1, pid, port, mode, startedAt, roomsRoot: root };
    atomicReplaceSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  function clearMeta(expectedPid = process.pid) {
    const r = readFileRetry(metaPath);
    if (!r.ok || r.missing) return;
    try {
      const m = JSON.parse(r.text);
      if (m && m.pid && m.pid !== expectedPid) return;
    } catch { /* remove stale malformed meta */ }
    try { fs.rmSync(metaPath, { force: true }); } catch { /* best effort */ }
  }

  async function drain() {
    await writeChain;
    try { flushNow(); } catch { /* logged above */ }
  }

  return {
    regPath,
    metaPath,
    load,
    getRoom,
    listEntries,
    upsertRoom,
    removeRoom,
    writeMeta,
    clearMeta,
    drain,
  };
}

export function readDaemonStatus(roomsRoot, { isAlive = pidAlive } = {}) {
  const root = path.resolve(roomsRoot);
  const metaPath = path.join(root, DAEMON_META_FILE);
  const r = readFileRetry(metaPath);
  if (!r.ok) {
    return {
      running: false,
      unreadable: true,
      reason: (r.error && (r.error.code || r.error.message)) || 'read_failed',
      metaPath,
      meta: null,
    };
  }
  if (r.missing) return { running: false, metaPath, meta: null };
  let meta = null;
  try { meta = JSON.parse(r.text); } catch { meta = null; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !Number.isInteger(meta.pid) || meta.pid <= 0) {
    return { running: false, metaPath, meta: null, corrupt: true };
  }
  const running = !!isAlive(meta.pid);
  return { running, metaPath, meta };
}
