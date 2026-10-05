// test/dpapi.test.mjs - P3 DPAPI storage of the built-in Pi key (lib/hosted/dpapi.mjs, admin pi-key
// --save/--status/--forget, the service picking the saved key up). The tests marked Windows-only run
// real Windows PowerShell 5.1 and real DPAPI (CurrentUser) on this machine; elsewhere they are
// skipped with the reason. The others inject a spawn or an unprotect function and run everywhere.
// Every temporary directory lives under testRunsRoot().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testRunsRoot, randomHex, readJsonl, isInside, fwd, virtualizationRedirect } from '../lib/common.mjs';
import { spawnClean } from '../lib/spawn.mjs';
import { createGuard } from '../lib/guard.mjs';
import {
  protect, unprotect, isAvailable, powershellPath, psArgs, savePiKey, forgetPiKey, piKeyStatus, loadSavedPiKey,
  savedPiKeyPath, keyFingerprint, DPAPI_ENTROPY,
} from '../lib/hosted/dpapi.mjs';
import { ADMIN_COMMANDS } from '../lib/admin.mjs';
import { CliError } from '../lib/seat.mjs';
import { createRoomService } from '../lib/service.mjs';
import { createFakeProvider } from '../lib/hosted/pi.mjs';

const WIN = process.platform === 'win32';
const WIN_ONLY = WIN ? false : 'Windows only: DPAPI (ProtectedData through Windows PowerShell 5.1) does not exist on this platform';
const ROOM_MJS = fileURLToPath(new URL('../room.mjs', import.meta.url));
const T0 = Date.parse('2026-10-03T08:00:00.000Z');

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tempDir(prefix) {
  const d = path.join(testRunsRoot(), `${prefix}-${randomHex(5)}`);
  fs.mkdirSync(d, { recursive: true });
  roots.push(d);
  return d;
}
const newKey = (tag = 'k') => `sk-${tag}-${crypto.randomBytes(10).toString('hex')}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const walkFiles = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc); else if (e.isFile()) acc.push(p);
  }
  return acc;
};
// Every form in which a key could leak: the UTF-8 text, its base64, its UTF-16LE bytes.
function leakForms(key) { return [Buffer.from(key, 'utf8'), Buffer.from(b64(key), 'utf8'), Buffer.from(key, 'utf16le')]; }
function containsKey(bufOrText, key) {
  const buf = Buffer.isBuffer(bufOrText) ? bufOrText : Buffer.from(String(bufOrText), 'utf8');
  return leakForms(key).some((f) => buf.includes(f));
}
function filesContainingKey(dir, key) { return walkFiles(dir).filter((f) => containsKey(fs.readFileSync(f), key)); }

// A spawn stand-in for spawnClean: records each call and answers like the PowerShell helper would.
function fakePs(answer) {
  const calls = [];
  const spawn = async (file, args, opts) => {
    calls.push({ file, args: [...args], opts: { ...opts } });
    const a = typeof answer === 'function' ? answer({ file, args, opts }) : answer;
    return { file, args, code: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, spawnError: null, ...a };
  };
  return { spawn, calls };
}
// The real spawnClean, with every call recorded.
function recordingSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => { calls.push({ file, args: [...args], opts: { ...opts } }); return spawnClean(file, args, opts); };
  return { spawn, calls };
}

// ---------------------------------------------------------------- everywhere (injected)

test('isAvailable is false off Windows; the helper path is the fixed Windows PowerShell 5.1 location', () => {
  assert.equal(isAvailable({ platform: 'linux' }), false);
  assert.equal(isAvailable({ platform: 'darwin' }), false);
  assert.equal(isAvailable({ platform: 'win32', exists: () => false }), false);
  assert.equal(isAvailable({ platform: 'win32', exists: () => true }), true);
  assert.equal(powershellPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(psArgs('Protect').slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  for (const op of ['Protect', 'Unprotect']) {
    const script = psArgs(op)[3];
    assert.match(script, new RegExp(`ProtectedData\\]::${op}\\(`));
    assert.match(script, /Add-Type -AssemblyName System\.Security/);
    assert.match(script, /DataProtectionScope\]::CurrentUser/);
    assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/, 'the data is read from stdin');
    assert.ok(script.includes(b64(DPAPI_ENTROPY)), 'fixed per-app entropy');
    assert.ok(/^[\x20-\x7e]+$/.test(script), 'the script is printable ASCII');
  }
  if (WIN) assert.equal(isAvailable(), true, 'this Windows machine has Windows PowerShell 5.1');
});

test('off Windows: protect / unprotect refuse with DPAPI_UNAVAILABLE and start nothing', async () => {
  const f = fakePs({});
  await assert.rejects(protect('sk-x', { spawn: f.spawn, platform: 'linux' }), (e) => e.code === 'DPAPI_UNAVAILABLE' && !e.message.includes('sk-x'));
  await assert.rejects(unprotect(Buffer.from('blob'), { spawn: f.spawn, platform: 'linux' }), { code: 'DPAPI_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(protect('', { spawn: f.spawn, platform: 'win32' }), TypeError);
  await assert.rejects(unprotect(Buffer.alloc(0), { spawn: f.spawn, platform: 'win32' }), TypeError);
});

test('injected spawn: the PowerShell command line never carries the secret; it crosses only stdin, as base64', async () => {
  const KEY = `${newKey('argv')}-密钥`;
  const BLOB = crypto.randomBytes(180);
  const f = fakePs(({ opts }) => {
    const data = Buffer.from(String(opts.input).trim(), 'base64');
    // Protect answers with a fixed blob; Unprotect hands back the key for that blob.
    return { stdout: data.equals(BLOB) ? `DPAPI_OK:${b64(KEY)}\n` : `DPAPI_OK:${BLOB.toString('base64')}\n` };
  });
  const blob = await protect(KEY, { spawn: f.spawn, platform: 'win32' });
  assert.ok(blob.equals(BLOB));
  assert.equal(await unprotect(blob, { spawn: f.spawn, platform: 'win32' }), KEY);
  assert.equal(f.calls.length, 2);
  for (const [i, c] of f.calls.entries()) {
    assert.match(c.file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.deepEqual(c.args, psArgs(i === 0 ? 'Protect' : 'Unprotect'));
    const commandLine = [c.file, ...c.args].join(' ');
    assert.ok(!containsKey(commandLine, KEY), 'the key is not in the command line');
    assert.ok(!commandLine.includes(BLOB.toString('base64')), 'the blob is not in the command line either');
    assert.deepEqual(c.opts.env, {}, 'no caller env keys: whitelist only');
    const { input, ...rest } = c.opts;
    assert.ok(!containsKey(JSON.stringify(rest), KEY), 'no other spawn option carries the key');
    assert.equal(typeof input, 'string');
    assert.match(input, /^[A-Za-z0-9+/]+={0,2}\n$/, 'stdin is one line of base64 and nothing else');
  }
  assert.equal(f.calls[0].opts.input, `${b64(KEY)}\n`, 'protect: the key is on stdin, base64');
  assert.equal(f.calls[1].opts.input, `${BLOB.toString('base64')}\n`, 'unprotect: the blob is on stdin, base64');
});

test('injected spawn: failures map to DPAPI_UNAVAILABLE / DPAPI_FAILED and never quote stdout, stderr or the key', async () => {
  const KEY = newKey('err');
  // What PowerShell really does on a parse error: it echoes the offending line, data included, on stderr.
  const noisy = { stderr: `At line:1 char:5\n+ ${b64(KEY)} ${KEY}\n`, stdout: `junk ${KEY} ${b64(KEY)}\n` };
  const cases = [
    [{ spawnError: 'ENOENT: spawn powershell.exe ENOENT', code: null }, 'DPAPI_UNAVAILABLE'],
    [{ ...noisy, stdout: `DPAPI_ERR:LANGUAGE_MODE\n${noisy.stdout}`, code: 5 }, 'DPAPI_UNAVAILABLE'],
    [{ ...noisy, stdout: `DPAPI_ERR:System.Security.Cryptography.CryptographicException:8009000B\n`, code: 3 }, 'DPAPI_FAILED'],
    [{ ...noisy, code: 0 }, 'DPAPI_FAILED'],                                     // exit 0 without a result (parse error)
    [{ ...noisy, timedOut: true, code: null }, 'DPAPI_FAILED'],
    [{ stdout: 'DPAPI_OK:@@not-base64@@\n', code: 0 }, 'DPAPI_FAILED'],
    [{ stdout: `DPAPI_OK:${b64(KEY)}\n`, code: 1 }, 'DPAPI_FAILED'],             // a result with a failing exit is not a result
  ];
  for (const [answer, code] of cases) {
    const f = fakePs(answer);
    for (const run of [() => protect(KEY, { spawn: f.spawn, platform: 'win32' }), () => unprotect(Buffer.from('blob-bytes'), { spawn: f.spawn, platform: 'win32' })]) {
      await assert.rejects(run(), (e) => {
        assert.equal(e.code, code, `${JSON.stringify(answer).slice(0, 80)} -> ${e.code}`);
        assert.ok(/^[A-Z_]+：/.test(e.message), 'message starts with the ASCII code');
        assert.ok(!containsKey(e.message, KEY) && !containsKey(JSON.stringify(e), KEY), 'error carries no key');
        assert.ok(!e.message.includes('junk') && !e.message.includes('At line'), 'no stdout/stderr text is quoted');
        return true;
      });
    }
  }
  // A thrown spawn (programmer error in the injected function) is DPAPI_UNAVAILABLE too.
  await assert.rejects(protect(KEY, { spawn: () => { throw Object.assign(new Error(KEY), { code: 'EBOOM' }); }, platform: 'win32' }), (e) => e.code === 'DPAPI_UNAVAILABLE' && !e.message.includes(KEY));
  // Unprotect output that is not UTF-8 is refused.
  const bad = fakePs({ stdout: `DPAPI_OK:${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')}\n` });
  await assert.rejects(unprotect(Buffer.from('b'), { spawn: bad.spawn, platform: 'win32' }), { code: 'DPAPI_FAILED' });
});

