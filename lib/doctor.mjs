// Read-only diagnostic command: `node room.mjs doctor [--dir <roomDir> | --id <roomId>] [--rooms-root <dir>] [--json]`
// Design rules (anti-silent-failure diagnostics):
//   - Strictly 100% read-only: never creates folders, writes files, rotates backups, or triggers recovery.
//   - Never reports an unreadable value as 0; distinguishes `ok`, `warn`, `fail`, `unknown`, and `unconfigured`.
//   - Shares the exact runtime gates (`codexWakeStatus`, `virtualizationRedirect`, `lockHolderAlive`,
//     `validateRoom`, `rebuildFromEvents`) so diagnostics and runtime enforcement agree.
//   - Optional host capabilities (such as Codex wake when no inspected room configures a codex-queue seat)
//     report `warn`/`unknown`/`unconfigured` instead of failing the whole environment check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOM_FILES as F,
  fwd,
  roomMjsPath,
  virtualizationRedirect,
  lockHolderAlive,
  pidAlive,
} from './common.mjs';
import { codexWakeStatus, MIN_WIN_CODEX_QUEUE_VERSION } from './codex.mjs';
import { readDaemonStatus, REGISTRY_FILE } from './daemon-store.mjs';
import { winNameProblem, realOf } from './admin.mjs';
import { validateRoom } from './supervision.mjs';
import { rebuildFromEvents } from './reducer.mjs';
import { CliError } from './seat.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/;
const KNOWN_FLAGS = new Set(['_', '__argv', 'dir', 'id', 'rooms-root', 'json']);

function appRootFor(env = process.env) {
  return (env && env.ROOM_DEV_HOME) || path.join(os.homedir(), 'room-dev');
}

function defaultRoomsRootFor(env = process.env) {
  return path.join(appRootFor(env), 'rooms');
}

function existingAncestor(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

function readJsonStrict(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: (err && (err.code || err.message)) || 'read_failed' };
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) };
  } catch (err) {
    return { state: 'corrupt', reason: (err && err.message) || 'invalid_json' };
  }
}

// O(N) single-pass events.jsonl integrity check (distinguishes a torn final line from mid-file corruption).
function inspectEventsFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', events: [], validLines: 0, corruptLines: 0, tornTail: false };
    return { state: 'unreadable', reason: (err && (err.code || err.message)) || 'read_failed', events: null, validLines: null, corruptLines: null, tornTail: null };
  }
  const lines = raw.split('\n');
  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) { lastNonEmpty = i; break; }
  }
  const events = [];
  let corruptLines = 0;
  let tornTail = false;
  for (let i = 0; i <= lastNonEmpty; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      if (i === lastNonEmpty) tornTail = true;
      else corruptLines += 1;
    }
  }
  return { state: 'ok', events, validLines: events.length, corruptLines, tornTail };
}

function redirectRecovery(platform) {
  return platform === 'win32'
    ? 'Set ROOM_DEV_HOME to a real, non-redirected directory outside %LOCALAPPDATA% (e.g. %USERPROFILE%\\room-dev).'
    : 'Set ROOM_DEV_HOME to a real, non-symlinked directory (default ~/room-dev).';
}

function checkRuntime({ nodeVersion = process.versions.node, platform = process.platform, arch = process.arch, observedAt }) {
  const major = Number(String(nodeVersion || '').split('.')[0]);
  const ok = Number.isInteger(major) && major >= 22;
  return {
    id: 'runtime',
    label: 'Node.js runtime',
    status: ok ? 'ok' : 'fail',
    observedAt,
    summary: ok
      ? `Node.js v${nodeVersion} on ${platform}/${arch} (zero runtime dependencies)`
      : `Node.js v${nodeVersion} is below the required >= 22 baseline`,
    detail: { nodeVersion, platform, arch, entry: fwd(roomMjsPath()) },
    ...(ok ? {} : { recovery: 'Install Node.js 22 or newer from https://nodejs.org/' }),
  };
}

