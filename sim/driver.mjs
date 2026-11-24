// Simulation driver (plan §13.2, INTERFACES §11): runs lib/service.mjs in-process on a fake clock,
// in a fresh room directory per case under testRunsRoot() (%USERPROFILE%\room-dev\test-runs\<random>,
// never AppData). Rooms and seats are created with the real admin commands (lib/admin.mjs cmdInit /
// cmdAddSeat); room.json overrides the CLI cannot express are written through a guard. Scripted seats
// (sim/scripted-seat.mjs) act only through their outbox files, exactly as `room <cmd>` does, so the
// service code path is the same one a real seat exercises.
//
// No child process is ever started: the service gets a fake spawn (wake pushes and disclosure runs
// are recorded in sim.spawnCalls), a fake codex path and gitExe=null; hosted Pi seats use an injected
// fake provider. Nothing here writes outside the case's own base directory.
//
//   const sim = await createSim({ preset, seats: [{seatId, role, files, ...}], room: {...}, mutate })
//   await sim.admin({cmd:'task', text}); await sim.admin({cmd:'start'})
//   await sim.run([createScriptedSeat({seatId:'A', script:[{wait:{}}, {submit:'...'}]}), ...])
//   sim.assertEvents(['packet_issued', 'submission_accepted']); sim.lastEvent('round_done'); sim.state()
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ROOM_FILES as F, testRunsRoot, randomHex, readJson, readJsonl } from '../lib/common.mjs';
import { createGuard } from '../lib/guard.mjs';
import { createRoomService } from '../lib/service.mjs';
import { cmdInit, cmdAddSeat } from '../lib/admin.mjs';

export const T0 = Date.parse('2026-10-01T08:00:00.000Z');
export const FAKE_CODEX = 'C:/fake/codex.exe';
async function simIdle() { return { idle: true, note: 'sim: scripted seat between turns' }; }

// Event types that end an attempt (lib/reducer.mjs finishAttempt callers).
export const TERMINAL_EVENT_TYPES = Object.freeze(['submission_accepted', 'attempt_canceled', 'attempt_expired', 'seat_failed', 'work_partial', 'seat_skipped', 'reconciled']);

// True when `metaUrl` is the module node started (node --test runs every file as its own main
// module). Case files register their tests only then, so mutation tests can import a case's
// scenario without running the case's own tests a second time.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (u) => (process.platform === 'win32' ? u.toLowerCase() : u);
  return norm(pathToFileURL(path.resolve(process.argv[1])).href) === norm(metaUrl);
}

export function createClock(t0 = T0) {
  let t = t0;
  return { now: () => t, advance(ms) { t += ms; return t; }, set(v) { t = v; return t; } };
}

// Fake spawn: records every call, starts nothing. `handler(file, args, opts)` may return a partial
// result (e.g. {stdout, code}) to shape what a disclosure run "printed".
export function createFakeSpawn(calls, handler) {
  return async (file, args = [], opts = {}) => {
    const rec = { file, args: [...args], opts };
    calls.push(rec);
    const r = (handler && (await handler(file, args, opts))) || {};
    const stdout = r.stdout !== undefined ? String(r.stdout) : 'ok';
    const stderr = r.stderr !== undefined ? String(r.stderr) : '';
    return {
      file, args, code: r.code !== undefined ? r.code : 0, signal: null, stdout, stderr,
      raw: { stdout: Buffer.from(stdout, 'utf8'), stderr: Buffer.from(stderr, 'utf8') },
      truncated: false, timedOut: false, spawnError: null,
    };
  };
}

