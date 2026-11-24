// node --test test/spawn.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testRunsRoot } from '../lib/common.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  spawnClean, buildCleanEnv, findOnPath, killTree, ENV_WHITELIST, IMPLICIT_WIN32_VARS, IMPLICIT_DARWIN_VARS,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES,
} from '../lib/spawn.mjs';
import { findCodex, codexPathFromConfig, codexHome } from '../lib/codex.mjs';

const WIN = process.platform === 'win32';
const NODE = process.execPath;

function tempRoot() {
  // testRunsRoot(), never %LOCALAPPDATA% (MSIX redirection, INTERFACES §1).
  const dir = path.join(testRunsRoot(), crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

// ---------- buildCleanEnv ----------

test('buildCleanEnv keeps only whitelist keys from the source plus explicit extras', () => {
  const source = { PATH: 'p', SystemRoot: 'C:\\W', TEMP: 't', SECRET_TOKEN: 'leak', CODEX_HOME: 'x', HOME: '/h' };
  const env = buildCleanEnv({ ROOM_X: '1' }, source);
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'ROOM_X', 'SystemRoot', 'TEMP']);
  assert.equal(env.ROOM_X, '1');
  assert.equal('SECRET_TOKEN' in env, false);
  assert.equal('HOME' in env, false);
});

test('buildCleanEnv: explicit key overrides whitelist, null removes, values are stringified', () => {
  const source = { PATH: 'orig', TMP: 'x' };
  const env = buildCleanEnv({ PATH: 'mine', TMP: null, N: 5 }, source);
  assert.equal(env.PATH, 'mine');
  assert.equal('TMP' in env, false);
  assert.equal(env.N, '5');
});

test('buildCleanEnv rejects invalid names and never mutates the source', () => {
  const source = { PATH: 'p' };
  assert.throws(() => buildCleanEnv({ 'A=B': '1' }, source), TypeError);
  assert.throws(() => buildCleanEnv({ '': '1' }, source), TypeError);
  buildCleanEnv({ Z: '1' }, source);
  assert.deepEqual(source, { PATH: 'p' });
});

test('buildCleanEnv collapses SystemRoot/SYSTEMROOT to one entry on Windows', { skip: !WIN }, () => {
  const env = buildCleanEnv({}, { SystemRoot: 'C:\\W', SYSTEMROOT: 'C:\\W' });
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'SYSTEMROOT');
  assert.equal(keys.length, 1);
});

test('whitelist is exactly the eight contract keys', () => {
  assert.deepEqual([...ENV_WHITELIST], ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'WINDIR']);
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1_048_576);
});

// ---------- findOnPath ----------

test('findOnPath resolves node on the clean PATH and returns null for a missing program', () => {
  const found = findOnPath('node');
  assert.ok(found, 'node should be on PATH for tests to run');
  assert.ok(fs.statSync(found).isFile());
  assert.equal(findOnPath('definitely-not-a-program-7f3a'), null);
  assert.equal(findOnPath(''), null);
  assert.equal(findOnPath(null), null);
});

test('findOnPath accepts an absolute path and honours a custom PATH', () => {
  assert.equal(findOnPath(NODE), NODE);
  const dir = path.dirname(NODE);
  const name = path.basename(NODE);
  assert.equal(findOnPath(name, { env: { PATH: dir } }), path.join(dir, name));
  assert.equal(findOnPath(name, { env: { PATH: '' } }), null);
});

// ---------- spawnClean ----------

test('spawnClean validates arguments synchronously', () => {
  assert.throws(() => spawnClean('', []), TypeError);
  assert.throws(() => spawnClean(NODE, 'not-an-array'), TypeError);
  assert.throws(() => spawnClean(NODE, [1]), TypeError);
  assert.throws(() => spawnClean(NODE, [], { timeoutMs: -1 }), TypeError);
  assert.throws(() => spawnClean(NODE, [], { maxOutputBytes: 1.5 }), TypeError);
  assert.throws(() => spawnClean(NODE, [], { input: 42 }), TypeError);
});