test('savePiKey refuses a redirected location (MSIX / link) in Chinese, before or after writing', async () => {
  const home = tempDir('dpapi-redirect');
  const file = savedPiKeyPath(home);
  const KEY = newKey('redir');
  const ok = fakePs({ stdout: `DPAPI_OK:${crypto.randomBytes(64).toString('base64')}\n` });
  const packaged = (p) => ({ asked: path.resolve(p), real: `C:\\Users\\u\\AppData\\Local\\Packages\\Claude_x\\LocalCache\\Local\\${path.basename(p)}`, packaged: true });
  // 1. The nearest existing ancestor is already redirected: nothing is protected, nothing written.
  await assert.rejects(savePiKey(KEY, { file, redirect: packaged, spawn: ok.spawn, platform: 'win32' }), (e) => e.code === 'PI_KEY_REDIRECTED' && /MSIX/.test(e.message) && /ROOM_DEV_HOME/.test(e.message) && !e.message.includes(KEY));
  assert.equal(ok.calls.length, 0, 'not even protected');
  assert.equal(fs.existsSync(path.dirname(file)), false, 'secrets dir not created');
  // 2. Only the written file turns out redirected: the write is removed and the save refused.
  const late = (p) => (path.resolve(p) === path.resolve(file) ? packaged(p) : null);
  await assert.rejects(savePiKey(KEY, { file, redirect: late, spawn: ok.spawn, platform: 'win32' }), (e) => e.code === 'PI_KEY_REDIRECTED' && /保存的 key 文件/.test(e.message));
  assert.equal(fs.existsSync(file), false, 'the redirected write was removed');
  const log = readJsonl(path.join(path.dirname(file), 'write-log.jsonl'));
  assert.deepEqual(log.map((r) => r.op), ['mkdir', 'write', 'rm']);
  assert.ok(log.every((r) => r.who === 'admin:pi-key' && isInside(r.path, path.dirname(file))));
  // 3. A link (not MSIX): refused with the real path.
  const link = (p) => ({ asked: path.resolve(p), real: 'D:\\elsewhere', packaged: false });
  await assert.rejects(savePiKey(KEY, { file, redirect: link, spawn: ok.spawn, platform: 'win32' }), (e) => e.code === 'PI_KEY_REDIRECTED' && /真实位置/.test(e.message));
  // Invalid keys never reach DPAPI.
  for (const k of ['', '  ', 'a\nb', 'a\rb']) await assert.rejects(savePiKey(k, { file, spawn: ok.spawn, platform: 'win32' }), { code: 'PI_KEY_INVALID' });
});

