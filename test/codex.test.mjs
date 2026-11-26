// lib/codex.mjs: single-door spawn invariant, Windows npm vendor native codex.exe resolution,
// candidate fallback across Desktop + npm, env-scrubbed version probing, 10s cold-start timeout
// distinction, POSIX non-blocking behavior, and service integration.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptableExe,
  npmVendorCodexCandidates,
  buildCodexProbeEnv,
  findCodex,
  findCodexCandidates,
  parseCodexVersion,
  compareSemver,
  checkCodexQueueGate,
  resolveEligibleCodex,
  codexWakeStatus,
  MIN_WIN_CODEX_QUEUE_VERSION,
  CODEX_PROBE_TIMEOUT_MS,
} from '../lib/codex.mjs';
import { createRoomService } from '../lib/service.mjs';
import { testRunsRoot, randomHex, readJsonl } from '../lib/common.mjs';
import { cmdInit, cmdAddSeat } from '../lib/admin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const base = path.join(testRunsRoot(), `codex-test-${randomHex(4)}`);
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('lib/codex.mjs preserves the lib/spawn.mjs single-door child_process invariant', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'codex.mjs'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]node:child_process['"]|spawnSync/, 'lib/codex.mjs must spawn exclusively through lib/spawn.mjs');
  assert.ok(CODEX_PROBE_TIMEOUT_MS >= 10_000, 'cold-start timeout must allow >= 10s for MSIX/Rust binary startup');
});

test('acceptableExe refuses .cmd/.bat shims on Windows and accepts .exe/.com', () => {
  const existing = new Set([
    'C:\\npm\\codex.cmd',
    'C:\\npm\\codex.bat',
    'C:\\npm\\codex',
    'C:\\npm\\codex.exe',
    'C:\\npm\\codex.com',
  ]);
  const isFile = (p) => existing.has(p);
  assert.equal(acceptableExe('C:\\npm\\codex.cmd', { platform: 'win32', isFile }), false);
  assert.equal(acceptableExe('C:\\npm\\codex.bat', { platform: 'win32', isFile }), false);
  assert.equal(acceptableExe('C:\\npm\\codex', { platform: 'win32', isFile }), false);
  assert.equal(acceptableExe('C:\\npm\\codex.exe', { platform: 'win32', isFile }), true);
  assert.equal(acceptableExe('C:\\npm\\codex.com', { platform: 'win32', isFile }), true);
});