test('spawnClean input: written to the child stdin and closed; never copied into argv, env or the result', async () => {
  const secret = `in-${crypto.randomBytes(6).toString('hex')}-café`;
  const script = 'let b=[];process.stdin.on("data",(c)=>b.push(c));process.stdin.on("end",()=>{const s=Buffer.concat(b).toString("utf8");process.stdout.write(JSON.stringify({len:s.length,sha:require("crypto").createHash("sha256").update(s).digest("hex"),argv:process.argv,env:process.env}))})';
  const r = await spawnClean(NODE, ['-e', script], { input: Buffer.from(`${secret}\n`, 'utf8'), timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.sha, crypto.createHash('sha256').update(`${secret}\n`).digest('hex'), 'the child read exactly the input');
  assert.ok(!JSON.stringify(got.argv).includes(secret) && !JSON.stringify(got.env).includes(secret), 'input is not in the child argv or env');
  const { raw, ...plain } = r;
  assert.ok(!JSON.stringify(plain).includes(secret) && !raw.stdout.includes(Buffer.from(secret)), 'input is not echoed into the result');
  // A string input works the same way, and a child that never reads stdin does not break the call.
  const r2 = await spawnClean(NODE, ['-e', 'process.exit(0)'], { input: 'x'.repeat(1 << 20), timeoutMs: 30_000 });
  assert.equal(r2.code, 0);
  assert.equal(r2.spawnError, null);
});

test('spawnClean runs node, captures stdout/stderr and the exit code', async () => {
  const r = await spawnClean(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
  assert.equal(r.truncated, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.spawnError, null);
  assert.ok(Buffer.isBuffer(r.raw.stdout));
  assert.equal(r.stdoutBytes, 3);
  assert.equal(r.stderrBytes, 3);
  assert.ok(r.durationMs >= 0);
  assert.ok(typeof r.pid === 'number');
  assert.match(r.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('spawnClean child env is whitelist + explicit keys only (contract 3, #42)', async () => {
  process.env.ROOM_SPAWN_TEST_SECRET = 'must-not-leak';
  try {
    const r = await spawnClean(NODE, ['-e', 'console.log(JSON.stringify(process.env))'], { env: { ROOM_EXTRA: 'yes' } });
    assert.equal(r.code, 0);
    const childEnv = JSON.parse(r.stdout);
    assert.equal('ROOM_SPAWN_TEST_SECRET' in childEnv, false);
    assert.equal(childEnv.ROOM_EXTRA, 'yes');
    const allowed = new Set([
      ...ENV_WHITELIST,
      'ROOM_EXTRA',
      ...(WIN ? IMPLICIT_WIN32_VARS : []),
      ...(process.platform === 'darwin' ? IMPLICIT_DARWIN_VARS : []),
    ].map((k) => k.toUpperCase()));
    const offenders = Object.keys(childEnv).filter((k) => !k.startsWith('=') && !allowed.has(k.toUpperCase()));
    assert.deepEqual(offenders, [], `unexpected env keys reached the child: ${offenders.join(', ')}`);
  } finally {
    delete process.env.ROOM_SPAWN_TEST_SECRET;
  }
});

test('spawnClean reads whitelist values from an injected source', async () => {
  const source = { ...buildCleanEnv({}, process.env), TEMP: 'injected-temp' };
  const r = await spawnClean(NODE, ['-e', 'console.log(process.env.TEMP)'], { source });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'injected-temp');
});

test('spawnClean never goes through a shell: metacharacters arrive as literal arguments', async () => {
  const args = ['a && echo pwned', '%PATH%', '$HOME', '"quoted"', 'café arg', 'tab\there'];
  const r = await spawnClean(NODE, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), args);
});

test('spawnClean works with a cwd containing non-ASCII characters and spaces', async () => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'café dir test');
    fs.mkdirSync(cwd, { recursive: true });
    const r = await spawnClean(NODE, ['-e', 'console.log(process.cwd())'], { cwd });
    assert.equal(r.code, 0);
    assert.equal(fs.realpathSync(r.stdout.trim()), fs.realpathSync(cwd));
    assert.equal(r.cwd, path.resolve(cwd));
  } finally { rmrf(root); }
});