function seatArgs(roomDir, s, cwd) {
  const a = { dir: roomDir, seat: s.seatId, role: s.role || 'participant', cwd, wait: s.waitMode || (s.hosted ? 'manual' : 'background') };
  if (s.agent) a.agent = s.agent;
  if (s.tier) a.tier = s.tier;
  if (s.reviews) a.reviews = Array.isArray(s.reviews) ? s.reviews.join(',') : String(s.reviews);
  if (s.hosted) a.hosted = typeof s.hosted === 'string' ? s.hosted : `pi:${s.hosted.tier || 'discussion'}`;
  if (s.wakeThread) a['wake-thread'] = s.wakeThread;
  if (s.wakeMax) a['wake-max'] = String(s.wakeMax);
  if (s.wallClockSec) a.wall = String(s.wallClockSec);
  if (s.name) a.name = s.name;
  return a;
}

// createSim(opts) -> sim. Options:
//   preset, id                      room preset / id (admin init)
//   seats: [{seatId, role, files:{rel: text}, cwdOf: 'B' (share B's cwd), waitMode, agent, tier,
//            reviews, hosted: 'pi:discussion', wakeThread, wakeMax, wallClockSec, extra: {...}}]
//   init: {wall, 'work-wall', 'max-work', 'max-tokens', 'packet-max-bytes'}   admin init flags
//   room: {...}                     merged into room.json after the seats are added (through a guard)
//   mutate                          passed to createRoomService (undefined -> ROOM_MUTATE env)
//   audit, piProvider, piApiKey     injected into the service
//   savedPiKeyPath                  the DPAPI-saved Pi key the service may read (default: none; a
//                                   simulated room never reads the user's real saved key)
//   spawnHandler                    shapes fake spawn results
//   idleCheck                       wake idle check (default: every scripted seat's thread is idle,
//                                   since a scripted seat only acts between turns)
//   snapshot                        replaces lib/workspace.mjs snapshot (to edit a file mid-freeze)
//   checkCommand                    replaces lib/workspace.mjs checkCommand (acceptance argv[0] lookup)
//   adjudicationsPath               cross-room log (default: inside this case's base dir)
//   start                           start the service now (default true)
export async function createSim(opts = {}) {
  fs.mkdirSync(testRunsRoot(), { recursive: true });
  const base = path.join(testRunsRoot(), `sim-${randomHex(5)}`);
  const guard = createGuard({ allowed: [base], logPath: path.join(base, 'sim-write-log.jsonl'), who: 'sim' });
  guard.mkdir(base);
  const roomDir = path.join(base, 'room');
  const clock = createClock(opts.t0 || T0);
  const logs = [];
  const adminOut = [];
  const spawnCalls = [];
  const fakeSpawn = createFakeSpawn(spawnCalls, opts.spawnHandler);
  const adjudicationsPath = opts.adjudicationsPath || path.join(base, 'app', 'adjudications.jsonl');
  const io = { out: (l) => adminOut.push(l) };

  const init = { dir: roomDir, id: opts.id || `sim${randomHex(3)}` };
  if (opts.preset) init.preset = opts.preset;
  for (const [k, v] of Object.entries(opts.init || {})) init[k] = String(v);
  cmdInit(init, io);

  const cwdOf = {};
  function cwdFor(s) {
    if (s.cwdOf) return cwdOf[s.cwdOf];
    return path.join(base, `cwd-${s.seatId}`);
  }
  function addSeat(s) {
    const cwd = cwdFor(s);
    if (!fs.existsSync(cwd)) guard.mkdir(cwd);
    for (const [rel, content] of Object.entries(s.files || {})) {
      const p = path.join(cwd, rel);
      guard.mkdir(path.dirname(p));
      guard.writeFile(p, content);
    }
    cwdOf[s.seatId] = cwd;
    const before = adminOut.length;
    cmdAddSeat(seatArgs(roomDir, s, cwd), io);
    return adminOut.slice(before);
  }
  const seatOutput = {};
  for (const s of opts.seats || []) seatOutput[s.seatId] = addSeat(s);

  // room.json overrides (and per-seat extras) the admin CLI has no flag for, written the way an
  // admin edit would be: through a guard rooted at the room directory.
  const roomGuard = createGuard({ allowed: [roomDir], logPath: path.join(roomDir, F.writeLog), who: 'sim-setup' });
  function patchRoom(patch, seatPatches = {}) {
    const p = path.join(roomDir, F.room);
    const r = readJson(p);
    Object.assign(r, patch || {});
    for (const s of r.seats) if (seatPatches[s.seatId]) Object.assign(s, seatPatches[s.seatId]);
    roomGuard.atomicWrite(p, JSON.stringify(r, null, 1));
    return r;
  }
  const seatExtras = Object.fromEntries((opts.seats || []).filter((s) => s.extra).map((s) => [s.seatId, s.extra]));
  if (opts.room || Object.keys(seatExtras).length) patchRoom(opts.room, seatExtras);

  let svc = null;
  let ticks = 0;
  let services = 0;
  function startService() {
    if (svc) throw new Error('sim: service already running');
    svc = createRoomService({
      roomDir, now: clock.now, log: (l) => logs.push(l), spawn: fakeSpawn, codexExe: FAKE_CODEX, gitExe: null,
      adjudicationsPath, mutate: opts.mutate, audit: opts.audit, piProvider: opts.piProvider, piApiKey: opts.piApiKey,
      ...(opts.savedPiKeyPath ? { savedPiKeyPath: opts.savedPiKeyPath } : { savedPiKey: false }),
      idleCheck: opts.idleCheck || simIdle, snapshot: opts.snapshot, checkCommand: opts.checkCommand,
    });
    services++;
    return svc;
  }
  // A crash: the service object is abandoned between ticks without close(): service.lock stays,
  // state.json is whatever was last flushed, events.jsonl is the commit point.
  async function crashService() {
    if (!svc) return;
    await settled(svc);
    svc = null;
    logs.push('[sim] service crashed (abandoned without close)');
  }
  async function restartService() {
    if (svc) await crashService();
    return startService();
  }
  // settle=false: do not wait for the service's async side tasks (a hosted Pi prompt that is
  // deliberately held open by the fake provider would otherwise block the tick).
  async function tick(n = 1, { settle = true } = {}) {
    for (let i = 0; i < n; i++) {
      if (!svc) return;
      await svc.tick();
      if (settle) await settled(svc);
      ticks++;
    }
  }
  // svc.settle() with a real-time bound, so a side task that never ends fails the case instead of
  // hanging the test process.
  async function settled(s, ms = opts.settleTimeoutMs || 5000) {
    let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`sim: service side tasks did not settle within ${ms} ms (use tick(n, {settle:false}) while a hosted prompt is held open)`)), ms); });
    try { await Promise.race([s.settle(), limit]); } finally { clearTimeout(timer); }
  }
  async function admin(cmd) {
    if (!svc) throw new Error('sim: admin call while the service is down');
    const r = await svc.admin(cmd);
    await settled(svc);
    return r;
  }

  // Runs scripted seats until every script is done. Each loop: every seat advances as far as it
  // can (writes, waits, admin steps), then the service ticks once.
  async function run(seats, { maxTicks = 300, settle = true } = {}) {
    for (const s of seats) s.bind(sim);
    for (let i = 0; i <= maxTicks; i++) {
      for (const s of seats) await s.advance();
      if (seats.every((s) => s.done)) { await tick(1, { settle }); return; }
      await tick(1, { settle });
    }
    const where = seats.filter((s) => !s.done).map((s) => `${s.seatId}@${s.pc}:${JSON.stringify(s.currentStepLabel())}`).join(' ');
    throw new Error(`sim.run: seats not done after ${maxTicks} ticks: ${where}; last events: ${events().slice(-8).map((e) => `${e.seq}:${e.type}${e.seatId ? `/${e.seatId}` : ''}${e.reason ? `/${e.reason}` : ''}`).join(' ')}`);
  }
  async function until(pred, { maxTicks = 100 } = {}) {
    for (let i = 0; i <= maxTicks; i++) {
      if (await pred(sim)) return true;
      await tick();
    }
    throw new Error('sim.until: predicate not satisfied');
  }

  // ---- reading the room (events.jsonl on disk is the truth)
  function events(type) {
    const all = readJsonl(path.join(roomDir, F.events));
    return type ? all.filter((e) => e.type === type) : all;
  }
  function ofType(type, pred) { return events(type).filter((e) => !pred || pred(e)); }
  function lastEvent(type, pred) { const l = ofType(type, pred); return l.length ? l[l.length - 1] : null; }
  // Asserts `types` appear in events.jsonl as an ordered subsequence. Each entry is a type string or
  // {type, ...fields} matched with deep equality on the given fields.
  function assertEvents(types, { from = 0 } = {}) {
    const list = events().filter((e) => e.seq > from);
    let i = 0;
    const matches = (e, want) => {
      if (typeof want === 'string') return e.type === want;
      for (const [k, v] of Object.entries(want)) {
        try { assert.deepEqual(e[k], v); } catch { return false; }
      }
      return true;
    };
    const found = [];
    for (const want of types) {
      while (i < list.length && !matches(list[i], want)) i++;
      if (i >= list.length) {
        assert.fail(`expected event ${JSON.stringify(want)} after ${found.length ? `seq ${found[found.length - 1]}` : 'the start'}; events: ${list.map((e) => `${e.seq}:${e.type}`).join(' ')}`);
      }
      found.push(list[i].seq);
      i++;
    }
    return found;
  }
  function state() { if (!svc) throw new Error('sim: service is down'); return svc.view(); }
  function diskState() { return readJson(path.join(roomDir, F.state), null); }
  function attempt(attemptId) { return svc ? svc.state.attemptLog[attemptId] : null; }
  function packetText(attemptId) {
    const ev = events('packet_issued').find((e) => e.attemptId === attemptId);
    return ev ? fs.readFileSync(ev.path, 'utf8') : null;
  }
  function packetManifest(attemptId) {
    const ev = events('packet_issued').find((e) => e.attemptId === attemptId);
    return ev ? readJson(ev.manifestPath) : null;
  }
  function reply(seatId, subId) { return readJson(path.join(roomDir, F.replies, seatId, `${subId}.json`), null); }
  function seatRecord(seatId) { return readJson(path.join(roomDir, F.seats, seatId, 'seat.json')); }
  function seatDir(seatId) { return path.join(roomDir, F.seats, seatId); }
  function token(seatId) { return fs.readFileSync(path.join(roomDir, F.seats, seatId, 'token'), 'utf8').trim(); }
  function writeLog() { return readJsonl(path.join(roomDir, F.writeLog)); }
  function holding(seatId) { return svc ? svc.state.holding[seatId] || null : null; }
  function latestManifest(seatId) { return svc && svc.state.seats[seatId] ? svc.state.seats[seatId].latestManifest || null : null; }
  // An external edit (the user or the agent itself, not the room) inside a seat's working directory.
  function editFile(seatId, rel, text) {
    const p = path.isAbsolute(rel) ? rel : path.join(cwdOf[seatId], rel);
    guard.mkdir(path.dirname(p));
    guard.writeFile(p, text);
    return p;
  }
  // Raw bytes appended to a room file (crash residue such as a torn events.jsonl line).
  function appendRaw(rel, text) { guard.appendFsync(path.join(roomDir, rel), text); }

  async function close() {
    if (svc) { try { await svc.close(); } catch { /* reported by the caller */ } svc = null; }
  }
  async function cleanup() {
    await close();
    if (process.env.ROOM_SIM_KEEP) return;
    fs.rmSync(base, { recursive: true, force: true });
  }
  // Runs fn(sim); removes the case directory when it passes, keeps it (and says where) when it fails.
  async function check(fn) {
    try {
      await fn(sim);
    } catch (e) {
      await close();
      if (e && typeof e.message === 'string') e.message += `\n[sim] case directory kept: ${base}`;
      throw e;
    }
    await cleanup();
  }

  const sim = {
    base, roomDir, clock, guard, logs, adminOut, seatOutput, spawnCalls, adjudicationsPath, cwdOf,
    get svc() { return svc; }, get ticks() { return ticks; }, get services() { return services; },
    startService, crashService, restartService, tick, admin, run, until, addSeat, patchRoom,
    events, ofType, lastEvent, assertEvents, state, diskState, attempt, packetText, packetManifest, reply,
    seatRecord, seatDir, token, writeLog, holding, latestManifest, editFile, appendRaw, close, cleanup, check,
  };
  if (opts.start !== false) startService();
  return sim;
}