test('admin pi-key (in process): one mode at a time, no value on the flag, DPAPI_UNAVAILABLE refused without writing', async () => {
  const home = tempDir('dpapi-admin');
  const file = savedPiKeyPath(home);
  const KEY = newKey('inproc');
  const lines = [];
  const io = (extra = {}) => ({ out: (l) => lines.push(l), env: { ROOM_PI_API_KEY: KEY }, readStdin: () => '', piKeyFile: file, ...extra });
  const pi = (args, i = io()) => ADMIN_COMMANDS['pi-key']({ _: ['pi-key'], ...args }, i);
  await assert.rejects(pi({ save: true, status: true }), (e) => e instanceof CliError && /一次只能用一个/.test(e.message));
  await assert.rejects(pi({ save: true, port: '1234' }), /一次只能用一个/);
  await assert.rejects(pi({ save: KEY }), (e) => e instanceof CliError && /不带值/.test(e.message) && !e.message.includes(KEY), 'a key on the command line is refused, not echoed');
  await assert.rejects(pi({ save: true }, io({ env: {}, readStdin: () => '' })), /没有拿到 API key/);
  await assert.rejects(pi({ save: true }, io({ env: {}, readStdin: () => 'a\nb' })), /只能是一行/);
  await assert.rejects(pi({ save: true }, io({ dpapi: { platform: 'linux' } })), (e) => e instanceof CliError && /DPAPI_UNAVAILABLE/.test(e.message) && /ROOM_PI_API_KEY/.test(e.message) && !e.message.includes(KEY));
  assert.equal(fs.existsSync(file), false, 'nothing written');
  assert.equal(await pi({ status: true }, io({ dpapi: { platform: 'linux' } })), 0);
  assert.match(lines.at(-1), /^PI_KEY_STATUS saved=no /);
  assert.equal(await pi({ forget: true }), 0);
  assert.match(lines.at(-1), /^NOT_SAVED /);
  // Without a mode the --port loopback handoff is unchanged: --dir is still required.
  await assert.rejects(pi({}), /--dir/);
  assert.ok(!lines.join('\n').includes(KEY));
});