function checkDataRoot({ roomsRoot, env = process.env, platform = process.platform, redirect = virtualizationRedirect, observedAt }) {
  const rootAbs = path.resolve(roomsRoot);
  const nameErr = winNameProblem(rootAbs, { platform });
  if (nameErr) {
    return {
      id: 'data-root',
      label: 'Data root & path safety',
      status: 'fail',
      observedAt,
      summary: nameErr,
      detail: { roomsRoot: fwd(rootAbs), exists: fs.existsSync(rootAbs) },
      recovery: 'Set ROOM_DEV_HOME to a clean absolute path without trailing dots/spaces or reserved Windows device names.',
    };
  }
  const exists = fs.existsSync(rootAbs);
  if (exists) {
    let isDir = false;
    try { isDir = fs.statSync(rootAbs).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      return {
        id: 'data-root',
        label: 'Data root & path safety',
        status: 'fail',
        observedAt,
        summary: `Rooms root ${fwd(rootAbs)} exists but is not a directory`,
        detail: { roomsRoot: fwd(rootAbs), exists: true, isDirectory: false },
        recovery: 'Point ROOM_DEV_HOME / --rooms-root at a directory path.',
      };
    }
  }
  const probePath = exists ? rootAbs : existingAncestor(rootAbs);
  const redir = redirect(probePath, { platform });
  if (redir) {
    return {
      id: 'data-root',
      label: 'Data root & path safety',
      status: 'fail',
      observedAt,
      summary: redir.packaged
        ? `MSIX AppData virtualization redirect detected (${fwd(redir.asked)} -> ${fwd(redir.real)})`
        : `Path redirection/symlink detected (${fwd(redir.asked)} -> ${fwd(redir.real)})`,
      detail: { roomsRoot: fwd(rootAbs), probePath: fwd(probePath), redirect: redir },
      recovery: redirectRecovery(platform),
    };
  }
  return {
    id: 'data-root',
    label: 'Data root & path safety',
    status: 'ok',
    observedAt,
    summary: exists
      ? `Rooms root ${fwd(rootAbs)} is clean (no virtualization redirect observed)`
      : `Rooms root ${fwd(rootAbs)} is not created yet; parent path ${fwd(probePath)} is clean`,
    detail: { roomsRoot: fwd(rootAbs), appRoot: fwd(appRootFor(env)), exists, realPath: fwd(realOf(rootAbs)) },
  };
}

function checkDaemon({ roomsRoot, isAlive = pidAlive, observedAt }) {
  const st = readDaemonStatus(roomsRoot, { isAlive });
  const regPath = path.join(path.resolve(roomsRoot), REGISTRY_FILE);
  const reg = readJsonStrict(regPath);
  const regValid = reg.state === 'ok'
    && reg.value
    && typeof reg.value === 'object'
    && !Array.isArray(reg.value)
    && reg.value.version === 1
    && reg.value.rooms
    && typeof reg.value.rooms === 'object'
    && !Array.isArray(reg.value.rooms);
  const regSummary = regValid
    ? { state: 'ok', roomCount: Object.keys(reg.value.rooms).length }
    : reg.state === 'missing'
      ? { state: 'missing', roomCount: null }
      : { state: reg.state === 'ok' ? 'corrupt' : reg.state, reason: reg.reason || 'invalid_registry_shape', roomCount: null };

  if (st.unreadable) {
    return {
      id: 'daemon',
      label: 'Multi-room daemon',
      status: 'unknown',
      observedAt,
      summary: `Daemon metadata file could not be read (${st.reason})`,
      detail: { metaPath: fwd(st.metaPath), reason: st.reason, registry: regSummary },
      recovery: `Inspect permissions and file type of ${fwd(st.metaPath)}.`,
    };
  }
  if (st.corrupt) {
    return {
      id: 'daemon',
      label: 'Multi-room daemon',
      status: 'fail',
      observedAt,
      summary: `Daemon metadata file is corrupt (${fwd(st.metaPath)})`,
      detail: { metaPath: fwd(st.metaPath), registry: regSummary },
      recovery: 'Verify no daemon process is running, remove the corrupt .room-daemon.json, then run `node room.mjs daemon --open`.',
    };
  }
  if (st.running && st.meta) {
    const regWarn = regSummary.state === 'corrupt' || regSummary.state === 'unreadable';
    return {
      id: 'daemon',
      label: 'Multi-room daemon',
      status: regWarn ? 'warn' : 'ok',
      observedAt,
      summary: `Daemon running (pid=${st.meta.pid}, port=${st.meta.port}, registry=${regSummary.state === 'ok' ? `${regSummary.roomCount} room(s)` : regSummary.state})`,
      detail: { pid: st.meta.pid, port: st.meta.port, startedAt: st.meta.startedAt || null, metaPath: fwd(st.metaPath), registry: regSummary },
    };
  }
  if (st.meta && !st.running) {
    return {
      id: 'daemon',
      label: 'Multi-room daemon',
      status: 'warn',
      observedAt,
      summary: `Stale daemon metadata found (recorded pid=${st.meta.pid} is not alive)`,
      detail: { pid: st.meta.pid, port: st.meta.port || null, startedAt: st.meta.startedAt || null, metaPath: fwd(st.metaPath), registry: regSummary },
      recovery: 'Run `node room.mjs daemon --open` to start a fresh daemon (it replaces stale metadata automatically).',
    };
  }
  if (regSummary.state === 'corrupt' || regSummary.state === 'unreadable') {
    return {
      id: 'daemon',
      label: 'Multi-room daemon',
      status: 'warn',
      observedAt,
      summary: `Daemon stopped; registry file is ${regSummary.state} (${fwd(regPath)})`,
      detail: { metaPath: fwd(st.metaPath), registry: regSummary },
      recovery: 'Starting the daemon will preserve a `.bak` copy of a corrupt registry before resetting it.',
    };
  }
  return {
    id: 'daemon',
    label: 'Multi-room daemon',
    status: 'unconfigured',
    observedAt,
    summary: 'Daemon not running (no active .room-daemon.json recorded)',
    detail: { metaPath: fwd(st.metaPath), registry: regSummary },
  };
}

