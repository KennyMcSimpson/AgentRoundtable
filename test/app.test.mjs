// The desktop app (圆桌.exe) without Electron: the pure main-process helpers (app/main-helpers.mjs),
// static checks of app/main.mjs and app/preload.cjs, the icon generator (dist/make-icon.mjs), the app
// build in --dry-run (dist/build-app.mjs), the lobby's parentPort protocol (lib/lobby.mjs), and the
// seat runtime fallback for machines without node (lib/join.mjs, admin add-seat, packets).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import util from 'node:util';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as H from '../app/main-helpers.mjs';
import { appRoot, testRunsRoot, randomHex, readJsonl, ROOM_FILES as F } from '../lib/common.mjs';
import { buildIco, readIco, renderIcon, encodePng, ICON_SIZES, PNG_SIGNATURE } from '../dist/make-icon.mjs';
import { parseBuildAppArgs, locateElectronZip, locateRcedit, planAppFiles, buildApp, BuildRefusal, numericVersion, rceditArgs, electronVersionFromName, runtimeExcluded, EXE_NAME, removeTree, DEFAULT_APP_ASAR } from '../dist/build-app.mjs';
import { startLobby } from '../lib/lobby.mjs';
import { nodeOnPath, seatRuntimeFor, seatCommandPrefix, seatRoomCmd, renderJoin, renderRoomCmd, cmdPath } from '../lib/join.mjs';
import { ADMIN_COMMANDS } from '../lib/admin.mjs';
import { createRoomService } from '../lib/service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WIN = process.platform === 'win32';
const roots = [];
after(async () => { for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true }); });
function base(tag) {
  const b = path.join(testRunsRoot(), `app-${tag}-${randomHex(5)}`);
  fs.mkdirSync(b, { recursive: true });
  roots.push(b);
  return b;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Source without comments, for static checks.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ---------------------------------------------------------------- data locations

test('app data lives under appRoot()/app-data (ROOM_DEV_HOME honoured), never AppData', () => {
  const home = WIN ? 'C:\\Users\\u' : '/home/u';
  const p = H.appPaths({}, home);
  assert.equal(p.userData, path.join(home, 'room-dev', 'app-data'));
  assert.equal(p.sessionData, p.userData);
  for (const k of ['crashDumps', 'logs', 'temp']) assert.ok(H.isInsideDir(p[k], p.userData), k);
  const moved = H.appPaths({ ROOM_DEV_HOME: path.join(home, 'elsewhere') }, home);
  assert.equal(moved.userData, path.join(home, 'elsewhere', 'app-data'));
  // Same formula as lib/common.mjs appRoot() in this process.
  assert.equal(H.appRootFrom(process.env), appRoot());
  for (const v of Object.values(H.appPaths(process.env))) assert.ok(!/[\\/]AppData[\\/]/i.test(v) || !!process.env.ROOM_DEV_HOME, v);
  // main.mjs sets every path before the app is ready, and before the single-instance lock.
  const main = code('app/main.mjs');
  const idx = (s) => main.indexOf(s);
  for (const s of ["app.setPath('userData', PATHS.userData)", "app.setPath('sessionData', PATHS.sessionData)", "app.setPath('crashDumps', PATHS.crashDumps)", 'app.setAppLogsPath(PATHS.logs)']) {
    assert.ok(idx(s) > 0, s);
    assert.ok(idx(s) < idx('app.requestSingleInstanceLock()') && idx(s) < idx('app.whenReady()'), `${s} before ready`);
  }
  assert.ok(!/getPath\('appData'\)|LOCALAPPDATA|APPDATA/.test(main), 'main.mjs never names AppData');
});

test('a relative ROOM_DEV_HOME is refused with a Chinese message before any folder or setPath (SEC-3)', () => {
  const home = WIN ? 'C:\\Users\\u' : '/home/u';
  for (const bad of ['rel', 'rel\\x', './x', '..\\up']) {
    const msg = H.roomDevHomeProblem({ ROOM_DEV_HOME: bad });
    assert.match(msg, /环境变量 ROOM_DEV_HOME 必须是绝对路径/, bad);
    assert.ok(msg.includes(bad), 'names the value');
    const p = H.appPaths({ ROOM_DEV_HOME: bad }, home);
    assert.equal(p.problem, msg);
    for (const k of ['appRoot', 'userData', 'sessionData', 'crashDumps', 'logs', 'temp']) assert.equal(p[k], null, `${bad} ${k}`);
    assert.equal(H.appRootFrom({ ROOM_DEV_HOME: bad }, home), null);
    assert.equal(H.smokeOutPath({ ROOM_DEV_HOME: bad, ROOM_APP_SMOKE_OUT: path.resolve(bad, 'smoke.json') }, home), null, 'no smoke file under a relative root');
  }
  // Windows: rooted without a drive, or drive-relative, is not fully qualified either.
  for (const bad of ['\\room-dev', 'C:room-dev']) assert.ok(H.roomDevHomeProblem({ ROOM_DEV_HOME: bad }, { platform: 'win32' }), bad);
  for (const good of ['C:\\x\\room-dev', 'D:/r', '\\\\server\\share\\room-dev']) assert.equal(H.roomDevHomeProblem({ ROOM_DEV_HOME: good }, { platform: 'win32' }), null, good);
  assert.equal(H.roomDevHomeProblem({ ROOM_DEV_HOME: '/home/u/r' }, { platform: 'linux' }), null);
  assert.equal(H.roomDevHomeProblem({}), null);
  assert.equal(H.roomDevHomeProblem({ ROOM_DEV_HOME: '' }), null, 'empty = unset');
  const abs = H.appPaths({ ROOM_DEV_HOME: path.join(home, 'r') }, home);
  assert.equal(abs.problem, null);
  assert.equal(abs.userData, path.join(home, 'r', 'app-data'));
  // main.mjs: the problem is checked before mkdirSync and setPath; setPath sits in try/catch with a
  // Chinese message; the startup problem shows a Chinese error box and exits 1 before the lock.
  const m = code('app/main.mjs');
  const i = (s) => { const k = m.indexOf(s); assert.ok(k >= 0, s); return k; };
  assert.ok(i('if (PATHS.problem) return PATHS.problem;') < i('fs.mkdirSync(PATHS.temp'), 'checked before any folder');
  assert.ok(i('if (PATHS.problem) return PATHS.problem;') < i("app.setPath('userData'"), 'checked before setPath');
  const setup = /function setupDataLocations\(\) \{([\s\S]*?)\n\}/.exec(m)[1];
  assert.match(setup, /try \{\s*app\.setPath\('userData', PATHS\.userData\);[\s\S]*app\.setAppLogsPath\(PATHS\.logs\);\s*\} catch \(e\) \{\s*return `圆桌没能把自己的数据目录设到/);
  assert.match(m, /if \(STARTUP_PROBLEM\) \{[\s\S]*?dialog\.showErrorBox\(H\.APP_TITLE, STARTUP_PROBLEM\);\s*app\.exit\(1\);\s*\} else if \(!app\.requestSingleInstanceLock\(\)\)/);
  assert.ok(i('const STARTUP_PROBLEM = setupDataLocations();') < i('if (STARTUP_PROBLEM) {'));
});

test('room window title carries the room id (F4)', () => {
  assert.equal(H.roomWindowTitle('demo'), '圆桌 · 房间 · demo');
  assert.equal(H.roomWindowTitle('app-smoke-1a2b'), `${H.ROOM_WINDOW_TITLE} · app-smoke-1a2b`);
  assert.equal(H.roomWindowTitle(''), H.ROOM_WINDOW_TITLE);
  assert.equal(H.roomWindowTitle(undefined), H.ROOM_WINDOW_TITLE);
  assert.equal(H.roomWindowTitle('a\nb'), '圆桌 · 房间 · ab');
  assert.notEqual(H.roomWindowTitle('r1'), H.roomWindowTitle('r2'), 'two rooms differ');
});

test('smoke out path must be inside appRoot(); argv flags', () => {
  const home = WIN ? 'C:\\Users\\u' : '/home/u';
  const inside = path.join(home, 'room-dev', 'test-runs', 'x', 'smoke.json');
  assert.equal(H.smokeOutPath({ ROOM_APP_SMOKE_OUT: inside }, home), path.resolve(inside));
  assert.equal(H.smokeOutPath({ ROOM_APP_SMOKE_OUT: path.join(home, 'Desktop', 's.json') }, home), null);
  assert.equal(H.smokeOutPath({ ROOM_APP_SMOKE_OUT: 'relative.json' }, home), null);
  assert.equal(H.smokeOutPath({}, home), null);
  assert.deepEqual(H.parseAppArgs(['exe']), { smoke: false, smokeRoom: false });
  assert.deepEqual(H.parseAppArgs(['exe', '--smoke']), { smoke: true, smokeRoom: false });
  assert.deepEqual(H.parseAppArgs(['exe', '--smoke-room']), { smoke: true, smokeRoom: true });
});

// ---------------------------------------------------------------- lobby process and URL line

test('lobby URL line: parsed, token never in JSON / inspect / logs', () => {
  const tok = 'a'.repeat(8) + '0123456789abcdef'.repeat(2) + 'b'.repeat(8);
  const line = `圆桌启动器：http://127.0.0.1:51234/#${tok}`;
  const info = H.parseLobbyLine(line);
  assert.equal(info.port, 51234);
  assert.equal(info.base, 'http://127.0.0.1:51234/');
  assert.equal(H.lobbyLoadUrl(info), `http://127.0.0.1:51234/#${tok}`);
  assert.ok(!JSON.stringify(info).includes(tok), 'JSON');
  assert.ok(!util.inspect(info).includes(tok), 'inspect');
  assert.ok(!`${Object.values(info).join(' ')}`.includes(tok), 'values');
  assert.deepEqual(Object.keys(info).sort(), ['base', 'port']);
  assert.ok(!H.redactSecrets(line).includes(tok), 'redacted log line');
  assert.match(H.redactSecrets(line), /51234\/#<已隐藏>/);
  assert.ok(!H.redactSecrets(`[lobby] room x opened; open http://127.0.0.1:6000/#${tok} now`).includes(tok));
  assert.equal(H.parseLobbyLine(`${line}\r`).port, 51234, 'CRLF tolerated');
  for (const bad of [`圆桌启动器：https://127.0.0.1:1/#${tok}`, `圆桌启动器：http://localhost:1/#${tok}`, '圆桌启动器：http://127.0.0.1:51234/', `x 圆桌启动器：http://127.0.0.1:1/#${tok}`, `圆桌启动器：http://127.0.0.1:99999/#${tok}`, `圆桌启动器：http://127.0.0.1:1/#short`]) {
    assert.equal(H.parseLobbyLine(bad), null, bad);
  }
  // main.mjs logs the port only, and every lobby output line goes through redactSecrets.
  const main = code('app/main.mjs');
  assert.match(main, /function log\(line\) \{\s*const text = `\$\{new Date\(\)\.toISOString\(\)\} \$\{H\.redactSecrets\(line\)\}\\n`;/);
  assert.ok(!/log\([^\n]*token/i.test(main.replace(/lobbyInfo\.token, id/g, '')), 'no log call mentions the token');
  assert.ok(!/console\.(log|error|info)/.test(main), 'no console logging');
});

test('line splitter: CRLF and UTF-8 split across chunks', () => {
  const lines = [];
  const push = H.lineSplitter((l) => lines.push(l));
  const buf = Buffer.from('圆桌启动器：x\r\n第二行\n半', 'utf8');
  push(buf.subarray(0, 4)); push(buf.subarray(4, 20)); push(buf.subarray(20));
  push.flush();
  assert.deepEqual(lines, ['圆桌启动器：x', '第二行', '半']);
});

test('lobby fork spec and room-dev location (dev layout and packaged layout)', () => {
  const spec = H.lobbyForkSpec({ roomDevDir: ROOT, execPath: 'C:\\apps\\圆桌\\圆桌.exe', env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', ROOM_APP_SMOKE_OUT: 'y' } });
  assert.equal(spec.modulePath, path.join(ROOT, 'room.mjs'));
  assert.deepEqual(spec.args, ['lobby', '--port', '0']);
  assert.equal(spec.options.stdio, 'pipe');
  assert.equal(spec.options.env.ROOM_SEAT_RUNTIME, 'C:\\apps\\圆桌\\圆桌.exe');
  assert.equal(spec.options.env.PATH, 'x');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in spec.options.env) && !('ROOM_APP_SMOKE_OUT' in spec.options.env));
  assert.equal(H.resolveRoomDevDir(path.join(ROOT, 'app')), path.resolve(ROOT), 'development: the repository');
  const packaged = path.join('X:', 'p', 'resources', 'app');
  assert.equal(H.resolveRoomDevDir(packaged, (p) => p === path.join(packaged, 'room-dev', 'room.mjs')), path.join(packaged, 'room-dev'));
  assert.equal(H.resolveRoomDevDir(packaged, () => false), null);
});

// ---------------------------------------------------------------- navigation, windows, keys, menu

test('navigation: the main window stays on the lobby origin, room windows on their own', () => {
  assert.equal(H.mainNavigationAllowed('http://127.0.0.1:7380/', 7380), true);
  assert.equal(H.mainNavigationAllowed('http://127.0.0.1:7380/lobby.html#x', 7380), true);
  for (const u of ['http://127.0.0.1:7381/', 'http://localhost:7380/', 'https://127.0.0.1:7380/', 'file:///C:/x.html', 'about:blank', 'http://user:pw@127.0.0.1:7380/', 'javascript:alert(1)', 'not a url']) {
    assert.equal(H.mainNavigationAllowed(u, 7380), false, u);
  }
  assert.equal(H.roomNavigationAllowed('http://127.0.0.1:5000/index.html', 5000), true);
  assert.equal(H.roomNavigationAllowed('http://127.0.0.1:7380/', 5000), false);
});

test('window.open: announced room UIs open as app windows, https asks, everything else is denied', () => {
  const ctx = { lobbyPort: 7380, roomPorts: new Set([5001]) };
  assert.deepEqual(H.decideWindowOpen('http://127.0.0.1:5001/#admintoken', ctx), { action: 'room', port: 5001 });
  assert.deepEqual(H.decideWindowOpen('http://127.0.0.1:5001/index.html', ctx), { action: 'room', port: 5001 });
  assert.deepEqual(H.decideWindowOpen('http://127.0.0.1:5002/#t', ctx), { action: 'wait-room', port: 5002 }, 'not announced yet');
  assert.deepEqual(H.decideWindowOpen('https://example.org/x', ctx), { action: 'external' });
  for (const u of ['http://127.0.0.1:7380/', 'http://127.0.0.1:5001/api/state', 'http://example.org/', 'about:blank', 'file:///C:/Windows/', 'http://localhost:5001/', 'mailto:a@b.c', '']) {
    assert.deepEqual(H.decideWindowOpen(u, ctx), { action: 'deny' }, u);
  }
  assert.equal(H.externalUrlAllowed('https://x.y/'), true);
  assert.equal(H.externalUrlAllowed('http://x.y/'), false);
  assert.equal(H.describeUrl('http://127.0.0.1:5001/#secret'), 'http://127.0.0.1:5001');
});

test('reload accelerators are recognised (Ctrl+R, Ctrl+Shift+R, F5), nothing else', () => {
  const k = (key, mods = {}) => ({ type: 'keyDown', key, ...mods });
  for (const i of [k('r', { control: true }), k('R', { control: true, shift: true }), k('F5'), k('F5', { control: true }), k('F5', { shift: true }), { type: 'keyDown', key: 'Unidentified', code: 'KeyR', control: true }, k('BrowserRefresh')]) {
    assert.equal(H.isReloadAccelerator(i), true, JSON.stringify(i));
  }
  for (const i of [k('r'), k('c', { control: true }), k('v', { control: true }), k('F6'), { type: 'keyUp', key: 'F5' }, null]) {
    assert.equal(H.isReloadAccelerator(i), false, JSON.stringify(i));
  }
});

test('context menu: 复制 / 粘贴 / 剪切 / 全选 only, enabled by the edit flags', () => {
  const none = H.contextMenuTemplate({ editFlags: {} });
  assert.deepEqual(none.map((x) => x.label), ['复制', '粘贴', '剪切', '全选']);
  assert.deepEqual(none.map((x) => x.role), ['copy', 'paste', 'cut', 'selectAll']);
  assert.ok(none.every((x) => x.enabled === false));
  const field = H.contextMenuTemplate({ isEditable: true, selectionText: 'abc', editFlags: { canCopy: true, canPaste: true, canCut: true, canSelectAll: true } });
  assert.ok(field.every((x) => x.enabled === true));
  const text = H.contextMenuTemplate({ isEditable: false, selectionText: 'abc', editFlags: { canCopy: true, canPaste: true, canCut: true, canSelectAll: true } });
  assert.deepEqual(text.map((x) => x.enabled), [true, false, false, true], 'page text: copy and select all only');
});

test('existingAncestor: the folder picker starts at the nearest existing folder', () => {
  const b = base('anc');
  assert.equal(H.existingAncestor(path.join(b, 'a', 'b')), b);
  assert.equal(H.existingAncestor(b), b);
  assert.equal(H.existingAncestor('relative'), undefined);
  assert.equal(H.existingAncestor(null), undefined);
});

// ---------------------------------------------------------------- smoke

test('smoke result shape and checks; the in-page scripts parse and carry the token only as a string', () => {
  const ok = H.buildSmokeResult({ page: { title: '圆桌启动器', hasCreate: true, isApp: true, hasToken: true, fragmentCleared: true, extra: 1 }, lobbyPortOk: true, windows: 1, userData: 'C:\\u\\room-dev\\app-data' });
  for (const k of H.SMOKE_KEYS) assert.ok(k in ok, k);
  assert.ok(!('extra' in ok), 'only known page keys');
  assert.deepEqual(H.smokeProblems(ok, { expectUserData: 'C:\\u\\room-dev\\app-data' }), []);
  assert.deepEqual(H.smokeProblems({ ...ok, isApp: false, windows: 0 }), ['isApp', 'windows']);
  assert.deepEqual(H.smokeProblems(ok, { expectUserData: 'C:\\other' }), ['userData']);
  assert.ok(H.smokeProblems(ok, { smokeRoom: true }).includes('room'));
  const withRoom = H.buildSmokeResult({ page: { title: 't', hasCreate: true, isApp: true, hasToken: true }, lobbyPortOk: true, windows: 2, userData: 'x', room: { ok: true, id: 'app-smoke-1', title: '房间界面', windowTitle: '圆桌 · 房间 · app-smoke-1', port: 1 } });
  assert.deepEqual(H.smokeProblems(withRoom, { smokeRoom: true }), []);
  // The room window must carry its room id in the title.
  assert.deepEqual(H.smokeProblems({ ...withRoom, room: { ...withRoom.room, windowTitle: '圆桌 · 房间' } }, { smokeRoom: true }), ['roomWindowTitle']);
  assert.deepEqual(H.smokeProblems(H.buildSmokeResult({ error: 'LOBBY_EXITED_1' })).slice(0, 1), ['error:LOBBY_EXITED_1']);
  // Both scripts are valid JavaScript expressions.
  assert.doesNotThrow(() => new Function(`return ${H.SMOKE_PAGE_SCRIPT};`));
  const tok = 'f'.repeat(48);
  const s = H.smokeRoomScript({ token: tok, id: 'app-smoke-1', cwd: 'C:\\Users\\u\\room-dev\\test-runs\\app-smoke-1\\A' });
  assert.doesNotThrow(() => new Function(`return ${s};`));
  assert.equal(s.split(tok).length - 1, 1, 'token appears once');
  assert.match(s, /"C:\\\\Users\\\\u\\\\room-dev/, 'paths are JSON-escaped');
  assert.match(s, /window\.open\(o\.json\.url, '_blank'\)/, 'same window-open path as the button');
  assert.ok(!/return \{ ok: true[^}]*url/.test(s), 'the room url (admin token) is not returned');
  assert.match(H.SMOKE_PAGE_SCRIPT, /新建房间/);
  assert.match(H.SMOKE_PAGE_SCRIPT, /window\.roomApp/);
});

// ---------------------------------------------------------------- main.mjs, preload.cjs, package.json

test('main.mjs: sandboxed windows, guarded navigation, single instance, no menu, graceful quit', () => {
  const m = code('app/main.mjs');
  for (const s of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true', 'preload: PRELOAD', 'devTools: DEVTOOLS']) assert.ok(m.includes(s), s);
  assert.match(m, /const DEVTOOLS = process\.env\.ROOM_APP_DEVTOOLS === '1';/);
  assert.match(m, /Menu\.setApplicationMenu\(null\)/);
  assert.match(m, /app\.requestSingleInstanceLock\(\)/);
  assert.match(m, /app\.on\('second-instance'/);
  assert.match(m, /wc\.on\('will-navigate', onNav\)/);
  assert.match(m, /wc\.setWindowOpenHandler\(\(\{ url \}\) => \{ handleOpen\(url, win\); return \{ action: 'deny' \}; \}\)/);
  assert.match(m, /before-input-event[^\n]*isReloadAccelerator/);
  assert.match(m, /lobby\.postMessage\(\{ t: 'quit' \}\)/);
  assert.match(m, /waitLobbyExit\(H\.QUIT_GRACE_MS\)/);
  assert.match(m, /lobby\.kill\(\)/);
  assert.match(m, /title: H\.APP_TITLE/);
  assert.match(m, /const title = H\.roomWindowTitle\(roomPorts\.get\(port\)\);\s*const win = new BrowserWindow\(\{\s*title,/, 'room window titled after its room');
  assert.match(m, /win\.on\('page-title-updated', \(e\) => e\.preventDefault\(\)\)/, 'the page cannot replace the title');
  assert.match(m, /backgroundColor: bg\(\)/);
  assert.match(m, /show: false/);
  assert.match(m, /ready-to-show/);
  assert.match(m, /dialog\.showErrorBox\(H\.APP_TITLE, `圆桌启动器进程意外退出/);
  assert.match(m, /shell\.openExternal\(url\)/);
  assert.ok(m.indexOf('showMessageBox') < m.indexOf('shell.openExternal(url)'), 'confirm before opening a browser');
  assert.equal(H.QUIT_GRACE_MS, 4000);
  assert.deepEqual([H.WINDOW_SIZE.width, H.WINDOW_SIZE.height], [1180, 800]);
  // The background matches ui/lobby.css --bg in both schemes.
  const css = read('ui/lobby.css');
  assert.ok(css.includes(`--bg: ${H.BACKGROUND.light};`) && css.includes(`--bg: ${H.BACKGROUND.dark};`));
  // No CLI flag for anything dangerous; ESM main.
  assert.ok(!/require\(/.test(m), 'main.mjs is ESM');
});

test('preload.cjs exposes only window.roomApp {isApp, pickFolder, copyText, saveEvidence}', () => {
  const p = code('app/preload.cjs');
  assert.equal((p.match(/exposeInMainWorld\(/g) || []).length, 1);
  assert.match(p, /exposeInMainWorld\('roomApp'/);
  assert.match(p, /ipcRenderer\.invoke\('room:pickFolder'/);
  assert.match(p, /ipcRenderer\.invoke\('room:copyText'/);
  assert.match(p, /ipcRenderer\.invoke\('room:saveEvidence'/);
  assert.ok(!/ipcRenderer\.(send|on|sendSync)\b/.test(p), 'invoke only');
  // Evaluate it with a fake electron module and look at what it exposes.
  const exposed = {};
  const calls = [];
  const fakeRequire = (name) => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve(null); } } };
  };
  new Function('require', read('app/preload.cjs'))(fakeRequire);
  assert.deepEqual(Object.keys(exposed), ['roomApp']);
  assert.deepEqual(Object.keys(exposed.roomApp).sort(), ['copyText', 'isApp', 'pickFolder', 'saveEvidence']);
  assert.equal(exposed.roomApp.isApp, true);
  exposed.roomApp.pickFolder('C:\\x'); exposed.roomApp.pickFolder(5); exposed.roomApp.copyText(12);
  exposed.roomApp.saveEvidence('room-evidence-r-1.json', '{}'); exposed.roomApp.saveEvidence(undefined, null);
  assert.deepEqual(calls, [['room:pickFolder', 'C:\\x'], ['room:pickFolder', null], ['room:copyText', '12'], ['room:saveEvidence', 'room-evidence-r-1.json', '{}'], ['room:saveEvidence', '', '']]);
});

// ---------------------------------------------------------------- F2: evidence export in the app

test('evidence export: the app keeps downloads cancelled and saves through room:saveEvidence from room windows only', () => {
  const m = code('app/main.mjs');
  assert.match(m, /ses\.on\('will-download', \(e\) => e\.preventDefault\(\)\)/, 'downloads stay cancelled');
  assert.match(m, /ipcMain\.handle\('room:saveEvidence', \(e, name, text\) => saveEvidence\(e, name, text\)\)/);
  const fn = /async function saveEvidence\(e, name, text\) \{([\s\S]*?)\n\}/.exec(m);
  assert.ok(fn, 'saveEvidence in main.mjs');
  const body = fn[1];
  const at = (s) => { const i = body.indexOf(s); assert.ok(i >= 0, s); return i; };
  // Sender check first, then the dialog on the sender's window starting under appRoot(), then the write.
  assert.ok(at('const from = fromRoomWindow(e);') < at('dialog.showSaveDialog(from.win'), 'room window checked before the dialog');
  assert.ok(at('if (!from) return { saved: false') < at('dialog.showSaveDialog(from.win'));
  assert.ok(at('H.evidenceDefaultPath(PATHS.appRoot, name)') < at('dialog.showSaveDialog(from.win'));
  assert.ok(at("if (r.canceled || !r.filePath) return { saved: false, canceled: true };") < at('fs.promises.writeFile(r.filePath, text'));
  assert.match(body, /return \{ saved: true, path: r\.filePath \};/);
  assert.ok(!/writeFile(Sync)?\((?!r\.filePath)/.test(body), 'writes only the path the user confirmed');
  assert.match(m, /function fromRoomWindow\(e\) \{\s*for \(const \[port, w\] of roomWindows\) if \(!w\.isDestroyed\(\) && e\.sender === w\.webContents && H\.roomNavigationAllowed\(senderUrl\(e\), port\)\)/);
  // Default path: appRoot()/exports/<sanitised name>.json.
  const root = WIN ? 'C:\\Users\\u\\room-dev' : '/home/u/room-dev';
  assert.equal(H.evidenceDefaultPath(root, 'room-evidence-demo-1700000000000.json'), path.join(root, 'exports', 'room-evidence-demo-1700000000000.json'));
  assert.equal(H.evidenceDefaultPath(root, '..\\..\\Windows\\evil.json'), path.join(root, 'exports', 'evil.json'), 'no path parts');
  assert.equal(H.evidenceDefaultPath(root, '../x y:z'), path.join(root, 'exports', 'x_y_z.json'));
  assert.equal(H.evidenceDefaultPath(root, '房间-1.json'), path.join(root, 'exports', '房间-1.json'));
  assert.equal(H.evidenceDefaultPath(root, '', 42), path.join(root, 'exports', 'room-evidence-42.json'));
  assert.ok(H.isInsideDir(H.evidenceDefaultPath(root, '...'), path.join(root, 'exports')));
});

// Runs ui/app.js exportEvidence() with stubs: in the app it calls saveEvidence and toasts only what happened.
async function runExport(roomApp, answer) {
  const src = read('ui/app.js');
  const fnSrc = /\n  function exportEvidence\(\) \{[\s\S]*?\n  \}\n/.exec(src)[0];
  const toasts = [];
  const saved = [];
  const clicks = [];
  const win = roomApp ? { roomApp: { isApp: true, saveEvidence: (name, text) => { saved.push({ name, text }); return typeof answer === 'function' ? answer() : Promise.resolve(answer); } } } : {};
  const doc = { body: { appendChild() {}, removeChild() {} } };
  const h = (tag, attrs) => ({ tag, attrs, click() { clicks.push(attrs); } });
  const app = { room: { id: 'demo' }, state: { phase: 'idle' }, events: [{ seq: 1 }], derived: { lastSeq: 1, counts: {}, audits: [] } };
  const URLs = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  const run = new Function('window', 'document', 'app', 'toast', 'h', 'receiptRows', 'Blob', 'URL', 'setTimeout', `${fnSrc}; return exportEvidence;`)(
    win, doc, app, (t, tone) => toasts.push({ t, tone }), h, () => [], class { constructor(parts) { this.parts = parts; } }, URLs, () => {});
  run();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { toasts, saved, clicks };
}

test('ui/app.js 导出证据: in the app it goes through saveEvidence and claims success only when saved', async () => {
  const ok = await runExport(true, { saved: true, path: 'C:\\Users\\u\\room-dev\\exports\\e.json' });
  assert.equal(ok.saved.length, 1);
  assert.match(ok.saved[0].name, /^room-evidence-demo-\d+\.json$/);
  const payload = JSON.parse(ok.saved[0].text);
  assert.deepEqual(payload.events, [{ seq: 1 }]);
  assert.ok(!/token/i.test(ok.saved[0].text.replace(/不含令牌/g, '')), 'no token');
  assert.deepEqual(ok.clicks, [], 'no <a download> in the app');
  assert.deepEqual(ok.toasts, [{ t: '已导出证据 JSON：C:\\Users\\u\\room-dev\\exports\\e.json', tone: 'ok' }]);
  const cancel = await runExport(true, { saved: false, canceled: true });
  assert.equal(cancel.toasts.length, 1);
  assert.notEqual(cancel.toasts[0].tone, 'ok');
  assert.ok(!/已导出证据 JSON/.test(cancel.toasts[0].t), 'cancel is not reported as exported');
  const failed = await runExport(true, { saved: false, error: 'EACCES' });
  assert.deepEqual(failed.toasts, [{ t: '证据没有导出：EACCES', tone: 'bad' }]);
  const rejected = await runExport(true, () => Promise.reject(new Error('IPC 断开')));
  assert.deepEqual(rejected.toasts, [{ t: '证据没有导出：IPC 断开', tone: 'bad' }]);
  // Browser: the blob download, as before.
  const browser = await runExport(false);
  assert.equal(browser.clicks.length, 1);
  assert.match(browser.clicks[0].download, /^room-evidence-demo-\d+\.json$/);
  assert.deepEqual(browser.toasts, [{ t: '已导出证据 JSON', tone: 'ok' }]);
});

test('app/package.json: 圆桌, ESM main, version of the root package.json', () => {
  const app = JSON.parse(read('app/package.json'));
  const rootPkg = JSON.parse(read('package.json'));
  assert.equal(app.name, 'room-dev-app');
  assert.equal(app.productName, '圆桌');
  assert.equal(app.version, rootPkg.version);
  assert.equal(app.type, 'module');
  assert.equal(app.main, 'main.mjs');
  assert.equal(rootPkg.scripts.app, 'node dist/build-app.mjs');
});

test('ui/lobby.js uses window.roomApp when present: 浏览… picker, app clipboard, window.open after the lobby answers', () => {
  const c = code('ui/lobby.js');
  assert.match(c, /var APP = \(typeof window !== 'undefined' && window\.roomApp && window\.roomApp\.isApp === true\) \? window\.roomApp : null;/);
  assert.match(c, /APP\.pickFolder\(/);
  assert.match(c, /text: '浏览…'/);
  assert.match(c, /APP\.copyText\(text\)/);
  assert.match(c, /if \(APP\) \{ openRoomUiInApp\(id, btn\); return; \}/);
  assert.match(c, /window\.open\(url, '_blank'\)/);
  assert.match(c, /showRoomLink\(id, url, false\)/, 'the fallback link stays');
});

// ---------------------------------------------------------------- icon

test('icon: committed app/icon.ico is what dist/make-icon.mjs draws; valid ICO with 7 PNG entries', () => {
  const committed = fs.readFileSync(path.join(ROOT, 'app', 'icon.ico'));
  // Same pixels as the generator draws (compared decoded: deflate bytes may differ between zlib builds).
  const fresh = readIco(buildIco());
  const pixels = (png) => zlib.inflateSync(png.subarray(8 + 25 + 8, png.length - 12 - 4));
  readIco(committed).forEach((e, k) => assert.ok(pixels(e.png).equals(pixels(fresh[k].png)), `size ${e.width}: regenerate with node dist/make-icon.mjs`));
  assert.equal(committed.readUInt16LE(0), 0);
  assert.equal(committed.readUInt16LE(2), 1, 'type icon');
  assert.equal(committed.readUInt16LE(4), 7, 'entry count');
  const entries = readIco(committed);
  assert.deepEqual(entries.map((e) => e.width), [...ICON_SIZES]);
  assert.deepEqual(ICON_SIZES, [16, 24, 32, 48, 64, 128, 256]);
  for (const e of entries) {
    assert.equal(e.bpp, 32);
    assert.ok(e.png.subarray(0, 8).equals(PNG_SIGNATURE), `PNG signature at ${e.width}`);
    assert.equal(e.png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(e.png.readUInt32BE(16), e.width);
    assert.equal(e.png.readUInt32BE(20), e.height);
    assert.equal(e.png.toString('ascii', e.png.length - 8, e.png.length - 4), 'IEND');
    assert.ok(e.offset + e.bytes <= committed.length);
  }
  // The glyph: transparent corners, a filled table in the middle, four seats around it.
  const s = 64;
  const px = renderIcon(s);
  const alpha = (x, y) => px[(y * s + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(32, 32), 255);
  for (const [x, y] of [[32, 6], [58, 32], [32, 58], [6, 32]]) assert.equal(alpha(x, y), 255, `seat at ${x},${y}`);
  // The PNG decodes back to the same pixels (filter 0 rows).
  const png = encodePng(px, s, s);
  const idat = png.subarray(8 + 25 + 8, png.length - 12 - 4);
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, (s * 4 + 1) * s);
  assert.ok(raw.subarray(1, 1 + s * 4).equals(px.subarray(0, s * 4)));
});

// ---------------------------------------------------------------- build-app (dry run)

test('build-app: argument parsing, version helpers, rcedit arguments', () => {
  assert.deepEqual(parseBuildAppArgs(['--electron-zip', 'a.zip', '--out', 'o', '--zip', '--dry-run', '--rcedit', 'r.exe']), { electronZip: 'a.zip', rcedit: 'r.exe', out: 'o', zip: true, dryRun: true, help: false });
  assert.throws(() => parseBuildAppArgs(['--download']), /未知参数/);
  assert.throws(() => parseBuildAppArgs(['--out']), /路径/);
  assert.equal(electronVersionFromName('C:\\x\\electron-v43.6.0-win32-x64.zip'), '43.6.0');
  assert.equal(electronVersionFromName('electron-v43.6.0-darwin-x64.zip'), null);
  assert.equal(numericVersion('0.1.0-dev'), '0.1.0.0');
  assert.equal(numericVersion('1.2.3.4.5'), '1.2.3.4');
  const a = rceditArgs({ exe: 'X.exe', icon: 'i.ico', version: '0.1.0-dev' });
  const pairs = {};
  for (let i = 0; i < a.length; i++) if (a[i] === '--set-version-string') { pairs[a[i + 1]] = a[i + 2]; i += 2; }
  assert.deepEqual(pairs, { FileDescription: '圆桌', ProductName: '圆桌', CompanyName: 'KennyMcSimpson', OriginalFilename: '圆桌.exe', InternalName: '圆桌' });
  assert.equal(a[a.indexOf('--set-icon') + 1], 'i.ico');
  assert.equal(a[a.indexOf('--set-file-version') + 1], '0.1.0.0');
  assert.equal(a[a.indexOf('--set-product-version') + 1], '0.1.0.0');
  assert.equal(EXE_NAME, '圆桌.exe');
});

test('build-app: the zip and rcedit locators read the caches and pick the newest', () => {
  const b = base('loc');
  const cache = path.join(b, 'Local', 'electron', 'Cache');
  const put = (dir, name) => { fs.mkdirSync(path.join(cache, dir), { recursive: true }); fs.writeFileSync(path.join(cache, dir, name), 'x'); return path.join(cache, dir, name); };
  put('h1', 'electron-v38.8.4-win32-x64.zip');
  const want = put('h2', 'electron-v43.6.0-win32-x64.zip');
  put('h3', 'electron-v44.0.0-darwin-x64.zip');
  put('h4', 'electron-v43.10.0-linux-x64.zip');
  const env = { LOCALAPPDATA: path.join(b, 'Local') };
  const found = locateElectronZip({ env });
  assert.equal(found.path, want);
  assert.equal(found.version, '43.6.0');
  assert.equal(found.source, 'cache');
  assert.equal(locateElectronZip({ env, option: want }).source, 'option');
  assert.equal(locateElectronZip({ env: { ...env, ROOM_ELECTRON_ZIP: want } }).source, 'env');
  assert.throws(() => locateElectronZip({ env, option: path.join(b, 'nope.zip') }), (e) => e instanceof BuildRefusal && e.code === 'ELECTRON_ZIP_MISSING');
  assert.equal(locateElectronZip({ env: { LOCALAPPDATA: path.join(b, 'empty') } }), null);
  assert.equal(locateElectronZip({ env: {} }), null);
  const wcs = path.join(b, 'Local', 'electron-builder', 'Cache', 'winCodeSign', '1');
  fs.mkdirSync(wcs, { recursive: true });
  fs.writeFileSync(path.join(wcs, 'rcedit-x64.exe'), 'x');
  assert.equal(locateRcedit({ env }).path, path.join(wcs, 'rcedit-x64.exe'));
  assert.equal(locateRcedit({ env: { LOCALAPPDATA: path.join(b, 'empty') } }), null);
});

test('build-app --dry-run: file plan ships app/ and the room-dev runtime, not fixtures, tests or dist', async () => {
  const b = base('plan');
  const zip = path.join(b, 'electron-v43.6.0-win32-x64.zip');
  fs.writeFileSync(zip, 'not read in a dry run');
  const out = path.join(b, 'out');
  const r = await buildApp({ dryRun: true, electronZip: zip, out, env: { LOCALAPPDATA: path.join(b, 'none') }, log: () => {} });
  assert.equal(r.dryRun, true);
  assert.equal(r.out, path.join(out, '圆桌'));
  assert.ok(!fs.existsSync(out), 'a dry run writes nothing');
  const dests = new Set(r.plan.map((p) => p.dest));
  for (const d of ['resources/app/main.mjs', 'resources/app/main-helpers.mjs', 'resources/app/preload.cjs', 'resources/app/icon.ico', 'resources/app/package.json',
    'resources/app/room-dev/room.mjs', 'resources/app/room-dev/package.json', 'resources/app/room-dev/README.md', 'resources/app/room-dev/LICENSE', 'resources/app/room-dev/docs/INTERFACES.md',
    'resources/app/room-dev/lib/lobby.mjs', 'resources/app/room-dev/lib/join.mjs', 'resources/app/room-dev/lib/hosted/pi.mjs', 'resources/app/room-dev/lib/templates/preamble.md',
    'resources/app/room-dev/ui/lobby.html', 'resources/app/room-dev/ui/lobby.js', 'resources/app/room-dev/ui/index.html', 'resources/app/room-dev/ui/app.js']) {
    assert.ok(dests.has(d), d);
  }
  for (const d of dests) {
    assert.ok(d.startsWith('resources/app/'), d);
    assert.ok(!/\/(test|dist|sim|contract|evidence|fixtures)\//.test(d), d);
    assert.ok(!d.endsWith('mock-server.mjs'), d);
  }
  assert.equal(runtimeExcluded('ui/fixtures/state.json'), true);
  assert.equal(runtimeExcluded('ui/mock-server.mjs'), true);
  assert.equal(runtimeExcluded('ui/lobby.js'), false);
  // Every lib/ module is shipped (lib/ must run on its own).
  const libFiles = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(path.join(d, e.name), r); else libFiles.push(r); } };
  walk(path.join(ROOT, 'lib'), 'lib');
  for (const f of libFiles) assert.ok(dests.has(`resources/app/room-dev/${f}`), f);
  assert.equal(planAppFiles().missing.length, 0);
});

test('build-app refuses without an Electron zip and never downloads (function and CLI)', async () => {
  const b = base('nozip');
  const out = path.join(b, 'out');
  await assert.rejects(buildApp({ dryRun: true, out, env: { LOCALAPPDATA: path.join(b, 'empty') }, log: () => {} }), (e) => e instanceof BuildRefusal && e.code === 'NO_ELECTRON_ZIP' && /不下载/.test(e.message) && /--electron-zip/.test(e.message));
  const env = { ...process.env, LOCALAPPDATA: path.join(b, 'empty') };
  delete env.ROOM_ELECTRON_ZIP;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'build-app.mjs'), '--out', out], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^REFUSED NO_ELECTRON_ZIP/m);
  assert.match(r.stderr, /本脚本不下载任何东西/);
  assert.ok(!fs.existsSync(out), 'nothing written');
  const src = code('dist/build-app.mjs');
  assert.ok(!/\bfetch\(|https?:\/\/|node:https|node:http\b/.test(src), 'no network code in build-app');
});

test('build-app removes folders by non-ASCII paths (圆桌) and never leaves default_app.asar or fs.rmSync in play', async () => {
  const b = base('rmtree');
  const d = path.join(b, `.${'圆桌'}.old-test`, 'resources');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'x.bin'), 'x');
  await removeTree(path.dirname(d));
  assert.ok(!fs.existsSync(path.dirname(d)), 'non-ASCII folder removed');
  assert.equal(DEFAULT_APP_ASAR, 'resources/default_app.asar');
  // read(), not code(): the build script's strings contain glob paths like Cache\*\ that code()'s
  // block-comment stripping would cut.
  const src = read('dist/build-app.mjs');
  assert.ok(!/\bfs\.rmSync\(/.test(src), 'build-app does not use fs.rmSync (silently a no-op on non-ASCII paths under Node 24.11)');
  assert.match(src, /rel\.toLowerCase\(\) === DEFAULT_APP_ASAR\) continue/, 'default_app.asar is never extracted');
});

// ---------------------------------------------------------------- lobby parentPort

function req(port, { method = 'GET', pathname = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('lobby under a parent port: announces opened rooms (no token), {t:quit} closes them and exits 0', async () => {
  const b = base('port');
  const roomsRoot = path.join(b, 'rooms');
  const port = new EventEmitter();
  const posted = [];
  port.postMessage = (m) => posted.push(m);
  let exitCode = null;
  let exited;
  const exitedP = new Promise((r) => { exited = r; });
  const lobby = await startLobby({ port: 0, roomsRoot, parentPort: port, exit: (c) => { exitCode = c; exited(c); } });
  assert.equal(port.listenerCount('message'), 1);
  const create = await req(lobby.port, { method: 'POST', pathname: '/lobby/api/create', body: { token: lobby.token, id: 'pp', seats: [{ seatId: 'A', role: 'participant', agent: 'generic', cwd: path.join(b, 'seats', 'A'), createCwd: true }] } });
  assert.equal(create.status, 200, JSON.stringify(create.json));
  const open = await req(lobby.port, { method: 'POST', pathname: '/lobby/api/open', body: { token: lobby.token, id: 'pp' } });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const roomPort = Number(new URL(open.json.url).port);
  assert.deepEqual(posted, [{ t: 'room-opened', id: 'pp', port: roomPort }]);
  assert.ok(!JSON.stringify(posted).includes(lobby.token) && !JSON.stringify(posted).includes(new URL(open.json.url).hash.slice(1)), 'no token in messages');
  const lock = path.join(roomsRoot, 'pp', F.lock);
  assert.ok(fs.existsSync(lock), 'the room service holds its lock');
  // Messages that are not {t:'quit'} are ignored; Electron wraps the message in {data}.
  port.emit('message', { data: { t: 'hello' } });
  port.emit('message', { data: 'quit' });
  assert.equal(exitCode, null);
  port.emit('message', { data: { t: 'quit' } });
  assert.equal(await exitedP, 0);
  assert.ok(!fs.existsSync(lock), 'service.lock removed by the graceful quit');
  assert.deepEqual(posted.at(-1), { t: 'room-closed', id: 'pp', port: roomPort });
  assert.equal(port.listenerCount('message'), 0, 'listener removed on close');
  await assert.rejects(req(lobby.port, { pathname: '/lobby/api/meta' }), 'the lobby no longer listens');
});

test('lobby without a parent port (CLI) does not exit the process and posts nothing', async () => {
  const b = base('noport');
  const lobby = await startLobby({ port: 0, roomsRoot: path.join(b, 'rooms'), parentPort: undefined, exit: () => { throw new Error('must not exit'); } });
  await lobby.close();
  const src = code('lib/lobby.mjs');
  assert.match(src, /parentPort = process\.parentPort/);
});

// ---------------------------------------------------------------- seat runtime fallback

const FAKE_EXE = WIN ? 'C:\\Program Files\\圆桌\\圆桌.exe' : '/opt/圆桌/圆桌';

test('nodeOnPath / seatRuntimeFor: node on PATH wins; otherwise ROOM_SEAT_RUNTIME (absolute) is the runtime', () => {
  const winFs = (set) => (p) => set.has(p);
  assert.equal(nodeOnPath({ Path: 'C:\\a;"C:\\Program Files\\nodejs";C:\\b' }, { platform: 'win32', isFile: winFs(new Set(['C:\\Program Files\\nodejs\\node.exe'])) }), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(nodeOnPath({ PATH: 'C:\\a;relative' }, { platform: 'win32', isFile: () => false }), null);
  assert.equal(nodeOnPath({ PATH: 'C:\\shims' }, { platform: 'win32', isFile: winFs(new Set(['C:\\shims\\node.cmd'])) }), null, 'only node.exe');
  assert.equal(nodeOnPath({ PATH: '/usr/bin:/bin' }, { platform: 'linux', isFile: (p) => p === '/usr/bin/node' }), '/usr/bin/node');
  assert.equal(nodeOnPath({}, { platform: 'win32', isFile: () => true }), null);
  // This test process runs on node, so the real PATH lookup finds one only when PATH has it; the
  // injected finder decides the branch below.
  assert.equal(seatRuntimeFor({ env: { ROOM_SEAT_RUNTIME: FAKE_EXE }, findNode: () => 'C:\\node.exe' }), null, 'node on PATH: unchanged');
  assert.deepEqual(seatRuntimeFor({ env: { ROOM_SEAT_RUNTIME: FAKE_EXE }, findNode: () => null }), { kind: 'app', exe: path.resolve(FAKE_EXE) });
  assert.equal(seatRuntimeFor({ env: {}, findNode: () => null }), null, 'neither: unchanged (node text)');
  assert.equal(seatRuntimeFor({ env: { ROOM_SEAT_RUNTIME: 'relative.exe' }, findNode: () => null }), null);
});

test('room.cmd for an app-runtime seat runs room.mjs on the app exe with ELECTRON_RUN_AS_NODE=1', () => {
  const roomMjs = WIN ? 'C:\\Program Files\\圆桌\\resources\\app\\room-dev\\room.mjs' : '/opt/圆桌/resources/app/room-dev/room.mjs';
  const t = renderRoomCmd({ roomMjs, runtime: { kind: 'app', exe: FAKE_EXE } });
  assert.ok(!/[^\r]\n/.test(t), 'CRLF only');
  assert.deepEqual(t.split('\r\n'), ['@echo off', 'chcp 65001 >nul', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"', `"${path.resolve(FAKE_EXE)}" "${path.resolve(roomMjs)}" %*`, 'exit /b %ERRORLEVEL%', '']);
  // The node form is unchanged.
  assert.equal(renderRoomCmd({ roomMjs: WIN ? 'C:\\room-dev\\room.mjs' : '/room-dev/room.mjs' }), `@echo off\r\nnode "${path.resolve(WIN ? 'C:\\room-dev\\room.mjs' : '/room-dev/room.mjs')}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
});

test('JOIN.md: node seats keep node <room.mjs> and its rule; app-runtime seats are told to call room.cmd', () => {
  const roomMjs = WIN ? 'C:\\room-dev\\room.mjs' : '/room-dev/room.mjs';
  const seatDir = WIN ? 'C:\\Users\\u\\room-dev\\rooms\\demo\\seats\\B' : '/home/u/room-dev/rooms/demo/seats/B';
  const roomDir = path.dirname(path.dirname(seatDir));
  const seat = { seatId: 'B', role: 'executor', agent: 'claude-code', waitMode: 'background', cwd: WIN ? 'D:\\work\\demo' : '/work/demo', wake: { enabled: false } };
  const mjs = cmdPath(roomMjs);
  const nodeMd = renderJoin({ room: { id: 'demo' }, seat, seatDir, roomDir, roomMjs, agent: 'claude-code' });
  assert.ok(nodeMd.includes(`Bash(node ${mjs}:*)`));
  assert.ok(nodeMd.includes(`node ${mjs} wait --seat`));
  const appSeat = { ...seat, runtime: { kind: 'app', exe: FAKE_EXE } };
  const rc = cmdPath(path.join(seatDir, 'room.cmd'));
  assert.equal(seatCommandPrefix({ seat: appSeat, seatDir, roomMjs }), rc);
  assert.equal(seatCommandPrefix({ seat, seatDir, roomMjs }), `node ${mjs}`);
  assert.equal(seatRoomCmd({ seat: appSeat, seatDir, fallback: 'F' }), rc);
  assert.equal(seatRoomCmd({ seat, seatDir, fallback: 'F' }), 'F');
  const md = renderJoin({ room: { id: 'demo' }, seat: appSeat, seatDir, roomDir, roomMjs, agent: 'claude-code' });
  assert.ok(md.includes(`Bash(${rc}:*)`), 'allow rule for room.cmd');
  assert.ok(!md.includes(`Bash(node `), 'no node rule');
  assert.ok(md.includes(`${rc} wait --seat`) && md.includes(`${rc} submit --seat`) && md.includes(`${rc} leave --seat`) && md.includes(`${rc} status --seat`));
  assert.ok(!/\bnode [A-Za-z/"]/.test(md.replace(/不要改用 node/g, '')), 'no node command anywhere');
  assert.match(md, /PATH 上没有 node/);
  const codex = renderJoin({ room: { id: 'demo' }, seat: { ...appSeat, agent: 'codex-cli', waitMode: 'turn_over' }, seatDir, roomDir, roomMjs, agent: 'codex-cli' });
  assert.ok(codex.includes(`只放行 ${rc} 这一个命令前缀`));
});

test('admin add-seat records the runtime only without node on PATH; packets and the room.cmd follow it', async () => {
  const b = base('rt');
  const roomDir = path.join(b, 'room');
  const cwdA = path.join(b, 'cwd-A');
  const cwdB = path.join(b, 'cwd-B');
  fs.mkdirSync(cwdA); fs.mkdirSync(cwdB);
  const lines = [];
  const io = (env) => ({ out: (l) => lines.push(l), env: { CLAUDE_CONFIG_DIR: path.join(b, 'claude-home'), ...env }, redirect: () => null });
  assert.equal(ADMIN_COMMANDS.init({ dir: roomDir, id: 'rt', _: ['init'] }, io({})), 0);
  // A: no node on PATH, created by the app.
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, seat: 'A', role: 'participant', agent: 'claude-code', cwd: cwdA, _: ['add-seat'] }, io({ PATH: '', ROOM_SEAT_RUNTIME: FAKE_EXE })), 0, lines.join('\n'));
  // B: node on PATH (the directory of this test's node binary).
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, seat: 'B', role: 'participant', agent: 'claude-code', cwd: cwdB, _: ['add-seat'] }, io({ PATH: path.dirname(process.execPath), ROOM_SEAT_RUNTIME: FAKE_EXE })), 0, lines.join('\n'));
  const seatA = JSON.parse(fs.readFileSync(path.join(roomDir, 'seats', 'A', 'seat.json'), 'utf8'));
  const seatB = JSON.parse(fs.readFileSync(path.join(roomDir, 'seats', 'B', 'seat.json'), 'utf8'));
  assert.deepEqual(seatA.runtime, { kind: 'app', exe: path.resolve(FAKE_EXE) });
  if (path.basename(process.execPath).toLowerCase() === (WIN ? 'node.exe' : 'node')) assert.equal(seatB.runtime, undefined, 'node on PATH: nothing recorded');
  const cmdA = fs.readFileSync(path.join(roomDir, 'seats', 'A', 'room.cmd'), 'utf8');
  assert.match(cmdA, /set "ELECTRON_RUN_AS_NODE=1"/);
  const joinA = fs.readFileSync(path.join(roomDir, 'seats', 'A', 'JOIN.md'), 'utf8');
  const rcA = cmdPath(path.join(roomDir, 'seats', 'A', 'room.cmd'));
  assert.ok(joinA.includes(`Bash(${rcA}:*)`));
  const joinB = fs.readFileSync(path.join(roomDir, 'seats', 'B', 'JOIN.md'), 'utf8');
  if (!seatB.runtime) assert.match(joinB, /Bash\(node /);

  // The packet the service issues to A names A's room.cmd.
  const svc = createRoomService({
    roomDir, now: () => Date.parse('2026-10-04T00:00:00Z'), log: () => {}, codexExe: null, gitExe: null,
    spawn: async () => ({ code: 0, signal: null, stdout: '', stderr: '', raw: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, truncated: false, timedOut: false, spawnError: null }),
    adjudicationsPath: path.join(b, 'adjudications.jsonl'), savedPiKeyPath: path.join(b, 'secrets', 'pi-key.dpapi'), idleCheck: async () => ({ idle: true, note: 'test' }),
  });
  try {
    await svc.admin({ cmd: 'task', text: 't' });
    await svc.admin({ cmd: 'start', order: ['A', 'B'] });
    for (let i = 0; i < 3; i++) { await svc.tick(); await svc.settle(); }
    const issued = readJsonl(path.join(roomDir, F.events)).filter((e) => e.type === 'packet_issued' && e.seatId === 'A');
    assert.ok(issued.length >= 1, 'A got a packet');
    const pkt = fs.readFileSync(path.join(roomDir, F.packets, `${issued[0].packetId}.md`), 'utf8');
    assert.ok(pkt.includes(rcA), 'packet names A\'s room.cmd');
  } finally {
    await svc.close();
  }
});

// ---------------------------------------------------------------- F1: lock probe with a non-ASCII image

test('service.lock probe: a holder named 圆桌 is recognised (base64 name, not the OEM code page)', async () => {
  const { probeLockHolder, lockProbeScript, parseLockProbeOutput } = await import('../lib/service.mjs');
  const now = Date.now();
  const lock = { pid: 4321, image: '圆桌', procStartedAt: '2026-10-01T08:00:00.000Z', heartbeatAt: new Date(now).toISOString() };
  const fake = (stdout) => async (cmd, args) => { assert.equal(cmd, 'powershell.exe'); assert.match(args.at(-1), /ToBase64String\(\[Text\.Encoding\]::UTF8\.GetBytes\(\$p\.ProcessName\)\)/); return { code: 0, stdout, stderr: '', spawnError: null, timedOut: false }; };
  const b64 = (s) => `b64:${Buffer.from(s, 'utf8').toString('base64')}`;
  const alive = () => true;
  assert.equal(await probeLockHolder(lock, { spawn: fake(`${b64('圆桌')}|2026-10-01T07:59:59.9000000Z\r\n`), isAlive: alive, nowMs: now }), 'alive', 'the app holding its room');
  assert.equal(await probeLockHolder(lock, { spawn: fake(`${b64('node')}|2026-10-01T07:59:59.9000000Z\r\n`), isAlive: alive, nowMs: now }), 'stale', 'another image');
  assert.equal(await probeLockHolder(lock, { spawn: fake(`b64:%%%|2026-10-01T07:59:59.9000000Z`), isAlive: alive, nowMs: now }), 'unknown', 'unreadable name: do not take over');
  assert.deepEqual(parseLockProbeOutput(`${b64('圆桌')}|t\r\n`), ['圆桌', 't']);
  assert.deepEqual(parseLockProbeOutput('node|t'), ['node', 't'], 'plain form still parsed');
  assert.match(lockProbeScript(12), /^\$p = Get-Process -Id 12 /);
  assert.ok(/^[\x20-\x7e]*$/.test(lockProbeScript(12)), 'the script itself is ASCII');
});

test('service.lock probe on the real PowerShell: a running process whose image is non-ASCII is "alive"', { skip: !WIN && 'Windows only' }, async () => {
  const { probeLockHolder } = await import('../lib/service.mjs');
  const b = base('probe');
  // A hard link (or a copy) of this node binary under a Chinese name, so the OS reports a non-ASCII image.
  const exe = path.join(b, '圆桌探测.exe');
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
  const { spawn } = await import('node:child_process');
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const lock = { pid: child.pid, image: '圆桌探测', procStartedAt: new Date(Date.now() + 1000).toISOString(), heartbeatAt: new Date().toISOString() };
    assert.equal(await probeLockHolder(lock), 'alive');
    assert.equal(await probeLockHolder({ ...lock, image: 'node' }), 'stale', 'a different image is still told apart');
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
  }
});

// ---------------------------------------------------------------- F3: a seat keeps its own room.mjs

test('a seat keeps the room.mjs it was created with when another copy (the app\'s bundled one) renders its commands', async () => {
  const { pathToFileURL } = await import('node:url');
  const { roomMjsPath } = await import('../lib/common.mjs');
  const b = base('mjs');
  // Copy B: lib/ + room.mjs in another folder, like the app's resources/app/room-dev.
  const copyB = path.join(b, 'bundled', 'room-dev');
  fs.cpSync(path.join(ROOT, 'lib'), path.join(copyB, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'room.mjs'), path.join(copyB, 'room.mjs'));
  const B = await import(pathToFileURL(path.join(copyB, 'lib', 'common.mjs')).href);
  const joinB = await import(pathToFileURL(path.join(copyB, 'lib', 'join.mjs')).href);
  const lobbyB = await import(pathToFileURL(path.join(copyB, 'lib', 'lobby.mjs')).href);
  const serviceB = await import(pathToFileURL(path.join(copyB, 'lib', 'service.mjs')).href);
  const A = path.resolve(roomMjsPath());
  assert.equal(B.roomMjsPath(), path.join(copyB, 'room.mjs'));
  assert.notEqual(B.roomMjsPath(), A);

  // The seat is created by copy A (this repository), node on PATH.
  const roomDir = path.join(b, 'room');
  const cwd = path.join(b, 'cwd-A');
  fs.mkdirSync(cwd);
  const lines = [];
  const io = { out: (l) => lines.push(l), env: { CLAUDE_CONFIG_DIR: path.join(b, 'claude-home'), PATH: path.dirname(process.execPath) }, redirect: () => null };
  assert.equal(ADMIN_COMMANDS.init({ dir: roomDir, id: 'mjs', _: ['init'] }, io), 0);
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, seat: 'A', role: 'participant', agent: 'claude-code', cwd, _: ['add-seat'] }, io), 0, lines.join('\n'));
  const seatDir = path.join(roomDir, 'seats', 'A');
  const seat = JSON.parse(fs.readFileSync(path.join(seatDir, 'seat.json'), 'utf8'));
  if (seat.runtime) return; // this node is not node.exe on PATH: app-runtime seat, covered above
  assert.equal(seat.roomMjs, A, 'add-seat records its room.mjs');
  assert.equal(JSON.parse(fs.readFileSync(path.join(roomDir, 'room.json'), 'utf8')).seats[0].roomMjs, A);
  const wantPrefix = `node ${cmdPath(A)}`;
  const join = fs.readFileSync(path.join(seatDir, 'JOIN.md'), 'utf8');
  assert.ok(join.includes(`Bash(${wantPrefix}:*)`));

  // Rendered by copy B: command prefix, packet/wake prefix, lobby hint all still say A.
  const check = (s, what) => { assert.ok(s.includes(wantPrefix), `${what}: ${s}`); assert.ok(!s.includes(cmdPath(B.roomMjsPath())), `${what} names copy B`); };
  check(joinB.seatCommandPrefix({ seat, seatDir, roomMjs: B.roomMjsPath() }), 'seatCommandPrefix');
  check(joinB.seatRoomCmd({ seat, seatDir, fallback: `node ${B.fwd(B.roomMjsPath())}` }), 'seatRoomCmd');
  const hint = lobbyB.seatHint({ agent: 'claude-code', cwd, prefix: joinB.seatCommandPrefix({ seat, seatDir, roomMjs: B.roomMjsPath() }) });
  check(hint, 'lobby hint');
  assert.ok(hint.includes(`Bash(${wantPrefix}:*)`), 'the hint names the JOIN.md rule');
  // A seat created before seat.roomMjs existed: read back from its own room.cmd.
  const old = { ...seat };
  delete old.roomMjs;
  check(joinB.seatCommandPrefix({ seat: old, seatDir, roomMjs: B.roomMjsPath() }), 'old seat prefix (room.cmd)');
  check(joinB.seatRoomCmd({ seat: old, seatDir, fallback: `node ${B.fwd(B.roomMjsPath())}` }), 'old seat packet prefix (room.cmd)');
  // No record and no room.cmd: the running copy, as before.
  assert.equal(joinB.seatRoomCmd({ seat: old, seatDir: path.join(b, 'nowhere'), fallback: 'F' }), 'F');

  // Copy B's room service issues A's packet and wake text with A's room.mjs.
  const svc = serviceB.createRoomService({
    roomDir, now: () => Date.parse('2026-10-04T00:00:00Z'), log: () => {}, codexExe: null, gitExe: null,
    spawn: async () => ({ code: 0, signal: null, stdout: '', stderr: '', raw: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, truncated: false, timedOut: false, spawnError: null }),
    adjudicationsPath: path.join(b, 'adjudications.jsonl'), savedPiKeyPath: path.join(b, 'secrets', 'pi-key.dpapi'), idleCheck: async () => ({ idle: true, note: 'test' }),
  });
  try {
    await svc.admin({ cmd: 'task', text: 't' });
    await svc.admin({ cmd: 'start', order: ['A'] });
    for (let i = 0; i < 3; i++) { await svc.tick(); await svc.settle(); }
    const issued = readJsonl(path.join(roomDir, F.events)).filter((e) => e.type === 'packet_issued' && e.seatId === 'A');
    assert.ok(issued.length >= 1, 'A got a packet');
    const pkt = fs.readFileSync(path.join(roomDir, F.packets, `${issued[0].packetId}.md`), 'utf8');
    check(pkt, 'packet');
  } finally {
    await svc.close();
  }
});

test('lobby seat hint follows the seat runtime', async () => {
  const { seatHint } = await import('../lib/lobby.mjs');
  const rc = 'C:/Users/u/room-dev/rooms/r/seats/A/room.cmd';
  assert.match(seatHint({ agent: 'claude-code', cwd: 'C:\\w', prefix: rc }), new RegExp(`Bash\\(${rc.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:\\*\\)`));
  assert.match(seatHint({ agent: 'claude-code', cwd: 'C:\\w' }), /Bash\(node /);
  assert.match(seatHint({ agent: 'gemini-cli', cwd: 'C:\\w', prefix: rc }), new RegExp(`只放行 ${rc.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} 这一个命令前缀`));
});