test('spawnClean caps each output stream at maxOutputBytes and flags truncation', async () => {
  const r = await spawnClean(NODE, ['-e', 'process.stdout.write("x".repeat(200000)); process.stderr.write("y".repeat(10))'], { maxOutputBytes: 1000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 1000);
  assert.equal(r.stderr, 'y'.repeat(10));
  assert.equal(r.truncated, true);
  const r2 = await spawnClean(NODE, ['-e', 'process.stdout.write("abc")'], { maxOutputBytes: 0 });
  assert.equal(r2.stdout, '');
  assert.equal(r2.truncated, true);
});

test('spawnClean kills the child on timeout and reports timedOut', async () => {
  const started = Date.now();
  const r = await spawnClean(NODE, ['-e', 'setInterval(() => {}, 1000); console.log("alive")'], { timeoutMs: 700 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 15000, 'timeout must not hang');
  assert.equal(r.stdout.trim(), 'alive');
});

test('spawnClean reports a missing executable as spawnError, not a rejection', async () => {
  const r = await spawnClean('definitely-not-a-program-7f3a', ['x']);
  assert.equal(r.code, null);
  assert.ok(r.spawnError && /ENOENT/.test(r.spawnError), r.spawnError);
  assert.equal(r.timedOut, false);
});

test('spawnClean with timeoutMs 0 disables the timer', async () => {
  const r = await spawnClean(NODE, ['-e', 'setTimeout(() => console.log("done"), 50)'], { timeoutMs: 0 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'done');
});

test('spawnClean refuses batch files without a shell on Windows (no .cmd/.bat execution)', { skip: !WIN }, async () => {
  const root = tempRoot();
  try {
    const cmd = path.join(root, 'evil.cmd');
    fs.writeFileSync(cmd, '@echo pwned\r\n');
    const r = await spawnClean(cmd, []);
    assert.notEqual(r.stdout.trim(), 'pwned');
    assert.ok(r.spawnError, 'expected EINVAL spawnError');
  } finally { rmrf(root); }
});

// ---------- killTree (NI-8) ----------

// Before the fix taskkill was started with no env option and inherited the service's whole
// environment (ROOM_PI_API_KEY included).
test('killTree starts taskkill with the whitelist env only, no shell, from System32', { skip: !WIN }, () => {
  const calls = [];
  const fakeSpawn = (file, args, opts) => { calls.push({ file, args, opts }); return { on() {}, unref() {} }; };
  const source = { PATH: 'C:\\bin', SystemRoot: 'C:\\Win', ROOM_PI_API_KEY: 'sk-secret', SECRET_TOKEN: 'x' };
  let killed = false;
  killTree({ pid: 4242, kill() { killed = true; } }, { env: buildCleanEnv({}, source), spawnFn: fakeSpawn });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.file, path.join('C:\\Win', 'System32', 'taskkill.exe'));
  assert.deepEqual(c.args, ['/PID', '4242', '/T', '/F']);
  assert.equal(c.opts.shell, false);
  assert.deepEqual(c.opts.env, { PATH: 'C:\\bin', SystemRoot: 'C:\\Win' });
  assert.equal(killed, true);
  // default env: built from process.env through the whitelist, never the raw process.env
  process.env.ROOM_PI_API_KEY_TEST_SENTINEL = 'must-not-leak';
  try {
    killTree({ pid: 1, kill() {} }, { spawnFn: fakeSpawn });
    assert.ok(calls[1].opts.env && typeof calls[1].opts.env === 'object');
    assert.equal('ROOM_PI_API_KEY_TEST_SENTINEL' in calls[1].opts.env, false);
    const allowed = new Set(ENV_WHITELIST.map((k) => k.toUpperCase()));
    assert.deepEqual(Object.keys(calls[1].opts.env).filter((k) => !allowed.has(k.toUpperCase())), []);
  } finally { delete process.env.ROOM_PI_API_KEY_TEST_SENTINEL; }
});

// ---------- findCodex (W4) ----------

function codexFixture() {
  const root = tempRoot();
  const env = { PATH: path.join(root, 'path bin'), LOCALAPPDATA: path.join(root, 'local'), CODEX_HOME: path.join(root, 'codex home') };
  fs.mkdirSync(env.PATH, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  return { root, env };
}

test('findCodex never returns the npm shim codex.cmd (spawnClean cannot run it)', { skip: !WIN }, () => {
  const { root, env } = codexFixture();
  try {
    fs.writeFileSync(path.join(env.PATH, 'codex.cmd'), '@echo shim\r\n');
    fs.writeFileSync(path.join(env.PATH, 'codex.bat'), '@echo shim\r\n');
    assert.equal(findCodex({ env }), null);
    // a CODEX_CLI_PATH pointing at the shim is not accepted either
    assert.equal(findCodex({ env: { ...env, CODEX_CLI_PATH: path.join(env.PATH, 'codex.cmd') } }), null);
    // a real .exe on PATH is found
    fs.writeFileSync(path.join(env.PATH, 'codex.exe'), 'MZ');
    assert.equal(findCodex({ env }), path.join(env.PATH, 'codex.exe'));
  } finally { rmrf(root); }
});

test('findCodex order: CODEX_CLI_PATH, then config.toml, then the Desktop bin dir, then PATH', { skip: !WIN }, () => {
  const { root, env } = codexFixture();
  try {
    const desk = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'abc123');
    fs.mkdirSync(desk, { recursive: true });
    fs.writeFileSync(path.join(desk, 'codex.exe'), 'MZ');
    fs.writeFileSync(path.join(env.PATH, 'codex.exe'), 'MZ');
    assert.equal(findCodex({ env }), path.join(desk, 'codex.exe'), 'Desktop bin beats PATH');

    const cfgExe = path.join(root, 'café config', 'codex.exe');
    fs.mkdirSync(path.dirname(cfgExe), { recursive: true });
    fs.writeFileSync(cfgExe, 'MZ');
    const toml = `model = "x"\n\n[mcp_servers.node_repl.env]\nCODEX_HOME = "C:\\\\x"\nCODEX_CLI_PATH = "${cfgExe.replace(/\\/g, '\\\\')}"\n`;
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), toml, 'utf8');
    assert.equal(codexPathFromConfig(path.join(env.CODEX_HOME, 'config.toml')), cfgExe);
    assert.equal(codexHome(env), env.CODEX_HOME);
    assert.equal(findCodex({ env }), cfgExe, 'config.toml beats the Desktop bin dir');

    const envExe = path.join(root, 'env', 'codex.exe');
    fs.mkdirSync(path.dirname(envExe), { recursive: true });
    fs.writeFileSync(envExe, 'MZ');
    assert.equal(findCodex({ env: { ...env, CODEX_CLI_PATH: envExe } }), envExe, 'CODEX_CLI_PATH beats config.toml');

    // config.toml naming a .cmd or a missing file is skipped
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `CODEX_CLI_PATH = '${path.join(env.PATH, 'codex.cmd')}'\n`);
    assert.equal(findCodex({ env }), path.join(desk, 'codex.exe'));
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `CODEX_CLI_PATH = '${path.join(root, 'gone.exe')}'\n`);
    assert.equal(findCodex({ env }), path.join(desk, 'codex.exe'));
    assert.equal(codexPathFromConfig(path.join(root, 'no-such.toml')), null);
  } finally { rmrf(root); }
});

