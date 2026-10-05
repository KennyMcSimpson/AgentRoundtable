// Tests for lib/hosted/pi.mjs. Everything runs against createFakeProvider or a mocked SDK object; the
// real package is not required (and is absent on the authoring machine).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testRunsRoot } from '../lib/common.mjs';
import {
  PI_PACKAGE, TIERS, FAILURE_CLASSES, redactSecret, classifyFailure, resolveAllowed, classifyCommand,
  buildSystemPrompt, buildTools, createFakeProvider, createSdkProvider, resolvePiPackage, loadSdkProvider, createPiSeat,
} from '../lib/hosted/pi.mjs';

const KEY = 'sk-test-SECRET-9f8e7d6c5b4a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Temporary roots live under testRunsRoot() (%USERPROFILE%\room-dev\test-runs), never under
// %LOCALAPPDATA%: from inside an MSIX-packaged app those writes are redirected (INTERFACES §1).
function testRoot() {
  const base = testRunsRoot();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'pi-'));
}

function mkSeat(root, extra = {}) {
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const events = [];
  const provider = extra.provider || createFakeProvider({ script: extra.script || [], abortNeverConfirms: extra.abortNeverConfirms });
  const seat = createPiSeat({
    tier: extra.tier || 'discussion', apiKey: KEY, model: extra.model || 'anthropic/claude-test', cwd,
    sessionDir: path.join(root, 'session'), provider, onEvent: (e) => events.push(e),
    readRoots: extra.readRoots, spawn: extra.spawn, cancelTimeoutMs: extra.cancelTimeoutMs, permissionWaitMs: extra.permissionWaitMs, limits: extra.limits,
  });
  return { seat, events, provider, cwd, sessionDir: path.join(root, 'session') };
}

function assertNoKey(root, events, ...others) {
  assert.ok(!JSON.stringify(events).includes(KEY), 'events must not contain the api key');
  for (const o of others) assert.ok(!JSON.stringify(o).includes(KEY), 'returned values must not contain the api key');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else assert.ok(!fs.readFileSync(p, 'utf8').includes(KEY), `file ${p} must not contain the api key`); } };
  walk(root);
}

describe('constants', () => {
  test('tiers and failure classes match INTERFACES §9 / plan §6.7', () => {
    assert.deepEqual([...TIERS], ['discussion', 'exec', 'reviewer']);
    assert.deepEqual([...FAILURE_CLASSES], ['rate_limited', 'quota_exhausted', 'auth_expired', 'crashed', 'denied', 'other']);
    assert.equal(PI_PACKAGE, '@earendil-works/pi-coding-agent');
  });
});

describe('redactSecret', () => {
  test('replaces the secret in strings, nested objects, arrays and errors', () => {
    const err = new Error(`bad key ${KEY}`); err.code = 'E'; err.cause = { header: `Bearer ${KEY}` };
    const r = redactSecret({ a: `x${KEY}y`, b: [KEY, { c: KEY }], e: err }, KEY);
    assert.equal(r.a, 'x[redacted]y');
    assert.deepEqual(r.b, ['[redacted]', { c: '[redacted]' }]);
    assert.equal(r.e.message, 'bad key [redacted]');
    assert.equal(r.e.cause.header, 'Bearer [redacted]');
    assert.ok(!JSON.stringify(r).includes(KEY));
  });
  test('tolerates circular structures and empty secrets', () => {
    const o = { s: KEY }; o.self = o;
    const r = redactSecret(o, KEY);
    assert.equal(r.s, '[redacted]'); assert.equal(r.self, '[circular]');
    assert.equal(redactSecret('abc', ''), 'abc');
    assert.equal(redactSecret(42, KEY), 42);
  });
});

describe('classifyFailure', () => {
  test('status codes', () => {
    assert.equal(classifyFailure({ status: 429 }), 'rate_limited');
    assert.equal(classifyFailure({ statusCode: 401 }), 'auth_expired');
    assert.equal(classifyFailure({ response: { status: 403 } }), 'denied');
    assert.equal(classifyFailure(429), 'rate_limited');
  });
  test('identifiers win over status (429 + insufficient_quota is quota)', () => {
    assert.equal(classifyFailure({ status: 429, error: { code: 'insufficient_quota' } }), 'quota_exhausted');
    assert.equal(classifyFailure({ type: 'rate_limit_error' }), 'rate_limited');
    assert.equal(classifyFailure({ code: 'invalid_api_key' }), 'auth_expired');
    assert.equal(classifyFailure({ cause: { code: 'permission_denied' } }), 'denied');
    assert.equal(classifyFailure('insufficient_quota'), 'quota_exhausted');
  });
  test('ASCII identifier token in a message counts; localized or plain sentences do not', () => {
    assert.equal(classifyFailure(new Error('provider returned insufficient_quota for org')), 'quota_exhausted');
    assert.equal(classifyFailure(new Error('配额已用尽，请充值')), 'other');
    assert.equal(classifyFailure(new Error('Rate limit exceeded, retry later')), 'other');
    assert.equal(classifyFailure(new Error('Too many requests')), 'other');
  });
  test('process exit and signals are crashed; unknown is other', () => {
    assert.equal(classifyFailure({ exitCode: 1 }), 'crashed');
    assert.equal(classifyFailure({ signal: 'SIGKILL' }), 'crashed');
    assert.equal(classifyFailure({ code: 'ERR_WORKER_CRASHED' }), 'crashed');
    assert.equal(classifyFailure({ exitCode: 0 }), 'other');
    assert.equal(classifyFailure(null), 'other');
    assert.equal(classifyFailure(new Error('ECONNRESET')), 'other');
  });
});