async function checkCodexWake({ env, platform, arch, isFile, probe, requiredByRoom = false, observedAt }) {
  const st = await codexWakeStatus({ env, platform, arch, isFile, probe });
  if (st.state === 'ok') {
    return {
      id: 'codex-wake',
      label: 'Codex native wake (codex-queue)',
      status: 'ok',
      observedAt,
      summary: `Codex executable resolved (${fwd(st.executable)}${st.version ? `, v${st.version}` : ''})`,
      detail: { ...st, requiredByRoom },
    };
  }
  if (st.state === 'unconfigured') {
    return {
      id: 'codex-wake',
      label: 'Codex native wake (codex-queue)',
      status: requiredByRoom ? 'fail' : 'unconfigured',
      observedAt,
      summary: requiredByRoom
        ? 'Codex executable not found, but inspected room has codex-queue wake seat(s)'
        : 'Codex executable not found (optional; only needed for turn_over codex-queue wake pushes)',
      detail: { ...st, requiredByRoom },
      ...(requiredByRoom ? { recovery: 'Install native Codex CLI (npm global @openai/codex or Codex Desktop) or disable wake on that seat.' } : {}),
    };
  }
  // Blocked: escalate to `fail` only when an inspected room actually relies on codex-queue wake.
  // For general environment diagnostics, transient probe timeouts report `unknown` and version
  // mismatches report `warn` so non-Codex users are not failed globally.
  const status = requiredByRoom ? 'fail' : (st.transient ? 'unknown' : 'warn');
  let recovery;
  if (st.reason === 'windows_codex_version_probe_timeout') {
    recovery = 'Codex CLI timed out during `--version` cold start; retry `node room.mjs doctor` once warm or verify Codex Desktop/CLI is not stalled.';
  } else if (platform === 'win32') {
    recovery = `Install or upgrade native Codex CLI to >= ${MIN_WIN_CODEX_QUEUE_VERSION} (npm global @openai/codex or Codex Desktop).`;
  } else {
    recovery = 'Ensure the `codex` binary is executable on PATH or set CODEX_CLI_PATH.';
  }
  return {
    id: 'codex-wake',
    label: 'Codex native wake (codex-queue)',
    status,
    observedAt,
    summary: `Codex wake gate blocked (${st.reason})`,
    detail: { ...st, requiredByRoom },
    recovery,
  };
}