// ---------------------------------------------------------------- service (fixture shared below)

function makeHostedRoom(base, { hosted = true } = {}) {
  const g = createGuard({ allowed: [base], logPath: path.join(base, 'test-write-log.jsonl'), who: 'test' });
  const roomDir = path.join(base, 'room');
  g.mkdir(roomDir);
  const seats = [];
  for (const s of [{ seatId: 'A', role: 'lead' }, { seatId: 'P', role: 'participant', hosted: hosted ? { kind: 'pi', tier: 'discussion' } : null }]) {
    const cwd = path.join(base, `cwd${s.seatId}`);
    g.mkdir(cwd);
    const seatDir = path.join(roomDir, 'seats', s.seatId);
    g.mkdir(seatDir);
    g.writeFile(path.join(seatDir, 'token'), randomHex(24));
    const rec = { seatId: s.seatId, name: s.seatId, role: s.role, waitMode: 'background', cwd, outbox: path.join(cwd, '.room-outbox', s.seatId), roomDir, createdAt: new Date(T0).toISOString(), wake: { enabled: false }, audit: null, hosted: s.hosted || null };
    g.writeFile(path.join(seatDir, 'seat.json'), JSON.stringify(rec));
    seats.push(rec);
  }
  g.writeFile(path.join(roomDir, 'room.json'), JSON.stringify({ schema_version: 2, id: `d${randomHex(3)}`, createdAt: new Date(T0).toISOString(), preset: 'discussion', wallClockSec: 600, workWallClockSec: 3600, maxWorkConcurrent: 2, budget: { maxTokens: null, packetMaxBytes: 200000 }, disclosureAllowlist: [['git', 'diff']], seats }, null, 1));
  g.writeFile(path.join(roomDir, 'admin.token'), randomHex(16));
  g.writeFile(path.join(roomDir, 'events.jsonl'), '');
  return { roomDir, base };
}

function hostedService(env, opts = {}) {
  const logs = [];
  const created = [];
  const provider = createFakeProvider({ script: [{ text: 'Pi 用保存的 key 发言' }], onCreate: (init) => created.push(init.apiKey) });
  const svc = createRoomService({
    roomDir: env.roomDir, now: () => T0, log: (l) => logs.push(l),
    spawn: async () => ({ code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false }),
    codexExe: 'C:/fake/codex.exe', adjudicationsPath: path.join(env.base, 'adjudications.jsonl'), gitExe: null,
    piProvider: provider, idleCheck: async () => ({ idle: true }), ...opts,
  });
  return { svc, logs, provider, created };
}

