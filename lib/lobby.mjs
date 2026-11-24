// The lobby (AgentRoundtable Launcher): a loopback page where the user creates rooms and seats, gets
// the one sentence to say to each agent, opens a room's UI and gives it a task, without typing CLI
// commands (plan §1.8: launcher UI to name seats, pick roles, and pick wait modes).
//
//   GET  /, /lobby.js, /lobby.css           ui/lobby.html, ui/lobby.js, ui/lobby.css (fixed list)
//   GET  /lobby/api/meta                    presets, roles, agent kinds, wait modes, rooms root
//   GET  /lobby/api/rooms                   rooms under roomsRoot (no token in the answer)
//   GET  /lobby/api/seat-defaults?id=&seat= suggested seat folder %USERPROFILE%\room-seats\<id>-<seat>
//   POST /lobby/api/folder {token, path}    {exists, isDir} of one absolute path (read-only), so the
//                                           page can untick "Create empty folder for me" for an existing folder
//   POST /lobby/api/create {token, id, preset, seats:[...]}   createRoom + addSeat (lib/api.mjs)
//   POST /lobby/api/open   {token, id}       api.openRoom({roomDir, port: 0}) in this process
//   POST /lobby/api/stop   {token, id}       close that handle
//   POST /lobby/api/task   {token, id, text} handle.admin('task')
//   POST /lobby/api/start  {token, id, order} handle.admin('start')
//
// Same gate as lib/http.mjs: 127.0.0.1 only, Host/Origin/Sec-Fetch-Site checked on every request,
// same security headers, JSON bodies capped at MAX_BODY_BYTES, no query string on a POST. The lobby
// token is random per launch; it travels in the URL fragment of the one printed URL and in POST
// bodies, never in a query string, a header or a log line. GET answers carry no secret: a room UI url
// with its admin token comes back only from POST /lobby/api/open.
//
// Room and seat writes go through lib/api.mjs createRoom / addSeat, i.e. the same functions as
// `room admin init` / `admin add-seat`, with every CLI rule. The only thing the lobby writes itself:
// an empty new seat folder when the user ticked "Create empty folder for me" (createCwd), after the location
// checks below, and the removal of what one failed create request made (its room directory and the
// empty folders it created), so a refused create leaves nothing behind.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHostOrigin, tokenEquals, send, jsonBody, UI_DIR, SECURITY_HEADERS, MAX_SSE_CLIENTS, SSE_HEARTBEAT_MS } from './http.mjs';
import { defaultRoomsRoot, randomHex, readJson, fwd, roomMjsPath, lockHolderAlive, nowIso, ROOM_FILES as F, virtualizationRedirect } from './common.mjs';
import { createRoom, addSeat, openRoom } from './api.mjs';
import { PRESETS, ROLES, WAIT_MODES, HOSTED_TIERS, realOf, insideReal, repoRootOf, locationProblem, winNameProblem } from './admin.mjs';
import { AGENT_KINDS, AGENT_KIND_NAMES, cmdPath, seatCommandPrefix } from './join.mjs';
import { codexHome } from './codex.mjs';
import { spawnClean } from './spawn.mjs';
import { createDaemonStore, readDaemonStatus } from './daemon-store.mjs';
import { SUPPORTED_LANGS, DEFAULT_LANG, normalizeLang } from './i18n.mjs';

export const DEFAULT_LOBBY_PORT = 7380;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SEATS = 12;
const PENDING_NOTE = /^Note \(resolve before starting\): /;
const ROUND_PHASES = new Set(['assign', 'work', 'meet', 'summary', 'reconcile']);

const STATIC = Object.freeze({
  '/': ['lobby.html', 'text/html; charset=utf-8'],
  '/lobby.html': ['lobby.html', 'text/html; charset=utf-8'],
  '/lobby.js': ['lobby.js', 'text/javascript; charset=utf-8'],
  '/lobby.css': ['lobby.css', 'text/css; charset=utf-8'],
  '/rt-i18n.js': ['rt-i18n.js', 'text/javascript; charset=utf-8'],
});

export const PRESET_INFO = Object.freeze({
  'implement-review': 'Implement -> Review: executors build and freeze artifacts; the lead/reviewer meets, marks items, and issues verdicts (Work -> Meet -> Summary).',
  discussion: 'Discussion: meeting and summary only, with no work phase (Meet -> Summary).',
  report: 'Report: artifact-producing seats declare artifacts first, then meet and summarize (Meet -> Summary).',
  'cross-check': 'Cross-check: seats read assigned materials and cross-check findings in a meeting (Meet -> Summary).',
  division: 'Division: lead drafts assignments, you confirm, executors work in parallel, then review in a meeting (Assign -> Work -> Meet -> Summary).',
  simplified: 'Simplified: one external agent plus one built-in Pi seat (select "Built-in Pi", discussion tier by default; configure ROOM_PI_API_KEY or admin pi-key --save before starting).',
});
export const ROLE_INFO = Object.freeze({
  lead: 'Lead (opens, summarizes, reviews)',
  executor: 'Executor (works, freezes artifacts)',
  reviewer: 'Reviewer (issues verdicts)',
  participant: 'Participant (speaks only)',
});
export const WAIT_INFO = Object.freeze({
  background: 'Background wait (recommended for Claude Code)',
  turn_over: 'Turn-over exit (recommended for Codex, uses wake push)',
  manual: 'Manual wake (you notify it)',
});
export const HOSTED_INFO = Object.freeze({
  discussion: 'Discussion only (no tools)',
  exec: 'Exec (reads/writes inside cwd; risky calls require your approval)',
  reviewer: 'Reviewer (inspection tools only)',
});
const CODEX_AGENTS = new Set(['codex-desktop', 'codex-cli']);

// Suggested seat folder: outside AppData, outside any repository the room could sit in.
// Follows ROOM_DEV_HOME when set (unless `home` is passed explicitly), keeping seat folders off C: when ROOM_DEV_HOME is elsewhere.
export function defaultSeatsRoot(env = process.env) {
  return env && env.ROOM_DEV_HOME ? path.join(env.ROOM_DEV_HOME, 'room-seats') : path.join(os.homedir(), 'room-seats');
}

