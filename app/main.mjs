// 圆桌 desktop app: Electron main process (ESM). It opens the lobby (lib/lobby.mjs) in an app window
// instead of a browser tab, and each room UI the lobby opens in a window of its own.
//
//   - The lobby runs out of the main thread: utilityProcess.fork(<room-dev>/room.mjs, ['lobby',
//     '--port', '0']) with ROOM_SEAT_RUNTIME = this exe (seats on a machine without node run room.mjs
//     on it, lib/join.mjs). Main reads its one URL line and never logs the token.
//   - All Electron/Chromium data lives under appRoot()/app-data (ROOM_DEV_HOME or
//     %USERPROFILE%\room-dev), set before ready: never AppData (INTERFACES §1, MSIX redirection).
//   - Windows: contextIsolation, no nodeIntegration, sandbox, webSecurity, preload.cjs only;
//     navigation pinned to the lobby origin (main window) or the room origin (room windows); room UIs
//     announced by the lobby open as new app windows; https links open in the browser after a
//     confirm; everything else is denied. Reload keys are blocked (tokens live in page memory).
//   - Closing the main window quits: the lobby gets {t:'quit'}, closes every room it opened
//     (removing service.lock) and exits; after QUIT_GRACE_MS it is killed.
//   - --smoke / --smoke-room with ROOM_APP_SMOKE_OUT: checks the page, writes a JSON result, quits.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, utilityProcess, nativeTheme, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as H from './main-helpers.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(APP_DIR, 'icon.ico');
const PRELOAD = path.join(APP_DIR, 'preload.cjs');
const ARGS = H.parseAppArgs(process.argv);
const PATHS = H.appPaths(process.env);
const DEVTOOLS = process.env.ROOM_APP_DEVTOOLS === '1';

// ---- data locations, before anything else touches them. An unusable ROOM_DEV_HOME (relative) is
// refused before any folder is created: a relative one would land under the current directory.
// Returns a Chinese message when the app cannot start, else null.
function setupDataLocations() {
  if (PATHS.problem) return PATHS.problem;
  try { fs.mkdirSync(PATHS.temp, { recursive: true }); } catch { /* reported by Chromium if it matters */ }
  process.env.TEMP = PATHS.temp;
  process.env.TMP = PATHS.temp;
  try {
    app.setPath('userData', PATHS.userData);
    app.setPath('sessionData', PATHS.sessionData);
    app.setPath('crashDumps', PATHS.crashDumps);
    app.setAppLogsPath(PATHS.logs);
  } catch (e) {
    return `圆桌没能把自己的数据目录设到 ${PATHS.userData}：${e && e.message}。请检查环境变量 ROOM_DEV_HOME 或这个目录的权限，然后重新打开圆桌。`;
  }
  return null;
}
const STARTUP_PROBLEM = setupDataLocations();
if (!STARTUP_PROBLEM && process.platform === 'win32') app.setAppUserModelId('KennyMcSimpson.RoomDev.Yuanzhuo');

// ---- logging: redacted, to stdout and appRoot()/app-data/logs/main.log
function log(line) {
  const text = `${new Date().toISOString()} ${H.redactSecrets(line)}\n`;
  try { process.stdout.write(text); } catch { /* no console */ }
  if (STARTUP_PROBLEM) return; // nowhere of ours to write
  try { fs.mkdirSync(PATHS.logs, { recursive: true }); fs.appendFileSync(path.join(PATHS.logs, 'main.log'), text); } catch { /* best effort */ }
}

// ---- state
let lobby = null;           // UtilityProcess
let lobbyInfo = null;       // {base, port} (+ non-enumerable token)
let lobbyExited = false;
let lobbyExitCode = null;
let mainWindow = null;
let quitting = false;
let shutdownPromise = null;
const roomPorts = new Map();   // port -> room id (announced by the lobby)
const roomWindows = new Map(); // port -> BrowserWindow
const portWaiters = new Map(); // port -> [resolve]
const roomLoadWaiters = new Map(); // port -> [resolve(win)]
const smoke = { out: H.smokeOutPath(process.env), result: null, cleanup: [] };

function bg() { return nativeTheme.shouldUseDarkColors ? H.BACKGROUND.dark : H.BACKGROUND.light; }

function webPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: PRELOAD,
    devTools: DEVTOOLS,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
  };
}

// ---- startup problem (Chinese dialog, nothing created), then single instance
if (STARTUP_PROBLEM) {
  log(`[app] cannot start: ${STARTUP_PROBLEM}`);
  // --smoke runs unattended: no dialog, exit code 1 (there is no appRoot() to write a result into).
  if (!ARGS.smoke) dialog.showErrorBox(H.APP_TITLE, STARTUP_PROBLEM);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  if (ARGS.smoke && smoke.out) {
    try { fs.writeFileSync(smoke.out, JSON.stringify(H.buildSmokeResult({ error: 'ALREADY_RUNNING' }), null, 1)); } catch { /* nothing else to do */ }
  }
  app.exit(ARGS.smoke ? 3 : 0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  Menu.setApplicationMenu(null);
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    if (!DEVTOOLS) wc.on('devtools-opened', () => wc.closeDevTools());
  });
  app.on('window-all-closed', () => { shutdown(0); });
  app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); shutdown(0); } });
  app.whenReady().then(boot, (e) => fatal(`应用没能启动：${e && e.message}`, 'READY_FAILED'));
}

// ---- boot
async function boot() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  // No downloads at all; the room UI's 导出证据 uses IPC room:saveEvidence instead.
  ses.on('will-download', (e) => e.preventDefault());
  registerIpc();

  const roomDevDir = H.resolveRoomDevDir(APP_DIR);
  if (!roomDevDir) { fatal(`找不到圆桌的程序文件（room.mjs）。安装可能不完整，请重新构建或解压：${APP_DIR}`, 'NO_ROOM_DEV'); return; }
  try {
    lobbyInfo = await startLobbyProcess(roomDevDir);
  } catch (e) {
    fatal(`圆桌启动器没能启动：${e && e.message}`, 'LOBBY_START_FAILED');
    return;
  }
  createMainWindow();
}

function startLobbyProcess(roomDevDir) {
  return new Promise((resolve, reject) => {
    const spec = H.lobbyForkSpec({ roomDevDir, execPath: process.execPath, env: process.env });
    log(`[app] starting the lobby from ${spec.modulePath}`);
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`${H.LOBBY_START_TIMEOUT_MS / 1000} 秒内没有收到启动器地址`)); } }, H.LOBBY_START_TIMEOUT_MS);
    try {
      lobby = utilityProcess.fork(spec.modulePath, spec.args, spec.options);
    } catch (e) { clearTimeout(timer); reject(e); return; }
    const onOut = H.lineSplitter((line) => {
      if (!settled) {
        const info = H.parseLobbyLine(line);
        if (info) { settled = true; clearTimeout(timer); log(`[app] lobby ready on 127.0.0.1:${info.port}`); resolve(info); return; }
      }
      if (line.trim()) log(`[lobby] ${line}`);
    });
    const onErr = H.lineSplitter((line) => { if (line.trim()) log(`[lobby:err] ${line}`); });
    if (lobby.stdout) lobby.stdout.on('data', onOut);
    if (lobby.stderr) lobby.stderr.on('data', onErr);
    lobby.on('message', onLobbyMessage);
    lobby.on('exit', (code) => {
      lobbyExited = true;
      lobbyExitCode = code;
      log(`[app] lobby exited with code ${code}`);
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`启动器进程退出了（退出码 ${code}）`)); return; }
      if (!quitting) lobbyCrashed(code);
    });
  });
}

// {t:'room-opened'|'room-closed', id, port} from lib/lobby.mjs (no token in them).
function onLobbyMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const port = Number(msg.port);
  if (!Number.isInteger(port) || port < 1) return;
  if (msg.t === 'room-opened') {
    roomPorts.set(port, String(msg.id || ''));
    for (const r of portWaiters.get(port) || []) r(true);
    portWaiters.delete(port);
  } else if (msg.t === 'room-closed') {
    roomPorts.delete(port);
    const w = roomWindows.get(port);
    if (w && !w.isDestroyed()) w.destroy();
    roomWindows.delete(port);
  }
}