async function runPiTurn(svc) {
  await svc.admin({ cmd: 'task', text: '讨论' });
  await svc.admin({ cmd: 'start', order: ['P'] });
  for (let i = 0; i < 4; i++) { await svc.tick(); await svc.settle(); }
  return readJsonl(path.join(svc.roomDir, 'events.jsonl'));
}

function withoutEnvKey(fn) {
  return async (...a) => {
    const saved = process.env.ROOM_PI_API_KEY;
    delete process.env.ROOM_PI_API_KEY;
    try { return await fn(...a); } finally { if (saved !== undefined) process.env.ROOM_PI_API_KEY = saved; }
  };
}

test('service (injected unprotect): reads the saved key only when needed; a failure is a Chinese warning and PI_NO_KEY', withoutEnvKey(async () => {
  const base = tempDir('dpapi-svc-inj');
  const keyFile = path.join(base, 'secrets', 'pi-key.dpapi');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, crypto.randomBytes(200));
  const KEY = newKey('svcinj');
  let calls = 0;
  const unprotectOk = async () => { calls++; return KEY; };

  // A key given to the service wins: the saved file is not even read.
  const e1 = makeHostedRoom(tempDir('dpapi-svc-r1'));
  const s1 = hostedService(e1, { piApiKey: 'sk-given', savedPiKeyPath: keyFile, piKeyUnprotect: unprotectOk });
  assert.equal(s1.svc.view().piKeySource, 'option');
  await s1.svc.close();
  assert.equal(calls, 0);

  // savedPiKey:false never reads it; neither does a room without hosted seats.
  const e2 = makeHostedRoom(tempDir('dpapi-svc-r2'));
  const s2 = hostedService(e2, { savedPiKey: false, savedPiKeyPath: keyFile, piKeyUnprotect: unprotectOk });
  await s2.svc.close();
  const e2b = makeHostedRoom(tempDir('dpapi-svc-r2b'), { hosted: false });
  const s2b = hostedService(e2b, { savedPiKeyPath: keyFile, piKeyUnprotect: unprotectOk });
  await s2b.svc.tick();
  await s2b.svc.close();
  assert.equal(s2b.svc.view().piKey, 'absent');
  assert.equal(calls, 0);

  // No key anywhere else: the saved one is used for the hosted seat.
  const e3 = makeHostedRoom(tempDir('dpapi-svc-r3'));
  const s3 = hostedService(e3, { savedPiKeyPath: keyFile, piKeyUnprotect: unprotectOk });
  const ev3 = await runPiTurn(s3.svc);
  assert.equal(calls, 1);
  assert.deepEqual(s3.created, [KEY], 'the hosted seat got the saved key');
  assert.ok(ev3.some((e) => e.type === 'submission_accepted' && e.seatId === 'P'));
  assert.equal(s3.svc.view().piKeySource, 'saved');
  await s3.svc.close();
  assert.deepEqual(filesContainingKey(e3.roomDir, KEY), []);
  assert.ok(!containsKey(s3.logs.join('\n'), KEY));

  // Decryption fails: Chinese warning with the ASCII code, room continues, hosted seat fails PI_NO_KEY.
  const e4 = makeHostedRoom(tempDir('dpapi-svc-r4'));
  const s4 = hostedService(e4, { savedPiKeyPath: keyFile, piKeyUnprotect: async () => { throw Object.assign(new Error('DPAPI_FAILED：解密失败'), { code: 'DPAPI_FAILED' }); } });
  const ev4 = await runPiTurn(s4.svc);
  const warn = s4.logs.find((l) => /警告/.test(l));
  assert.ok(warn && /DPAPI_FAILED/.test(warn) && /PI_NO_KEY/.test(warn), warn);
  const sf = ev4.find((e) => e.type === 'seat_failed' && e.seatId === 'P');
  assert.ok(sf && sf.class === 'auth_expired' && /PI_NO_KEY/.test(sf.detail) && /--save/.test(sf.detail), JSON.stringify(sf));
  assert.equal(s4.svc.view().piKey, 'absent');
  // A key that arrives later over loopback still works after the failed load.
  assert.equal((await s4.svc.admin({ cmd: 'pi-key', key: KEY })).ok, true);
  assert.equal(s4.svc.view().piKeySource, 'admin');
  await s4.svc.close();
  assert.equal(s4.provider.calls.prompt, 0);
}));