function checkRoom({ roomDir, platform = process.platform, redirect = virtualizationRedirect, isAlive = pidAlive, nowMs = Date.now(), observedAt }) {
  const dir = path.resolve(roomDir);
  const nameErr = winNameProblem(dir, { platform });
  if (nameErr) {
    return {
      id: 'room',
      label: 'Room inspection',
      status: 'fail',
      observedAt,
      summary: nameErr,
      detail: { roomDir: fwd(dir) },
      recovery: 'Move the room to a clean directory name without trailing dots/spaces or reserved Windows device names.',
    };
  }
  if (!fs.existsSync(dir)) {
    return {
      id: 'room',
      label: 'Room inspection',
      status: 'fail',
      observedAt,
      summary: `Room directory does not exist: ${fwd(dir)}`,
      detail: { roomDir: fwd(dir), exists: false },
      recovery: 'Pass a valid --dir <roomDir> or --id <roomId>, or create one with `node room.mjs admin init`.',
    };
  }
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return {
      id: 'room',
      label: 'Room inspection',
      status: 'fail',
      observedAt,
      summary: `Room path exists but is not a directory: ${fwd(dir)}`,
      detail: { roomDir: fwd(dir), exists: true, isDirectory: false },
    };
  }
  const redir = redirect(dir, { platform });
  if (redir) {
    return {
      id: 'room',
      label: 'Room inspection',
      status: 'fail',
      observedAt,
      summary: redir.packaged
        ? `Room directory hits MSIX AppData virtualization (${fwd(redir.asked)} -> ${fwd(redir.real)})`
        : `Room directory is redirected via symlink/junction (${fwd(redir.asked)} -> ${fwd(redir.real)})`,
      detail: { roomDir: fwd(dir), redirect: redir },
      recovery: redirectRecovery(platform),
    };
  }

  const roomRes = readJsonStrict(path.join(dir, F.room));
  if (roomRes.state !== 'ok' || !roomRes.value || typeof roomRes.value !== 'object' || Array.isArray(roomRes.value)) {
    return {
      id: 'room',
      label: 'Room inspection',
      status: 'fail',
      observedAt,
      summary: `room.json is ${roomRes.state === 'ok' ? 'invalid' : roomRes.state}${roomRes.reason ? ` (${roomRes.reason})` : ''}`,
      detail: { roomDir: fwd(dir), roomJson: roomRes.state === 'ok' ? 'invalid' : roomRes.state },
      recovery: 'Verify the room directory was initialized with `node room.mjs admin init`.',
    };
  }
  const room = roomRes.value;
  const rawSeats = Array.isArray(room.seats) ? room.seats : [];
  const invalidSeatEntries = rawSeats.filter((s) => !s || typeof s !== 'object' || Array.isArray(s)).length;
  const validSeatObjects = rawSeats.filter((s) => s && typeof s === 'object' && !Array.isArray(s));
  const validation = invalidSeatEntries > 0
    ? { errors: [{ code: 'MALFORMED_SEAT_ENTRY', message: `room.json contains ${invalidSeatEntries} malformed seat entry(s)` }], warnings: [] }
    : validateRoom(room);

  const lockRes = readJsonStrict(path.join(dir, F.lock));
  let lockState = 'stopped';
  if (lockRes.state === 'ok') {
    lockState = lockHolderAlive(lockRes.value, { isAlive, nowMs }) ? 'running' : 'stale_lock';
  } else if (lockRes.state === 'corrupt' || lockRes.state === 'unreadable') {
    lockState = lockRes.state;
  }

  const evRes = inspectEventsFile(path.join(dir, F.events));
  let derived = null;
  let replayError = null;
  if (evRes.state === 'ok') {
    try {
      derived = rebuildFromEvents(evRes.events);
    } catch (err) {
      derived = null;
      replayError = (err && err.message) || 'replay_failed';
    }
  }

  const seats = validSeatObjects.map((s) => ({
    seatId: typeof s.seatId === 'string' ? s.seatId : null,
    role: typeof s.role === 'string' ? s.role : null,
    agent: typeof s.agent === 'string' ? s.agent : null,
    waitMode: typeof s.waitMode === 'string' ? s.waitMode : null,
    wakeKind: s.wake && s.wake.enabled ? (s.wake.kind || 'codex-queue') : 'off',
    cwdExists: typeof s.cwd === 'string' && s.cwd ? fs.existsSync(s.cwd) : null,
    outboxExists: typeof s.outbox === 'string' && s.outbox ? fs.existsSync(s.outbox) : null,
  }));
  const missingCwdSeats = seats.filter((s) => s.cwdExists === false).map((s) => s.seatId || '?');
  const usesCodexWake = seats.some((s) => s.wakeKind === 'codex-queue');

  const needsReconcileCount = derived && Array.isArray(derived.needsReconcile) ? derived.needsReconcile.length : 0;
  const awaitingDecision = !!(derived && derived.awaitingDecision);
  const pendingDisclosures = derived && derived.disclosures
    ? Object.values(derived.disclosures).filter((d) => d && d.status === 'requested').length
    : 0;

  const issues = [];
  if (validation.errors.length) issues.push(`${validation.errors.length} config error(s)`);
  if (evRes.state === 'missing') issues.push('events.jsonl missing');
  if (evRes.state === 'unreadable') issues.push('events.jsonl unreadable');
  if (evRes.corruptLines > 0) issues.push(`${evRes.corruptLines} corrupt event line(s)`);
  if (evRes.tornTail) issues.push('torn trailing line in events.jsonl (tolerated on replay)');
  if (replayError) issues.push(`event replay failed (${replayError})`);
  if (lockState === 'stale_lock') issues.push('stale service.lock');
  if (lockState === 'corrupt' || lockState === 'unreadable') issues.push(`service.lock ${lockState}`);
  if (missingCwdSeats.length) issues.push(`missing seat cwd (${missingCwdSeats.join(', ')})`);
  if (needsReconcileCount > 0) issues.push(`${needsReconcileCount} attempt(s) awaiting reconciliation`);
  if (awaitingDecision) issues.push('round awaiting timeout decision');

  const hasFail = validation.errors.length > 0
    || evRes.state === 'unreadable'
    || evRes.corruptLines > 0
    || !!replayError
    || lockState === 'corrupt'
    || lockState === 'unreadable';
  const hasWarn = !hasFail && (
    validation.warnings.length > 0
    || evRes.state === 'missing'
    || evRes.tornTail
    || lockState === 'stale_lock'
    || missingCwdSeats.length > 0
    || needsReconcileCount > 0
    || awaitingDecision
  );
  const status = hasFail ? 'fail' : hasWarn ? 'warn' : 'ok';

  return {
    id: 'room',
    label: `Room "${room.id || path.basename(dir)}"`,
    status,
    observedAt,
    summary: issues.length
      ? `service=${lockState}, phase=${derived ? derived.phase : 'unknown'}, round=${derived ? derived.roundId : 'unknown'}, events=${evRes.validLines ?? 'unknown'} (${issues.join('; ')})`
      : `service=${lockState}, phase=${derived ? derived.phase : 'unknown'}, round=${derived ? derived.roundId : 'unknown'}, events=${evRes.validLines ?? 'unknown'}, seats=${seats.length}`,
    detail: {
      roomDir: fwd(dir),
      id: typeof room.id === 'string' ? room.id : null,
      preset: typeof room.preset === 'string' ? room.preset : null,
      serviceLock: lockState,
      usesCodexWake,
      events: { state: evRes.state, validLines: evRes.validLines, corruptLines: evRes.corruptLines, tornTail: evRes.tornTail, ...(replayError ? { replayError } : {}) },
      state: derived ? {
        phase: derived.phase,
        roundId: derived.roundId,
        epoch: derived.epoch,
        needsReconcile: needsReconcileCount,
        awaitingDecision,
        pendingDisclosures,
      } : null,
      validation: { errors: validation.errors.map((e) => e.message), warnings: validation.warnings.map((w) => w.message) },
      seats,
    },
  };
}

