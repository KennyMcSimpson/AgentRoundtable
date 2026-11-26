// lib/doctor.mjs: strictly read-only anti-silent-failure diagnostics, real event replay,
// optional vs room-required Codex wake severities, missing seat cwd warnings, unreadable metadata
// distinction, boolean-flag hardening, and zero-mutation negative control.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDoctor, cmdDoctor, formatDoctorReport } from '../lib/doctor.mjs';
import { cmdInit, cmdAddSeat } from '../lib/admin.mjs';
import { testRunsRoot, randomHex } from '../lib/common.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOM_MJS = path.join(ROOT, 'room.mjs');
const base = path.join(testRunsRoot(), `doctor-test-${randomHex(4)}`);
after(() => fs.rmSync(base, { recursive: true, force: true }));

function snapshotTree(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(cur, ent.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        out.push(`D:${rel}`);
        walk(p);
      } else {
        const st = fs.statSync(p);
        out.push(`F:${rel}:${st.size}:${Math.trunc(st.mtimeMs)}`);
      }
    }
  };
  walk(dir);
  return out;
}

test('doctor replays real room state (needs_reconcile) and stays 100% read-only on corrupt registry + torn tail', async () => {
  const roomsRoot = path.join(base, 'ro-rooms');
  const roomDir = path.join(roomsRoot, 'demo');
  const seatDir = path.join(base, 'ro-seat-a');
  fs.mkdirSync(roomsRoot, { recursive: true });
  fs.mkdirSync(seatDir, { recursive: true });

  const quiet = { out: () => {} };
  cmdInit({ dir: roomDir, id: 'demo', preset: 'discussion' }, quiet);
  cmdAddSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'claude-code', cwd: seatDir }, quiet);

  fs.writeFileSync(path.join(roomsRoot, '.room-daemon-rooms.json'), '{corrupt-json', 'utf8');
  fs.writeFileSync(path.join(roomsRoot, '.room-daemon.json'), JSON.stringify({ version: 1, pid: 999999, port: 7380 }), 'utf8');
  fs.writeFileSync(path.join(roomDir, 'events.jsonl'), [
    JSON.stringify({ seq: 1, ts: '2026-11-26T00:00:00Z', type: 'room_created', id: 'demo', preset: 'discussion' }),
    JSON.stringify({ seq: 2, ts: '2026-11-26T00:00:01Z', type: 'round_started', roundId: 1, phase: 'meet', order: ['A'], epoch: 0 }),
    JSON.stringify({ seq: 3, ts: '2026-11-26T00:00:02Z', type: 'packet_issued', roundId: 1, phase: 'meet', seatId: 'A', attemptId: 'att-1', turnIndex: 0, epoch: 0 }),
    JSON.stringify({ seq: 4, ts: '2026-11-26T00:00:03Z', type: 'needs_reconcile', seatId: 'A', attemptId: 'att-1' }),
    '{"seq":5,"torn',
  ].join('\n'), 'utf8');

  const before = snapshotTree(base);
  const report = await runDoctor({
    roomsRoot,
    roomDir,
    env: { PATH: '', CODEX_HOME: path.join(base, 'no-codex') },
    isAlive: () => false,
    isFile: () => false,
    redirect: () => null,
  });
  const afterSnap = snapshotTree(base);

  assert.deepEqual(afterSnap, before, 'doctor must NEVER create, modify, backup, or delete any file');
  assert.equal(report.readOnly, true);
  assert.equal(report.ok, true, 'warnings alone do not fail doctor');

  const daemonCheck = report.checks.find((c) => c.id === 'daemon');
  assert.equal(daemonCheck.status, 'warn');
  assert.match(daemonCheck.summary, /Stale daemon metadata/);
  assert.equal(daemonCheck.detail.registry.state, 'corrupt');
  assert.equal(daemonCheck.detail.registry.roomCount, null, 'unreadable registry reports null, never 0');

  const roomCheck = report.checks.find((c) => c.id === 'room');
  assert.equal(roomCheck.status, 'warn');
  assert.ok(roomCheck.detail.state !== null, 'events must replay cleanly via rebuildFromEvents');
  assert.equal(roomCheck.detail.state.phase, 'meet');
  assert.equal(roomCheck.detail.state.roundId, 1);
  assert.equal(roomCheck.detail.state.needsReconcile, 1);
  assert.equal(roomCheck.detail.events.tornTail, true);
  assert.equal(roomCheck.detail.events.validLines, 4);

  const formatted = formatDoctorReport(report);
  assert.match(formatted, /AgentRoundtable Doctor \(read-only/);
  assert.match(formatted, /\[WARN\]/);
  assert.match(formatted, /\[UNCONFIGURED\]/);
});