// ---------------------------------------------------------------- Windows: real DPAPI

test('DPAPI round trip: ASCII, Chinese and a 200-character key; the blob does not contain the plaintext', { skip: WIN_ONLY }, async () => {
  const keys = [newKey('ascii'), `中文密钥-${crypto.randomBytes(4).toString('hex')}-测试`, `sk-${crypto.randomBytes(100).toString('hex')}`.slice(0, 200)];
  assert.equal(keys[2].length, 200);
  for (const key of keys) {
    const blob = await protect(key);
    assert.ok(Buffer.isBuffer(blob) && blob.length > 100);
    assert.equal(blob.readUInt32LE(0), 1, 'a DPAPI blob starts with version 1');
    assert.ok(!containsKey(blob, key), 'the protected bytes do not contain the plaintext (UTF-8, base64 or UTF-16LE)');
    assert.equal(await unprotect(blob), key);
    const again = await protect(key);
    assert.ok(!again.equals(blob), 'two protections of the same key differ (random salt)');
  }
});

test('DPAPI: a tampered blob fails with DPAPI_FAILED and the error does not contain the key', { skip: WIN_ONLY }, async () => {
  const KEY = newKey('tamper');
  const blob = await protect(KEY);
  for (const at of [blob.length - 8, 70, Math.floor(blob.length / 2)]) {
    const t = Buffer.from(blob);
    t[at] ^= 0x5a;
    await assert.rejects(unprotect(t), (e) => {
      assert.equal(e.code, 'DPAPI_FAILED', e.message);
      assert.ok(!containsKey(e.message, KEY) && !containsKey(JSON.stringify(e), KEY));
      return true;
    });
  }
  await assert.rejects(unprotect(blob.subarray(0, 40)), { code: 'DPAPI_FAILED' });
  await assert.rejects(unprotect(Buffer.from('not a dpapi blob at all')), { code: 'DPAPI_FAILED' });
});

test('DPAPI (real PowerShell, recorded): the command line never contains the secret; stdin carries it as base64', { skip: WIN_ONLY }, async () => {
  const KEY = `${newKey('rec')}-中文`;
  const rec = recordingSpawn();
  const blob = await protect(KEY, { spawn: rec.spawn });
  assert.equal(await unprotect(blob, { spawn: rec.spawn }), KEY);
  assert.equal(rec.calls.length, 2);
  for (const c of rec.calls) {
    assert.equal(path.resolve(c.file).toLowerCase(), path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase());
    assert.ok(!containsKey([c.file, ...c.args].join(' '), KEY), 'not in argv');
    assert.ok(!containsKey(JSON.stringify(c.opts.env), KEY), 'not in env');
    assert.deepEqual(c.opts.env, {});
  }
  assert.equal(rec.calls[0].opts.input, `${b64(KEY)}\n`, 'the secret is on stdin, base64');
  assert.ok(!rec.calls[1].opts.input.includes(b64(KEY)), 'unprotect sends the blob, not the key');
});