function waitForRoomPort(port, ms) {
  if (roomPorts.has(port)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const list = portWaiters.get(port) || [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    list.push(finish);
    portWaiters.set(port, list);
    setTimeout(() => finish(false), ms);
  });
}

function lobbyCrashed(code) {
  log(`[app] the lobby process ended unexpectedly (code ${code})`);
  if (ARGS.smoke) { writeSmoke(H.buildSmokeResult({ error: `LOBBY_EXITED_${code}` })); shutdown(1); return; }
  dialog.showErrorBox(H.APP_TITLE, `圆桌启动器进程意外退出（退出码 ${code}）。圆桌将关闭；从启动器打开的房间服务也随之停止。请重新打开圆桌。\n\n日志：${path.join(PATHS.logs, 'main.log')}`);
  shutdown(1);
}

function fatal(message, code) {
  log(`[app] fatal ${code}: ${message}`);
  if (ARGS.smoke) { writeSmoke(H.buildSmokeResult({ error: code })); shutdown(1); return; }
  dialog.showErrorBox(H.APP_TITLE, message);
  shutdown(1);
}

// ---- windows
function guardContents(win, kind, port) {
  const wc = win.webContents;
  const allowed = (url) => (kind === 'main' ? H.mainNavigationAllowed(url, port) : H.roomNavigationAllowed(url, port));
  const onNav = (e, legacyUrl) => {
    const url = (e && e.url) || legacyUrl;
    if (allowed(url)) return;
    e.preventDefault();
    handleOpen(url, win);
  };
  wc.on('will-navigate', onNav);
  wc.on('will-redirect', onNav);
  wc.setWindowOpenHandler(({ url }) => { handleOpen(url, win); return { action: 'deny' }; });
  wc.on('before-input-event', (e, input) => { if (H.isReloadAccelerator(input)) e.preventDefault(); });
  wc.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate(H.contextMenuTemplate(params)).popup({ window: win });
  });
  win.on('page-title-updated', (e) => e.preventDefault());
}

function handleOpen(url, fromWin) {
  if (quitting) return;
  const d = H.decideWindowOpen(url, { lobbyPort: lobbyInfo && lobbyInfo.port, roomPorts: new Set(roomPorts.keys()) });
  if (d.action === 'room') { openRoomWindow(url, d.port); return; }
  if (d.action === 'wait-room') {
    waitForRoomPort(d.port, H.ROOM_PORT_WAIT_MS).then((ok) => {
      if (ok) openRoomWindow(url, d.port);
      else log(`[app] denied a window for ${H.describeUrl(url)}: not a room opened by this lobby`);
    });
    return;
  }
  if (d.action === 'external') { confirmExternal(url, fromWin); return; }
  log(`[app] denied navigation or window for ${H.describeUrl(url)}`);
}