describe('resolveAllowed', () => {
  let root;
  before(() => { root = testRoot(); fs.mkdirSync(path.join(root, 'in', 'sub'), { recursive: true }); fs.writeFileSync(path.join(root, 'in', 'sub', 'f.txt'), 'x'); fs.mkdirSync(path.join(root, 'out')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  test('inside, nonexistent-inside, outside, dot-dot escape', () => {
    const roots = [path.join(root, 'in')];
    assert.equal(resolveAllowed(roots, 'sub/f.txt', roots[0]).ok, true);
    assert.equal(resolveAllowed(roots, 'sub/new/deeper.txt', roots[0]).ok, true);
    assert.equal(resolveAllowed(roots, path.join(root, 'out', 'x'), roots[0]).ok, false);
    assert.equal(resolveAllowed(roots, '../out/x', roots[0]).ok, false);
    assert.equal(resolveAllowed(roots, '.', roots[0]).ok, true);
  });
  test('symlink escape is refused when symlinks can be created', (t) => {
    const link = path.join(root, 'in', 'escape');
    try { fs.symlinkSync(path.join(root, 'out'), link, 'junction'); } catch { t.skip('cannot create symlink here'); return; }
    const r = resolveAllowed([path.join(root, 'in')], 'escape/x.txt', path.join(root, 'in'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /符号链接/);
    assert.equal(resolveAllowed([path.join(root, 'in')], 'escape', path.join(root, 'in')).ok, false);
  });
  test('a dangling link (target missing or unresolvable) is refused, not treated as a fresh path', (t) => {
    const link = path.join(root, 'in', 'dangle');
    try { fs.symlinkSync(path.join(root, 'nowhere'), link, 'junction'); } catch { t.skip('cannot create symlink here'); return; }
    const r = resolveAllowed([path.join(root, 'in')], 'dangle/new.txt', path.join(root, 'in'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /符号链接/);
  });
  test('a root reached through a junction is compared by its real location', (t) => {
    const alias = path.join(root, 'in-alias');
    try { fs.symlinkSync(path.join(root, 'in'), alias, 'junction'); } catch { t.skip('cannot create symlink here'); return; }
    assert.equal(resolveAllowed([alias], 'sub/f.txt', alias).ok, true);
    assert.equal(resolveAllowed([path.join(root, 'in')], path.join(alias, 'sub', 'f.txt'), root).ok, false, 'lexically outside the root, whatever it resolves to');
  });
});

describe('classifyCommand', () => {
  test('safe commands', () => {
    for (const argv of [['git', 'status'], ['git', 'diff', '--stat'], ['npm', 'test'], ['node', 'script.mjs'], ['python', 'x.py'], ['dir'], ['cargo', 'build'], ['git', 'checkout', 'feature']]) {
      assert.equal(classifyCommand(argv).dangerous, false, argv.join(' '));
    }
  });
  test('dangerous categories', () => {
    assert.equal(classifyCommand(['git', 'push', 'origin', 'main']).category, 'git_push');
    assert.equal(classifyCommand(['C:\\Program Files\\Git\\bin\\git.exe', '-C', '.', 'push']).category, 'git_push');
    assert.equal(classifyCommand(['curl', 'http://x']).category, 'network');
    assert.equal(classifyCommand(['git', 'fetch']).category, 'network');
    assert.equal(classifyCommand(['npm', 'install', 'left-pad']).category, 'network');
    assert.equal(classifyCommand(['Invoke-WebRequest', 'x']).category, 'network');
    assert.equal(classifyCommand(['rm', '-rf', 'dist']).category, 'delete');
    assert.equal(classifyCommand(['Remove-Item', 'x']).category, 'delete');
    assert.equal(classifyCommand(['git', 'reset', '--hard']).category, 'delete');
    assert.equal(classifyCommand(['git', 'clean', '-fd']).category, 'delete');
    assert.equal(classifyCommand(['find', '.', '-name', '*.tmp', '-delete']).category, 'delete');
    // A shell call whose inner command is recognisably dangerous reports the inner category.
    assert.equal(classifyCommand(['bash', '-c', 'rm -rf /']).category, 'delete');
    assert.equal(classifyCommand(['cmd', '/c', 'del x']).category, 'delete');
    // An inner command that is not recognisably dangerous still leaves the call opaque: 'shell'.
    assert.equal(classifyCommand(['powershell', '-Command', 'x']).category, 'shell');
    assert.equal(classifyCommand(['cmd', '/c', 'echo hi']).category, 'shell');
    assert.equal(classifyCommand(['bash', '-c', 'ls']).category, 'shell');
    assert.equal(classifyCommand(['node', '-e', '1']).category, 'shell');
    assert.equal(classifyCommand([]).category, 'malformed');
    assert.equal(classifyCommand(['git', 42]).category, 'malformed');
    assert.equal(classifyCommand('git push').category, 'malformed');
  });

  test('git global options before the subcommand do not hide it', () => {
    for (const argv of [
      ['git', '-C', 'sub', 'push'], ['git', '--git-dir', '.git', 'push'], ['git', '--git-dir=.git', '--work-tree=.', 'push'],
      ['git', '--no-pager', '-C', '.', 'push', '--force'], ['GIT.EXE', 'push'], ['/usr/bin/git', 'send-pack', 'x'],
    ]) assert.equal(classifyCommand(argv).category, 'git_push', argv.join(' '));
    assert.equal(classifyCommand(['git', '-C', 'push', 'status']).dangerous, false, '-C value named "push" is a path, not the subcommand');
    // A config override can run anything (core.fsmonitor, alias.x=!cmd), and never hides a push.
    assert.equal(classifyCommand(['git', '-c', 'core.fsmonitor=calc', 'status']).category, 'shell');
    assert.equal(classifyCommand(['git', '-c', 'user.name=x', 'push']).category, 'git_push');
    assert.equal(classifyCommand(['git', 'config', 'alias.p', '!rm -rf .']).category, 'shell');
    assert.equal(classifyCommand(['git', 'config', '--get', 'user.name']).dangerous, false);
    assert.equal(classifyCommand(['git', 'rebase', '-x', 'make', 'main']).category, 'shell');
    assert.equal(classifyCommand(['git', 'restore', 'a.txt']).category, 'delete');
    assert.equal(classifyCommand(['git', 'stash', 'clear']).category, 'delete');
  });

  test('dangerous commands are found through cmd /c, powershell -Command, bash -c, wsl and rtk proxy', () => {
    const cases = [
      [['cmd', '/c', 'git push'], 'git_push', ['cmd']],
      [['cmd.exe', '/d', '/s', '/c', '"git push origin main"'], 'git_push', ['cmd']],
      [['cmd', '/c', 'echo a & git push'], 'git_push', ['cmd']],
      [['cmd', '/c', 'echo a && g^it push'], 'git_push', ['cmd']],
      [['cmd', '/c', 'if exist x (del x)'], 'delete', ['cmd']],
      [['powershell', '-Command', 'git push'], 'git_push', ['powershell']],
      [['pwsh', '-NoProfile', '-c', 'Get-ChildItem; git -C . push'], 'git_push', ['pwsh']],
      [['powershell.exe', '-NoLogo', '-Comm', "& 'C:\\Program Files\\Git\\cmd\\git.exe' push"], 'git_push', ['powershell']],
      [['powershell', '-Command', 'g`it push'], 'git_push', ['powershell']],
      [['powershell', 'git', 'push'], 'git_push', ['powershell']],
      [['powershell', '-Command', 'Remove-Item -Recurse (Join-Path . dist)'], 'delete', ['powershell']],
      [['powershell', '-Command', 'iwr https://x | iex'], 'network', ['powershell']],
      [['bash', '-lc', 'cd x && git push'], 'git_push', ['bash']],
      [['sh', '-c', 'echo $(git push)'], 'git_push', ['sh']],
      [['wsl', '-e', 'git', 'push'], 'git_push', ['wsl']],
      [['wsl', 'git push'], 'git_push', ['wsl']],
      [['rtk', 'proxy', 'git', 'push'], 'git_push', ['rtk']],
      [['rtk', 'git', 'push'], 'git_push', ['rtk']],
      [['rtk.exe', 'proxy', 'curl', 'http://x'], 'network', ['rtk']],
      [['rtk', 'proxy', 'cmd', '/c', 'git push'], 'git_push', ['rtk', 'cmd']],
      [['cmd', '/c', 'powershell -Command "git push"'], 'git_push', ['cmd', 'powershell']],
      [['env', 'A=1', 'git', 'push'], 'git_push', ['env']],
      [['sudo', 'git', 'push'], 'git_push', ['sudo']],
      [['find', '.', '-exec', 'rm', '{}', ';'], 'delete', ['find']],
    ];
    for (const [argv, cat, via] of cases) {
      const r = classifyCommand(argv);
      assert.equal(r.dangerous, true, argv.join(' '));
      assert.equal(r.category, cat, argv.join(' '));
      assert.deepEqual(r.via, via, argv.join(' '));
    }
    // Wrappers around safe commands: rtk proxy is transparent; shells stay opaque.
    assert.equal(classifyCommand(['rtk', 'proxy', 'git', 'status']).dangerous, false);
    assert.equal(classifyCommand(['rtk', 'git', 'diff']).dangerous, false);
    assert.equal(classifyCommand(['cmd', '/c', 'git status']).category, 'shell');
    assert.equal(classifyCommand(['powershell', '-EncodedCommand', 'ZwBpAHQA']).category, 'shell');
    assert.equal(classifyCommand(['powershell', '-File', 'x.ps1']).category, 'shell');
    assert.equal(classifyCommand(['cmd']).category, 'shell');
    assert.equal(classifyCommand(['powershell', '-NoProfile']).category, 'shell');
    assert.equal(classifyCommand(['bash', 'build.sh']).dangerous, false, 'a script file in cwd is on the same footing as node script.mjs');
  });
});

describe('buildSystemPrompt / buildTools', () => {
  test('prompt names the tier and cwd', () => {
    for (const tier of TIERS) assert.ok(buildSystemPrompt({ tier, cwd: 'E:\\x' }).length > 20);
    assert.match(buildSystemPrompt({ tier: 'exec', cwd: 'E:\\x' }), /E:\\x/);
    assert.match(buildSystemPrompt({ tier: 'discussion', cwd: 'E:\\x' }), /没有任何工具/);
  });
  test('tool sets per tier', () => {
    const ctx = { cwd: 'E:\\x', readRoots: [], guard: null, emit() {}, limits: {}, requestPermission() {}, spawn: null };
    assert.deepEqual(buildTools({ ...ctx, tier: 'discussion' }), []);
    assert.deepEqual(buildTools({ ...ctx, tier: 'reviewer' }).map((t) => t.name), ['read_file', 'list_dir', 'grep']);
    assert.deepEqual(buildTools({ ...ctx, tier: 'exec' }).map((t) => t.name), ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file', 'exec']);
    for (const t of buildTools({ ...ctx, tier: 'exec' })) { assert.equal(t.parameters.type, 'object'); assert.equal(typeof t.execute, 'function'); assert.ok(t.description); }
  });
});

describe('createPiSeat validation and install check', () => {
  let root;
  before(() => { root = testRoot(); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  test('rejects bad tier, missing key, relative paths, missing model', () => {
    const base = { apiKey: KEY, model: 'm', cwd: root, sessionDir: path.join(root, 's'), provider: createFakeProvider() };
    assert.throws(() => createPiSeat({ ...base, tier: 'admin' }), { code: 'PI_BAD_TIER' });
    assert.throws(() => createPiSeat({ ...base, tier: 'discussion', apiKey: '' }), { code: 'PI_NO_KEY' });
    assert.throws(() => createPiSeat({ ...base, tier: 'discussion', cwd: 'relative' }), { code: 'PI_BAD_CWD' });
    assert.throws(() => createPiSeat({ ...base, tier: 'discussion', sessionDir: 'rel' }), { code: 'PI_BAD_SESSION_DIR' });
    assert.throws(() => createPiSeat({ ...base, tier: 'discussion', model: '' }), { code: 'PI_NO_MODEL' });
  });
  test('without an injected provider, a missing package throws PI_NOT_INSTALLED synchronously', (t) => {
    let installed = true;
    try { resolvePiPackage(); } catch (e) { installed = false; assert.equal(e.code, 'PI_NOT_INSTALLED'); }
    if (installed) { t.skip('pi package is installed on this machine'); return; }
    assert.throws(() => createPiSeat({ tier: 'discussion', apiKey: KEY, model: 'm', cwd: root, sessionDir: path.join(root, 's2') }), { code: 'PI_NOT_INSTALLED' });
    assert.ok(!fs.existsSync(path.join(root, 's2')), 'nothing is created before the check passes');
  });
  test('resolvePiPackage / loadSdkProvider on a bogus package name', async () => {
    assert.throws(() => resolvePiPackage('@room-dev/definitely-not-installed'), { code: 'PI_NOT_INSTALLED' });
    await assert.rejects(loadSdkProvider('@room-dev/definitely-not-installed'), { code: 'PI_NOT_INSTALLED' });
  });
  test('model "provider/id" is split; explicit modelProvider wins', () => {
    const a = createPiSeat({ tier: 'discussion', apiKey: KEY, model: 'openai/gpt-x', cwd: root, sessionDir: path.join(root, 's3'), provider: createFakeProvider() });
    assert.equal(a.modelProvider, 'openai'); assert.equal(a.model, 'gpt-x');
    const b = createPiSeat({ tier: 'discussion', apiKey: KEY, model: 'claude-x', modelProvider: 'anthropic', cwd: root, sessionDir: path.join(root, 's4'), provider: createFakeProvider() });
    assert.equal(b.modelProvider, 'anthropic'); assert.equal(b.model, 'claude-x');
    assert.deepEqual(a.tools, []);
  });
});

describe('discussion tier', () => {
  let root;
  before(() => { root = testRoot(); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('prompt returns end_turn with text and normalized usage; session created once; key never leaks', async () => {
    const { seat, events, provider } = mkSeat(root, { script: [{ text: '第一轮发言', usage: { inputTokens: 100, outputTokens: 20 } }, { text: '第二轮' }] });
    const r1 = await seat.prompt('packet 1');
    assert.equal(r1.stopReason, 'end_turn'); assert.equal(r1.text, '第一轮发言');
    assert.deepEqual(r1.usage, { input: 100, output: 20, cached: 0 });
    const r2 = await seat.prompt('packet 2');
    assert.equal(r2.text, '第二轮');
    assert.equal(provider.calls.createSession, 1);
    assert.equal(provider.calls.prompt, 2);
    assert.ok(events.some((e) => e.type === 'session_created' && e.tier === 'discussion'));
    assert.ok(events.some((e) => e.type === 'usage' && e.input === 100));
    assertNoKey(root, events, r1, r2);
    await seat.dispose();
  });

  test('provider error -> stopReason error, failureClass from code, no retry, key redacted from detail', async () => {
    const err = new Error(`401 unauthorized with key ${KEY}`); err.status = 401;
    const { seat, events, provider } = mkSeat(root, { script: [{ throw: err }] });
    const r = await seat.prompt('p');
    assert.equal(r.stopReason, 'error'); assert.equal(r.failureClass, 'auth_expired');
    assert.equal(provider.calls.prompt, 1, 'no automatic retry');
    assert.ok(events.some((e) => e.type === 'prompt_failed' && e.failureClass === 'auth_expired'));
    assert.ok(r.error.message.includes('[redacted]'));
    assertNoKey(root, events, r);
    await seat.dispose();
  });

  test('429 -> rate_limited (plan #24); insufficient_quota -> quota_exhausted', async () => {
    const { seat } = mkSeat(root, { script: [{ throw: { status: 429 } }, { throw: { status: 429, error: { code: 'insufficient_quota' } } }] });
    assert.equal((await seat.prompt('a')).failureClass, 'rate_limited');
    assert.equal((await seat.prompt('b')).failureClass, 'quota_exhausted');
    await seat.dispose();
  });

  test('stopReason error returned (not thrown) by the provider is classified too', async () => {
    const { seat } = mkSeat(root, { script: [{ text: 'partial', stopReason: 'error', error: { type: 'overloaded_error' } }] });
    const r = await seat.prompt('a');
    assert.equal(r.stopReason, 'error'); assert.equal(r.failureClass, 'rate_limited'); assert.equal(r.text, 'partial');
    await seat.dispose();
  });

  test('session creation failure is reported as an error result and retried on the next prompt', async () => {
    let n = 0;
    const provider = { calls: {}, async createSession() { if (n++ === 0) { const e = new Error('boom'); e.exitCode = 3; throw e; } return (await createFakeProvider({ script: [{ text: 'ok' }] }).createSession({ tier: 'discussion', tools: [] })); } };
    const { seat } = mkSeat(root, { provider });
    const r1 = await seat.prompt('a');
    assert.equal(r1.stopReason, 'error'); assert.equal(r1.failureClass, 'crashed');
    const r2 = await seat.prompt('b');
    assert.equal(r2.stopReason, 'end_turn'); assert.equal(r2.text, 'ok');
    await seat.dispose();
  });

  test('second prompt while one is in flight is refused with PI_BUSY', async () => {
    const { seat } = mkSeat(root, { script: [{ text: 'slow', delayMs: 60 }] });
    const p = seat.prompt('a');
    assert.equal(seat.busy, true);
    await assert.rejects(seat.prompt('b'), { code: 'PI_BUSY' });
    await p;
    assert.equal(seat.busy, false);
    await seat.dispose();
  });

  test('non-string packet rejected', async () => {
    const { seat } = mkSeat(root);
    await assert.rejects(seat.prompt(42), { code: 'PI_BAD_PACKET' });
    await seat.dispose();
  });
});

describe('cancel', () => {
  let root;
  before(() => { root = testRoot(); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('confirmed cancel resolves the prompt with cancelled and no unconfirmed flag', async () => {
    const { seat, events, provider } = mkSeat(root, { script: [{ hang: true }] });
    const p = seat.prompt('a');
    await sleep(10);
    const c = await seat.cancel();
    const r = await p;
    assert.equal(r.stopReason, 'cancelled'); assert.equal(r.unconfirmed, undefined);
    assert.deepEqual(c, { cancelled: true, unconfirmed: false });
    assert.equal(provider.calls.abort, 1);
    assert.ok(events.some((e) => e.type === 'cancel_requested'));
    assert.ok(!events.some((e) => e.type === 'cancel_unconfirmed'));
    await seat.dispose();
  });

  test('cancel with nothing in flight is a no-op; repeated cancel is idempotent', async () => {
    const { seat } = mkSeat(root, { script: [{ hang: true }] });
    assert.deepEqual(await seat.cancel(), { cancelled: false });
    const p = seat.prompt('a');
    await sleep(5);
    const [c1, c2] = await Promise.all([seat.cancel(), seat.cancel()]);
    assert.equal(c1.cancelled, true); assert.equal(c2.cancelled, true);
    assert.equal((await p).stopReason, 'cancelled');
    await seat.dispose();
  });

  test('unconfirmed cancel: provider never confirms -> cancelled + unconfirmed:true within the timeout', async () => {
    const { seat, events } = mkSeat(root, { script: [{ hang: true, ignoreAbort: true }], abortNeverConfirms: true, cancelTimeoutMs: 40 });
    const p = seat.prompt('a');
    await sleep(5);
    const t0 = Date.now();
    const c = await seat.cancel();
    const r = await p;
    assert.ok(Date.now() - t0 < 2000, 'cancel() must not hang on an unresponsive provider');
    assert.equal(r.stopReason, 'cancelled'); assert.equal(r.unconfirmed, true);
    assert.equal(c.unconfirmed, true);
    assert.ok(events.some((e) => e.type === 'cancel_unconfirmed'));
    await seat.dispose();
  });

  test('a result arriving after an unconfirmed cancel is dropped, not published', async () => {
    const { seat, events } = mkSeat(root, { script: [async () => { await sleep(120); return { text: 'late answer' }; }], abortNeverConfirms: true, cancelTimeoutMs: 30 });
    const p = seat.prompt('a');
    await sleep(5);
    await seat.cancel();
    const r = await p;
    assert.equal(r.stopReason, 'cancelled'); assert.equal(r.text, '');
    await sleep(160);
    assert.ok(events.some((e) => e.type === 'late_result_dropped'));
    assert.equal(seat.busy, false);
    await seat.dispose();
  });

  test('caller-supplied AbortSignal cancels; an already-aborted signal cancels too', async () => {
    const { seat } = mkSeat(root, { script: [{ hang: true }, { hang: true }] });
    const ac = new AbortController();
    const p = seat.prompt('a', { signal: ac.signal });
    await sleep(5); ac.abort();
    assert.equal((await p).stopReason, 'cancelled');
    const ac2 = new AbortController(); ac2.abort();
    assert.equal((await seat.prompt('b', { signal: ac2.signal })).stopReason, 'cancelled');
    await seat.dispose();
  });

  test('dispose cancels an in-flight turn, disposes the provider, and refuses later prompts', async () => {
    const { seat, events, provider } = mkSeat(root, { script: [{ hang: true }] });
    const p = seat.prompt('a');
    await sleep(5);
    await seat.dispose();
    assert.equal((await p).stopReason, 'cancelled');
    assert.equal(provider.calls.dispose, 1);
    assert.equal(seat.disposed, true);
    await assert.rejects(seat.prompt('b'), { code: 'PI_DISPOSED' });
    assert.ok(events.some((e) => e.type === 'disposed'));
    await seat.dispose(); // idempotent
  });
});

describe('reviewer tier (read-only tools)', () => {
  let root, cwd, materials;
  before(() => {
    root = testRoot();
    cwd = path.join(root, 'work'); fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.mjs'), 'line1\nexport const x = 1;\nline3\n');
    fs.writeFileSync(path.join(cwd, 'src', 'b.txt'), 'nothing here\nexport nothing\n');
    fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([1, 2, 0, 4]));
    fs.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'node_modules', 'dep', 'x.mjs'), 'export const x = 2;');
    materials = path.join(root, 'materials'); fs.mkdirSync(materials); fs.writeFileSync(path.join(materials, 'm.md'), '# 材料\n');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function reviewerSeat(script) {
    const events = [];
    const seat = createPiSeat({ tier: 'reviewer', apiKey: KEY, model: 'm', cwd, sessionDir: path.join(root, 'session-r'), provider: createFakeProvider({ script }), onEvent: (e) => events.push(e), readRoots: [materials] });
    return { seat, events };
  }

  test('tool list, read inside cwd with paging, read from an extra read root', async () => {
    const seen = [];
    const { seat, events } = reviewerSeat([async ({ tools, callTool }) => {
      seen.push(tools);
      seen.push(await callTool('read_file', { path: 'src/a.mjs', offset: 2, limit: 1 }));
      seen.push(await callTool('read_file', { path: path.join(materials, 'm.md') }));
      seen.push(await callTool('read_file', { path: 'bin.dat' }));
      return { text: 'done' };
    }]);
    assert.deepEqual(seat.tools, ['read_file', 'list_dir', 'grep']);
    await seat.prompt('p');
    assert.deepEqual(seen[0], ['read_file', 'list_dir', 'grep']);
    assert.equal(seen[1].content[0].text, '2\texport const x = 1;');
    assert.equal(seen[1].details.totalLines, 4);
    assert.match(seen[2].content[0].text, /材料/);
    assert.equal(seen[3].details.binary, true);
    assert.equal(events.filter((e) => e.type === 'tool_call' && e.tool === 'read_file').length, 2);
    await seat.dispose();
  });

  test('read outside the allowed roots is refused and surfaced as tool_denied', async () => {
    let res;
    const { seat, events } = reviewerSeat([async ({ callTool }) => { res = await callTool('read_file', { path: '../secret.txt' }); return { text: 'x' }; }]);
    await seat.prompt('p');
    assert.equal(res.details.denied, true);
    assert.match(res.content[0].text, /拒绝/);
    const d = events.find((e) => e.type === 'tool_denied');
    assert.equal(d.tool, 'read_file');
    assert.ok(!events.some((e) => e.type === 'permission_pending'), 'reviewer refusals are not permission requests');
    await seat.dispose();
  });

  test('list_dir and grep (glob, skip node_modules, max results, outside refused)', async () => {
    const out = {};
    const { seat } = reviewerSeat([async ({ callTool }) => {
      out.ls = await callTool('list_dir', { path: 'src' });
      out.grep = await callTool('grep', { pattern: '^export', path: '.' });
      out.grepGlob = await callTool('grep', { pattern: 'export', glob: '*.txt' });
      out.grepMax = await callTool('grep', { pattern: 'line', maxResults: 1 });
      out.grepOut = await callTool('grep', { pattern: 'x', path: '..' });
      out.bad = await callTool('grep', { pattern: '(' });
      return { text: 'x' };
    }]);
    await seat.prompt('p');
    assert.deepEqual(out.ls.details.entries.map((e) => e.name).sort(), ['a.mjs', 'b.txt']);
    assert.deepEqual(out.grep.details.hits.map((h) => h.file.replace(/\\/g, '/')).sort(), ['src/a.mjs', 'src/b.txt']);
    assert.deepEqual(out.grepGlob.details.hits.map((h) => h.file.replace(/\\/g, '/')), ['src/b.txt']);
    assert.equal(out.grepMax.details.hits.length, 1); assert.equal(out.grepMax.details.truncated, true);
    assert.equal(out.grepOut.details.denied, true);
    assert.equal(out.bad.details.error, 'bad_pattern');
    await seat.dispose();
  });

  test('reviewer has no write or exec tool at all', async () => {
    let err;
    const { seat } = reviewerSeat([async ({ callTool }) => { try { await callTool('write_file', { path: 'x', content: 'y' }); } catch (e) { err = e; } return { text: 'x' }; }]);
    await seat.prompt('p');
    assert.equal(err.code, 'FAKE_NO_TOOL');
    assert.ok(!fs.existsSync(path.join(cwd, 'x')));
    await seat.dispose();
  });
});

describe('exec tier (write / edit / exec with interception)', () => {
  let root, cwd;
  before(() => {
    root = testRoot();
    cwd = path.join(root, 'work'); fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'alpha beta alpha\n');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function execSeat(script, extra = {}) {
    const events = [];
    const spawnCalls = [];
    const spawn = extra.spawn || (async (file, args, o) => { spawnCalls.push({ file, args, o }); return { exitCode: 0, stdout: `ran ${file}`, stderr: '', truncated: false, timedOut: false }; });
    const seat = createPiSeat({ tier: 'exec', apiKey: KEY, model: 'm', cwd, sessionDir: extra.sessionDir || path.join(root, 'session-e'), provider: createFakeProvider({ script }), onEvent: (e) => events.push(e), spawn, permissionWaitMs: extra.permissionWaitMs });
    return { seat, events, spawnCalls };
  }

  test('write inside cwd goes through the guard and is logged in the seat session dir', async () => {
    let res;
    const { seat, events } = execSeat([async ({ callTool }) => { res = await callTool('write_file', { path: 'out/new.txt', content: '你好\n' }); return { text: 'x' }; }]);
    assert.deepEqual(seat.tools, ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file', 'exec']);
    await seat.prompt('p');
    assert.equal(fs.readFileSync(path.join(cwd, 'out', 'new.txt'), 'utf8'), '你好\n');
    assert.equal(res.details.bytes, Buffer.byteLength('你好\n'));
    const log = fs.readFileSync(path.join(root, 'session-e', 'write-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(log.some((l) => l.op === 'write' && l.path.toLowerCase() === path.join(cwd, 'out', 'new.txt').toLowerCase()));
    assert.ok(log.every((l) => l.path.toLowerCase().startsWith(cwd.toLowerCase()) || l.path.toLowerCase().startsWith(path.join(root, 'session-e').toLowerCase())));
    assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'write_file'));
    assertNoKey(root, events);
    await seat.dispose();
  });

  test('write outside cwd, into .git, into .room-outbox -> permission_pending, nothing written', async () => {
    const out = {};
    const { seat, events } = execSeat([async ({ callTool }) => {
      out.outside = await callTool('write_file', { path: '../escaped.txt', content: 'x' });
      out.git = await callTool('write_file', { path: '.git/config', content: 'x' });
      out.outbox = await callTool('edit_file', { path: '.room-outbox/A/joined.json', oldText: 'a', newText: 'b' });
      return { text: 'x' };
    }]);
    await seat.prompt('p');
    assert.ok(!fs.existsSync(path.join(root, 'escaped.txt')));
    assert.ok(!fs.existsSync(path.join(cwd, '.git', 'config')));
    assert.equal(out.outside.details.pending, true); assert.equal(out.outside.details.category, 'write_outside_cwd');
    assert.equal(out.git.details.category, 'git_internal');
    assert.equal(out.outbox.details.category, 'outbox');
    assert.match(out.outside.content[0].text, /待审批/);
    const pend = events.filter((e) => e.type === 'permission_pending');
    assert.equal(pend.length, 3);
    assert.deepEqual(seat.pendingPermissions().map((p) => p.category), ['write_outside_cwd', 'git_internal', 'outbox']);
    await seat.dispose();
    assert.equal(seat.pendingPermissions().length, 0, 'dispose denies what is still pending');
  });

  test('edit_file: success, not found, ambiguous', async () => {
    const out = {};
    const { seat } = execSeat([async ({ callTool }) => {
      out.amb = await callTool('edit_file', { path: 'notes.txt', oldText: 'alpha', newText: 'A' });
      out.nf = await callTool('edit_file', { path: 'notes.txt', oldText: 'zzz', newText: 'A' });
      out.ok = await callTool('edit_file', { path: 'notes.txt', oldText: 'beta', newText: 'BETA' });
      return { text: 'x' };
    }]);
    await seat.prompt('p');
    assert.equal(out.amb.details.error, 'ambiguous');
    assert.equal(out.nf.details.error, 'not_found');
    assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'alpha BETA alpha\n');
    await seat.dispose();
  });

  test('safe exec runs through the injected spawn with cwd and an empty env; dangerous exec is intercepted before spawn', async () => {
    const out = {};
    const { seat, events, spawnCalls } = execSeat([async ({ callTool }) => {
      out.ok = await callTool('exec', { argv: ['git', 'status'], timeoutSec: 5 });
      out.push = await callTool('exec', { argv: ['git', 'push'] });
      out.net = await callTool('exec', { argv: ['curl', 'http://example.invalid'] });
      out.del = await callTool('exec', { argv: ['rm', '-rf', '.'] });
      out.shell = await callTool('exec', { argv: ['powershell', '-Command', 'Get-Date'] });
      out.psDel = await callTool('exec', { argv: ['powershell', '-Command', 'Remove-Item *'] });
      out.cmdPush = await callTool('exec', { argv: ['cmd', '/c', 'git push'] });
      out.rtkPush = await callTool('exec', { argv: ['rtk', 'proxy', 'git', 'push'] });
      out.bad = await callTool('exec', { argv: ['git', 42] });
      return { text: 'x' };
    }]);
    await seat.prompt('p');
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, ['status']);
    assert.equal(spawnCalls[0].o.cwd, cwd); assert.deepEqual(spawnCalls[0].o.env, {}); assert.equal(spawnCalls[0].o.timeoutMs, 5000);
    assert.match(out.ok.content[0].text, /exit=0/); assert.match(out.ok.content[0].text, /ran git/);
    for (const [k, cat] of [['push', 'git_push'], ['net', 'network'], ['del', 'delete'], ['shell', 'shell'], ['psDel', 'delete'], ['cmdPush', 'git_push'], ['rtkPush', 'git_push']]) {
      assert.equal(out[k].details.pending, true, k); assert.equal(out[k].details.category, cat, k);
    }
    const pend = events.filter((e) => e.type === 'permission_pending' && e.tool === 'exec');
    assert.equal(pend.length, 7);
    assert.deepEqual(pend.find((e) => e.id === out.cmdPush.details.permissionId).params, { argv: ['cmd', '/c', 'git push'], via: ['cmd'] });
    // Malformed argv is refused outright, not offered for approval (coercion would make ['git', 42] look harmless).
    assert.equal(out.bad.details.denied, true); assert.equal(out.bad.details.error, 'malformed');
    await seat.dispose();
  });

  test('exec reports spawn failure and missing exit code gracefully', async () => {
    const out = {};
    const spawn = async (file) => { if (file === 'boom') throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); return { stdout: 'x', stderr: 'warn', timedOut: true }; };
    const { seat } = execSeat([async ({ callTool }) => { out.a = await callTool('exec', { argv: ['boom'] }); out.b = await callTool('exec', { argv: ['node', 'x.mjs'] }); return { text: 'x' }; }], { spawn });
    await seat.prompt('p');
    assert.equal(out.a.details.error, 'ENOENT');
    assert.match(out.b.content[0].text, /exit=\? \(timeout\)/); assert.match(out.b.content[0].text, /stderr/);
    await seat.dispose();
  });

  test('resolvePermission: approve executes the stored action later; deny does not; errors for bad ids/decisions', async () => {
    const { seat, events, spawnCalls } = execSeat([async ({ callTool }) => { await callTool('exec', { argv: ['git', 'push'] }); await callTool('exec', { argv: ['curl', 'x'] }); return { text: 'x' }; }]);
    await seat.prompt('p');
    const [a, b] = seat.pendingPermissions();
    assert.equal(spawnCalls.length, 0);
    const ra = await seat.resolvePermission(a.id, 'approve');
    assert.equal(ra.decision, 'approve'); assert.equal(spawnCalls.length, 1); assert.deepEqual(spawnCalls[0].args, ['push']);
    assert.ok(events.some((e) => e.type === 'permission_resolved' && e.id === a.id && e.decision === 'approve'));
    const rb = await seat.resolvePermission(b.id, 'deny');
    assert.equal(rb.result, null); assert.equal(spawnCalls.length, 1);
    assert.equal(seat.pendingPermissions().length, 0);
    await assert.rejects(seat.resolvePermission(a.id, 'approve'), { code: 'PI_PERMISSION_DECIDED' });
    await assert.rejects(seat.resolvePermission('perm-nope', 'approve'), { code: 'PI_NO_SUCH_PERMISSION' });
    await assert.rejects(seat.resolvePermission(b.id, 'maybe'), { code: 'PI_BAD_DECISION' });
    await seat.dispose();
  });

  test('approved write_outside_cwd still cannot pass the guard (roots are cwd and sessionDir)', async () => {
    const { seat } = execSeat([async ({ callTool }) => { await callTool('write_file', { path: '../escaped2.txt', content: 'x' }); return { text: 'x' }; }]);
    await seat.prompt('p');
    const [p] = seat.pendingPermissions();
    const r = await seat.resolvePermission(p.id, 'approve');
    assert.equal(r.result.details.error, 'GuardViolation');
    assert.ok(!fs.existsSync(path.join(root, 'escaped2.txt')));
    await seat.dispose();
  });

  test('approval runs exactly the stored snapshot, exactly once (later mutation and racing approvals change nothing)', async () => {
    const pExec = { argv: ['git', 'push', 'origin'] };
    const pWrite = { path: '../snap.txt', content: 'original' };
    const { seat, spawnCalls, events } = execSeat([async ({ callTool }) => { await callTool('exec', pExec); await callTool('write_file', pWrite); return { text: 'x' }; }], { sessionDir: path.join(root, 'session-once') });
    await seat.prompt('p');
    pExec.argv[1] = 'status'; pExec.argv.push('--evil'); pWrite.content = 'mutated';
    const [a, w] = seat.pendingPermissions();
    assert.deepEqual(a.params.argv, ['git', 'push', 'origin'], 'what the user sees is the snapshot');
    assert.equal(w.params.bytes, Buffer.byteLength('original'));
    assert.ok(Object.isFrozen(a.params));
    const [r1, r2] = await Promise.allSettled([seat.resolvePermission(a.id, 'approve'), seat.resolvePermission(a.id, 'approve')]);
    assert.equal(r1.status, 'fulfilled'); assert.equal(r2.status, 'rejected'); assert.equal(r2.reason.code, 'PI_PERMISSION_DECIDED');
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, ['push', 'origin']);
    assert.equal(events.filter((e) => e.type === 'permission_resolved' && e.id === a.id).length, 1);
    await seat.resolvePermission(w.id, 'deny');
    assert.ok(!fs.existsSync(path.join(root, 'snap.txt')));
    await seat.dispose();
  });

  test('approved write into the seat\'s own session dir is refused even though the guard root covers it', async () => {
    const sessionDir = path.join(root, 'session-prot');
    const { seat } = execSeat([async ({ callTool }) => { await callTool('write_file', { path: '../session-prot/agent/settings.json', content: '{}' }); return { text: 'x' }; }], { sessionDir });
    await seat.prompt('p');
    const [p] = seat.pendingPermissions();
    assert.equal(p.category, 'write_outside_cwd');
    const r = await seat.resolvePermission(p.id, 'approve');
    assert.equal(r.result.details.error, 'GuardViolation');
    assert.ok(!fs.existsSync(path.join(sessionDir, 'agent', 'settings.json')));
    await seat.dispose();
  });

  test('a junction inside cwd pointing outside: write is intercepted, and approval still cannot write through it', async (t) => {
    const outside = path.join(root, 'outside-target'); fs.mkdirSync(outside, { recursive: true });
    const link = path.join(cwd, 'via-link');
    try { fs.symlinkSync(outside, link, 'junction'); } catch { t.skip('cannot create symlink here'); return; }
    try {
      const out = {};
      const { seat } = execSeat([async ({ callTool }) => {
        out.w = await callTool('write_file', { path: 'via-link/x.txt', content: 'x' });
        out.e = await callTool('edit_file', { path: 'via-link/x.txt', oldText: 'a', newText: 'b' });
        return { text: 'x' };
      }], { sessionDir: path.join(root, 'session-link') });
      await seat.prompt('p');
      assert.equal(out.w.details.category, 'write_outside_cwd');
      assert.equal(out.e.details.category, 'write_outside_cwd');
      const [pw, pe] = seat.pendingPermissions();
      assert.equal((await seat.resolvePermission(pw.id, 'approve')).result.details.error, 'GuardViolation');
      assert.equal((await seat.resolvePermission(pe.id, 'approve')).result.details.error, 'GuardViolation');
      assert.ok(!fs.existsSync(path.join(outside, 'x.txt')));
      await seat.dispose();
    } finally { fs.rmSync(link, { recursive: true, force: true }); }
  });

  // Measured on Windows 11 / Node 24: `.GIT`, `.git::$INDEX_ALLOCATION` and the 8.3 name `GIT~1` all
  // write into `.git`; `.git.` does NOT (Node passes the name through literally, it is a new directory).
  test('.git is recognised by its real location (.GIT, ::$INDEX_ALLOCATION, 8.3 alias on Windows)', async (t) => {
    if (process.platform !== 'win32') { t.skip('these aliases are a Windows property'); return; }
    const shortAlias = (() => { try { return fs.realpathSync.native(path.join(cwd, 'GIT~1')).toLowerCase() === path.join(cwd, '.git').toLowerCase(); } catch { return false; } })();
    const out = {};
    const { seat } = execSeat([async ({ callTool }) => {
      out.upper = await callTool('write_file', { path: '.GIT/config', content: 'x' });
      out.stream = await callTool('write_file', { path: '.git::$INDEX_ALLOCATION/hooks/pre-commit', content: 'x' });
      if (shortAlias) out.short = await callTool('write_file', { path: 'GIT~1/hooks/post-checkout', content: 'x' });
      return { text: 'x' };
    }], { sessionDir: path.join(root, 'session-gitcase') });
    await seat.prompt('p');
    assert.equal(out.upper.details.category, 'git_internal');
    assert.equal(out.stream.details.category, 'git_internal');
    if (shortAlias) assert.equal(out.short.details.category, 'git_internal');
    assert.ok(!fs.existsSync(path.join(cwd, '.git', 'config')));
    assert.ok(!fs.existsSync(path.join(cwd, '.git', 'hooks')));
    await seat.dispose();
  });

  test('permissionWaitMs > 0: a decision during the wait is returned to the model in the same turn; timeout returns pending', async () => {
    const out = {};
    const { seat, spawnCalls } = execSeat([async ({ callTool }) => { out.a = await callTool('exec', { argv: ['git', 'push'] }); out.b = await callTool('exec', { argv: ['curl', 'x'] }); return { text: 'x' }; }], { permissionWaitMs: 150, sessionDir: path.join(root, 'session-w') });
    const p = seat.prompt('p');
    await sleep(20);
    const [a] = seat.pendingPermissions();
    await seat.resolvePermission(a.id, 'approve');
    await p;
    assert.match(out.a.content[0].text, /exit=0/);
    assert.equal(out.b.details.pending, true);
    assert.equal(spawnCalls.length, 1);
    await seat.dispose();
  });

  test('exec without an injected spawn goes through lib/spawn.mjs: real exit code, missing executable reported', async (t) => {
    if (!fs.existsSync(new URL('../lib/spawn.mjs', import.meta.url))) { t.skip('lib/spawn.mjs not present'); return; }
    const out = {};
    const seat = createPiSeat({ tier: 'exec', apiKey: KEY, model: 'm', cwd, sessionDir: path.join(root, 'session-real'), provider: createFakeProvider({ script: [async ({ callTool }) => {
      out.ok = await callTool('exec', { argv: [process.execPath, '--version'], timeoutSec: 30 });
      out.missing = await callTool('exec', { argv: [path.join(cwd, 'definitely-missing-binary.exe')], timeoutSec: 30 });
      return { text: 'x' };
    }] }) });
    await seat.prompt('p');
    assert.match(out.ok.content[0].text, /exit=0/);
    assert.match(out.ok.content[0].text, /v\d+\./);
    assert.ok(out.missing.details.error, 'a missing executable is an error result, not a crash');
    await seat.dispose();
  });

  test('exec without an injected spawn and without lib/spawn.mjs reports SPAWN_UNAVAILABLE instead of running anything', async (t) => {
    if (fs.existsSync(new URL('../lib/spawn.mjs', import.meta.url))) { t.skip('lib/spawn.mjs exists now; the lazy import path is exercised by that module'); return; }
    let res;
    const events = [];
    const seat = createPiSeat({ tier: 'exec', apiKey: KEY, model: 'm', cwd, sessionDir: path.join(root, 'session-n'), provider: createFakeProvider({ script: [async ({ callTool }) => { res = await callTool('exec', { argv: ['git', 'status'] }); return { text: 'x' }; }] }), onEvent: (e) => events.push(e) });
    await seat.prompt('p');
    assert.equal(res.details.error, 'SPAWN_UNAVAILABLE');
    await seat.dispose();
  });
});

describe('createFakeProvider', () => {
  test('script entries, tool dispatch, counters', async () => {
    const prov = createFakeProvider({ script: [{ text: 'a' }, { toolCalls: [{ name: 't', params: { v: 1 } }], text: 'b', usage: null }] });
    const calls = [];
    const s = await prov.createSession({ tier: 'exec', tools: [{ name: 't', async execute(_id, p) { calls.push(p); return { content: [{ type: 'text', text: 'r' }], details: {} }; } }] });
    assert.deepEqual(await s.prompt('x'), { text: 'a', usage: { input: 10, output: 5, cached: 0 }, stopReason: 'stop', error: undefined, toolResults: [] });
    const r2 = await s.prompt('y');
    assert.equal(r2.text, 'b'); assert.equal(r2.usage, null); assert.deepEqual(calls, [{ v: 1 }]);
    assert.equal((await s.prompt('z')).text, '（空脚本）');
    await s.abort(); await s.dispose();
    assert.deepEqual(prov.calls, { createSession: 1, prompt: 3, abort: 1, dispose: 1 });
  });
});

describe('createSdkProvider (mocked SDK surface)', () => {
  function mockSdk(overrides = {}) {
    const auth = { runtime: {}, saved: [] };
    class AuthStorage { constructor(p) { this.path = p; } static create(p) { return new AuthStorage(p); } setRuntimeApiKey(prov, key) { auth.runtime[prov] = key; } set(prov, cred) { auth.saved.push([prov, cred]); } }
    class ModelRegistry { constructor(a) { this.auth = a; } find(prov, id) { return id === 'missing' ? null : { provider: prov, id }; } }
    const SessionManager = { create(cwd, dir) { return { cwd, dir }; } };
    const SettingsManager = { inMemory(o) { return { o }; } };
    class DefaultResourceLoader { constructor(o) { this.o = o; this.reloaded = false; } async reload() { this.reloaded = true; } }
    const captured = {};
    const subs = new Set();
    const session = {
      agent: { async waitForIdle() { session.idleWaited = true; } },
      aborted: false, disposed: false, prompted: [],
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      async prompt(text) { session.prompted.push(text); for (const m of session.replies || []) for (const fn of subs) fn({ type: 'message_end', message: m }); if (session.hangUntilAbort) await new Promise((r) => { session.release = r; }); },
      async abort() { session.aborted = true; if (session.release) session.release(); },
      async dispose() { session.disposed = true; },
    };
    const sdk = {
      AuthStorage, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader,
      async createAgentSession(o) { captured.options = o; return { session }; },
      ...overrides,
    };
    return { sdk, auth, captured, session };
  }
  const init = (tools) => ({ tier: 'discussion', apiKey: KEY, modelProvider: 'anthropic', model: 'claude-x', cwd: 'E:\\w', sessionDir: 'E:\\s', agentDir: 'E:\\s\\agent', tools: tools || [], systemPrompt: 'SP', emit() {} });

  test('surface probes fail with PI_SDK_SURFACE', async () => {
    assert.throws(() => createSdkProvider({}), { code: 'PI_SDK_SURFACE' });
    const { sdk } = mockSdk();
    sdk.AuthStorage = class { static create() { return {}; } };
    await assert.rejects(createSdkProvider(sdk).createSession(init()), { code: 'PI_SDK_SURFACE' });
    const m2 = mockSdk({ async createAgentSession() { return { session: { prompt() {} } }; } });
    await assert.rejects(createSdkProvider(m2.sdk).createSession(init()), { code: 'PI_SDK_SURFACE' });
  });

  test('wires runtime key (never saved), own agentDir, no built-in tools, room tools as customTools, no project resources', async () => {
    const { sdk, auth, captured } = mockSdk();
    const tools = [{ name: 'read_file', execute() {} }];
    const events = [];
    await createSdkProvider(sdk).createSession({ ...init(tools), emit: (e) => events.push(e) });
    assert.deepEqual(auth.runtime, { anthropic: KEY }); assert.deepEqual(auth.saved, []);
    assert.equal(captured.options.authStorage.path, path.join('E:\\s\\agent', 'auth.json'));
    assert.deepEqual(captured.options.tools, []); assert.equal(captured.options.customTools, tools);
    assert.deepEqual(captured.options.sessionManager, { cwd: 'E:\\w', dir: 'E:\\s' });
    assert.deepEqual(captured.options.model, { provider: 'anthropic', id: 'claude-x' });
    const rl = captured.options.resourceLoader;
    assert.equal(rl.reloaded, true); assert.equal(rl.o.noSkills, true); assert.equal(rl.o.noExtensions, true);
    assert.equal(rl.o.systemPromptOverride(), 'SP'); assert.deepEqual(rl.o.agentsFilesOverride(), { agentsFiles: [] });
    assert.ok(events.some((e) => e.type === 'sdk_session'));
    assert.ok(!JSON.stringify(events).includes(KEY));
  });

  test('model not found', async () => {
    const { sdk } = mockSdk();
    await assert.rejects(createSdkProvider(sdk).createSession({ ...init(), model: 'missing' }), { code: 'PI_MODEL_NOT_FOUND' });
  });

  test('prompt collects this turn\'s assistant messages, sums usage, maps stop reasons; abort via signal', async () => {
    const { sdk, session } = mockSdk();
    const s = await createSdkProvider(sdk).createSession(init());
    session.replies = [
      { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }, { type: 'toolCall' }], usage: { input: 5, output: 1, cacheRead: 2 }, stopReason: 'toolUse' },
      { role: 'assistant', content: [{ type: 'text', text: '最终' }], usage: { input: 7, output: 3 }, stopReason: 'stop' },
    ];
    const r = await s.prompt('hello');
    assert.deepEqual(session.prompted, ['hello']);
    assert.equal(r.text, '最终'); assert.equal(r.stopReason, 'stop');
    assert.deepEqual(r.usage, { input: 12, output: 4, cached: 2 });
    assert.equal(session.idleWaited, true);
    session.replies = [{ role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error', errorMessage: 'rate_limit_error' }];
    const e = await s.prompt('x');
    assert.equal(e.stopReason, 'error'); assert.equal(e.error, 'rate_limit_error'); assert.equal(e.usage, null);
    session.replies = []; session.hangUntilAbort = true;
    const ac = new AbortController();
    const p = s.prompt('y', { signal: ac.signal });
    await sleep(5); ac.abort();
    const a = await p;
    assert.equal(a.stopReason, 'aborted'); assert.equal(session.aborted, true);
    await s.dispose(); assert.equal(session.disposed, true);
  });

  test('a seat built on the sdk provider behaves like any other provider', async () => {
    const root = testRoot();
    try {
      const { sdk, session } = mockSdk();
      session.replies = [{ role: 'assistant', content: [{ type: 'text', text: '来自 SDK' }], usage: { input: 1, output: 2 }, stopReason: 'stop' }];
      const events = [];
      const seat = createPiSeat({ tier: 'discussion', apiKey: KEY, model: 'anthropic/claude-x', cwd: root, sessionDir: path.join(root, 's'), provider: createSdkProvider(sdk), onEvent: (e) => events.push(e) });
      const r = await seat.prompt('packet');
      assert.equal(r.text, '来自 SDK'); assert.equal(r.stopReason, 'end_turn'); assert.deepEqual(r.usage, { input: 1, output: 2, cached: 0 });
      assertNoKey(root, events, r);
      await seat.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
