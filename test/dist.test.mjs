// dist/build.mjs: build with --no-download into a temp dir and check the archive with an independent,
// minimal zip reader written here (so the writer is not graded by its own reader).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testRunsRoot } from '../lib/common.mjs';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = path.join(ROOT, 'dist', 'build.mjs');
const rand = Math.random().toString(16).slice(2, 8);
const base = path.join(testRunsRoot(), `dist-${rand}`);
const outDir = path.join(base, 'out');

// Minimal zip reader: EOCD -> central directory -> local headers; stored or deflate; returns a map.
function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'EOCD record present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `local header signature for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, usize, `size of ${name}`);
    entries.set(name, { data, method, crc, utf8: (flags & 0x0800) !== 0 });
  }
  return entries;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

let built;
let entries;
let top;

test('build --no-download produces the zip and reports placeholder', () => {
  fs.mkdirSync(base, { recursive: true });
  const r = spawnSync(process.execPath, [BUILD, '--no-download', '--out', outDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, `build exit 0\n${r.stdout}\n${r.stderr}`);
  const m = r.stdout.match(/^BUILT zip=(\S+) entries=(\d+) bytes=(\d+) sha256=([0-9a-f]{64}) node=placeholder$/m);
  assert.ok(m, `BUILT line present and node=placeholder\n${r.stdout}`);
  assert.match(r.stdout, /--no-download/, 'build output says the runtime was not downloaded');
  built = { zipPath: m[1], entries: Number(m[2]), bytes: Number(m[3]), sha256: m[4] };
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  top = `room-dev-${pkg.version}-win-x64`;
  assert.equal(path.basename(built.zipPath), `${top}.zip`);
  assert.ok(fs.existsSync(built.zipPath), 'zip exists');
  assert.ok(fs.existsSync(`${built.zipPath}.sha256`), 'sha256 sidecar exists');
  const buf = fs.readFileSync(built.zipPath);
  assert.equal(buf.length, built.bytes, 'reported byte count matches file');
  entries = listZip(buf);
  assert.equal(entries.size, built.entries, 'reported entry count matches central directory');
});

test('zip lists launcher, THIRD-PARTY, BUILD.json, node placeholder and the project files', () => {
  const names = [...entries.keys()];
  for (const expected of [`${top}/launch.cmd`, `${top}/THIRD-PARTY.md`, `${top}/BUILD.json`, `${top}/node/PLACEHOLDER.txt`, `${top}/app/room.mjs`, `${top}/app/package.json`, `${top}/app/README.md`, `${top}/app/LICENSE`, `${top}/app/docs/INTERFACES.md`]) {
    assert.ok(entries.has(expected), `entry ${expected} present; have ${names.filter((n) => !n.includes('/app/lib/')).join(', ')}`);
  }
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs'));
  assert.ok(libFiles.length > 0, 'lib/ has modules');
  for (const f of libFiles) assert.ok(entries.has(`${top}/app/lib/${f}`), `lib/${f} packed`);
  if (fs.existsSync(path.join(ROOT, 'ui'))) {
    assert.ok(names.some((n) => n.startsWith(`${top}/app/ui/`)), 'ui/ packed when present');
  }
  assert.ok(!names.some((n) => n.includes('/app/test/') || n.includes('/app/dist/') || n.includes('node_modules')), 'tests, dist tooling and node_modules are not packed');
  assert.ok(!names.some((n) => n.includes('/app/docs/internal/')), 'docs/internal/ (machine-specific records) is not packed');
  assert.ok(!names.some((n) => n.includes('/app/docs/assets/')), 'docs/assets/ (README artwork and screenshots) is not packed');
  assert.ok(!names.some((n) => n.endsWith('/')), 'no directory entries');
  assert.ok(names.every((n) => n.startsWith(`${top}/`)), 'every entry under the top-level folder');
});

test('entry bytes equal the source files and CRCs are right', () => {
  for (const [name, e] of entries) {
    assert.equal(crc32(e.data), e.crc, `crc of ${name}`);
    assert.ok(e.utf8, `${name} flagged as UTF-8 name`);
  }
  const roomMjs = entries.get(`${top}/app/room.mjs`).data;
  assert.ok(roomMjs.equals(fs.readFileSync(path.join(ROOT, 'room.mjs'))), 'room.mjs bytes identical');
  const third = entries.get(`${top}/THIRD-PARTY.md`).data;
  assert.ok(third.equals(fs.readFileSync(path.join(ROOT, 'dist', 'THIRD-PARTY.md'))), 'THIRD-PARTY.md bytes identical');
  const placeholder = entries.get(`${top}/node/PLACEHOLDER.txt`).data.toString('utf8');
  assert.match(placeholder, /--no-download/);
});

test('launcher is rendered: no placeholders left, CRLF, no BOM, ASCII first line, English prose', () => {
  const cmd = entries.get(`${top}/launch.cmd`).data;
  assert.notEqual(cmd[0], 0xef, 'no BOM');
  const text = cmd.toString('utf8');
  assert.ok(text.startsWith('@echo off\r\n'), 'starts with @echo off + CRLF');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'no unrendered placeholders');
  assert.ok(!/[^\r]\n/.test(text), 'all line endings are CRLF');
  assert.match(text, /chcp 65001/);
  assert.match(text, /room-dev\\rooms/);
  // The launcher starts the lobby (rooms are created and opened there), keeping the node-runtime logic.
  assert.match(text, /^"%NODE_EXE%" "%APP%" lobby --open --port %PORT%\r$/m);
  assert.match(text, /set "NODE_EXE=%ROOT%node\\node\.exe"/);
  assert.match(text, /set "NODE_EXE=node"/);
  assert.ok(!/admin\.token|#token=|serve --dir/.test(text), 'no room token or direct serve in the launcher');
  assert.match(text, /Runtime not bundled in this archive/, 'placeholder build says the runtime is not bundled');
  assert.match(text, /Requirements/);
});

// W1: the launcher must put rooms where defaultRoomsRoot() says, never under AppData (INTERFACES §1).
test('launcher rooms root is never AppData and follows ROOM_DEV_HOME like appRoot()', async () => {
  const text = entries.get(`${top}/launch.cmd`).data.toString('utf8');
  assert.ok(!/%(?:LOCAL)?APPDATA%/i.test(text), 'rendered launcher never names %LOCALAPPDATA% or %APPDATA%');
  const { checkLauncher } = await import('../dist/build.mjs');
  assert.doesNotThrow(() => checkLauncher(text));
  assert.throws(() => checkLauncher(text.replace('%USERPROFILE%\\room-dev\\rooms', '%LOCALAPPDATA%\\room-dev\\rooms')), /AppData/);
  assert.throws(() => checkLauncher(text.replace(/^if defined ROOM_DEV_HOME.*$/m, 'rem')), /ROOM_DEV_HOME/);
  assert.throws(() => checkLauncher(text.replace(/^("%NODE_EXE%" "%APP%") lobby --open/m, '$1 serve --dir x')), /lobby/);
  assert.throws(() => checkLauncher(text.replace(/^"%NODE_EXE%" -e .*$/m, 'rem')), /Node version/);
  if (process.platform !== 'win32') return;
  // Execute the launcher's own prefix (everything up to the ROOMS lines) in cmd.exe and compare with
  // defaultRoomsRoot() evaluated by node under the same environment.
  const lines = text.split('\r\n');
  const last = lines.findIndex((l) => l.startsWith('if defined ROOM_DEV_HOME'));
  assert.ok(last > 0, 'ROOM_DEV_HOME line present');
  const probeDir = path.join(base, 'launcher-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const probe = path.join(probeDir, 'probe.cmd');
  fs.writeFileSync(probe, `${[...lines.slice(0, last + 1), 'echo ROOMS=%ROOMS%', 'endlocal'].join('\r\n')}\r\n`);
  const { spawnClean } = await import('../lib/spawn.mjs');
  const commonUrl = new URL('../lib/common.mjs', import.meta.url).href;
  const fakeHome = path.join(base, 'home café');
  for (const devHome of [null, path.join(base, 'dev home über')]) {
    const env = { USERPROFILE: fakeHome, ROOM_DEV_HOME: devHome };
    const cmd = await spawnClean(process.env.ComSpec || 'cmd.exe', ['/d', '/c', probe], { env, cwd: probeDir, timeoutMs: 20_000 });
    assert.equal(cmd.code, 0, `probe exit 0\n${cmd.stdout}\n${cmd.stderr}`);
    const got = (cmd.stdout.match(/^ROOMS=(.*?)\r?$/m) || [])[1];
    const want = await spawnClean(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(commonUrl)}).then((m) => process.stdout.write(m.defaultRoomsRoot()))`], { env, timeoutMs: 20_000 });
    assert.equal(want.code, 0, want.stderr);
    assert.equal(got, want.stdout, `launcher ROOMS equals defaultRoomsRoot() (ROOM_DEV_HOME=${devHome})`);
    assert.equal(got, devHome ? path.join(devHome, 'rooms') : path.join(fakeHome, 'room-dev', 'rooms'));
  }
});

// F6: an old node (bundled or the PATH fallback) stops with the 'Node.js 22' message
// before room.mjs runs; a current node passes the probe.
test('launcher probes the node version before running room.mjs', async () => {
  const text = entries.get(`${top}/launch.cmd`).data.toString('utf8');
  const lines = text.split('\r\n');
  const from = lines.findIndex((l) => l.startsWith('"%NODE_EXE%" -e '));
  const run = lines.findIndex((l) => l.startsWith('"%NODE_EXE%" "%APP%"'));
  assert.ok(from > 0 && from < run, 'probe line precedes the room.mjs line');
  const fallback = lines.findIndex((l) => l === '  set "NODE_EXE=node"');
  assert.ok(fallback > 0 && fallback < from, 'probe follows the PATH fallback, so both runtimes are checked');
  if (process.platform !== 'win32') return;
  const to = lines.indexOf(')', from);
  const block = lines.slice(from, to + 1).map((l) => (l.trim() === 'pause' ? 'rem pause' : l));
  const probeDir = path.join(base, 'node-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  // A preload that makes this node report version 18 stands in for an old runtime.
  const pretendOld = path.join(probeDir, 'pretend-node18.cjs');
  fs.writeFileSync(pretendOld, "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '18.20.0' } });\n");
  const { spawnClean } = await import('../lib/spawn.mjs');
  for (const [nodeOptions, wantCode] of [[`--require "${pretendOld}"`, 9], [null, 0]]) {
    const probe = path.join(probeDir, `probe-${wantCode}.cmd`);
    fs.writeFileSync(probe, `${['@echo off', 'chcp 65001 >nul', 'setlocal EnableExtensions', `set "NODE_EXE=${process.execPath}"`, ...block, 'echo PROBE_PASSED', 'exit /b 0'].join('\r\n')}\r\n`);
    const r = await spawnClean(process.env.ComSpec || 'cmd.exe', ['/d', '/c', probe], { cwd: probeDir, env: { NODE_OPTIONS: nodeOptions }, timeoutMs: 20_000 });
    assert.equal(r.code, wantCode, `${nodeOptions ? 'node reporting 18' : 'this node'}: exit ${wantCode}\n${r.stdout}\n${r.stderr}`);
    if (wantCode) { assert.match(r.stdout, /Node\.js 22/); assert.ok(!r.stdout.includes('PROBE_PASSED')); } else assert.match(r.stdout, /PROBE_PASSED/);
  }
});

test('BUILD.json inventory covers every other entry with matching sha256', async () => {
  const crypto = await import('node:crypto');
  const record = JSON.parse(entries.get(`${top}/BUILD.json`).data.toString('utf8'));
  assert.equal(record.node.bundled, false);
  assert.match(record.node.version, /^\d+\.\d+\.\d+$/);
  assert.equal(record.platform, 'win-x64');
  const listed = new Map(record.files.map((f) => [f.path, f]));
  for (const [name, e] of entries) {
    if (name === `${top}/BUILD.json`) continue;
    const f = listed.get(name);
    assert.ok(f, `${name} listed in BUILD.json`);
    assert.equal(f.sha256, crypto.createHash('sha256').update(e.data).digest('hex'), `sha256 of ${name}`);
    assert.equal(f.bytes, e.data.length);
  }
  assert.equal(listed.size, entries.size - 1, 'inventory lists exactly the other entries');
});

test('--node-version is validated and unknown flags are refused', () => {
  const bad = spawnSync(process.execPath, [BUILD, '--no-download', '--out', outDir, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 9);
  assert.match(bad.stderr, /Unknown option/);
  const help = spawnSync(process.execPath, [BUILD, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-download/);
});

test('zip writer round-trips through the independent reader (stored + deflate, unicode names)', async () => {
  const { ZipWriter } = await import('../dist/build.mjs');
  const w = new ZipWriter({ level: 6 });
  const big = Buffer.from('café '.repeat(5000), 'utf8');
  const tiny = Buffer.from('x');
  w.add('café/résumé.txt', big);
  w.add('tiny.bin', tiny);
  w.add('empty.txt', Buffer.alloc(0));
  w.add('stored.bin', big, { store: true });
  const m = listZip(w.finish());
  assert.equal(m.size, 4);
  assert.equal(m.get('café/résumé.txt').method, 8, 'compressible entry deflated');
  assert.ok(m.get('café/résumé.txt').data.equals(big));
  assert.equal(m.get('tiny.bin').method, 0, 'tiny entry stored');
  assert.equal(m.get('empty.txt').data.length, 0);
  assert.equal(m.get('stored.bin').method, 0, 'store option honoured');
  assert.throws(() => w.add('tiny.bin', tiny), /duplicate/);
  assert.throws(() => new ZipWriter().add('../escape', tiny), /bad zip entry name/);
});

test.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