test('DPAPI: PowerShell script block logging does not record the key (event 4104)', { skip: WIN_ONLY }, async (t) => {
  // Measured while writing lib/hosted/dpapi.mjs: PowerShell 5.1 auto-logs script blocks that call
  // Add-Type, so a key inside the script text would land in Microsoft-Windows-PowerShell/Operational.
  // The key travels as stdin data instead; this checks that no 4104 event since the call contains it.
  const since = new Date(Date.now() - 2000).toISOString();
  const KEY = newKey('evlog');
  await protect(KEY);
  // The needles go to the checker on stdin as data too, so its own script text never contains them.
  const script = "$ErrorActionPreference = 'Stop'; try { $in = [Console]::In.ReadToEnd().Split([char]10) | Where-Object { $_.Trim() }; $since = [DateTime]::Parse($in[0].Trim(), $null, [Globalization.DateTimeStyles]::RoundtripKind); $needles = @($in | Select-Object -Skip 1 | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.Trim())) }); $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PowerShell/Operational'; Id = 4104; StartTime = $since.ToLocalTime() } -ErrorAction SilentlyContinue); $pd = @($ev | Where-Object { $_.Message.Contains('ProtectedData') }).Count; $hits = 0; foreach ($e in $ev) { foreach ($n in $needles) { if ($e.Message.Contains($n)) { $hits++ } } }; [Console]::Out.Write('EVENTS:' + $ev.Count + ' PD:' + $pd + ' HITS:' + $hits + [char]10) } catch { [Console]::Out.Write('ERR:' + $_.Exception.GetType().FullName + [char]10) }";
  const input = [since, b64(KEY), b64(b64(KEY))].join('\n') + '\n';
  const r = await spawnClean(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { env: {}, input, timeoutMs: 60_000 });
  const m = /EVENTS:(\d+) PD:(\d+) HITS:(\d+)/.exec(r.stdout || '');
  if (!m) { t.skip(`the PowerShell operational log could not be read here (${(r.stdout || '').trim().slice(0, 80) || r.spawnError || `exit ${r.code}`})`); return; }
  if (Number(m[2]) === 0) { t.skip('script block logging recorded no DPAPI script here, so the log proves nothing either way'); return; }
  assert.equal(Number(m[3]), 0, `a 4104 event contains the key (${m[0]})`);
});