test('doctor flags missing seat cwd as warn, unreadable daemon meta as unknown, and malformed room.json as fail', async () => {
  const roomsRoot = path.join(base, 'cwd-warn-rooms');
  const roomDir = path.join(roomsRoot, 'gone-cwd');
  const seatDir = path.join(base, 'gone-seat');
  fs.mkdirSync(roomsRoot, { recursive: true });
  fs.mkdirSync(seatDir, { recursive: true });
  const quiet = { out: () => {} };
  cmdInit({ dir: roomDir, id: 'gone-cwd', preset: 'discussion' }, quiet);
  cmdAddSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'generic', cwd: seatDir }, quiet);
  fs.rmSync(seatDir, { recursive: true, force: true });

  const repWarn = await runDoctor({
    roomsRoot,
    roomDir,
    env: { PATH: '', CODEX_HOME: path.join(base, 'no-codex') },
    isFile: () => false,
    redirect: () => null,
  });
  const rcWarn = repWarn.checks.find((c) => c.id === 'room');
  assert.equal(rcWarn.status, 'warn');
  assert.match(rcWarn.summary, /missing seat cwd \(A\)/);

  const unreadableRoot = path.join(base, 'unreadable-daemon');
  fs.mkdirSync(path.join(unreadableRoot, '.room-daemon.json'), { recursive: true });
  const badRoomDir = path.join(unreadableRoot, 'bad-room');
  fs.mkdirSync(badRoomDir, { recursive: true });
  fs.writeFileSync(path.join(badRoomDir, 'room.json'), JSON.stringify({ id: 'bad-room', seats: [null] }), 'utf8');

  const repBad = await runDoctor({
    roomsRoot: unreadableRoot,
    roomDir: badRoomDir,
    env: { PATH: '', CODEX_HOME: path.join(base, 'no-codex') },
    isFile: () => false,
    redirect: () => null,
  });
  assert.equal(repBad.checks.find((c) => c.id === 'daemon').status, 'unknown');
  assert.equal(repBad.checks.find((c) => c.id === 'room').status, 'fail');
});