export async function runDoctor({
  roomDir = null,
  roomsRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  now = () => Date.now(),
  isAlive = pidAlive,
  redirect = virtualizationRedirect,
  isFile,
  probeCodex,
} = {}) {
  const effectiveRoomsRoot = roomsRoot ? path.resolve(roomsRoot) : defaultRoomsRootFor(env);
  const nowMs = now();
  const observedAt = new Date(nowMs).toISOString();
  const roomCheck = roomDir ? checkRoom({ roomDir, platform, redirect, isAlive, nowMs, observedAt }) : null;
  const requiredCodex = !!(roomCheck && roomCheck.detail && roomCheck.detail.usesCodexWake);
  const checks = [
    checkRuntime({ nodeVersion, platform, arch, observedAt }),
    checkDataRoot({ roomsRoot: effectiveRoomsRoot, env, platform, redirect, observedAt }),
    checkDaemon({ roomsRoot: effectiveRoomsRoot, isAlive, observedAt }),
    await checkCodexWake({ env, platform, arch, isFile, probe: probeCodex, requiredByRoom: requiredCodex, observedAt }),
  ];
  if (roomCheck) checks.push(roomCheck);
  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0, unconfigured: 0 };
  for (const c of checks) if (Object.prototype.hasOwnProperty.call(counts, c.status)) counts[c.status] += 1;
  const ok = counts.fail === 0;
  return { ok, readOnly: true, observedAt, counts, checks };
}