// ---------------------------------------------------------------- shared run prefixes

// The two seats most governance cases need: lead A, executor B with a small project.
export const IR_SEATS = Object.freeze([
  Object.freeze({ seatId: 'A', role: 'lead' }),
  Object.freeze({ seatId: 'B', role: 'executor', files: Object.freeze({ 'src/app.mjs': 'export const x = 1;\n', 'README.md': '# demo\n' }) }),
]);

// implement-review round 1 up to the lead's summary turn: B works and freezes `paths`, A opens, B
// reports. Returns {sha, summaryAttempt}; the summary attempt is open and held by A.
export async function runToSummary(sim, { task = 'Implement app.mjs', paths = ['src', 'README.md'], baseline = 'none' } = {}) {
  const { createScriptedSeat } = await import('./scripted-seat.mjs');
  await sim.admin({ cmd: 'task', text: task });
  await sim.admin({ cmd: 'start' });
  const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { artifacts: { paths, baseline } }, { submit: 'B: implementation complete' }, { wait: {} }, { submit: 'B: report complete' }] });
  const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A: opening the meeting, B please report' }, { until: (s) => !!s.holding('A') }] });
  await sim.run([A, B]);
  const summaryAttempt = sim.holding('A');
  if (!summaryAttempt || sim.svc.state.attemptLog[summaryAttempt].phase !== 'summary') throw new Error('runToSummary: A does not hold a summary attempt');
  return { sha: sim.latestManifest('B'), summaryAttempt, A, B };
}