test('findCodex & findCodexCandidates resolve Windows npm vendor codex.exe (nested, hoisted, quoted)', () => {
  const nested = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const hoistedArm = 'D:\\node-global\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe';

  assert.equal(
    findCodex({
      env: { PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', CODEX_HOME: 'Z:\\none' },
      platform: 'win32',
      arch: 'x64',
      isFile: (p) => p === 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd' || p === nested,
    }),
    nested,
  );

  assert.equal(
    findCodex({
      env: { PATH: 'D:\\node-global', CODEX_HOME: 'Z:\\none' },
      platform: 'win32',
      arch: 'arm64',
      isFile: (p) => p === 'D:\\node-global\\codex.cmd' || p === hoistedArm,
    }),
    hoistedArm,
  );

  assert.equal(
    findCodex({
      env: { CODEX_CLI_PATH: `"${nested}"`, PATH: '', CODEX_HOME: 'Z:\\none' },
      platform: 'win32',
      arch: 'x64',
      isFile: (p) => p === nested,
    }),
    nested,
  );
  assert.equal(
    findCodex({
      env: { CODEX_CLI_PATH: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', PATH: '', CODEX_HOME: 'Z:\\none' },
      platform: 'win32',
      arch: 'x64',
      isFile: (p) => p === 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd' || p === nested,
    }),
    nested,
  );

  assert.deepEqual(npmVendorCodexCandidates('/usr/local', { platform: 'linux', arch: 'x64' }), []);
  assert.deepEqual(findCodexCandidates({ env: { PATH: '', CODEX_HOME: 'Z:\\none' }, platform: 'win32', isFile: () => false }), []);
});

test('buildCodexProbeEnv strips API keys and unrelated secrets (Non-Interference Clause 3)', () => {
  const dirty = {
    PATH: 'C:\\Windows\\System32',
    CODEX_HOME: 'C:\\Users\\u\\.codex',
    ROOM_PI_API_KEY: 'canary-pi-secret',
    OPENAI_API_KEY: 'canary-openai-secret',
    ANTHROPIC_API_KEY: 'canary-anthropic-secret',
    GITHUB_TOKEN: 'canary-gh-secret',
  };
  const clean = buildCodexProbeEnv(dirty, 'win32');
  assert.equal(clean.CODEX_HOME, 'C:\\Users\\u\\.codex');
  for (const leaked of ['ROOM_PI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
    assert.equal(clean[leaked], undefined, `${leaked} must never enter codex --version probe env`);
  }
});

test('parseCodexVersion & compareSemver handle standard, prerelease, +build, and malformed strings', () => {
  assert.deepEqual(parseCodexVersion('codex-cli 0.160.0\n'), { version: '0.160.0', parts: [0, 160, 0] });
  assert.deepEqual(parseCodexVersion('codex-cli 0.157.0-rc.1+build.42\r\n'), { version: '0.157.0', parts: [0, 157, 0] });
  assert.equal(parseCodexVersion('node v22.14.0'), null);
  assert.equal(parseCodexVersion(''), null);

  assert.equal(compareSemver([0, 156, 9], [0, 157, 0]), -1);
  assert.equal(compareSemver([0, 157, 0], [0, 157, 0]), 0);
  assert.equal(compareSemver([0, 160, 0], [0, 157, 0]), 1);
  assert.equal(compareSemver([1, 0, 0], [0, 999, 0]), 1);
});

test('checkCodexQueueGate & resolveEligibleCodex handle Windows timeouts, Desktop->npm fallback, and POSIX non-blocking', async () => {
  assert.equal(MIN_WIN_CODEX_QUEUE_VERSION, '0.157.0');

  const below = await checkCodexQueueGate({ exe: 'C:\\codex.exe', platform: 'win32', probe: async () => 'codex-cli 0.156.9\n' });
  assert.equal(below.state, 'blocked');
  assert.equal(below.reason, 'windows_codex_version_below_minimum:0.156.9');
  assert.equal(below.transient, false);

  const timedOut = await checkCodexQueueGate({
    exe: 'C:\\codex.exe',
    platform: 'win32',
    spawn: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, spawnError: null }),
  });
  assert.equal(timedOut.state, 'blocked');
  assert.equal(timedOut.reason, 'windows_codex_version_probe_timeout');
  assert.equal(timedOut.transient, true);

  const unreadable = await checkCodexQueueGate({ exe: 'C:\\codex.exe', platform: 'win32', probe: async () => 'unexpected output' });
  assert.equal(unreadable.state, 'blocked');
  assert.equal(unreadable.reason, 'windows_codex_version_unreadable');
  assert.equal(unreadable.transient, false);

  // POSIX never spawns or blocks on `--version` probes (no minimum version on POSIX).
  let posixSpawned = 0;
  const okPosix = await checkCodexQueueGate({
    exe: '/usr/local/bin/codex',
    platform: 'linux',
    spawn: async () => { posixSpawned += 1; return { code: 1, stdout: '', stderr: 'err', timedOut: false }; },
  });
  assert.equal(okPosix.state, 'ok');
  assert.equal(posixSpawned, 0, 'POSIX must not spawn an extra blocking --version probe');

  // Windows candidate fallback: older binary first -> falls through to newer npm vendor binary.
  const oldBin = 'C:\\old-desktop\\codex.exe';
  const npmBin = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const fallback = await resolveEligibleCodex({
    env: { CODEX_CLI_PATH: oldBin, APPDATA: 'C:\\Users\\u\\AppData\\Roaming', PATH: '', CODEX_HOME: 'Z:\\none' },
    platform: 'win32',
    arch: 'x64',
    isFile: (p) => p === oldBin || p === npmBin,
    probe: async (exe) => (exe === oldBin ? 'codex-cli 0.140.0\n' : 'codex-cli 0.171.0\n'),
  });
  assert.equal(fallback.state, 'ok');
  assert.equal(fallback.executable, npmBin, 'must fall through from blocked older binary to eligible npm vendor binary');
  assert.equal(fallback.version, '0.171.0');
  assert.equal(fallback.checked, 2);

  const missing = await codexWakeStatus({ env: { PATH: '', CODEX_HOME: 'Z:\\none' }, platform: 'win32', isFile: () => false });
  assert.equal(missing.state, 'unconfigured');
  assert.equal(missing.reason, 'codex_executable_not_found');

  // Mixed candidates: candidate 0 non-transient old version + candidate 1 transient timeout -> propagates transient:true.
  const mixed = await resolveEligibleCodex({
    env: { CODEX_CLI_PATH: oldBin, APPDATA: 'C:\\Users\\u\\AppData\\Roaming', PATH: '', CODEX_HOME: 'Z:\\none' },
    platform: 'win32',
    arch: 'x64',
    isFile: (p) => p === oldBin || p === npmBin,
    probe: async (exe) => (exe === oldBin ? 'codex-cli 0.140.0\n' : { ok: false, timedOut: true }),
  });
  assert.equal(mixed.state, 'blocked');
  assert.equal(mixed.transient, true, 'transient timeout on fallback candidate must not be masked as permanent');
  assert.equal(mixed.reason, 'windows_codex_version_probe_timeout');

  // Real-disk PATH walk (no synthetic isFile): collects multiple PATH dirs + quoted dir with space.
  if (process.platform === 'win32') {
    const dir1 = path.join(base, 'path-old');
    const dir2 = path.join(base, 'path with space');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    const exe1 = path.join(dir1, 'codex.exe');
    const exe2 = path.join(dir2, 'codex.exe');
    fs.writeFileSync(exe1, 'stub1');
    fs.writeFileSync(exe2, 'stub2');
    const realEnv = { PATH: `${dir1};"${dir2}"`, CODEX_HOME: path.join(base, 'no-codex'), LOCALAPPDATA: path.join(base, 'no-local'), APPDATA: path.join(base, 'no-roaming') };
    const found = findCodexCandidates({ env: realEnv, platform: 'win32' });
    assert.deepEqual(found, [exe1, exe2], 'real-disk PATH scan must keep all candidates and strip quotes');
    const resolved = await resolveEligibleCodex({
      env: realEnv,
      platform: 'win32',
      probe: async (exe) => (exe === exe1 ? 'codex-cli 0.140.0\n' : 'codex-cli 0.171.0\n'),
    });
    assert.equal(resolved.state, 'ok');
    assert.equal(resolved.executable, exe2);
  }
});

test('service codex-queue wake respects async codexGate, retries transient probe failure, and classifies -32600/-32603', async () => {
  const roomDir = path.join(base, 'room-gate');
  const seatCwd = path.join(base, 'seat-a');
  fs.mkdirSync(seatCwd, { recursive: true });
  const quiet = { out: () => {} };
  cmdInit({ dir: roomDir, id: 'gate-room' }, quiet);
  cmdAddSeat({
    dir: roomDir, seat: 'A', role: 'participant', agent: 'codex-cli', wait: 'turn_over',
    cwd: seatCwd, 'wake-thread': '01a0f000-0000-7000-8000-000000000001',
  }, quiet);

  let gateCalls = 0;
  let spawned = 0;
  const svc1 = createRoomService({
    roomDir,
    log: () => {},
    codexExe: 'C:/fake/codex.exe',
    codexGate: async () => {
      gateCalls += 1;
      if (gateCalls === 1) return { state: 'blocked', reason: 'windows_codex_version_probe_timeout', transient: true };
      return { state: 'blocked', reason: 'windows_codex_version_below_minimum:0.150.0', transient: false };
    },
    idleCheck: async () => ({ idle: true }),
    spawn: async () => { spawned += 1; return { code: 0, stdout: 'ok', stderr: '' }; },
    adjudicationsPath: path.join(base, 'adj.jsonl'),
    gitExe: null,
    savedPiKeyPath: path.join(base, 'no-key.dpapi'),
  });
  await svc1.admin({ cmd: 'start', order: ['A'] });
  await svc1.tick();
  await svc1.admin({ cmd: 'wake', seatId: 'A' });
  await svc1.tick();
  await svc1.close();
  assert.equal(spawned, 0, 'blocked gate must never spawn codex queue');
  assert.equal(gateCalls, 2, 'transient gate timeout must be re-probed on subsequent wake');
  const wakes1 = readJsonl(path.join(roomDir, 'events.jsonl')).filter((e) => e.type === 'wake_pushed');
  assert.equal(wakes1.length, 2);
  assert.equal(wakes1[0].refused, 'CODEX_GATE_BLOCKED');
  assert.match(wakes1[0].detail, /windows_codex_version_probe_timeout/);
  assert.match(wakes1[1].detail, /windows_codex_version_below_minimum:0\.150\.0/);

  // Second room: codex queue returns JSON-RPC code -32600 -> classified as thread_archived.
  const roomDir2 = path.join(base, 'room-archived');
  const seatCwd2 = path.join(base, 'seat-b');
  fs.mkdirSync(seatCwd2, { recursive: true });
  cmdInit({ dir: roomDir2, id: 'arch-room' }, quiet);
  cmdAddSeat({
    dir: roomDir2, seat: 'B', role: 'participant', agent: 'codex-cli', wait: 'turn_over',
    cwd: seatCwd2, 'wake-thread': '01a0f000-0000-7000-8000-000000000002',
  }, quiet);
  const svc2 = createRoomService({
    roomDir: roomDir2,
    log: () => {},
    codexExe: 'C:/fake/codex.exe',
    codexGate: async () => ({ state: 'ok', executable: 'C:/fake/codex.exe', version: '0.160.0', transient: false }),
    idleCheck: async () => ({ idle: true }),
    spawn: async () => ({ code: 1, stdout: '', stderr: 'RPC error code -32600: archived', spawnError: null, timedOut: false }),
    adjudicationsPath: path.join(base, 'adj.jsonl'),
    gitExe: null,
    savedPiKeyPath: path.join(base, 'no-key.dpapi'),
  });
  await svc2.admin({ cmd: 'start', order: ['B'] });
  await svc2.tick();
  await svc2.close();
  const wakes2 = readJsonl(path.join(roomDir2, 'events.jsonl')).filter((e) => e.type === 'wake_pushed');
  assert.equal(wakes2.length, 1);
  assert.equal(wakes2[0].command_ok, false);
  assert.match(wakes2[0].detail, /thread_archived/);
});