const BADGE = Object.freeze({
  ok: '[OK]          ',
  warn: '[WARN]        ',
  fail: '[FAIL]        ',
  unknown: '[UNKNOWN]     ',
  unconfigured: '[UNCONFIGURED]',
});

export function formatDoctorReport(report) {
  const lines = [
    `AgentRoundtable Doctor (read-only · observed ${report.observedAt})`,
    `Result: ${report.ok ? 'PASS' : 'FAIL'} (ok=${report.counts.ok} warn=${report.counts.warn} fail=${report.counts.fail} unknown=${report.counts.unknown} unconfigured=${report.counts.unconfigured})`,
    '',
  ];
  for (const c of report.checks) {
    lines.push(`${BADGE[c.status] || `[${String(c.status).toUpperCase()}]`} ${c.label}: ${c.summary}`);
    if (c.recovery) lines.push(`               Recovery: ${c.recovery}`);
  }
  return lines.join('\n');
}

export async function cmdDoctor(args = {}, io = {}) {
  const out = typeof io.out === 'function' ? io.out : (line) => process.stdout.write(`${line}\n`);
  const env = io.env || process.env;
  for (const key of Object.keys(args)) {
    if (!KNOWN_FLAGS.has(key)) {
      throw new CliError(`doctor: unknown option --${key}; supported options: --dir <roomDir>, --id <roomId>, --rooms-root <dir>, --json`);
    }
  }
  if (Array.isArray(args._) && args._.length > 0) {
    throw new CliError(`doctor: unexpected positional argument "${args._[0]}"`);
  }
  if (args.json !== undefined && args.json !== true) {
    throw new CliError(`doctor: --json takes no value (got "${args.json}")`);
  }
  if (args['rooms-root'] !== undefined && (args['rooms-root'] === true || !String(args['rooms-root']).trim())) {
    throw new CliError('doctor: --rooms-root requires a path');
  }
  if (args.dir !== undefined && args.id !== undefined) {
    throw new CliError('doctor: pass either --dir or --id, not both');
  }
  const roomsRoot = args['rooms-root'] !== undefined
    ? path.resolve(String(args['rooms-root']))
    : defaultRoomsRootFor(env);
  let roomDir = null;
  if (args.dir !== undefined) {
    if (args.dir === true || !String(args.dir).trim()) throw new CliError('doctor: --dir requires a path');
    roomDir = path.resolve(String(args.dir));
  } else if (args.id !== undefined) {
    if (args.id === true || !ID_RE.test(String(args.id))) throw new CliError('doctor: --id <roomId> may contain letters, digits, - and _ only');
    roomDir = path.join(roomsRoot, String(args.id));
  }
  const report = await runDoctor({
    roomDir,
    roomsRoot,
    env,
    ...(io.platform ? { platform: io.platform } : {}),
    ...(io.arch ? { arch: io.arch } : {}),
    ...(io.nodeVersion ? { nodeVersion: io.nodeVersion } : {}),
    ...(io.now ? { now: io.now } : {}),
    ...(io.isAlive ? { isAlive: io.isAlive } : {}),
    ...(io.redirect ? { redirect: io.redirect } : {}),
    ...(io.isFile ? { isFile: io.isFile } : {}),
    ...(io.probeCodex ? { probeCodex: io.probeCodex } : {}),
  });
  if (args.json === true) out(JSON.stringify(report, null, 2));
  else out(formatDoctorReport(report));
  return report.ok ? 0 : 1;
}