test('spawnClean honours AbortSignal (pre-aborted and in-flight cancellation)', async () => {
  const pre = new AbortController();
  pre.abort();
  const r0 = await spawnClean(NODE, ['-e', 'console.log("should-not-run")'], { signal: pre.signal, timeoutMs: 5000 });
  assert.equal(r0.aborted, true);
  assert.equal(r0.pid, null);
  assert.equal(r0.stdout, '');

  const ac = new AbortController();
  const started = Date.now();
  const p = spawnClean(NODE, ['-e', 'setTimeout(() => console.log("late"), 30000)'], { signal: ac.signal, timeoutMs: 30_000 });
  setTimeout(() => ac.abort(), 120);
  const r1 = await p;
  const elapsed = Date.now() - started;
  assert.equal(r1.aborted, true);
  assert.equal(r1.timedOut, false);
  assert.ok(elapsed < 10_000, `aborted child should stop quickly, took ${elapsed}ms`);
});

test('spawnClean kills POSIX process group on abort (no orphan grandchild)', { skip: WIN }, async () => {
  const root = tempRoot();
  const pidFile = path.join(root, 'grandchild.pid');
  try {
    const ac = new AbortController();
    const script = [
      'const fs = require("fs");',
      'const { spawn } = require("child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      'fs.writeFileSync(process.argv[1], String(g.pid));',
      'setTimeout(() => {}, 60000);',
    ].join(' ');
    const p = spawnClean(NODE, ['-e', script, pidFile], { signal: ac.signal, timeoutMs: 20_000 });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fs.existsSync(pidFile), 'grandchild pid written');
    const gpid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    ac.abort();
    const r = await p;
    assert.equal(r.aborted, true);
    await new Promise((r) => setTimeout(r, 150));
    let alive = true;
    try { process.kill(gpid, 0); } catch { alive = false; }
    assert.equal(alive, false, `grandchild pid ${gpid} should be killed with process group`);
  } finally { rmrf(root); }
});