export function suggestedSeatCwd(roomId, seatId, home = undefined) {
  const base = home !== undefined ? path.join(home, 'room-seats') : defaultSeatsRoot();
  return path.join(base, `${roomId}-${seatId}`);
}

// Default Codex thread name for a seat: unique per room, since the wake push finds the thread by
// name in CODEX_HOME/session_index.jsonl (lib/service.mjs resolveCodexThread).
export function defaultWakeThread(roomId, seatId) { return `room-${roomId}-${seatId}`; }

export function joinSentence(joinPath, lang = DEFAULT_LANG) {
  void lang;
  const abs = path.resolve(joinPath);
  return `Read ${abs} and join the room following it.`;
}

// The agent-specific line shown under the sentence on each join card. `prefix` is the seat's command
// prefix (lib/join.mjs seatCommandPrefix): `node <room.mjs>`, or the seat's room.cmd for a seat that
// runs on the desktop app's own runtime.
export function seatHint({ agent, cwd, wakeThread, hosted, prefix = `node ${cmdPath(roomMjsPath())}`, lang = DEFAULT_LANG }) {
  void lang;
  if (hosted) {
    return 'This seat is hosted by the built-in Pi runner; no prompt needs to be sent to an external agent. Prepare ROOM_PI_API_KEY or `admin pi-key --save` before starting the room.';
  }
  const dir = path.resolve(cwd);
  const rule = `Bash(${prefix}:*)`;
  switch (agent) {
    case 'codex-desktop':
      return `Create a new thread in Codex Desktop with project folder ${dir} and sandbox workspace-write; ${wakeThread ? `rename the thread to "${wakeThread}" (unique across threads so wake pushes can locate it in the Codex thread index), ` : 'no wake thread name is registered, so notify it yourself when its turn comes; '}then send it the sentence above.`;
    case 'codex-cli':
      return `Start Codex CLI (workspace-write) in ${dir} and send it the sentence above; when prompted for approval, allow only the ${prefix} command prefix.${wakeThread ? ` Wake thread name: "${wakeThread}".` : ''}`;
    case 'claude-code':
      return `Open a new Claude Code session in ${dir} and send it the sentence above; on the first permission prompt, allow only the rule listed in JOIN.md: ${rule}`;
    case 'antigravity':
      return `Open an idle Antigravity conversation and send it the sentence above; it will run wait in the background per JOIN.md and submit automatically on its turn. Allow only the ${prefix} command prefix when prompted.`;
    default: {
      const label = (AGENT_KINDS[agent] || AGENT_KINDS.generic).label;
      return `Open ${label} in ${dir} and send it the sentence above; when prompted for permission, allow only the ${prefix} command prefix.`;
    }
  }
}

function claudeConfigHome(env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function realAncestor(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; cur = parent; }
  return cur;
}
// The topmost folder on the way to `p` that does not exist yet (`p` itself when its parent exists):
// what a recursive mkdir of `p` creates first, and the highest folder its undo may remove.
function firstMissing(p) {
  let cur = path.resolve(p);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur || fs.existsSync(parent)) return cur;
    cur = parent;
  }
}
// Path equality as Windows sees it: without a \\?\ (or \\?\UNC\) prefix, case-insensitive on win32.
function plainPath(p) {
  const s = String(p || '');
  if (/^\\\\\?\\UNC\\/i.test(s)) return `\\\\${s.slice(8)}`;
  return s.replace(/^\\\\\?\\/, '');
}
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const x = path.resolve(plainPath(a));
  const y = path.resolve(plainPath(b));
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// English refusal when the lobby must not create `cwd` for a seat of the room at `roomDir`, else
// null. Checked before anything is created; add-seat then applies the full CLI rules on top.
export function seatFolderProblem(cwd, { roomDir, roomsRoot, env = process.env, redirect = virtualizationRedirect, home = os.homedir(), platform = process.platform } = {}) {
  if (!path.isAbsolute(cwd)) return `Working folder ${cwd} must be an absolute path (e.g. ${fwd(suggestedSeatCwd('demo', 'A'))}).`;
  // Before the AppData check: `AppData.` or `AppData ` passes a literal comparison, but a Windows
  // program opening the path lands in AppData.
  const badName = winNameProblem(cwd, { platform });
  if (badName) return badName;
  const appData = [env.LOCALAPPDATA, env.APPDATA, path.join(home, 'AppData')].filter(Boolean);
  for (const a of appData) {
    if (insideReal(cwd, a)) return `Working folder ${fwd(cwd)} is under AppData (${fwd(a)}): processes launched from MSIX packaged apps have AppData writes redirected, so other agents cannot see them. Choose a folder under your user profile (e.g. ${fwd(path.join(home, 'room-seats'))}).`;
  }
  const early = locationProblem(realAncestor(cwd), { redirect, what: 'parent directory of the working folder' });
  if (early) return early;
  for (const [label, dir] of [['CODEX_HOME', codexHome(env)], ['CLAUDE_CONFIG_DIR', claudeConfigHome(env)]]) {
    if (insideReal(cwd, dir) || insideReal(dir, cwd)) return `Working folder must not be inside or contain ${label} (${fwd(dir)}): that is the agent's own shared state.`;
  }
  for (const d of [roomsRoot, roomDir].filter(Boolean)) {
    if (insideReal(cwd, d) || insideReal(d, cwd)) return `Working folder ${fwd(cwd)} and room directory ${fwd(d)} must not contain each other.`;
  }
  const repo = repoRootOf(cwd);
  if (repo && roomDir && insideReal(roomDir, repo)) return `Git repository ${fwd(repo)} of working folder ${fwd(cwd)} contains the room directory; a room cannot sit inside any repository.`;
  return null;
}