test('doctor keeps optional Codex wake issues non-fatal globally, but fails when inspected room requires codex-queue', async () => {
  const roomsRoot = path.join(base, 'codex-sev-rooms');
  fs.mkdirSync(roomsRoot, { recursive: true });

  // Global check (no room inspected): old Codex -> warn (overall ok=true), timeout -> unknown (overall ok=true).
  const repOld = await runDoctor({
    roomsRoot,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: 'C:\\codex-bin', CODEX_HOME: path.join(base, 'no-codex') },
    isFile: (p) => p === 'C:\\codex-bin\\codex.exe',
    probeCodex: async () => 'codex-cli 0.150.0\n',
    redirect: () => null,
  });
  assert.equal(repOld.ok, true, 'optional old Codex must not fail global doctor');
  assert.equal(repOld.checks.find((c) => c.id === 'codex-wake').status, 'warn');

  const repTimeout = await runDoctor({
    roomsRoot,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: 'C:\\codex-bin', CODEX_HOME: path.join(base, 'no-codex') },
    isFile: (p) => p === 'C:\\codex-bin\\codex.exe',
    probeCodex: async () => ({ ok: false, timedOut: true }),
    redirect: () => null,
  });
  assert.equal(repTimeout.ok, true, 'transient cold-start probe timeout must not fail global doctor');
  const cxTimeout = repTimeout.checks.find((c) => c.id === 'codex-wake');
  assert.equal(cxTimeout.status, 'unknown');
  assert.match(cxTimeout.summary, /windows_codex_version_probe_timeout/);

  // Inspected room with a codex-queue seat -> escalates blocked Codex wake to fail (exit 1).
  const roomDir = path.join(roomsRoot, 'needs-codex');
  const seatCwd = path.join(base, 'needs-codex-seat');
  fs.mkdirSync(seatCwd, { recursive: true });
  const quiet = { out: () => {} };
  cmdInit({ dir: roomDir, id: 'needs-codex', preset: 'discussion' }, quiet);
  cmdAddSeat({
    dir: roomDir, seat: 'A', role: 'lead', agent: 'codex-cli', wait: 'turn_over',
    cwd: seatCwd, 'wake-thread': '01a0f000-0000-7000-8000-000000000099',
  }, quiet);

  const lines = [];
  const rc = await cmdDoctor(
    { json: true, dir: roomDir, 'rooms-root': roomsRoot },
    {
      out: (l) => lines.push(l),
      platform: 'win32',
      arch: 'x64',
      env: { PATH: 'C:\\codex-bin', CODEX_HOME: path.join(base, 'no-codex') },
      isFile: (p) => p === 'C:\\codex-bin\\codex.exe',
      probeCodex: async () => 'codex-cli 0.150.0\n',
      redirect: () => null,
    },
  );
  assert.equal(rc, 1);
  const parsed = JSON.parse(lines.join('\n'));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.find((c) => c.id === 'codex-wake').status, 'fail');

  // Same codex-queue room with Codex completely absent -> also escalates to fail (exit 1).
  const repAbsent = await runDoctor({
    roomsRoot,
    roomDir,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: '', CODEX_HOME: path.join(base, 'no-codex') },
    isFile: () => false,
    redirect: () => null,
  });
  assert.equal(repAbsent.ok, false, 'missing Codex must fail when inspected room requires codex-queue');
  assert.equal(repAbsent.checks.find((c) => c.id === 'codex-wake').status, 'fail');
});

test('doctor reports FAIL on MSIX redirect / old Node and uses POSIX recovery text on Linux', async () => {
  const repPosix = await runDoctor({
    roomsRoot: path.join(base, 'posix-rooms'),
    nodeVersion: '20.11.0',
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '', CODEX_HOME: path.join(base, 'no-codex') },
    isFile: () => false,
    redirect: (p) => ({ asked: p, real: '/real/rooms', packaged: false }),
  });
  assert.equal(repPosix.ok, false);
  assert.equal(repPosix.checks.find((c) => c.id === 'runtime').status, 'fail');
  const dr = repPosix.checks.find((c) => c.id === 'data-root');
  assert.equal(dr.status, 'fail');
  assert.doesNotMatch(dr.recovery, /%LOCALAPPDATA%/, 'POSIX recovery advice must not cite Windows %LOCALAPPDATA%');
});

test('cmdDoctor rejects unknown options, boolean-flag value smuggling, missing --rooms-root, and --dir+--id', async () => {
  await assert.rejects(() => cmdDoctor({ typo: true }), /unknown option --typo/);
  await assert.rejects(() => cmdDoctor({ _: ['extra'] }), /unexpected positional argument/);
  await assert.rejects(() => cmdDoctor({ json: 'extra' }), /--json takes no value/);
  await assert.rejects(() => cmdDoctor({ 'rooms-root': true }), /--rooms-root requires a path/);
  await assert.rejects(() => cmdDoctor({ dir: 'C:\\a', id: 'demo' }), /not both/);

  const emptyRoot = path.join(base, 'cli-rooms');
  const r = spawnSync(process.execPath, [ROOM_MJS, 'doctor', '--json', '--rooms-root', emptyRoot], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ROOM_DEV_HOME: path.join(base, 'cli-home') },
  });
  assert.equal(r.status, 0, `unexpected exit ${r.status}: ${r.stderr}\n${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.checks.length, 4);
  assert.equal(fs.existsSync(emptyRoot), false, 'CLI doctor must not create a missing roomsRoot');
});
