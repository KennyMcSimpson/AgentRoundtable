// Pure helpers for the desktop app's Electron main process (app/main.mjs). Nothing here imports
// electron, so test/app.test.mjs runs them under plain `node --test`.
//
// Kept here: where the app keeps its data (appRoot()/app-data, never AppData), how the lobby's URL
// line is parsed without the token ever reaching a log, which navigations and window.open calls are
// allowed, which keys count as a reload, the context menu, and the --smoke result shape.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const APP_TITLE = 'AgentRoundtable';
export const ROOM_WINDOW_TITLE = 'AgentRoundtable · Room';
export const WINDOW_SIZE = Object.freeze({ width: 1180, height: 800, minWidth: 820, minHeight: 560 });
// ui/lobby.css --bg (light / prefers-color-scheme: dark), so the window does not flash white.
export const BACKGROUND = Object.freeze({ light: '#f6f4ee', dark: '#171614' });
export const QUIT_GRACE_MS = 4000;
export const LOBBY_START_TIMEOUT_MS = 30_000;
export const ROOM_PORT_WAIT_MS = 3000;
export const MAX_COPY_CHARS = 1_000_000;
// The room UI's Export Evidence JSON (state + events the page has pulled): generous, but bounded.
export const MAX_EVIDENCE_CHARS = 256 * 1024 * 1024;

// A room window's title names its room, so two rooms differ in the taskbar and Alt+Tab.
export function roomWindowTitle(id) {
  const s = typeof id === 'string' ? id.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return s ? `${ROOM_WINDOW_TITLE} · ${s.slice(0, 80)}` : ROOM_WINDOW_TITLE;
}

// Where the save dialog for Export Evidence starts: appRoot()/exports/<file name the page proposed>, the
// name reduced to letters, digits, . _ - and ending in .json. The app writes the file only where the
// user confirms in the dialog.
export function evidenceDefaultPath(appRoot, name, nowMs = Date.now()) {
  let base = path.basename(String(name === undefined || name === null ? '' : name).replace(/\\/g, '/'));
  base = base.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 120);
  if (!base || base.toLowerCase() === '.json') base = `room-evidence-${nowMs}.json`;
  if (!/\.json$/i.test(base)) base = `${base}.json`;
  return path.join(appRoot, 'exports', base);
}

// ---- where the app writes (INTERFACES §1: never AppData)

// A ROOM_DEV_HOME the app cannot use, as an error message, else null. It must be a fully qualified
// path: a relative one would put the app's data under whatever the current directory is (outside
// both appRoot() and the install folder), and Electron's setPath rejects it at startup. On Windows a
// rooted path without a drive (\x) or a drive-relative one (C:x) is refused for the same reason.
export function roomDevHomeProblem(env = process.env, { platform = process.platform } = {}) {
  const v = env.ROOM_DEV_HOME;
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  const P = platform === 'win32' ? path.win32 : path.posix;
  const qualified = P.isAbsolute(s) && (platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(s));
  if (!qualified) return `Environment variable ROOM_DEV_HOME must be an absolute path (for example, D:\\room-dev), got "${s}". Set it to an absolute path or unset it, then reopen AgentRoundtable.`;
  return null;
}

// Same formula as lib/common.mjs appRoot(): ROOM_DEV_HOME, else %USERPROFILE%\room-dev. Null when
// ROOM_DEV_HOME is set but unusable (roomDevHomeProblem).
export function appRootFrom(env = process.env, home = os.homedir()) {
  if (roomDevHomeProblem(env)) return null;
  return env.ROOM_DEV_HOME || path.join(home, 'room-dev');
}

// Every path Electron/Chromium would otherwise put under %APPDATA% / %LOCALAPPDATA%. With an
// unusable ROOM_DEV_HOME every path is null and `problem` says why (main.mjs then creates nothing).
export function appPaths(env = process.env, home = os.homedir()) {
  const problem = roomDevHomeProblem(env);
  if (problem) return { problem, appRoot: null, userData: null, sessionData: null, crashDumps: null, logs: null, temp: null };
  const root = appRootFrom(env, home);
  const data = path.join(root, 'app-data');
  return {
    problem: null,
    appRoot: root,
    userData: data,
    sessionData: data,
    crashDumps: path.join(data, 'Crashpad'),
    logs: path.join(data, 'logs'),
    temp: path.join(data, 'temp'),
  };
}