function refusal(status, error, message) { return { status, body: { ok: false, error, message } }; }
class LobbyRefusal extends Error {
  constructor(error, message, status = 400) { super(message); this.error = error; this.status = status; }
}

// Opens `url` in the default browser. Windows: rundll32 url.dll,FileProtocolHandler keeps the
// fragment (cmd's start and explorer.exe can drop it). Through lib/spawn.mjs like every child.
export async function openInBrowser(url, { spawn = spawnClean, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    return spawn(path.join(sysRoot, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { timeoutMs: 15_000, maxOutputBytes: 4096 });
  }
  return spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeoutMs: 15_000, maxOutputBytes: 4096 });
}

// Port number of a loopback url such as http://127.0.0.1:51234/, or null.
export function portOfUrl(url) {
  try { const u = new URL(url); const p = Number(u.port); return Number.isInteger(p) && p > 0 ? p : null; } catch { return null; }
}

// startLobby({port, roomsRoot, log, openBrowser, parentPort, exit}) -> Promise<{url, port, token, close()}>
//
// Inside the desktop app the lobby runs in an Electron utilityProcess (app/main.mjs), where
// process.parentPort exists. Then the lobby (a) tells the app about every room UI it opens or stops,
// {t: 'room-opened' | 'room-closed', id, port} (no token), so the app opens only those ports as room
// windows; (b) on {t: 'quit'} closes every room it opened (removing their service.lock) and exits 0.
// `parentPort` and `exit` are injectable for tests; the CLI (no parentPort) behaves as before.
export async function startLobby({ port = DEFAULT_LOBBY_PORT, roomsRoot = defaultRoomsRoot(), log = () => {}, openBrowser = false, env = process.env, redirect = virtualizationRedirect, uiDir = UI_DIR, parentPort = process.parentPort, exit = (code) => process.exit(code), mode = 'lobby', resume = false, persistRegistry = false, defaultLang = DEFAULT_LANG, maxSseClients = MAX_SSE_CLIENTS } = {}) {
  const root = path.resolve(roomsRoot);
  const token = randomHex(24);
  const handles = new Map(); // roomId -> openRoom handle
  const roomUnsubs = new Map(); // roomId -> unsubscribe fn
  const startChains = new Map(); // roomId -> Promise
  const sseClients = new Set(); // res objects subscribed to /lobby/api/stream
  const resumed = [];
  const startedAt = nowIso();
  const startedMs = Date.now();
  const normDefaultLang = normalizeLang(defaultLang) || DEFAULT_LANG;
  const store = (persistRegistry || resume || mode === 'daemon') ? createDaemonStore(root, { log }) : null;
  if (store) store.load();
  let boundPort = 0;
  let closing = false;
  let ownsMeta = false;
  let broadcastTimer = null;
  let sseHeartbeat = null;
  const parent = parentPort && typeof parentPort.on === 'function' ? parentPort : null;
  const notify = (msg) => {
    if (!parent || typeof parent.postMessage !== 'function') return;
    try { parent.postMessage(msg); } catch (e) { log(`[lobby] could not notify the app: ${e && e.message}`); }
  };
  // Every mutating request runs one at a time: two creates of the same id, or an open racing a stop,
  // never interleave.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const serialRoomStart = (id, fn) => {
    const prev = startChains.get(id) || Promise.resolve();
    const p = prev.then(fn, fn);
    const settled = p.catch(() => {});
    startChains.set(id, settled);
    settled.finally(() => { if (startChains.get(id) === settled) startChains.delete(id); });
    return p;
  };

  const roomDirOf = (id) => path.join(root, id);
  const roomUrl = (h) => (h && h.url ? h.url : null);
  const daemonInfo = () => ({
    mode,
    pid: process.pid,
    port: boundPort,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedMs),
    openRooms: handles.size,
    resumedRooms: resumed.slice(),
    sseClients: sseClients.size,
  });

  function writeSse(res, eventName, data) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch { return false; }
  }

  function broadcastRoomsNow() {
    if (closing || !sseClients.size) return;
    const payload = { roomsRoot: root, mode, daemon: daemonInfo(), rooms: listRooms() };
    for (const res of [...sseClients]) {
      if (!writeSse(res, 'rooms', payload)) sseClients.delete(res);
    }
  }

  function scheduleRoomsBroadcast() {
    if (closing || !sseClients.size || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastRoomsNow();
    }, 250);
    if (broadcastTimer.unref) broadcastTimer.unref();
  }

  function attachHandle(id, h) {
    handles.set(id, h);
    if (h && h.service && typeof h.service.subscribe === 'function') {
      const unsub = h.service.subscribe(() => scheduleRoomsBroadcast());
      roomUnsubs.set(id, unsub);
    }
  }

  function detachHandle(id) {
    handles.delete(id);
    const unsub = roomUnsubs.get(id);
    if (unsub) {
      roomUnsubs.delete(id);
      try { unsub(); } catch { /* ignore */ }
    }
  }

  const prefixOf = (roomDir, s) => seatCommandPrefix({ seat: s, seatDir: path.join(roomDir, F.seats, s.seatId), roomMjs: roomMjsPath() });
  function seatView(roomDir, s, lang = DEFAULT_LANG) {
    const joinPath = path.join(roomDir, F.seats, s.seatId, 'JOIN.md');
    return {
      seatId: s.seatId, role: s.role, agent: s.agent, cwd: s.cwd, waitMode: s.waitMode,
      wakeThread: s.wake && s.wake.enabled ? s.wake.thread : null,
      hosted: s.hosted ? (s.hosted.kind === 'lane' ? `lane:${s.hosted.lane}:${s.hosted.tier}` : `pi:${s.hosted.tier}`) : null,
      joinPath,
      sentence: s.hosted ? null : joinSentence(joinPath, lang),
      hint: seatHint({ agent: s.agent, cwd: s.cwd, wakeThread: s.wake && s.wake.enabled ? s.wake.thread : null, hosted: !!s.hosted, prefix: prefixOf(roomDir, s), lang }),
    };
  }

  function candidateRoomIds() {
    const ids = new Set();
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && ID_RE.test(e.name)) ids.add(e.name);
      }
    } catch { /* roomsRoot may not exist yet */ }
    if (store) {
      for (const entry of store.listEntries()) {
        if (ID_RE.test(entry.id) && samePath(entry.roomDir, roomDirOf(entry.id))) ids.add(entry.id);
      }
    }
    return [...ids];
  }

  function listRooms() {
    const names = candidateRoomIds();
    const rooms = [];
    for (const id of names) {
      const roomDir = roomDirOf(id);
      const room = readJson(path.join(roomDir, F.room), null);
      if (!room || typeof room !== 'object') continue;
      const roomLang = normalizeLang(room.lang) || DEFAULT_LANG;
      const h = handles.get(id);
      let st = null;
      if (h) { try { st = h.view(); } catch { st = null; } }
      if (!st) st = readJson(path.join(roomDir, F.state), null);
      const lock = readJson(path.join(roomDir, F.lock), null);
      const reg = store ? store.getRoom(id) : null;
      // `id` is the directory name: open / stop / task / start and `handles` all resolve rooms by it.
      // room.json's own id (admin init --dir <root>\foo --id bar is allowed) is shown, not used.
      rooms.push({
        id,
        roomId: typeof room.id === 'string' ? room.id : null,
        idMismatch: typeof room.id === 'string' && room.id !== id,
        createdAt: room.createdAt || null,
        preset: room.preset || null,
        lang: roomLang,
        phase: st && st.phase ? st.phase : 'idle',
        roundId: st && Number.isInteger(st.roundId) ? st.roundId : 0,
        closed: !!(st && st.closed),
        currentSeat: st && st.currentSeat ? st.currentSeat : null,
        task: st && st.task && typeof st.task.text === 'string' ? st.task.text : null,
        defaultOrder: reg && Array.isArray(reg.defaultOrder) ? reg.defaultOrder.slice() : null,
        seats: (Array.isArray(room.seats) ? room.seats : []).map((s) => seatView(roomDir, s, roomLang)),
        serviceRunning: lockHolderAlive(lock),
        openedHere: !!h,
        url: h ? roomUrl(h) : null,
      });
    }
    rooms.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return rooms;
  }

  // ---- create: validate everything first, then createRoom + addSeat; undo on any failure.
  function parseSeats(seats, roomId) {
    if (!Array.isArray(seats) || !seats.length) throw new LobbyRefusal('NO_SEATS', 'At least one seat is required.');
    if (seats.length > MAX_SEATS) throw new LobbyRefusal('TOO_MANY_SEATS', `A room can have at most ${MAX_SEATS} seats.`);
    const seen = new Set();
    return seats.map((raw, i) => {
      const s = raw && typeof raw === 'object' ? raw : {};
      const seatId = typeof s.seatId === 'string' ? s.seatId.trim() : '';
      if (!ID_RE.test(seatId)) throw new LobbyRefusal('BAD_SEAT_ID', `Seat #${i + 1} id "${seatId}" is invalid: use letters, digits, - and _ only.`);
      if (seen.has(seatId.toLowerCase())) throw new LobbyRefusal('SEAT_ID_DUPLICATE', `Duplicate seat id: ${seatId}.`);
      seen.add(seatId.toLowerCase());
      const role = typeof s.role === 'string' ? s.role : 'participant';
      if (!ROLES.includes(role)) throw new LobbyRefusal('BAD_ROLE', `Unknown role "${role}" for seat ${seatId}; allowed: ${ROLES.join(', ')}.`);
      const hosted = typeof s.hosted === 'string' && s.hosted.trim() ? s.hosted.trim() : null;
      const agent = typeof s.agent === 'string' && s.agent ? s.agent : 'generic';
      if (!hosted && !AGENT_KIND_NAMES.includes(agent)) throw new LobbyRefusal('BAD_AGENT', `Unknown agent "${agent}" for seat ${seatId}; allowed: ${AGENT_KIND_NAMES.join(', ')}.`);
      const wait = typeof s.wait === 'string' && s.wait ? s.wait : null;
      if (wait && !WAIT_MODES.includes(wait)) throw new LobbyRefusal('BAD_WAIT', `Unknown wait mode "${wait}" for seat ${seatId}; allowed: ${WAIT_MODES.join(', ')}.`);
      const cwdRaw = typeof s.cwd === 'string' ? s.cwd.trim() : '';
      if (!cwdRaw) throw new LobbyRefusal('NO_CWD', `Seat ${seatId} is missing a working folder.`);
      if (!path.isAbsolute(cwdRaw)) throw new LobbyRefusal('CWD_NOT_ABSOLUTE', `Seat ${seatId}'s working folder must be an absolute path: ${cwdRaw}`);
      const cwd = path.resolve(cwdRaw);
      const badName = winNameProblem(cwd);
      if (badName) throw new LobbyRefusal('CWD_BAD_NAME', `Invalid working folder for seat ${seatId}: ${badName}`);
      const createCwd = s.createCwd === true;
      let wakeThread = null;
      if (!hosted && CODEX_AGENTS.has(agent)) {
        // The default name carries the room id: every lobby room has a seat A, and the wake push
        // resolves the name through Codex's thread index, where it has to be unique.
        if (s.wakeThread === undefined || s.wakeThread === null) wakeThread = defaultWakeThread(roomId, seatId);
        else if (typeof s.wakeThread === 'string') wakeThread = s.wakeThread.trim() || null;
        if (wakeThread && (wakeThread.length > 128 || /[\x00-\x1f"]/.test(wakeThread))) throw new LobbyRefusal('BAD_WAKE_THREAD', `Invalid Codex wake thread name for seat ${seatId} (max 128 chars, no quotes or control characters).`);
      }
      return { seatId, role, agent, hosted, wait, cwd, createCwd, wakeThread };
    });
  }

  async function create(body) {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!ID_RE.test(id)) throw new LobbyRefusal('BAD_ID', `Invalid room id "${id}": use letters, digits, - and _ only.`);
    const preset = typeof body.preset === 'string' && body.preset ? body.preset : null;
    if (preset && !PRESETS.includes(preset)) throw new LobbyRefusal('BAD_PRESET', `Unknown preset "${preset}"; allowed: ${PRESETS.join(', ')}.`);
    let lang = null;
    if (body.lang !== undefined && body.lang !== null && body.lang !== '') {
      if (typeof body.lang !== 'string' || !SUPPORTED_LANGS.includes(body.lang.trim())) {
        throw new LobbyRefusal('BAD_LANG', `Unsupported language "${body.lang}"; allowed: ${SUPPORTED_LANGS.join(', ')}.`);
      }
      lang = body.lang.trim();
    } else if (normDefaultLang !== DEFAULT_LANG) {
      lang = normDefaultLang;
    }
    const effectiveLang = normalizeLang(lang || DEFAULT_LANG);
    const seats = parseSeats(body.seats, id);
    const roomDir = roomDirOf(id);
    if (fs.existsSync(roomDir)) throw new LobbyRefusal('ROOM_EXISTS', `Room ${id} already exists (${fwd(roomDir)}). Pick another id or open it from the room list.`, 409);
    const cwdKeys = new Map();
    for (const s of seats) {
      if (s.createCwd) {
        if (fs.existsSync(s.cwd)) throw new LobbyRefusal('CWD_EXISTS', `Seat ${s.seatId}'s working folder ${fwd(s.cwd)} already exists; the launcher only creates non-existent empty folders. Uncheck "Create empty folder for me" to use it as-is.`);
        const key = realOf(s.cwd).toLowerCase();
        if (cwdKeys.has(key)) throw new LobbyRefusal('CWD_DUPLICATE', `Seats ${cwdKeys.get(key)} and ${s.seatId} both request creating the same folder ${fwd(s.cwd)}.`);
        cwdKeys.set(key, s.seatId);
        const problem = seatFolderProblem(s.cwd, { roomDir, roomsRoot: root, env, redirect });
        if (problem) throw new LobbyRefusal('CWD_LOCATION', `Seat ${s.seatId}: ${problem}`);
      } else if (!fs.existsSync(s.cwd)) {
        throw new LobbyRefusal('CWD_MISSING', `Seat ${s.seatId}'s working folder ${fwd(s.cwd)} does not exist. Create it first or check "Create empty folder for me".`);
      } else if (!fs.statSync(s.cwd).isDirectory()) {
        throw new LobbyRefusal('CWD_NOT_DIR', `Seat ${s.seatId}'s working folder ${fwd(s.cwd)} is not a directory.`);
      }
    }

    const made = []; // {leaf, first}: folders this request may have created, removed again on failure
    let roomMade = false;
    const undo = () => {
      if (roomMade) { try { fs.rmSync(roomDir, { recursive: true, force: true }); } catch (e) { log(`[lobby] could not remove ${fwd(roomDir)}: ${e.code || e.message}`); } }
      for (const m of made.reverse()) {
        // Only empty folders, from the leaf up to and including `first` (the topmost folder that did
        // not exist before this request), never above it. A folder a failed mkdir never made (ENOENT)
        // is stepped over, so the parents it did make are still removed.
        let cur = path.resolve(m.leaf);
        for (;;) {
          try { fs.rmdirSync(cur); } catch (e) { if (!e || e.code !== 'ENOENT') break; }
          if (samePath(cur, m.first)) break;
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
    };
    const out = [];
    let pending = [];
    try {
      roomMade = true; // the directory did not exist a moment ago; whatever is there now is ours
      const init = await createRoom({ dir: roomDir, id, ...(preset ? { preset } : {}), ...(lang ? { lang } : {}) });
      if (init.code !== 0) throw new LobbyRefusal('INIT_REFUSED', `Room initialization refused: ${init.error || init.lines.join(' ')}`);
      for (const s of seats) {
        if (s.createCwd) {
          // Recorded before mkdir, from plain existence checks: mkdirSync's own return value carries
          // a \\?\ prefix on Windows and is missing when mkdir throws halfway.
          made.push({ leaf: s.cwd, first: firstMissing(s.cwd) });
          try { fs.mkdirSync(s.cwd, { recursive: true }); } catch (e) {
            throw new LobbyRefusal('CWD_CREATE_FAILED', `Could not create working folder ${fwd(s.cwd)} for seat ${s.seatId} (${e && (e.code || e.message)}). Pick another location or create it manually and uncheck "Create empty folder for me".`);
          }
          const after = locationProblem(s.cwd, { redirect, what: 'newly created working folder' });
          if (after) throw new LobbyRefusal('CWD_LOCATION', `Seat ${s.seatId}: ${after}`);
        }
        // Claude Code seats register the transcript baseline the auditor needs (read-only). A codex
        // audit needs the thread uuid, which nobody knows yet; `admin set-audit` adds it later.
        const audit = !s.hosted && s.agent === 'claude-code' ? 'claude' : null;
        const r = await addSeat({
          dir: roomDir, seat: s.seatId, role: s.role, cwd: s.cwd,
          ...(s.hosted ? { hosted: s.hosted } : { agent: s.agent }),
          ...(s.wait ? { wait: s.wait } : {}),
          ...(s.wakeThread ? { 'wake-thread': s.wakeThread } : {}),
          ...(audit ? { audit } : {}),
        });
        if (r.code !== 0 || !r.joinPath) throw new LobbyRefusal('SEAT_REFUSED', `Seat ${s.seatId} could not be created: ${r.error || r.lines.join(' ')}`);
        // add-seat's "Note (resolve before starting):" lines describe the room so far; only the last seat's are final.
        const notes = r.lines.filter((l) => /^Note: /.test(l) && !PENDING_NOTE.test(l));
        pending = r.lines.filter((l) => PENDING_NOTE.test(l)).map((l) => l.replace(PENDING_NOTE, ''));
        // The seat record says whether it runs on node or on the app's runtime (lib/join.mjs).
        const rec = readJson(path.join(path.dirname(r.joinPath), 'seat.json'), {}) || {};
        out.push({ ...s, joinPath: r.joinPath, sentence: s.hosted ? null : joinSentence(r.joinPath, effectiveLang), hint: seatHint({ ...s, hosted: !!s.hosted, prefix: prefixOf(roomDir, { ...rec, seatId: s.seatId }), lang: effectiveLang }), notes, createdCwd: s.createCwd });
      }
    } catch (e) {
      undo();
      throw e;
    }
    if (store) await store.upsertRoom(id, { roomDir });
    scheduleRoomsBroadcast();
    log(`[lobby] room ${id} created with ${out.length} seat(s) at ${fwd(roomDir)}`);
    return { ok: true, id, roomDir, preset, lang: effectiveLang, roomNotes: pending, seats: out.map(({ seatId, role, agent, hosted, cwd, wakeThread, joinPath, sentence, hint, notes, createdCwd }) => ({ seatId, role, agent, hosted, cwd, wakeThread, joinPath, sentence, hint, notes, createdCwd })) };
  }

  function knownRoom(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new LobbyRefusal('BAD_ID', 'Invalid room id.');
    const roomDir = roomDirOf(id);
    if (!fs.existsSync(path.join(roomDir, F.room))) throw new LobbyRefusal('NO_ROOM', `Room ${id} not found (${fwd(roomDir)}).`, 404);
    return roomDir;
  }
  function openHandle(id) {
    const h = handles.get(id);
    if (!h) throw new LobbyRefusal('NOT_OPEN', `Room ${id} is not opened by this launcher; click "Open Room UI" first.`, 409);
    return h;
  }

  async function open(body) {
    const id = body.id;
    const roomDir = knownRoom(id);
    const existing = handles.get(id);
    if (existing) return { ok: true, id, url: `${roomUrl(existing)}#${existing.adminToken}`, already: true };
    const lock = readJson(path.join(roomDir, F.lock), null);
    let lockProbe;
    if (lockHolderAlive(lock)) {
      if (lock.pid === process.pid) throw new LobbyRefusal('SERVICE_RUNNING', `Room ${id}'s service is already running elsewhere in this process; refusing to open a second instance.`, 409);
      const { probeLockHolder } = await import('./service.mjs');
      lockProbe = await probeLockHolder(lock);
      if (lockProbe !== 'stale') throw new LobbyRefusal('SERVICE_RUNNING', `Room ${id}'s service is already running elsewhere (pid ${lock.pid}). Use that window or stop it before opening here.`, 409);
    }
    let h;
    try {
      h = await openRoom({ roomDir, port: 0, log: (l) => log(`[room ${id}] ${l}`), ...(lockProbe ? { lockProbe } : {}) });
    } catch (e) {
      if (e && e.code === 'SERVICE_RUNNING') throw new LobbyRefusal('SERVICE_RUNNING', e.message, 409);
      throw new LobbyRefusal('OPEN_FAILED', `Failed to open room ${id}: ${e && e.message ? e.message : e}`, 500);
    }
    if (closing) { await h.close(); throw new LobbyRefusal('CLOSING', 'Launcher is shutting down.', 503); }
    attachHandle(id, h);
    if (store) await store.upsertRoom(id, { roomDir });
    scheduleRoomsBroadcast();
    log(`[lobby] room ${id} opened; UI on ${h.url}`);
    notify({ t: 'room-opened', id, port: portOfUrl(h.url) });
    return { ok: true, id, url: `${h.url}#${h.adminToken}` };
  }

  async function stop(body) {
    const id = body.id;
    knownRoom(id);
    const h = openHandle(id);
    detachHandle(id);
    await h.close();
    scheduleRoomsBroadcast();
    log(`[lobby] room ${id} stopped`);
    notify({ t: 'room-closed', id, port: portOfUrl(h.url) });
    return { ok: true, id };
  }

  function adminResult(r, what) {
    if (r && r.ok === false) throw new LobbyRefusal(r.error || 'REFUSED', `${what} was refused by the room: ${r.message || r.error}`, 409);
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  }
  async function task(body) {
    const id = body.id;
    knownRoom(id);
    const h = openHandle(id);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new LobbyRefusal('NO_TEXT', 'Task text cannot be empty.');
    const st = h.view();
    if (st && st.closed) throw new LobbyRefusal('ROOM_CLOSED', 'Task was refused by the room: room is closed.', 409);
    if (st && ROUND_PHASES.has(st.phase)) throw new LobbyRefusal('ROUND_IN_PROGRESS', 'Task was refused by the room: a round is already in progress; current task was not overwritten.', 409);
    const r = adminResult(await h.admin('task', { text }), 'Task');
    scheduleRoomsBroadcast();
    return { id, ...r };
  }
  async function start(body) {
    const id = body.id;
    knownRoom(id);
    return serialRoomStart(id, async () => {
      const h = openHandle(id);
      const seatIds = (h.service.room.seats || []).map((s) => s.seatId);
      const known = new Set(seatIds);
      let order;
      if (body.order !== undefined && body.order !== null) {
        if (!Array.isArray(body.order) || body.order.some((x) => typeof x !== 'string' || !ID_RE.test(x))) throw new LobbyRefusal('BAD_ORDER', 'Turn order must be a list of seat ids.');
        const unknown = body.order.filter((x) => !known.has(x));
        if (unknown.length) throw new LobbyRefusal('BAD_ORDER', `Turn order contains unknown seat(s): ${unknown.join(', ')}.`);
        order = body.order.slice();
      } else if (store) {
        const reg = store.getRoom(id);
        if (reg && Array.isArray(reg.defaultOrder) && reg.defaultOrder.length && reg.defaultOrder.every((x) => known.has(x))) {
          order = reg.defaultOrder.slice();
        }
      }
      if (body.task !== undefined && body.task !== null) {
        const taskText = typeof body.task === 'string' ? body.task.trim() : '';
        if (!taskText) throw new LobbyRefusal('NO_TEXT', 'Task text cannot be empty.');
        const st = h.view();
        if (st && st.closed) throw new LobbyRefusal('ROOM_CLOSED', 'Start was refused by the room: room is closed.', 409);
        if (st && ROUND_PHASES.has(st.phase)) throw new LobbyRefusal('ROUND_IN_PROGRESS', 'Start was refused by the room: a round is already in progress; current task was not overwritten.', 409);
        if (st && Array.isArray(st.needsReconcile) && st.needsReconcile.length) throw new LobbyRefusal('NEEDS_RECONCILE', 'Start was refused by the room: room has pending reconcile attempt(s); current task was not overwritten.', 409);
        if (st && st.awaitingDecision && st.awaitingDecision.seatId) throw new LobbyRefusal('AWAITING_DECISION', 'Start was refused by the room: room is awaiting user decision on an expired turn; current task was not overwritten.', 409);
        adminResult(await h.admin('task', { text: taskText }), 'Task');
      }
      const res = adminResult(await h.admin('start', order && order.length ? { order } : {}), 'Start');
      if (store) {
        const savedOrder = order && order.length ? order : seatIds;
        await store.upsertRoom(id, { roomDir: roomDirOf(id), ...(savedOrder.length ? { defaultOrder: savedOrder } : {}) });
      }
      scheduleRoomsBroadcast();
      return { id, ...res };
    });
  }

  async function folder(body) {
    const raw = typeof body.path === 'string' ? body.path : '';
    if (!raw || raw.length > 1024 || !path.isAbsolute(raw)) {
      throw new LobbyRefusal('BAD_ARGS', 'Only absolute paths are accepted.', 400);
    }
    let st = null;
    try { st = fs.statSync(path.resolve(raw)); } catch { st = null; }
    return { ok: true, exists: !!st, isDir: !!(st && st.isDirectory()) };
  }

  const POSTS = { create, open, stop, task, start, folder };

  function meta() {
    return {
      ok: true,
      mode,
      roomsRoot: root,
      seatsRoot: defaultSeatsRoot(),
      defaultLang: normDefaultLang,
      langs: SUPPORTED_LANGS.map((id) => ({ id, label: 'English' })),
      daemon: daemonInfo(),
      presets: PRESETS.map((id) => ({ id, desc: PRESET_INFO[id] || '' })),
      roles: ROLES.map((id) => ({ id, label: ROLE_INFO[id] || id })),
      agents: AGENT_KIND_NAMES.map((id) => ({ id, label: AGENT_KINDS[id].label, wait: AGENT_KINDS[id].wait })),
      waitModes: WAIT_MODES.map((id) => ({ id, label: WAIT_INFO[id] || id })),
      // Built-in Pi seat tiers; the page sends hosted: 'pi:<tier>' for a seat run by the room itself.
      hostedTiers: HOSTED_TIERS.map((id) => ({ id, label: HOSTED_INFO[id] || id })),
    };
  }

  async function resumeLiveRooms() {
    const ids = candidateRoomIds();
    for (const id of ids) {
      if (closing || handles.has(id)) continue;
      const roomDir = roomDirOf(id);
      const room = readJson(path.join(roomDir, F.room), null);
      if (!room || typeof room !== 'object') continue;
      const st = readJson(path.join(roomDir, F.state), null);
      if (!st || st.closed || !ROUND_PHASES.has(st.phase)) continue;
      const lock = readJson(path.join(roomDir, F.lock), null);
      let lockProbe;
      if (lockHolderAlive(lock)) {
        if (lock.pid === process.pid) continue;
        try {
          const { probeLockHolder } = await import('./service.mjs');
          lockProbe = await probeLockHolder(lock);
          if (lockProbe !== 'stale') {
            log(`[lobby] resume skipped ${id}: service already running (pid ${lock.pid})`);
            continue;
          }
        } catch (e) {
          log(`[lobby] resume probe failed for ${id}: ${e && e.message}`);
          continue;
        }
      }
      try {
        const h = await openRoom({ roomDir, port: 0, log: (l) => log(`[room ${id}] ${l}`), ...(lockProbe ? { lockProbe } : {}) });
        if (closing) { await h.close(); break; }
        attachHandle(id, h);
        resumed.push(id);
        if (store) await store.upsertRoom(id, { roomDir });
        notify({ t: 'room-opened', id, port: portOfUrl(h.url) });
        log(`[lobby] resumed live room ${id} (${st.phase}) on ${h.url}`);
      } catch (e) {
        log(`[lobby] resume failed for ${id}: ${e && e.message}`);
      }
    }
    if (resumed.length) scheduleRoomsBroadcast();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const gate = checkHostOrigin(req.headers, boundPort);
      if (!gate.ok) { send(res, gate.status, { ok: false, error: gate.error }); return; }
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${boundPort}`); } catch { send(res, 400, { ok: false, error: 'BAD_URL' }); return; }
      const p = url.pathname;

      if (p.startsWith('/lobby/api/')) {
        const name = p.slice('/lobby/api/'.length);
        if (name === 'stream') {
          if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
          if (url.search) { send(res, 400, { ok: false, error: 'BAD_QUERY' }); return; }
          if (closing) { send(res, 503, { ok: false, error: 'CLOSING' }); return; }
          if (sseClients.size >= maxSseClients) { send(res, 503, { ok: false, error: 'TOO_MANY_CLIENTS' }); return; }
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          sseClients.add(res);
          const drop = () => sseClients.delete(res);
          req.on('close', drop);
          res.on('close', drop);
          res.on('error', drop);
          writeSse(res, 'rooms', { roomsRoot: root, mode, daemon: daemonInfo(), rooms: listRooms() });
          return;
        }
        if (name === 'health') {
          if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
          send(res, 200, { ok: true, roomsRoot: root, ...daemonInfo() });
          return;
        }
        if (name === 'rooms' || name === 'meta' || name === 'seat-defaults') {
          if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
          if (name === 'rooms') { send(res, 200, { ok: true, roomsRoot: root, mode, daemon: daemonInfo(), rooms: listRooms() }); return; }
          if (name === 'meta') { send(res, 200, meta()); return; }
          const id = url.searchParams.get('id') || '';
          const seat = url.searchParams.get('seat') || '';
          if (!ID_RE.test(id) || !ID_RE.test(seat)) { send(res, 400, { ok: false, error: 'BAD_ARGS', message: 'Room id and seat id may contain letters, digits, - and _ only.' }); return; }
          const cwd = suggestedSeatCwd(id, seat);
          send(res, 200, { ok: true, cwd, exists: fs.existsSync(cwd) });
          return;
        }
        const fn = Object.prototype.hasOwnProperty.call(POSTS, name) ? POSTS[name] : null;
        if (!fn) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
        const body = await jsonBody(req, res, url);
        if (!body) return;
        if (!tokenEquals(body.token, token)) {
          log(`[lobby] ${name} refused: bad or missing lobby token`);
          send(res, 401, { ok: false, error: 'BAD_TOKEN', message: 'Lobby token is missing or invalid: reopen this page from the link printed by the launcher.' });
          return;
        }
        if (closing) { send(res, 503, { ok: false, error: 'CLOSING', message: 'Launcher is shutting down.' }); return; }
        const { token: _drop, ...rest } = body;
        try {
          const r = await serial(() => fn(rest));
          send(res, 200, r);
        } catch (e) {
          if (e instanceof LobbyRefusal) { const x = refusal(e.status, e.error, e.message); send(res, x.status, x.body); return; }
          throw e;
        }
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      const f = Object.prototype.hasOwnProperty.call(STATIC, p) ? STATIC[p] : null;
      if (!f) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
      send(res, 200, fs.readFileSync(path.join(uiDir, f[0])), f[1]);
    } catch (e) {
      log(`[lobby] ${req.method} ${String(req.url || '').split('?')[0]}: ${e && e.message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'INTERNAL', message: `Internal launcher error: ${e && e.message}` });
    }
  });

  const listen = (p) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  // Resume active rooms before accepting HTTP traffic so POST /lobby/api/open can never race resumeLiveRooms().
  if (resume) {
    await resumeLiveRooms();
  }
  const wanted = Number(port);
  try {
    await listen(Number.isInteger(wanted) && wanted >= 0 ? wanted : DEFAULT_LOBBY_PORT);
  } catch (e) {
    if (!e || (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') || wanted === 0) {
      for (const [id, h] of [...handles]) { detachHandle(id); try { await h.close(); } catch { /* ignore */ } }
      throw e;
    }
    log(`[lobby] port ${wanted} is busy (${e.code}); using a free port instead`);
    await listen(0);
  }
  boundPort = server.address().port;
  sseHeartbeat = setInterval(() => {
    if (closing || !sseClients.size) return;
    for (const res of [...sseClients]) {
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
    }
  }, SSE_HEARTBEAT_MS);
  if (sseHeartbeat.unref) sseHeartbeat.unref();
  if (mode === 'daemon' && store) {
    try {
      const existing = readDaemonStatus(root);
      if (!existing.running || !existing.meta || existing.meta.pid === process.pid) {
        store.writeMeta({ pid: process.pid, port: boundPort, mode, startedAt });
        ownsMeta = true;
      } else {
        log(`[lobby] another daemon (pid ${existing.meta.pid}) is already active for ${fwd(root)}; keeping existing daemon meta untouched`);
      }
    } catch (e) { log(`[lobby] could not write daemon meta: ${e && e.message}`); }
  }
  const base = `http://127.0.0.1:${boundPort}/`;
  const url = `${base}#${token}`;
  if (openBrowser) {
    openInBrowser(url).then((r) => { if (r && (r.spawnError || r.timedOut)) log('[lobby] could not open the browser; open the printed link by hand'); }, () => log('[lobby] could not open the browser; open the printed link by hand'));
  }

  let closed = null;
  let onParentMessage = null;
  const lobby = {
    url,
    base,
    port: boundPort,
    token,
    roomsRoot: root,
    mode,
    resumed,
    store,
    handles,
    close() {
      if (closed) return closed;
      closing = true;
      if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
      if (sseHeartbeat) { clearInterval(sseHeartbeat); sseHeartbeat = null; }
      for (const res of [...sseClients]) {
        try { res.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      closed = (async () => {
        await chain.catch(() => {});
        await Promise.all([...startChains.values()].map((p) => p.catch(() => {})));
        for (const [id, h] of [...handles]) {
          detachHandle(id);
          try { await h.close(); } catch (e) { log(`[lobby] closing room ${id}: ${e && e.message}`); }
          notify({ t: 'room-closed', id, port: portOfUrl(h.url) });
        }
        await new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); });
        if (store) {
          await store.drain().catch(() => {});
          if (mode === 'daemon' && ownsMeta) store.clearMeta(process.pid);
        }
        if (parent && onParentMessage) {
          const off = parent.off || parent.removeListener;
          if (typeof off === 'function') off.call(parent, 'message', onParentMessage);
        }
      })();
      return closed;
    },
  };
  if (parent) {
    // Electron delivers {data, ports}; a plain emitter (tests) may deliver the message itself.
    onParentMessage = (e) => {
      const msg = e && typeof e === 'object' && 'data' in e ? e.data : e;
      if (!msg || typeof msg !== 'object' || msg.t !== 'quit') return;
      log('[lobby] quit requested by the app: stopping the rooms opened here');
      lobby.close().then(() => exit(0), (err) => { log(`[lobby] close failed: ${err && err.message}`); exit(1); });
    };
    parent.on('message', onParentMessage);
  }
  return lobby;
}