// ---------------------------------------------------------------- analysis helpers (pure)

// Per attempt: the packet that opened it and every event that ended it. Exactly one terminal per
// attempt is the dedupe rule of plan §6.1.
export function attemptOutcomes(events) {
  const out = new Map();
  for (const e of events) {
    if (e.type === 'packet_issued') out.set(e.attemptId, { attemptId: e.attemptId, seatId: e.seatId, phase: e.phase, roundId: e.roundId, epoch: e.epoch, kind: e.kind, issuedSeq: e.seq, terminals: [] });
  }
  for (const e of events) {
    if (!TERMINAL_EVENT_TYPES.includes(e.type) || !e.attemptId) continue;
    if (e.type === 'reconciled' && e.action !== 'void') continue;
    const a = out.get(e.attemptId);
    if (a) a.terminals.push({ type: e.type, seq: e.seq, by: e.by || e.class || e.reason || null });
    else out.set(e.attemptId, { attemptId: e.attemptId, seatId: e.seatId, phase: null, terminals: [{ type: e.type, seq: e.seq }], orphan: true });
  }
  return [...out.values()];
}

// How many events judged each outbox file (seatId/file). Every file must be judged at most once.
export function fileJudgements(events) {
  const n = new Map();
  for (const e of events) {
    if (!e.file || !e.seatId) continue;
    if (!['submission_accepted', 'submission_rejected', 'structured_received', 'point_added', 'quote_submitted', 'misquoted_declared', 'disclose_requested', 'artifacts_frozen'].includes(e.type)) continue;
    const k = `${e.seatId}/${e.file}`;
    n.set(k, (n.get(k) || 0) + 1);
  }
  return n;
}