function norm(p) { return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase(); }
export function isInsideDir(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}${path.sep}`) || c.startsWith(`${p}/`);
}

// ---- command line

export function parseAppArgs(argv = process.argv) {
  const a = new Set((argv || []).slice(1).map(String));
  const smokeRoom = a.has('--smoke-room');
  return { smoke: a.has('--smoke') || smokeRoom, smokeRoom };
}

// ROOM_APP_SMOKE_OUT must be an absolute file inside appRoot() (the app writes nowhere else).
export function smokeOutPath(env = process.env, home = os.homedir()) {
  const p = env.ROOM_APP_SMOKE_OUT;
  if (!p || !path.isAbsolute(p)) return null;
  const root = appRootFrom(env, home);
  if (!root) return null;
  return isInsideDir(p, root) ? path.resolve(p) : null;
}

// ---- the lobby process

// The bundled room-dev next to main.mjs (packaged: resources/app/room-dev), else the repository
// root one level up (development: <repo>\app -> <repo>).
export function resolveRoomDevDir(appDir, exists = fs.existsSync) {
  for (const d of [path.join(appDir, 'room-dev'), path.resolve(appDir, '..')]) {
    if (exists(path.join(d, 'room.mjs'))) return d;
  }
  return null;
}

// utilityProcess.fork(modulePath, args, options) for the lobby. ROOM_SEAT_RUNTIME tells add-seat
// which exe can run room.mjs when no node is on PATH (lib/join.mjs).
export function lobbyForkSpec({ roomDevDir, execPath, env = process.env }) {
  const childEnv = { ...env, ROOM_SEAT_RUNTIME: execPath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ROOM_APP_SMOKE_OUT;
  return {
    modulePath: path.join(roomDevDir, 'room.mjs'),
    args: ['lobby', '--port', '0'],
    options: { stdio: 'pipe', serviceName: 'room-dev-lobby', env: childEnv },
  };
}

// The one line room.mjs lobby prints: AgentRoundtable Launcher: http://127.0.0.1:<port>/#<token>.
// Returns {base, port} with the token as a non-enumerable property: JSON.stringify, util.inspect and
// template logging of the result never show it. Use lobbyLoadUrl(info) to get the URL to load.
const LOBBY_LINE = /^AgentRoundtable Launcher: (http:\/\/127\.0\.0\.1:(\d{1,5})\/?)#(?:token=)?([A-Za-z0-9]{16,128})\s*$/;
export function parseLobbyLine(line) {
  const m = LOBBY_LINE.exec(String(line || '').replace(/^\uFEFF/, ''));
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const base = m[1].endsWith('/') ? m[1] : `${m[1]}/`;
  const info = { base, port };
  Object.defineProperty(info, 'token', { value: m[3], enumerable: false });
  return info;
}
export function lobbyLoadUrl(info) { return `${info.base}#${info.token}`; }

// Any loopback URL fragment (the lobby token, a room's admin token) is replaced before logging.
export function redactSecrets(text) {
  return String(text).replace(/(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s#]*)#[^\s]*/g, '$1#<redacted>');
}

// Origin only (no path, no fragment) for log lines about a URL.
export function describeUrl(url) {
  try { const u = new URL(url); return u.origin === 'null' ? u.protocol : u.origin; } catch { return '<invalid-url>'; }
}

// Splits a byte stream into lines (UTF-8 safe across chunk boundaries).
export function lineSplitter(onLine) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  const push = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : dec.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      onLine(line);
    }
  };
  push.flush = () => { buf += dec.end(); if (buf) { const l = buf; buf = ''; onLine(l); } };
  return push;
}

// ---- navigation and window.open

// {port, pathname, hash} of an http://127.0.0.1:<port>/... URL, else null.
export function parseLoopback(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password) return null;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1) return null;
  return { port, pathname: u.pathname, hash: u.hash };
}

// The main window stays on the lobby: http://127.0.0.1:<lobbyPort>/ only.
export function mainNavigationAllowed(url, lobbyPort) {
  const l = parseLoopback(url);
  return !!l && l.port === lobbyPort;
}
// A room window stays on its own room UI origin.
export function roomNavigationAllowed(url, roomPort) {
  const l = parseLoopback(url);
  return !!l && l.port === roomPort;
}