test('admin pi-key --save / --status / --forget as real CLI processes under ROOM_DEV_HOME; the service picks the saved key up', { skip: WIN_ONLY }, withoutEnvKey(async () => {
  const home = tempDir('dpapi-cli');
  const secrets = path.join(home, 'secrets');
  const file = path.join(secrets, 'pi-key.dpapi');
  const KEY = newKey('cli');
  const KEY2 = `${newKey('cli2')}-中文`;
  const cli = (args, { input, env = {} } = {}) => spawnClean(process.execPath, [ROOM_MJS, 'admin', 'pi-key', ...args], { env: { ROOM_DEV_HOME: home, ...env }, ...(input !== undefined ? { input } : {}), timeoutMs: 90_000 });
  const outputs = [];
  const run = async (args, o) => { const r = await cli(args, o); outputs.push(r.stdout, r.stderr); return r; };

  let r = await run(['--status']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`PI_KEY_STATUS saved=no path=${fwd(file)}（`), r.stdout);

  // --save from stdin
  r = await run(['--save'], { input: `${KEY}\n` });
  assert.equal(r.code, 0, r.stderr);
  const fp = keyFingerprint(KEY);
  assert.equal(fp.sha256, crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 8));
  assert.ok(r.stdout.startsWith(`SAVED ${fwd(file)} length=${KEY.length} sha256=${fp.sha256}（`), r.stdout);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one line');
  assert.ok(fs.existsSync(file));
  assert.equal(virtualizationRedirect(file), null, 'the saved file is where it says it is');
  assert.ok(!containsKey(fs.readFileSync(file), KEY));
  assert.equal(await unprotect(fs.readFileSync(file)), KEY, 'the file is a DPAPI blob of exactly the key');

  r = await run(['--status']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`PI_KEY_STATUS saved=yes decrypts=yes length=${KEY.length} sha256=${fp.sha256} path=${fwd(file)}`), r.stdout);

  // A value on the flag is refused without echo; the saved file is unchanged.
  const before = fs.readFileSync(file);
  r = await run(['--save', KEY2]);
  assert.equal(r.code, 9);
  assert.match(r.stderr, /不带值/);
  assert.ok(fs.readFileSync(file).equals(before));
  // Empty stdin, no env: refused.
  r = await run(['--save'], { input: '' });
  assert.equal(r.code, 9);
  assert.match(r.stderr, /没有拿到 API key/);

  // --save from ROOM_PI_API_KEY replaces the key.
  r = await run(['--save'], { env: { ROOM_PI_API_KEY: KEY2 } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^SAVED .* length=${KEY2.length} sha256=${keyFingerprint(KEY2).sha256}`));
  assert.equal((await piKeyStatus({ file })).sha256, keyFingerprint(KEY2).sha256);

  // The service finds it by the default path (appRoot() = ROOM_DEV_HOME) and uses it for the hosted seat.
  const env = makeHostedRoom(tempDir('dpapi-cli-room'));
  const savedHome = process.env.ROOM_DEV_HOME;
  process.env.ROOM_DEV_HOME = home;
  let s;
  try {
    assert.equal(savedPiKeyPath(), file);
    s = hostedService(env);
    const evs = await runPiTurn(s.svc);
    assert.deepEqual(s.created, [KEY2], 'the hosted seat was created with the saved key');
    const acc = evs.find((e) => e.type === 'submission_accepted' && e.seatId === 'P');
    assert.ok(acc && /保存的 key/.test(acc.text));
    assert.equal(s.svc.view().piKey, 'present');
    assert.equal(s.svc.view().piKeySource, 'saved');
    assert.ok(s.logs.some((l) => /取自 DPAPI 保存的文件/.test(l)));
    await s.svc.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROOM_DEV_HOME; else process.env.ROOM_DEV_HOME = savedHome;
  }
  assert.deepEqual(filesContainingKey(env.roomDir, KEY2), [], 'the key is in no room file');
  assert.ok(!containsKey(s.logs.join('\n'), KEY2), 'nor in the service log');
  const state = JSON.parse(fs.readFileSync(path.join(env.roomDir, 'state.json'), 'utf8'));
  assert.equal(state.piKeySource, 'saved');

  // Tampered file: --status says it does not decrypt; the service warns and continues without a key.
  const blob = fs.readFileSync(file);
  blob[blob.length - 6] ^= 0x33;
  fs.writeFileSync(file, blob);
  r = await run(['--status']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^PI_KEY_STATUS saved=yes decrypts=no code=DPAPI_FAILED /);
  const env2 = makeHostedRoom(tempDir('dpapi-cli-room2'));
  const s2 = hostedService(env2, { savedPiKeyPath: file });
  const evs2 = await runPiTurn(s2.svc);
  assert.ok(s2.logs.some((l) => /警告/.test(l) && /DPAPI_FAILED/.test(l)), s2.logs.join('\n'));
  assert.ok(evs2.some((e) => e.type === 'seat_failed' && e.seatId === 'P' && /PI_NO_KEY/.test(e.detail)));
  await s2.svc.close();

  // --forget removes it through the guard; a second --forget has nothing to do.
  r = await run(['--forget']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`FORGOTTEN ${fwd(file)}`), r.stdout);
  assert.equal(fs.existsSync(file), false);
  r = await run(['--forget']);
  assert.ok(r.stdout.startsWith(`NOT_SAVED ${fwd(file)}`), r.stdout);
  r = await run(['--status']);
  assert.match(r.stdout, /^PI_KEY_STATUS saved=no /);

  // Nothing printed the key; nothing under ROOM_DEV_HOME holds it; every write went through the
  // guard rooted at secrets/ and is in its write-log.
  for (const o of outputs) assert.ok(!containsKey(o, KEY) && !containsKey(o, KEY2), 'no output contains a key');
  assert.deepEqual(filesContainingKey(home, KEY), []);
  assert.deepEqual(filesContainingKey(home, KEY2), []);
  assert.deepEqual(walkFiles(home).map((f) => path.relative(home, f)).sort(), [path.join('secrets', 'write-log.jsonl')], 'only the write-log is left');
  const log = readJsonl(path.join(secrets, 'write-log.jsonl'));
  assert.ok(log.length >= 5);
  assert.ok(log.every((x) => x.who === 'admin:pi-key' && isInside(x.path, secrets)), JSON.stringify(log));
  assert.deepEqual([...new Set(log.map((x) => x.op))].sort(), ['mkdir', 'rm', 'write']);
}));

test('loadSavedPiKey: a missing file is "not saved"; an empty one does not reach DPAPI', async () => {
  const dir = tempDir('dpapi-load');
  const file = path.join(dir, 'pi-key.dpapi');
  assert.deepEqual(await loadSavedPiKey({ file }), { path: file, saved: false });
  fs.writeFileSync(file, Buffer.alloc(0));
  let called = 0;
  const r = await loadSavedPiKey({ file, unprotect: async () => { called++; return 'x'; } });
  assert.equal(r.saved, true);
  assert.equal(r.code, 'DPAPI_FAILED');
  assert.equal(called, 0);
  assert.deepEqual(forgetPiKey({ file: path.join(dir, 'nope.dpapi') }), { path: path.join(dir, 'nope.dpapi'), removed: false });
});