async function confirmExternal(url, parent) {
  const opts = {
    type: 'question',
    buttons: ['在浏览器中打开', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: H.APP_TITLE,
    message: '要在默认浏览器里打开这个外部链接吗？',
    detail: url,
  };
  const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  if (r.response === 0) await shell.openExternal(url);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: H.APP_TITLE,
    width: H.WINDOW_SIZE.width,
    height: H.WINDOW_SIZE.height,
    minWidth: H.WINDOW_SIZE.minWidth,
    minHeight: H.WINDOW_SIZE.minHeight,
    icon: ICON,
    backgroundColor: bg(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  mainWindow.removeMenu();
  guardContents(mainWindow, 'main', lobbyInfo.port);
  mainWindow.once('ready-to-show', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  mainWindow.on('close', (e) => { if (!quitting) { e.preventDefault(); shutdown(0); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (ARGS.smoke) mainWindow.webContents.once('did-finish-load', () => { runSmoke().catch((e) => { writeSmoke(H.buildSmokeResult({ error: `SMOKE_FAILED ${e && e.message}` })); shutdown(1); }); });
  mainWindow.loadURL(H.lobbyLoadUrl(lobbyInfo)).catch((e) => fatal(`启动器页面没能打开：${e && e.message}`, 'LOAD_FAILED'));
}

function openRoomWindow(url, port) {
  const existing = roomWindows.get(port);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
  // 「圆桌 · 房间 · <id>」: page-title-updated stays suppressed (guardContents), so the id stays.
  const title = H.roomWindowTitle(roomPorts.get(port));
  const win = new BrowserWindow({
    title,
    width: H.WINDOW_SIZE.width,
    height: H.WINDOW_SIZE.height,
    minWidth: H.WINDOW_SIZE.minWidth,
    minHeight: H.WINDOW_SIZE.minHeight,
    icon: ICON,
    backgroundColor: bg(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  win.removeMenu();
  guardContents(win, 'room', port);
  roomWindows.set(port, win);
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => { if (roomWindows.get(port) === win) roomWindows.delete(port); });
  win.webContents.once('did-finish-load', () => {
    for (const r of roomLoadWaiters.get(port) || []) r(win);
    roomLoadWaiters.delete(port);
  });
  log(`[app] opening a room window for 127.0.0.1:${port}`);
  win.loadURL(url).catch((e) => log(`[app] room window for port ${port} did not load: ${e && e.message}`));
}

// ---- IPC (preload.cjs: window.roomApp)
function senderUrl(e) { try { return e.senderFrame ? e.senderFrame.url : e.sender.getURL(); } catch { return ''; } }
function fromMain(e) {
  return !!mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents && !!lobbyInfo && H.mainNavigationAllowed(senderUrl(e), lobbyInfo.port);
}
// {win, port} of the room window that sent this IPC (on its own room origin), else null.
function fromRoomWindow(e) {
  for (const [port, w] of roomWindows) if (!w.isDestroyed() && e.sender === w.webContents && H.roomNavigationAllowed(senderUrl(e), port)) return { win: w, port };
  return null;
}
function fromAppWindow(e) {
  return fromMain(e) || !!fromRoomWindow(e);
}

// 导出证据 from a room window. Downloads stay cancelled for the whole session (will-download), so
// the export goes through a native save dialog that starts in appRoot()/exports; the file is
// written only where the user confirms. -> {saved: true, path} | {saved: false, canceled: true} |
// {saved: false, error}.
async function saveEvidence(e, name, text) {
  const from = fromRoomWindow(e);
  if (!from) return { saved: false, error: '只有房间窗口可以导出证据' };
  if (typeof text !== 'string' || !text.length || text.length > H.MAX_EVIDENCE_CHARS) return { saved: false, error: '证据内容为空或过大' };
  const defaultPath = H.evidenceDefaultPath(PATHS.appRoot, name);
  try { fs.mkdirSync(path.dirname(defaultPath), { recursive: true }); } catch { /* the dialog still opens */ }
  const r = await dialog.showSaveDialog(from.win, {
    title: '导出证据 JSON',
    defaultPath,
    buttonLabel: '保存',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
  });
  if (r.canceled || !r.filePath) return { saved: false, canceled: true };
  try {
    await fs.promises.writeFile(r.filePath, text, 'utf8');
  } catch (err) {
    log(`[app] evidence export failed: ${err && err.code}`);
    return { saved: false, error: `写入失败：${(err && err.message) || err}` };
  }
  log(`[app] evidence exported (${text.length} chars)`);
  return { saved: true, path: r.filePath };
}

function registerIpc() {
  ipcMain.handle('room:pickFolder', async (e, defaultPath) => {
    if (!fromMain(e)) return null;
    const opts = { title: '选择工作文件夹', buttonLabel: '选择这个文件夹', properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] };
    const start = H.existingAncestor(typeof defaultPath === 'string' ? defaultPath : null);
    if (start) opts.defaultPath = start;
    const r = await dialog.showOpenDialog(mainWindow, opts);
    return r.canceled || !r.filePaths || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('room:copyText', (e, text) => {
    if (!fromAppWindow(e)) return false;
    if (typeof text !== 'string' || text.length > H.MAX_COPY_CHARS) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('room:saveEvidence', (e, name, text) => saveEvidence(e, name, text));
}

// ---- shutdown: graceful lobby quit, then kill after the grace period
function waitLobbyExit(ms) {
  if (!lobby || lobbyExited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    lobby.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

function shutdown(code) {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    for (const w of roomWindows.values()) if (!w.isDestroyed()) w.destroy();
    roomWindows.clear();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    let graceful = true;
    if (lobby && !lobbyExited) {
      try { lobby.postMessage({ t: 'quit' }); } catch { /* exited meanwhile */ }
      graceful = await waitLobbyExit(H.QUIT_GRACE_MS);
      if (!graceful) {
        log('[app] the lobby did not exit in time; killing it');
        try { lobby.kill(); } catch { /* gone */ }
        await waitLobbyExit(1000);
      }
    }
    if (ARGS.smoke && smoke.result) finishSmoke({ graceful, lobbyExitCode });
    log(`[app] quit (code ${code}, lobby ${graceful ? 'exited' : 'killed'})`);
    app.exit(code);
  })();
  return shutdownPromise;
}

// ---- --smoke
function writeSmoke(result) {
  smoke.result = result;
  if (!smoke.out) { log('[app] --smoke without ROOM_APP_SMOKE_OUT inside appRoot(): result not written'); return; }
  try {
    fs.mkdirSync(path.dirname(smoke.out), { recursive: true });
    fs.writeFileSync(smoke.out, `${JSON.stringify(result, null, 1)}\n`);
  } catch (e) { log(`[app] could not write the smoke result: ${e && e.message}`); }
}

// After the graceful quit: did the lobby remove the smoke room's service.lock; then remove the
// throwaway room and seat folder (both inside appRoot()).
function finishSmoke({ graceful, lobbyExitCode: exitCode }) {
  const extra = { shutdown: { graceful, lobbyExitCode: exitCode } };
  if (smoke.result && smoke.result.room && smoke.result.room.roomDir) {
    extra.shutdown.serviceLockRemoved = !fs.existsSync(path.join(smoke.result.room.roomDir, 'service.lock'));
  }
  for (const p of smoke.cleanup) {
    if (!H.isInsideDir(p, PATHS.appRoot)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log(`[app] smoke cleanup ${p}: ${e && e.message}`); }
  }
  extra.shutdown.cleaned = smoke.cleanup.every((p) => !fs.existsSync(p));
  writeSmoke({ ...smoke.result, ...extra });
}

async function runSmoke() {
  const wc = mainWindow.webContents;
  const page = await wc.executeJavaScript(H.SMOKE_PAGE_SCRIPT, true);
  const loaded = H.parseLoopback(wc.getURL());
  const lobbyPortOk = !!lobbyInfo && Number.isInteger(lobbyInfo.port) && !!loaded && loaded.port === lobbyInfo.port;
  let room;
  if (ARGS.smokeRoom) room = await smokeRoom(wc);
  const result = H.buildSmokeResult({ page, lobbyPortOk, windows: BrowserWindow.getAllWindows().length, userData: app.getPath('userData'), room });
  const problems = H.smokeProblems(result, { expectUserData: PATHS.userData, smokeRoom: ARGS.smokeRoom });
  result.problems = problems;
  writeSmoke(result);
  log(`[app] smoke ${problems.length ? `failed: ${problems.join(', ')}` : 'ok'}`);
  shutdown(problems.length ? 1 : 0);
}

async function smokeRoom(wc) {
  const id = `app-smoke-${crypto.randomBytes(4).toString('hex')}`;
  const seatsBase = path.join(PATHS.appRoot, 'test-runs', id);
  const roomDir = path.join(PATHS.appRoot, 'rooms', id);
  smoke.cleanup.push(roomDir, seatsBase);
  const r = await wc.executeJavaScript(H.smokeRoomScript({ token: lobbyInfo.token, id, cwd: path.join(seatsBase, 'A') }), true);
  if (!r || r.ok !== true) return { ok: false, id, roomDir, step: r && r.step, error: r && r.error };
  const port = Number(r.port);
  const win = await new Promise((resolve) => {
    const existing = roomWindows.get(port);
    const list = roomLoadWaiters.get(port) || [];
    list.push(resolve);
    roomLoadWaiters.set(port, list);
    if (existing && !existing.isDestroyed() && !existing.webContents.isLoading()) resolve(existing);
    setTimeout(() => resolve(null), 20_000);
  });
  if (!win) return { ok: false, id, roomDir, port, step: 'room-window', error: 'NO_ROOM_WINDOW' };
  return { ok: true, id, roomDir, port, title: win.webContents.getTitle(), windowTitle: win.getTitle() };
}