export function externalUrlAllowed(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

// window.open / target=_blank / a link the window may not navigate to:
//   {action: 'room', port}       a room UI this lobby opened -> a new app window
//   {action: 'wait-room', port}  looks like a room UI on a port not announced yet -> wait briefly for
//                                the lobby's room-opened message, then open or deny
//   {action: 'external'}         https -> shell.openExternal after a confirm dialog
//   {action: 'deny'}             everything else (about:blank, file:, the lobby itself, other ports' paths)
export function decideWindowOpen(url, { lobbyPort, roomPorts = new Set() } = {}) {
  const l = parseLoopback(url);
  if (l) {
    if (l.port === lobbyPort) return { action: 'deny' };
    if (l.pathname !== '/' && l.pathname !== '/index.html') return { action: 'deny' };
    return roomPorts.has(l.port) ? { action: 'room', port: l.port } : { action: 'wait-room', port: l.port };
  }
  if (externalUrlAllowed(url)) return { action: 'external' };
  return { action: 'deny' };
}

// Ctrl+R, Ctrl+Shift+R, F5 (with any modifier), the browser-refresh key: blocked, because the lobby
// token and a room's admin token live only in page memory and a reload would lose them.
export function isReloadAccelerator(input) {
  if (!input || (input.type && input.type !== 'keyDown' && input.type !== 'rawKeyDown')) return false;
  const key = String(input.key || '');
  const code = String(input.code || '');
  if (key === 'F5' || code === 'F5' || key === 'BrowserRefresh' || code === 'BrowserRefresh') return true;
  if ((input.control || input.meta) && (key.toLowerCase() === 'r' || code === 'KeyR')) return true;
  return false;
}

// The native context menu: Copy / Paste / Cut / Select All only, each enabled as Chromium's edit flags say.
export function contextMenuTemplate(params = {}) {
  const f = (params && params.editFlags) || {};
  const editable = !!(params && params.isEditable);
  const selected = !!(params && params.selectionText);
  return [
    { label: 'Copy', role: 'copy', enabled: !!f.canCopy && selected },
    { label: 'Paste', role: 'paste', enabled: !!f.canPaste && editable },
    { label: 'Cut', role: 'cut', enabled: !!f.canCut && editable && selected },
    { label: 'Select All', role: 'selectAll', enabled: !!f.canSelectAll },
  ];
}

// Folder picker default: the path itself when it exists, else its nearest existing ancestor.
export function existingAncestor(p, exists = fs.existsSync) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return undefined;
  let cur = path.resolve(p);
  for (;;) {
    if (exists(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

// ---- --smoke

// Evaluated in the lobby page after did-finish-load.
export const SMOKE_PAGE_SCRIPT = `(() => {
  const tok = document.getElementById('hdr-token');
  return {
    title: document.title,
    hasCreate: !![...document.querySelectorAll('button')].find((b) => /New Room/.test(b.textContent)),
    isApp: !!window.roomApp && window.roomApp.isApp === true,
    hasToken: !!tok && /Loaded/.test(tok.textContent),
    fragmentCleared: !location.hash,
  };
})()`;

// --smoke-room: creates a throwaway room through the lobby API (the page's own origin, token in the
// POST body), opens it, and window.opens its room UI the same way the Open Room UI button does.
// Returns {ok, port} or {ok: false, step, error}; never the room URL (it carries the admin token).
export function smokeRoomScript({ token, id, cwd }) {
  return `(async () => {
  const token = ${JSON.stringify(String(token))};
  const post = async (p, b) => {
    const r = await fetch(p, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, b, { token })) });
    let j = {};
    try { j = await r.json(); } catch (e) { j = {}; }
    return { status: r.status, json: j || {} };
  };
  const id = ${JSON.stringify(String(id))};
  const c = await post('/lobby/api/create', { id, seats: [{ seatId: 'A', role: 'participant', agent: 'generic', cwd: ${JSON.stringify(String(cwd))}, createCwd: true }] });
  if (!c.json.ok) return { ok: false, step: 'create', error: String(c.json.error || ('HTTP ' + c.status)) };
  const o = await post('/lobby/api/open', { id });
  if (!o.json.ok) return { ok: false, step: 'open', error: String(o.json.error || ('HTTP ' + o.status)) };
  let port = null;
  try { port = Number(new URL(o.json.url).port); } catch (e) { port = null; }
  window.open(o.json.url, '_blank');
  return { ok: true, port };
})()`;
}

export const SMOKE_KEYS = Object.freeze(['title', 'hasCreate', 'isApp', 'hasToken', 'lobbyPortOk', 'windows', 'userData']);

export function buildSmokeResult({ page = {}, lobbyPortOk = false, windows = 0, userData = null, room = undefined, error = undefined } = {}) {
  const p = page && typeof page === 'object' ? page : {};
  const r = {
    title: typeof p.title === 'string' ? p.title : null,
    hasCreate: p.hasCreate === true,
    isApp: p.isApp === true,
    hasToken: p.hasToken === true,
    fragmentCleared: p.fragmentCleared === true,
    lobbyPortOk: lobbyPortOk === true,
    windows: Number.isInteger(windows) ? windows : 0,
    userData: typeof userData === 'string' ? userData : null,
  };
  if (room !== undefined) r.room = room;
  if (error) r.error = String(error);
  return r;
}

// Empty when the result says the app works; otherwise what failed (ASCII keys).
export function smokeProblems(r, { expectUserData, smokeRoom = false } = {}) {
  const out = [];
  if (!r || typeof r !== 'object') return ['no-result'];
  if (r.error) out.push(`error:${r.error}`);
  if (!r.title) out.push('title');
  for (const k of ['hasCreate', 'isApp', 'hasToken', 'lobbyPortOk']) if (r[k] !== true) out.push(k);
  if (!(r.windows >= (smokeRoom ? 2 : 1))) out.push('windows');
  if (!r.userData || (expectUserData && norm(r.userData) !== norm(expectUserData))) out.push('userData');
  if (smokeRoom && !(r.room && r.room.ok === true && typeof r.room.title === 'string' && r.room.title)) out.push('room');
  // The room window is titled after its room (roomWindowTitle), not the page's own title.
  if (smokeRoom && r.room && r.room.ok === true && r.room.windowTitle !== roomWindowTitle(r.room.id)) out.push('roomWindowTitle');
  return out;
}
