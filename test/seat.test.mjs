// node --test test/seat.test.mjs
// Seat commands against a fake room (state.json, events.jsonl, replies/ written by the test, no real
// service), JOIN.md variants per agent kind, the admin-queue file format, and the location checks
// (MSIX virtualization refusal by injection, link redirection with a real junction).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testRunsRoot, readJson, readJsonl, isInside, EXIT, sha256 } from '../lib/common.mjs';
import { createGuard } from '../lib/guard.mjs';
import { spawnClean, ENV_WHITELIST } from '../lib/spawn.mjs';
import {
  SEAT_COMMANDS, SEAT_ENV_KEEP, CliError, scrubEnv, openAttemptFor, openAttemptsFromEvents, pendingReconcile,
  voidedNotice, buildSubmission, verifySubmissionProof, allValues, declaredPaths, parseArgvJson, discloseArgv, whoamiLine,
} from '../lib/seat.mjs';
import {
  ADMIN_COMMANDS, queueRecord, locationProblem, summarizeRoom, claudeTranscriptBaseline, realOf, ROOM_SCHEMA_VERSION, serviceRunning,
} from '../lib/admin.mjs';
import { LOCK_STALE_MS } from '../lib/common.mjs';
import { renderJoin, renderRoomCmd, AGENT_KINDS, AGENT_KIND_NAMES, defaultWaitMode, cmdPath } from '../lib/join.mjs';
import { parseArgs } from '../lib/common.mjs';
import { loadTemplates } from '../lib/packet.mjs';
import { startHttp } from '../lib/http.mjs';

const WIN = process.platform === 'win32';
const ROOM_MJS = fileURLToPath(new URL('../room.mjs', import.meta.url));
const roots = [];

function tempRoot() {
  const dir = path.join(testRunsRoot(), `seat-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
// fs.promises.rm, not rmSync: on Node 24 / Windows rmSync silently keeps non-ASCII-named targets.
after(async () => { for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true }); });

function testGuard(root) { return createGuard({ allowed: [root], logPath: path.join(root, 'test-write-log.jsonl'), who: 'test' }); }
function capture(extra = {}) { const lines = []; return { lines, io: { out: (l) => lines.push(l), pollMs: 40, ...extra }, text: () => lines.join('\n') }; }
const noRedirect = () => null;

// A room built by the real admin commands, with a fake service: the test writes state/events/replies.
function makeRoom({ seats = [{ seat: 'A', role: 'reviewer', agent: 'codex-desktop' }, { seat: 'B', role: 'executor', agent: 'claude-code' }], preset } = {}) {
  const root = tempRoot();
  const roomDir = path.join(root, 'room');
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') };
  const c = capture({ env, redirect: noRedirect });
  assert.equal(ADMIN_COMMANDS.init({ dir: roomDir, id: 'r1', ...(preset ? { preset } : {}), _: ['init'] }, c.io), 0);
  const g = testGuard(root);
  for (const s of seats) {
    const cwd = path.join(root, `cwd-${s.seat}`);
    g.mkdir(cwd); // the user creates seat working directories; add-seat never does
    assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, cwd, _: ['add-seat'], ...s }, c.io), 0, c.text());
  }
  // The guard's log must sit inside its allowed roots, so the fake service logs inside the room.
  const svc = createGuard({ allowed: [roomDir], logPath: path.join(roomDir, 'fake-service-log.jsonl'), who: 'fake-service' });
  const fake = {
    root, roomDir, env, io: c,
    seatDir: (id) => path.join(roomDir, 'seats', id),
    seat: (id) => readJson(path.join(roomDir, 'seats', id, 'seat.json')),
    setState: (st) => svc.atomicWrite(path.join(roomDir, 'state.json'), JSON.stringify(st)),
    setEvents: (evs) => svc.writeFile(path.join(roomDir, 'events.jsonl'), evs.map((e, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), ...e })).join('\n') + (evs.length ? '\n' : '')),
    reply: (seatId, subId, body) => { svc.mkdir(path.join(roomDir, 'replies', seatId)); svc.atomicWrite(path.join(roomDir, 'replies', seatId, `${subId}.json`), JSON.stringify(body)); },
    queued: () => fs.readdirSync(path.join(roomDir, 'admin-queue')).filter((f) => f.endsWith('.json')).sort().map((f) => ({ f, rec: readJson(path.join(roomDir, 'admin-queue', f)) })),
    token: () => fs.readFileSync(path.join(roomDir, 'admin.token'), 'utf8').trim(),
  };
  return fake;
}

const baseState = (over = {}) => ({ phase: 'meet', roundId: 1, epoch: 0, closed: false, order: ['A', 'B'], turnIndex: 0, currentSeat: null, attempt: null, seats: {}, messages: [], ...over });
const attemptFor = (seatId, attemptId, extra = {}) => ({ seatId, attemptId, packetId: `r1-${seatId}-${attemptId}`, nonce: 'abcd1234', sha256: 'f'.repeat(64), path: null, deadline: '2026-10-01T13:00:00.000Z', ...extra });

// Answers every new submission in a seat's outbox with handler(meta) -> reply body (or null = no reply).
function autoReply(fake, seatId, handler) {
  const outbox = fake.seat(seatId).outbox;
  const seen = new Set();
  const skip = new Set(['joined.json', 'leave.json', 'last-attempt.json']);
  const timer = setInterval(() => {
    let names = [];
    try { names = fs.readdirSync(outbox); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.json') || skip.has(n) || seen.has(n)) continue;
      let meta;
      try { meta = readJson(path.join(outbox, n)); } catch { continue; }
      seen.add(n);
      const body = handler(meta);
      if (body) fake.reply(seatId, meta.submissionId, body);
    }
  }, 30);
  return { stop: () => clearInterval(timer), seen };
}

async function seat(fake, cmd, args) {
  const c = capture();
  let code;
  try { code = await SEAT_COMMANDS[cmd]({ seat: fake.seatDir(args.seatId || 'B'), _: [], ...args }, c.io); } catch (e) { if (e instanceof CliError) { code = e.exitCode; c.lines.push(`ERROR ${e.message}`); } else throw e; }
  return { code, out: c.text(), first: c.lines[0] || '' };
}

// ---------------------------------------------------------------- environment

test('scrubEnv keeps only the whitelist and ROOM_DEV_HOME; keep list covers the spawn whitelist', () => {
  for (const k of ENV_WHITELIST) assert.ok(SEAT_ENV_KEEP.includes(k), `SEAT_ENV_KEEP has ${k}`);
  const env = { PATH: '/bin', TEMP: '/t', ROOM_DEV_HOME: '/h', OPENAI_API_KEY: 'sk-x', ROOM_CANARY_SECRET: 'c', NODE_OPTIONS: '--x', USERPROFILE: '/u' };
  const removed = scrubEnv(env);
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'ROOM_DEV_HOME', 'TEMP']);
  assert.deepEqual(removed.sort(), ['NODE_OPTIONS', 'OPENAI_API_KEY', 'ROOM_CANARY_SECRET', 'USERPROFILE']);
});

test('lib/seat.mjs does not import child_process or the spawn module', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../lib/seat.mjs', import.meta.url)), 'utf8');
  assert.ok(!/child_process/.test(src));
  assert.ok(!/spawn\.mjs/.test(src));
});

// ---------------------------------------------------------------- pure view

test('openAttemptFor: state.attempt, state.attempts (array and map), events fallback', () => {
  assert.equal(openAttemptFor({ state: { attempt: { attemptId: 'a1', seatId: 'B' }, currentSeat: 'B' }, seatId: 'B' }).attemptId, 'a1');
  assert.equal(openAttemptFor({ state: { attempt: { attemptId: 'a1' }, currentSeat: 'A' }, seatId: 'B' }), null);
  assert.equal(openAttemptFor({ state: { attempt: null }, events: [{ type: 'packet_issued', seatId: 'B', attemptId: 'x' }], seatId: 'B' }), null, 'state wins when it says no attempt');
  assert.equal(openAttemptFor({ state: { attempts: [{ seatId: 'A', attemptId: 'w1' }, { seatId: 'B', attemptId: 'w2' }] }, seatId: 'B' }).attemptId, 'w2');
  // lib/reducer.mjs shape: attempts keyed by attemptId (all ever issued) + holding[seatId].
  const reduced = { attempt: null, holding: { B: 'w3' }, attempts: { w1: { seatId: 'B', status: 'submitted' }, w3: { seatId: 'B', status: 'pending', nonce: 'n3' }, w4: { seatId: 'A', status: 'pending' } } };
  assert.equal(openAttemptFor({ state: reduced, seatId: 'B' }).attemptId, 'w3');
  assert.equal(openAttemptFor({ state: reduced, seatId: 'B' }).nonce, 'n3');
  assert.equal(openAttemptFor({ state: reduced, seatId: 'A' }), null, 'not held -> none');
  assert.equal(openAttemptFor({ state: { attempts: { w1: { seatId: 'B', status: 'submitted' }, w2: { seatId: 'B', status: 'pending' } } }, seatId: 'B' }).attemptId, 'w2');
  // ... or keyed by seat with an attemptLog by id; the record that names the held id wins.
  const bySeat = { holding: { B: 'w7' }, attempts: { B: { attemptId: 'w7', seatId: 'B', status: 'pending', nonce: 'n7', packetId: 'p7' } }, attemptLog: { w6: { attemptId: 'w6', seatId: 'B', status: 'canceled' } } };
  assert.equal(openAttemptFor({ state: bySeat, seatId: 'B' }).nonce, 'n7');
  const serial = { holding: { B: 'w8' }, attempts: {}, attempt: { attemptId: 'w8', seatId: 'B', nonce: 'n8' } };
  assert.equal(openAttemptFor({ state: serial, seatId: 'B' }).nonce, 'n8');
  assert.deepEqual(pendingReconcile({ state: { attempts: { w5: { seatId: 'B', status: 'needs_reconcile' } } }, events: [], seatId: 'B' }).map((e) => e.attemptId), ['w5']);
  const evs = [
    { type: 'packet_issued', seatId: 'B', attemptId: 'b1' }, { type: 'attempt_canceled', seatId: 'B', attemptId: 'b1' },
    { type: 'packet_issued', seatId: 'B', attemptId: 'b2' }, { type: 'packet_issued', seatId: 'A', attemptId: 'a1' },
  ];
  assert.equal(openAttemptFor({ state: {}, events: evs, seatId: 'B' }).attemptId, 'b2');
  assert.deepEqual(openAttemptsFromEvents([...evs, { type: 'reconciled', attemptId: 'b2', action: 'void' }]).map((a) => a.attemptId), ['a1']);
  assert.deepEqual(openAttemptsFromEvents([...evs, { type: 'seat_skipped', seatId: 'B', attemptId: null }]).map((a) => a.attemptId), ['a1']);
  assert.deepEqual(openAttemptsFromEvents([...evs, { type: 'room_closed' }]), []);
});

test('pendingReconcile and voidedNotice', () => {
  const evs = [{ type: 'needs_reconcile', attemptId: 'b1', seatId: 'B' }, { type: 'needs_reconcile', attemptId: 'a1', seatId: 'A' }];
  assert.deepEqual(pendingReconcile({ events: evs, seatId: 'B' }).map((e) => e.attemptId), ['b1']);
  assert.deepEqual(pendingReconcile({ events: [...evs, { type: 'reconciled', attemptId: 'b1', action: 'replay' }], seatId: 'B' }), []);
  assert.deepEqual(pendingReconcile({ state: { needsReconcile: [{ attemptId: 'b9', seatId: 'B' }] }, events: [], seatId: 'B' }).map((e) => e.attemptId), ['b9']);
  assert.equal(voidedNotice({ events: [{ type: 'packet_issued', attemptId: 'x' }], attemptId: 'x' }), null);
  assert.deepEqual(voidedNotice({ events: [{ type: 'submission_accepted', attemptId: 'x' }], attemptId: 'x' }), { accepted: true });
  assert.equal(voidedNotice({ events: [{ type: 'attempt_expired', attemptId: 'x' }], attemptId: 'x' }).status, 'expired');
  assert.equal(voidedNotice({ events: [{ type: 'reconciled', attemptId: 'x', action: 'void' }], attemptId: 'x' }).status, 'voided');
  assert.equal(voidedNotice({ events: [{ type: 'attempt_canceled', attemptId: 'x', by: 'admin' }], attemptId: 'x' }).by, 'admin');
});

test('submission records: proof binds token, attempt and body/payload', () => {
  const sp = buildSubmission({ seatId: 'B', attemptId: 'a1', token: 't', kind: 'speech', bodySha256: sha256('hi') });
  assert.match(sp.submissionId, /^a1-s[0-9a-f]{6}$/);
  assert.equal(sp.bodyFile, `${sp.submissionId}.md`);
  assert.equal(sp.kind, 'speech');
  assert.ok(verifySubmissionProof(sp, 't', Buffer.from('hi')));
  assert.ok(!verifySubmissionProof(sp, 't', Buffer.from('changed')));
  assert.ok(!verifySubmissionProof(sp, 'other', Buffer.from('hi')));
  const st = buildSubmission({ seatId: 'B', attemptId: 'a1', token: 't', kind: 'point', payload: { seq: 2, text: '要点' } });
  assert.equal(st.kind, 'point');
  assert.deepEqual(st.payload, { seq: 2, text: '要点' });
  const roundTrip = JSON.parse(JSON.stringify(st));
  assert.ok(verifySubmissionProof(roundTrip, 't'));
  roundTrip.payload.seq = 3;
  assert.ok(!verifySubmissionProof(roundTrip, 't'));
});

test('argument helpers: repeated --exclude, --declare lists, --argv JSON', () => {
  const raw = ['--seat', 's', '--declare', 'src', 'README.md', '--exclude', '*.log', '--exclude=tmp/**', '--baseline', 'whole'];
  const args = { ...parseArgs(raw), __argv: raw };
  assert.deepEqual(declaredPaths(args), ['src', 'README.md']);
  assert.deepEqual(allValues(args, 'exclude'), ['*.log', 'tmp/**']);
  assert.deepEqual(declaredPaths(parseArgs(['--declare', 'a', 'b'])), ['a', 'b']);
  assert.deepEqual(parseArgvJson('["git","diff"]'), ['git', 'diff']);
  // What Windows shells hand the program for --argv '["git","diff"]' (measured: PowerShell 5.1 / cmd.exe).
  assert.deepEqual(parseArgvJson('[git,diff]'), ['git', 'diff']);
  assert.deepEqual(parseArgvJson("'[git,diff]'"), ['git', 'diff']);
  assert.deepEqual(parseArgvJson('[git, diff, --stat]'), ['git', 'diff', '--stat']);
  assert.deepEqual(parseArgvJson('\'["git","diff"]\''), ['git', 'diff']);
  const rawArgs = ['--arg', 'git', '--arg', 'diff', '--arg=--name-only'];
  assert.deepEqual(discloseArgv({ ...parseArgs(rawArgs), __argv: rawArgs }), ['git', 'diff', '--name-only']);
  assert.deepEqual(discloseArgv({ arg: ['git', 'status'] }), ['git', 'status']);
  assert.deepEqual(discloseArgv({ argv: '[git,diff]' }), ['git', 'diff']);
  assert.throws(() => discloseArgv({}), /--arg git --arg diff/);
  assert.throws(() => parseArgvJson('git diff'), CliError);
  assert.throws(() => parseArgvJson('[]'), CliError);
  assert.throws(() => parseArgvJson('["git", 1]'), CliError);
});

// ---------------------------------------------------------------- admin init / add-seat

test('admin init writes a schema-2 room, refuses an existing room and CODEX_HOME', () => {
  const root = tempRoot();
  const c = capture({ redirect: noRedirect });
  const dir = path.join(root, 'room');
  assert.equal(ADMIN_COMMANDS.init({ dir, id: 'demo', preset: 'implement-review', 'max-tokens': '150000', _: ['init'] }, c.io), 0);
  assert.match(c.lines[0], /^INIT room=demo dir=.* preset=implement-review$/);
  const room = readJson(path.join(dir, 'room.json'));
  assert.equal(room.schema_version, ROOM_SCHEMA_VERSION);
  assert.equal(room.preset, 'implement-review');
  assert.equal(room.budget.maxTokens, 150000);
  assert.equal(room.budget.packetMaxBytes, 200000);
  assert.deepEqual(room.disclosureAllowlist, [['git', 'diff'], ['git', 'status']]);
  assert.equal(room.maxWorkConcurrent, 2);
  // INTERFACES §2: template hashes (preamble, per role, and the combined manifest templateHash).
  assert.match(room.templates.preamble, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(room.templates.roles).sort(), ['executor', 'lead', 'participant', 'reviewer']);
  for (const h of Object.values(room.templates.roles)) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(room.templates.preamble, sha256(fs.readFileSync(fileURLToPath(new URL('../lib/templates/preamble.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')));
  assert.equal(room.templates.all, loadTemplates().templateHash);
  assert.match(fs.readFileSync(path.join(dir, 'admin.token'), 'utf8'), /^[0-9a-f]{32}$/);
  for (const d of ['packets', 'replies', 'seats', 'admin-queue/done', 'private']) assert.ok(fs.existsSync(path.join(dir, d)), d);
  for (const row of readJsonl(path.join(dir, 'write-log.jsonl'))) {
    assert.equal(row.who, 'admin');
    assert.ok(isInside(row.path, dir), row.path);
  }
  assert.throws(() => ADMIN_COMMANDS.init({ dir, id: 'demo', _: ['init'] }, c.io), /room already exists/);
  assert.throws(() => ADMIN_COMMANDS.init({ dir: path.join(root, 'r2'), preset: 'nope', _: ['init'] }, c.io), /--preset/);
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  try {
    assert.throws(() => ADMIN_COMMANDS.init({ dir: path.join(root, 'codex-home', 'rooms', 'x'), _: ['init'] }, c.io), /CODEX_HOME/);
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
});

test('admin init --id alone lands under defaultRoomsRoot()', () => {
  const root = tempRoot();
  const prev = process.env.ROOM_DEV_HOME;
  process.env.ROOM_DEV_HOME = path.join(root, 'home');
  try {
    const c = capture({ redirect: noRedirect });
    assert.equal(ADMIN_COMMANDS.init({ id: 'byid', _: ['init'] }, c.io), 0);
    assert.ok(fs.existsSync(path.join(root, 'home', 'rooms', 'byid', 'room.json')));
  } finally { if (prev === undefined) delete process.env.ROOM_DEV_HOME; else process.env.ROOM_DEV_HOME = prev; }
});

test('MSIX virtualization: init and add-seat refuse with a Chinese explanation (injected redirect)', () => {
  const root = tempRoot();
  const packaged = (p) => ({ asked: path.resolve(p), real: path.join('C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local', path.basename(p)), packaged: true });
  const msg = locationProblem(path.join(root, 'x'), { redirect: packaged });
  assert.match(msg, /MSIX/);
  assert.match(msg, /%USERPROFILE%/);
  assert.match(msg, /ROOM_DEV_HOME/);
  assert.equal(locationProblem(root, { redirect: noRedirect }), null);
  assert.match(locationProblem(root, { redirect: (p) => ({ asked: p, real: 'D:\\elsewhere', packaged: false }) }), /真实位置是 D:\/elsewhere/);

  const c = capture({ redirect: packaged });
  assert.throws(() => ADMIN_COMMANDS.init({ dir: path.join(root, 'room'), id: 'v', _: ['init'] }, c.io), (e) => e instanceof CliError && /MSIX/.test(e.message) && e.exitCode === 9);
  // A room that passed, then a seat cwd that redirects.
  const ok = capture({ redirect: noRedirect });
  ADMIN_COMMANDS.init({ dir: path.join(root, 'room2'), id: 'v2', _: ['init'] }, ok.io);
  testGuard(root).mkdir(path.join(root, 'cwd-v'));
  const onlyCwd = (p) => (path.resolve(p).includes(`${path.sep}cwd-v`) ? packaged(p) : null);
  const c2 = capture({ redirect: onlyCwd });
  assert.throws(() => ADMIN_COMMANDS['add-seat']({ dir: path.join(root, 'room2'), seat: 'A', role: 'reviewer', cwd: path.join(root, 'cwd-v'), _: ['add-seat'] }, c2.io), /席位工作目录.*MSIX/s);
  assert.equal(readJson(path.join(root, 'room2', 'room.json')).seats.length, 0, 'refused seat is not registered');
});

test('real link redirection: a seat cwd reached through a junction/symlink is refused', (t) => {
  const root = tempRoot();
  const target = path.join(root, 'real-cwd');
  fs.mkdirSync(target);
  const link = path.join(root, 'link-cwd');
  try { fs.symlinkSync(target, link, WIN ? 'junction' : 'dir'); } catch (e) { t.skip(`cannot create link: ${e.code}`); return; }
  const c = capture();
  ADMIN_COMMANDS.init({ dir: path.join(root, 'room'), id: 'j', _: ['init'] }, c.io);
  assert.throws(() => ADMIN_COMMANDS['add-seat']({ dir: path.join(root, 'room'), seat: 'A', role: 'reviewer', cwd: link, _: ['add-seat'] }, c.io), /真实位置是/);
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: path.join(root, 'room'), seat: 'A', role: 'reviewer', cwd: target, _: ['add-seat'] }, c.io), 0, c.text());
  assert.equal(realOf(path.join(link, 'not-yet')).toLowerCase(), path.join(fs.realpathSync.native(target), 'not-yet').replace(/^\\\\\?\\/, '').toLowerCase());
});

test('add-seat records agent, defaults, reviews, hosted, wake, audit baseline; writes JOIN.md and room.cmd', () => {
  const root = tempRoot();
  const roomDir = path.join(root, 'room');
  const claudeHome = path.join(root, 'claude-home');
  const cwdB = path.join(root, 'cwd-B');
  const g = testGuard(root);
  const encDir = path.join(claudeHome, 'projects', path.resolve(cwdB).replace(/[^A-Za-z0-9]/g, '-'));
  g.mkdir(encDir);
  g.writeFile(path.join(encDir, 'old-session.jsonl'), '{}\n');
  const c = capture({ env: { CLAUDE_CONFIG_DIR: claudeHome }, redirect: noRedirect });
  ADMIN_COMMANDS.init({ dir: roomDir, id: 'r', _: ['init'] }, c.io);
  for (const d of ['cwd-A', 'cwd-B', 'cwd-P']) g.mkdir(path.join(root, d));
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, seat: 'A', role: 'lead', agent: 'codex-desktop', cwd: path.join(root, 'cwd-A'), 'wake-thread': 'room-A', 'wake-max': '2', reviews: 'B', audit: 'codex', 'thread-id': '01a0f000-0000-7000-8000-0000000000ab', _: ['add-seat'] }, c.io), 0, c.text());
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, seat: 'B', role: 'executor', agent: 'claude-code', cwd: cwdB, audit: 'claude', _: ['add-seat'] }, c.io), 0, c.text());
  assert.equal(ADMIN_COMMANDS['add-seat']({ dir: roomDir, seat: 'P', role: 'participant', hosted: 'pi:discussion', cwd: path.join(root, 'cwd-P'), _: ['add-seat'] }, c.io), 0, c.text());
  const a = readJson(path.join(roomDir, 'seats', 'A', 'seat.json'));
  assert.equal(a.agent, 'codex-desktop');
  assert.equal(a.waitMode, 'turn_over', 'codex default wait mode');
  assert.equal(a.declaredTier, 'readonly');
  assert.deepEqual(a.reviews, ['B']);
  assert.deepEqual(a.wake, { enabled: true, kind: 'codex-queue', thread: 'room-A', maxPerTurn: 2 });
  assert.deepEqual(a.audit, { kind: 'codex', threadId: '01a0f000-0000-7000-8000-0000000000ab', cwd: path.join(root, 'cwd-A') });
  assert.equal(a.hosted, null);
  assert.equal(a.outbox, path.join(root, 'cwd-A', '.room-outbox', 'A'));
  const b = readJson(path.join(roomDir, 'seats', 'B', 'seat.json'));
  assert.equal(b.waitMode, 'background');
  assert.equal(b.declaredTier, 'workspace');
  assert.equal(b.audit.kind, 'claude');
  assert.equal(b.audit.knownTranscripts.length, 1);
  assert.equal(b.audit.knownTranscripts[0].name, 'old-session.jsonl');
  assert.equal(b.audit.knownTranscripts[0].size, 3);
  const p = readJson(path.join(roomDir, 'seats', 'P', 'seat.json'));
  assert.deepEqual(p.hosted, { kind: 'pi', tier: 'discussion' });
  assert.equal(p.agent, 'hosted-pi');
  assert.match(fs.readFileSync(path.join(roomDir, 'seats', 'P', 'JOIN.md'), 'utf8'), /内置 Pi 托管/);
  const room = readJson(path.join(roomDir, 'room.json'));
  assert.deepEqual(room.seats.map((s) => s.seatId), ['A', 'B', 'P']);
  for (const s of room.seats) assert.equal(s.joinSha256, sha256(fs.readFileSync(path.join(roomDir, 'seats', s.seatId, 'JOIN.md'))));
  const cmd = fs.readFileSync(path.join(roomDir, 'seats', 'B', 'room.cmd'), 'utf8');
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(cmd.includes(`node "${ROOM_MJS}" %*\r\n`));
  assert.match(fs.readFileSync(path.join(roomDir, 'seats', 'B', 'token'), 'utf8'), /^[0-9a-f]{48}$/);
  // Only the room directory was written by admin.
  for (const row of readJsonl(path.join(roomDir, 'write-log.jsonl'))) assert.ok(isInside(row.path, roomDir), row.path);
  assert.ok(!fs.existsSync(path.join(cwdB, '.room-outbox')), 'admin does not create the outbox');
  assert.ok(c.text().includes('JOIN '));
  const baseline = claudeTranscriptBaseline(cwdB, { CLAUDE_CONFIG_DIR: claudeHome });
  assert.equal(baseline.dir, encDir);

  // set-audit updates both room.json and seat.json, keeps the thread id when only the session changes
  assert.equal(ADMIN_COMMANDS['set-audit']({ dir: roomDir, seat: 'A', 'thread-id': '01a0f000-0000-7000-8000-0000000000ef', _: ['set-audit'] }, c.io), 0);
  assert.equal(readJson(path.join(roomDir, 'seats', 'A', 'seat.json')).audit.threadId, '01a0f000-0000-7000-8000-0000000000ef');
  assert.equal(readJson(path.join(roomDir, 'room.json')).seats.find((s) => s.seatId === 'A').audit.threadId, '01a0f000-0000-7000-8000-0000000000ef');
  g.writeFile(path.join(encDir, 'second.jsonl'), '{}\n{}\n');
  assert.equal(ADMIN_COMMANDS['set-audit']({ dir: roomDir, seat: 'B', kind: 'claude', 'session-id': 'sess-1', _: ['set-audit'] }, c.io), 0);
  const bAudit = readJson(path.join(roomDir, 'seats', 'B', 'seat.json')).audit;
  assert.equal(bAudit.sessionId, 'sess-1');
  assert.deepEqual(bAudit.knownTranscripts.map((x) => x.name), ['old-session.jsonl', 'second.jsonl']);
  assert.throws(() => ADMIN_COMMANDS['set-audit']({ dir: roomDir, seat: 'B', kind: 'gpt', _: ['set-audit'] }, c.io), /--audit codex\|claude/);
  assert.throws(() => ADMIN_COMMANDS['set-audit']({ dir: roomDir, seat: 'B', 'thread-id': 'a b', _: ['set-audit'] }, c.io), /--thread-id/);
  // NI-5: a Codex thread id must be a full uuid; a prefix or a name would register nothing.
  for (const bad of ['0199-abc', 'th-123', '01a0f000', 'x01a0f000-0000-7000-8000-000000000001', '01a0f000-0000-7000-8000-000000000001-copy']) {
    assert.throws(() => ADMIN_COMMANDS['set-audit']({ dir: roomDir, seat: 'A', kind: 'codex', 'thread-id': bad, _: ['set-audit'] }, c.io), /--thread-id 必须是 Codex 线程的完整 UUID/, bad);
  }
  assert.equal(readJson(path.join(roomDir, 'seats', 'A', 'seat.json')).audit.threadId, '01a0f000-0000-7000-8000-0000000000ef', 'a refused id changes nothing');
});

test('admin export delegates to lib/export.mjs and never writes into the room dir', async () => {
  const fake = makeRoom();
  const c = capture();
  await assert.rejects(() => ADMIN_COMMANDS.export({ dir: fake.roomDir, out: path.join(fake.roomDir, 'x.zip'), _: ['export'] }, c.io), /不能写进房间目录/);
  const out = path.join(fake.root, 'exports', 'r1.zip');
  const code = await ADMIN_COMMANDS.export({ dir: fake.roomDir, out, redact: true, _: ['export'] }, c.io);
  assert.equal(code, 0, c.text());
  assert.match(c.text(), /EXPORTED zip=/);
  assert.ok(fs.existsSync(out));
});

test('add-seat refusals: containment, bad flags, review cycle, running service', () => {
  const fake = makeRoom({ seats: [] });
  const { roomDir, root } = fake;
  const c = capture({ redirect: noRedirect, env: fake.env });
  const add = (extra) => () => ADMIN_COMMANDS['add-seat']({ dir: roomDir, _: ['add-seat'], role: 'reviewer', ...extra }, c.io);
  const g = testGuard(root);
  for (const d of ['c', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']) g.mkdir(path.join(root, d));
  // A missing seat cwd is refused, not created: the room never writes a seat cwd (NI-13).
  const missing = path.join(root, 'not-created');
  assert.throws(add({ seat: 'M', cwd: missing }), (e) => e instanceof CliError && /不存在；请先自己创建它/.test(e.message));
  assert.ok(!fs.existsSync(missing), 'add-seat did not create the missing cwd');
  g.writeFile(path.join(root, 'a-file'), 'x');
  assert.throws(add({ seat: 'M', cwd: path.join(root, 'a-file') }), /不是目录/);
  assert.ok(!readJsonl(path.join(roomDir, 'write-log.jsonl')).some((r) => !isInside(r.path, roomDir)), 'admin wrote only inside the room');
  assert.throws(add({ seat: 'X', cwd: path.join(roomDir, 'inside') }), /互相包含/);
  assert.throws(add({ seat: 'X', cwd: root }), /互相包含/);
  assert.throws(add({ seat: 'X', cwd: path.join(root, 'c'), agent: 'notreal' }), /--agent/);
  assert.throws(add({ seat: 'X', cwd: path.join(root, 'c'), hosted: 'pi:god' }), /--hosted/);
  assert.throws(add({ seat: 'X', cwd: path.join(root, 'c'), tier: 'root' }), /--tier/);
  assert.throws(add({ seat: 'X', cwd: path.join(root, 'c'), wait: 'forever' }), /--wait/);
  assert.throws(add({ seat: 'bad id', cwd: path.join(root, 'c') }), /--seat/);
  assert.throws(add({ seat: 'X', cwd: path.join(root, 'c'), reviews: 'X' }), /不能审查自己/);
  assert.equal(add({ seat: 'R1', cwd: path.join(root, 'c1'), reviews: 'R2' })(), 0);
  assert.throws(add({ seat: 'R2', cwd: path.join(root, 'c2'), reviews: 'R1' }), /成环/);
  assert.equal(add({ seat: 'L1', role: 'lead', cwd: path.join(root, 'c3') })(), 0);
  assert.throws(add({ seat: 'L2', role: 'lead', cwd: path.join(root, 'c4') }), /主力只能有一个/);
  assert.throws(add({ seat: 'L1', cwd: path.join(root, 'c6') }), /seat L1 exists/);
  const svc = createGuard({ allowed: [roomDir], logPath: path.join(roomDir, 'fake-service-log.jsonl'), who: 'fake-service' });
  svc.atomicWrite(path.join(roomDir, 'service.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.throws(add({ seat: 'Z', cwd: path.join(root, 'c5') }), /stop the room service/);
  // W11: the same liveness test as the service. A lock whose heartbeat is older than 120 s belongs to
  // a service that is gone even when its pid exists (here: reused by this very process).
  assert.equal(serviceRunning(roomDir), true);
  svc.atomicWrite(path.join(roomDir, 'service.lock'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString() }));
  assert.equal(serviceRunning(roomDir), false, 'stale heartbeat -> not running');
  svc.atomicWrite(path.join(roomDir, 'service.lock'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
  assert.equal(serviceRunning(roomDir), true, 'fresh heartbeat -> running');
  assert.equal(serviceRunning(roomDir, { isAlive: () => false }), false, 'pid gone -> not running');
  svc.atomicWrite(path.join(roomDir, 'service.lock'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date(Date.now() - LOCK_STALE_MS - 5000).toISOString() }));
  assert.equal(add({ seat: 'Z', cwd: path.join(root, 'c5') })(), 0, 'a dead lock does not block add-seat');
});

test('room inside a governed git repository is refused at add-seat and at init (.git dir or gitdir file)', () => {
  for (const gitKind of ['dir', 'file']) {
    const root = tempRoot();
    const g = testGuard(root);
    const repo = path.join(root, 'repo');
    // A fake work tree: `.git` is a directory in a clone, a gitdir file in a worktree/submodule.
    if (gitKind === 'dir') g.mkdir(path.join(repo, '.git'));
    else { g.mkdir(repo); g.writeFile(path.join(repo, '.git'), 'gitdir: ../main/.git/worktrees/repo\n'); }
    g.mkdir(path.join(repo, 'app'));
    const outside = path.join(root, 'outside');
    g.mkdir(outside);
    const c = capture({ redirect: noRedirect, env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') } });

    // init: a room anywhere inside the repo is refused before anything is written.
    const inRepo = path.join(repo, 'rooms', 'x');
    assert.throws(() => ADMIN_COMMANDS.init({ dir: inRepo, id: 'x', _: ['init'] }, c.io), (e) => e instanceof CliError && /git 仓库 .*repo 之内/.test(e.message), gitKind);
    assert.ok(!fs.existsSync(path.join(repo, 'rooms')), `${gitKind}: nothing created inside the repo`);

    // add-seat: a room that already exists inside the seat's repo (e.g. created before .git appeared).
    const late = path.join(root, 'late');
    const lateRoom = path.join(late, 'rooms', 'y');
    assert.equal(ADMIN_COMMANDS.init({ dir: lateRoom, id: 'y', _: ['init'] }, c.io), 0);
    g.mkdir(path.join(late, 'app'));
    if (gitKind === 'dir') g.mkdir(path.join(late, '.git')); else g.writeFile(path.join(late, '.git'), 'gitdir: elsewhere\n');
    assert.throws(() => ADMIN_COMMANDS['add-seat']({ dir: lateRoom, seat: 'A', role: 'reviewer', cwd: path.join(late, 'app'), _: ['add-seat'] }, c.io), (e) => /房间目录 .* 在席位工作目录 .*app 所属的 git 仓库 .*late 之内/.test(e.message), gitKind);
    assert.deepEqual(readJson(path.join(lateRoom, 'room.json')).seats, [], `${gitKind}: refused seat not registered`);

    // A room outside every repo, with a seat cwd inside a repo, is accepted.
    const okRoom = path.join(outside, 'rooms', 'z');
    assert.equal(ADMIN_COMMANDS.init({ dir: okRoom, id: 'z', _: ['init'] }, c.io), 0);
    assert.equal(ADMIN_COMMANDS['add-seat']({ dir: okRoom, seat: 'A', role: 'reviewer', cwd: path.join(repo, 'app'), _: ['add-seat'] }, c.io), 0, c.text());
  }
});

// ---------------------------------------------------------------- admin queue

test('admin queue files: {cmd, ...params, token, ts} for every queued command', () => {
  const fake = makeRoom();
  const { roomDir, root } = fake;
  const g = testGuard(root);
  const draft = path.join(root, 'draft.md');
  g.writeFile(draft, '- B: 实现 --strict | 验收: ["node","--test"]\n');
  const sha = 'a'.repeat(64);
  const cases = [
    [['task'], { text: '做 X' }, { cmd: 'task', text: '做 X' }],
    [['start'], { order: 'A, B,A' }, { cmd: 'start', order: ['A', 'B', 'A'] }],
    [['cancel'], {}, { cmd: 'cancel' }],
    [['skip'], {}, { cmd: 'skip' }],
    [['retry'], {}, { cmd: 'retry' }],
    [['retry'], { seat: 'B' }, { cmd: 'retry', seatId: 'B' }],
    [['wake'], { seat: 'A' }, { cmd: 'wake', seatId: 'A' }],
    [['close'], {}, { cmd: 'close' }],
    [['say'], { text: '新消息' }, { cmd: 'say', text: '新消息' }],
    [['interrupt'], {}, { cmd: 'interrupt' }],
    [['interrupt'], { text: '停' }, { cmd: 'interrupt', text: '停' }],
    [['confirm-task'], {}, { cmd: 'confirm-task' }],
    [['confirm-task'], { file: draft }, { cmd: 'confirm-task', assignments: [{ seatId: 'B', text: '实现 --strict', acceptance: [['node', '--test']] }] }],
    [['approve-disclose', 'dsc-1'], {}, { cmd: 'approve-disclose', id: 'dsc-1' }],
    [['deny-disclose', 'dsc-2'], { reason: '不必要' }, { cmd: 'deny-disclose', id: 'dsc-2', reason: '不必要' }],
    [['accept-stale', sha], {}, { cmd: 'accept-stale', manifestSha: sha }],
    [['reverse'], {}, { cmd: 'reverse' }],
    [['reassign'], { seat: 'B', to: 'A', text: '换人' }, { cmd: 'reassign', seatId: 'B', toSeatId: 'A', text: '换人' }],
    [['reconcile', 'a1-2-ff', 'void'], {}, { cmd: 'reconcile', attemptId: 'a1-2-ff', action: 'void' }],
    [['reconcile', 'a1-2-ff', 'replay'], {}, { cmd: 'reconcile', attemptId: 'a1-2-ff', action: 'replay' }],
  ];
  const token = fake.token();
  let before = 0;
  for (const [pos, flags, expected] of cases) {
    const c = capture();
    assert.equal(ADMIN_COMMANDS[pos[0]]({ dir: roomDir, _: pos, ...flags }, c.io), 0, pos.join(' '));
    assert.match(c.lines[0], new RegExp(`^QUEUED ${pos[0]} -> \\d+-[0-9a-f]{6}\\.json`));
    const q = fake.queued();
    assert.equal(q.length, before + 1);
    before = q.length;
    const rec = q.map((x) => x.rec).find((r) => JSON.stringify({ ...r, token: undefined, ts: undefined }) === JSON.stringify({ ...expected, token: undefined, ts: undefined }));
    assert.ok(rec, `${pos.join(' ')} -> ${JSON.stringify(expected)} in ${JSON.stringify(q.map((x) => x.rec))}`);
    assert.equal(rec.token, token);
    assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  }
  assert.deepEqual(queueRecord('x', { a: 1 }, 't', 'T'), { cmd: 'x', a: 1, token: 't', ts: 'T' });
  const c = capture();
  const bad = [
    [['accept-stale', 'nothex'], {}],
    [['reconcile', 'a1'], {}],
    [['reconcile', 'a1', 'maybe'], {}],
    [['deny-disclose', 'd1'], {}],
    [['start'], { order: 'A,b c' }],
    [['task'], {}],
    [['reassign'], { seat: 'B' }],
    [['confirm-task'], { file: path.join(root, 'missing.md') }],
  ];
  for (const [pos, flags] of bad) assert.throws(() => ADMIN_COMMANDS[pos[0]]({ dir: roomDir, _: pos, ...flags }, c.io), CliError, pos.join(' '));
  g.writeFile(path.join(root, 'bad-draft.md'), '- 没有席位\n');
  assert.throws(() => ADMIN_COMMANDS['confirm-task']({ dir: roomDir, _: ['confirm-task'], file: path.join(root, 'bad-draft.md') }, c.io), /无法解析/);
  assert.equal(fake.queued().length, before, 'refused commands queue nothing');
});

// Every file under `dir` whose bytes contain `needle` (names relative to dir).
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(Buffer.from(needle))) hits.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return hits;
}

test('pi-key: never written to disk; sent only over loopback to a service started with --port', async () => {
  const fake = makeRoom();
  const { roomDir } = fake;
  const KEY = `sk-test-${crypto.randomBytes(8).toString('hex')}`;
  const c = capture({ env: { ROOM_PI_API_KEY: KEY } });
  const pi = (args, io = c.io) => ADMIN_COMMANDS['pi-key']({ dir: roomDir, _: ['pi-key'], ...args }, io);
  // Without --port there is no handoff at all: the command explains the in-memory ways and writes nothing.
  await assert.rejects(pi({}), (e) => e instanceof CliError && /不再经文件或 admin-queue/.test(e.message) && /ROOM_PI_API_KEY/.test(e.message) && /--pi-key-stdin/.test(e.message));
  await assert.rejects(pi({ port: 'x' }), /--port/);
  await assert.rejects(pi({ port: '1' }), /房间服务没有运行/);
  const svc = createGuard({ allowed: [roomDir], logPath: path.join(roomDir, 'fake-service-log.jsonl'), who: 'fake-service' });
  svc.atomicWrite(path.join(roomDir, 'service.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(pi({ port: '1' }, { ...c.io, env: {}, readStdin: () => '' }), /没有拿到 API key/);

  // A stand-in service behind the real loopback HTTP surface (lib/http.mjs).
  const adminToken = fake.token();
  const got = [];
  const service = { adminToken, room: { seats: [] }, seatToken: () => null, view: () => ({}), events: [], admin: async (cmd) => { got.push(cmd); return { ok: true }; } };
  const srv = await startHttp({ service, port: 0 });
  try {
    assert.equal(await pi({ port: String(srv.port), seat: 'P' }), 0, c.text());
    assert.match(c.lines.at(-1), /^SENT pi-key -> 127\.0\.0\.1:\d+ seat=P/);
    const fromStdin = capture({ env: {}, readStdin: () => `${KEY}-2\n` });
    assert.equal(await pi({ port: String(srv.port) }, fromStdin.io), 0);
    assert.deepEqual(got, [{ cmd: 'pi-key', key: KEY, seatId: 'P' }, { cmd: 'pi-key', key: `${KEY}-2` }]);
    // a bad admin token is refused by the service and reported
    const svc2 = { ...service, adminToken: 'other-token' };
    const srv2 = await startHttp({ service: svc2, port: 0 });
    try { await assert.rejects(pi({ port: String(srv2.port) }), /拒绝了 pi-key：BAD_TOKEN/); } finally { await srv2.close(); }
    assert.ok(!c.text().includes(KEY) && !fromStdin.text().includes(KEY), 'output never contains the key');
  } finally { await srv.close(); }
  // Negative control for the old design: no file under the room ever holds the key, and nothing was queued.
  assert.deepEqual(filesContaining(roomDir, KEY), [], 'the key is in no file under the room');
  assert.deepEqual(fs.readdirSync(path.join(roomDir, 'private')), [], 'no private handoff file');
  assert.equal(fake.queued().filter((x) => x.rec.cmd === 'pi-key').length, 0, 'no admin-queue record');
});

test('serve --pi-key-stdin: an empty stdin is refused before the service starts', async () => {
  const fake = makeRoom();
  const r = await spawnClean(process.execPath, [ROOM_MJS, 'serve', '--dir', fake.roomDir, '--once', '--pi-key-stdin'], { timeoutMs: 30000 });
  assert.equal(r.code, 9, r.stdout + r.stderr);
  assert.match(r.stderr, /--pi-key-stdin: 标准输入里没有 key/);
  assert.ok(!fs.existsSync(path.join(fake.roomDir, 'state.json')), 'the service did not start');
});

// ---------------------------------------------------------------- show

test('summarizeRoom: items, verdicts, stale, disclosures, usage (unknown is not 0), reject-rate signal', () => {
  const room = { id: 'r', preset: 'implement-review', budget: { maxTokens: 1000 }, seats: [{ seatId: 'A', role: 'reviewer', agent: 'codex-desktop', waitMode: 'turn_over', declaredTier: 'readonly', audit: { kind: 'codex' } }, { seatId: 'B', role: 'executor', agent: 'claude-code', waitMode: 'background' }] };
  const sha = 'b'.repeat(64);
  const events = [
    { type: 'seat_joined', seatId: 'A' },
    { type: 'point_added', itemId: 'm2p1', seatId: 'A', attemptId: 'a1', aboutSeq: 2, text: '缺测试' },
    { type: 'point_added', itemId: 'm2p2', seatId: 'A', attemptId: 'a1', aboutSeq: 2, text: '命名' },
    { type: 'item_marked', itemId: 'm2p1', by: 'A', status: 'accepted', text: '' },
    { type: 'summary_published', version: 2, seatId: 'A', attemptId: 'a3', unanswered: ['m2p2', 'm3'], supersedes: 1 },
    { type: 'artifacts_frozen', seatId: 'B', roundId: 1, manifestSha: sha, baseline: 'whole', fileCount: 3, bytes: 99, excluded: [], copyTorn: false },
    { type: 'artifacts_recomputed', seatId: 'B', manifestSha: sha, changed: [{ path: 'x', from: 'a', to: 'b' }], stale: true },
    { type: 'verdict_recorded', seatId: 'A', attemptId: 'a3', artifactSha: sha, verdict: 'pass', annotation: 'stale' },
    { type: 'disclose_requested', id: 'dsc-1', seatId: 'A', attemptId: 'a3', argv: ['git', 'diff'], reason: 'r' },
    { type: 'disclose_requested', id: 'dsc-2', seatId: 'A', attemptId: 'a3', argv: ['git', 'status'], reason: 'r' },
    { type: 'disclose_approved', id: 'dsc-2', by: 'admin' },
    { type: 'disclose_executed', id: 'dsc-2', manifestSha: sha, exitCode: 0, outputSha256: 'c', truncated: false },
    { type: 'usage_reported', seatId: 'P', attemptId: 'p1', input: 400, output: 100, cached: 0, source: 'hosted' },
    { type: 'usage_reported', seatId: 'B', attemptId: 'b1', input: null, output: null, source: 'declared' },
    { type: 'needs_reconcile', attemptId: 'b9', seatId: 'B' },
    { type: 'audit_observed', seatId: 'A', attemptId: 'a3', status: 'present_in_native', writes: [{}], unknownCommands: [], tainted: true },
  ];
  const adj = Array.from({ length: 14 }, () => ({ roomId: 'x', reviewerAgent: 'codex-desktop', preset: 'implement-review', verdict: 'pass' }));
  const lines = summarizeRoom({ room, state: null, events, adjudications: adj });
  const text = lines.join('\n');
  assert.match(lines[0], /^NO_STATE/);
  assert.match(text, /seat A role=reviewer agent=codex-desktop .*status=joined audit=codex tainted/);
  assert.match(text, /seat B .*status=not_joined/);
  assert.match(text, /items total=3 accepted=1 unanswered=2 summary=v2/);
  assert.match(text, /item m2p2 seat=A status=unanswered about=2 命名/);
  assert.match(text, /artifacts seat=B manifest=bbbbbbbbbbbb files=3 bytes=99 baseline=whole stale/);
  assert.match(text, /verdict seat=A attempt=a3 artifact=bbbbbbbbbbbb verdict=pass annotation=stale \(清单已过期\)/);
  assert.match(text, /disclosures total=2 pending=1/);
  assert.match(text, /disclose dsc-1 .*status=requested .*admin approve-disclose dsc-1/);
  assert.match(text, /disclose dsc-2 .*status=executed .*exit=0/);
  assert.match(text, /usage: 已知用量 500 tokens.*另有 1 个回合用量未知（席位 B）.*剩余 500/);
  assert.match(text, /needs_reconcile attempt=b9 seat=B/);
  assert.match(text, /reject_rate agent=codex-desktop preset=implement-review n=14 k=0 status=suspicious/);
  const few = summarizeRoom({ room, state: { phase: 'meet', order: ['A'], turnIndex: 0 }, events: [], adjudications: adj.slice(0, 3) }).join('\n');
  assert.match(few, /^phase=meet .*turn=1\/1/);
  assert.match(few, /status=insufficient 样本不足（3\/14）/);
  assert.match(few, /usage: 已知用量：无/);
});

// ---------------------------------------------------------------- JOIN.md

const JOIN_FIXTURE = WIN
  ? { roomMjs: 'C:\\room-dev\\room.mjs', roomDir: 'C:\\Users\\u\\room-dev\\rooms\\demo', seatDir: 'C:\\Users\\u\\room-dev\\rooms\\demo\\seats\\B', cwd: 'D:\\work\\demo' }
  : { roomMjs: '/opt/room-dev/room.mjs', roomDir: '/home/u/room-dev/rooms/demo', seatDir: '/home/u/room-dev/rooms/demo/seats/B', cwd: '/work/demo' };

function joinFor(agent, over = {}) {
  const f = JOIN_FIXTURE;
  const seat = { seatId: 'B', role: 'executor', agent, waitMode: defaultWaitMode(agent), cwd: f.cwd, declaredTier: 'workspace', wake: { enabled: false }, ...over };
  return renderJoin({ room: { id: 'demo' }, seat, seatDir: f.seatDir, roomDir: f.roomDir, roomMjs: f.roomMjs, agent });
}

// sha256 of renderJoin(JOIN_FIXTURE) per agent kind on win32. Update deliberately when the text changes.
const JOIN_SNAPSHOTS = {
  'claude-code': '68865bb6c778db074f0bb175efe885daf5f4018a372c564b5edce37db18b1129',
  'codex-desktop': '9e713a1e093e9c1ce4b5382aae888f7978bc8314ef49842fa467cad46560496b',
  'codex-cli': 'ece8d940c300767afd94b7eef9de3f466b0b18dcc544fd4ed8a7995c6d2a5aab',
  opencode: 'ea6a66a96ab3d84dc64dae145952039309ec6171ba253c36c6c4b872a9a1956b',
  'gemini-cli': 'c80bc86389908f57d8965c06973bb3db4aa1364d47f9e351f0c0faccd5cce322',
  kimi: '8015cd2e98d0997013dd8c027de77ae2919e93a3a2883f90a57e1e40ad45ad73',
  dsh: 'ab6e154e4c040ea18cc1232ee113bbd24f46e7c15e4be2be14dc6379b79c4a08',
  'pi-user': 'c204751fb979bdb33f99382508025e15dd7750eba5219b8b318296f0d7870144',
  generic: '6fb7a51a11be1b1ddaf3b09d25f2a922b83221f7e451e4338454b0be10d72e72',
};

test('JOIN.md variants: every agent kind states wait mode, cost, permissions, persistence, uploads, memory, farewell', () => {
  assert.deepEqual(AGENT_KIND_NAMES, ['claude-code', 'codex-desktop', 'codex-cli', 'opencode', 'gemini-cli', 'kimi', 'dsh', 'pi-user', 'generic']);
  const f = JOIN_FIXTURE;
  const mjs = f.roomMjs.replace(/\\/g, '/');
  const sd = f.seatDir.replace(/\\/g, '/');
  const cwd = f.cwd.replace(/\\/g, '/');
  for (const agent of AGENT_KIND_NAMES) {
    const md = joinFor(agent);
    const wait = defaultWaitMode(agent);
    assert.ok(md.includes(`JOIN 变体 ${agent}`), agent);
    assert.ok(md.includes(`## 等待方式与成本`), agent);
    assert.ok(md.includes(`(${wait})`) || md.includes(`（${wait}）`), `${agent} names wait mode ${wait}`);
    assert.match(md, /成本：/, agent);
    assert.ok(md.includes('## 权限提示'), agent);
    assert.ok(md.includes(fill(AGENT_KINDS[agent].persist, mjs, cwd)), `${agent} persistence line`);
    assert.match(md, /DSH/, `${agent} upload notice`);
    assert.match(md, /不得写入你的持久记忆/, `${agent} memory rule`);
    assert.match(md, /散会声明.*房间规则失效.*不要把房间内容写进持久记忆/s, `${agent} farewell`);
    // exact commands: absolute, forward slashes, unquoted
    assert.ok(md.includes(`node ${mjs} wait --seat ${sd}`), `${agent} wait command`);
    assert.ok(md.includes(`node ${mjs} submit --seat ${sd} --attempt <TURN 给出的 attempt> --file <文件>`), `${agent} submit command`);
    assert.ok(md.includes(`node ${mjs} artifacts --seat ${sd} --attempt <id> --declare`), `${agent} executor artifacts command`);
    assert.ok(md.includes(`node ${mjs} leave --seat ${sd}`), agent);
    assert.ok(md.includes(`node ${mjs} status --seat ${sd} --whoami`), agent);
    // Only the cmd.exe line carries a native path (cmd.exe needs backslashes in the command position).
    assert.ok(md.split('\n').filter((l) => !l.includes('cmd.exe')).every((l) => !l.includes('\\')), `${agent}: no backslashes`);
    assert.ok(!md.includes(`"${mjs}"`), `${agent}: unquoted`);
    // speech files in the cwd root, never under .room-outbox
    assert.ok(md.includes(`放在你的工作目录 ${cwd} 的根下，例如 ${cwd}/speech-<attempt>.md`), agent);
    assert.match(md, /不要把发言文件放进 \.room-outbox\/（Codex 的 apply_patch 在那里会失败/, agent);
    if (WIN) assert.equal(sha256(md), JOIN_SNAPSHOTS[agent], `${agent} snapshot`);
  }
  const claude = joinFor('claude-code');
  assert.ok(claude.includes(`Bash(node ${mjs}:*)`));
  assert.ok(claude.includes('.claude/settings.local.json'));
  assert.match(claude, /run_in_background/);
  assert.match(claude, /等待期间零模型调用/);
  const codex = joinFor('codex-desktop', { role: 'reviewer', wake: { enabled: true, kind: 'codex-queue', thread: 'room-B', maxPerTurn: 1 } });
  assert.match(codex, /TURN_OVER/);
  assert.match(codex, /每回合一次唤醒/);
  assert.match(codex, /固定文案『\[ROOM authority=none\] 轮到席位 B/);
  assert.match(codex, /只会收到上面那句固定的唤醒文案/);
  assert.match(codex, /verdict pass\|reject\|disclose/);
  // W3: the documented disclose form needs no shell quoting.
  assert.ok(codex.includes(`disclose --seat ${sd} --attempt <id> --arg git --arg diff --reason`), 'quote-free disclose form');
  assert.ok(!codex.includes(`'["git","diff"]'`), 'no JSON-on-the-command-line example');
  // CF-1: a TURN may carry a trailing voided-attempt note; JOIN.md says it does not change the result.
  assert.match(codex, /TURN 后面可能多一行「注意：NOTICE/);
  assert.ok(!codex.includes('artifacts --seat'), 'reviewer has no artifacts command');
  const codexNoWake = joinFor('codex-cli', { role: 'reviewer' });
  assert.match(codexNoWake, /没有登记唤醒线程/);
  const manual = joinFor('gemini-cli');
  assert.ok(manual.includes(`node ${mjs} wait --seat ${sd} --timeout 110`));
  assert.match(manual, /需用户唤醒（manual）/);
  const dsh = joinFor('dsh');
  assert.match(dsh, /## 先看这一条：会话上传/);
  assert.ok(dsh.indexOf('会话上传') < dsh.indexOf('## 权限提示'), 'DSH notice comes first');
  assert.ok(!claude.includes('## 先看这一条'));
  const lead = joinFor('claude-code', { role: 'lead' });
  assert.match(lead, /mark --seat .* --status accepted\|rejected\|deferred/);
  assert.match(lead, /assign --seat .* --file <草案文件>/);
});

function fill(text, mjs, cwd) { return text.replace(/\{RULE\}/g, `Bash(node ${mjs}:*)`).replace(/\{CWD\}/g, cwd).replace(/\{ROOMMJS\}/g, mjs); }

test('JOIN.md cmd.exe line quotes the native room.cmd path when it contains a space (W8)', () => {
  const seatDir = WIN ? 'C:\\Users\\John Smith\\room-dev\\rooms\\p2\\seats\\A' : '/home/John Smith/room-dev/rooms/p2/seats/A';
  const md = renderJoin({ room: { id: 'p2' }, seat: { seatId: 'A', role: 'executor', agent: 'claude-code', waitMode: 'background', cwd: WIN ? 'D:\\work\\a' : '/work/a', wake: { enabled: false } }, seatDir, roomDir: path.dirname(path.dirname(seatDir)), roomMjs: JOIN_FIXTURE.roomMjs, agent: 'claude-code' });
  const line = md.split('\n').find((l) => l.includes('cmd.exe'));
  assert.ok(line.includes(`（cmd.exe 下也可以用 "${path.join(seatDir, 'room.cmd')}" <命令>`), line);
  assert.match(md, /路径含空格或特殊字符，所以加了引号/);
  // Without whitespace the path stays bare (and native).
  const plain = joinFor('claude-code').split('\n').find((l) => l.includes('cmd.exe'));
  assert.ok(plain.includes(`用 ${path.join(JOIN_FIXTURE.seatDir, 'room.cmd')} <命令>`), plain);
});

test('JOIN.md quotes a path only when it contains whitespace, and says so', () => {
  const md = joinFor('claude-code', { cwd: WIN ? 'D:\\my work\\席位 A' : '/my work/席位 A' });
  const cwd = WIN ? 'D:/my work/席位 A' : '/my work/席位 A';
  assert.ok(md.includes(`"${cwd}"`));
  assert.match(md, /路径含空格或特殊字符，所以加了引号/);
  assert.equal(cmdPath(WIN ? 'C:\\a\\b' : '/a/b'), WIN ? 'C:/a/b' : '/a/b');
  assert.ok(!joinFor('claude-code').includes('加了引号'));
});

test('room.cmd wrapper: CRLF, quoted room.mjs path, code page switch only for non-ASCII paths', () => {
  const ascii = renderRoomCmd({ roomMjs: JOIN_FIXTURE.roomMjs });
  assert.ok(ascii.endsWith('exit /b %ERRORLEVEL%\r\n'));
  assert.ok(!ascii.includes('chcp'));
  assert.ok(!/[^\r]\n/.test(ascii), 'CRLF only');
  const cn = renderRoomCmd({ roomMjs: WIN ? 'C:\\工具\\room.mjs' : '/工具/room.mjs' });
  assert.match(cn, /chcp 65001 >nul\r\n/);
});

// ---------------------------------------------------------------- seat commands (fake service)

test('wait: NO_SERVICE, TURN, TURN_OVER, NOT_YOUR_TURN, --once, ROOM_CLOSED, LEFT, NEEDS_RECONCILE', async () => {
  const fake = makeRoom();
  let r = await seat(fake, 'wait', { timeout: '0' });
  assert.equal(r.code, EXIT.PENDING);
  assert.match(r.first, /^NO_SERVICE/);
  assert.ok(fs.existsSync(path.join(fake.seat('B').outbox, 'joined.json')), 'joined.json written in the outbox');

  fake.setEvents([]);
  fake.setState(baseState({ currentSeat: 'A', attempt: attemptFor('A', 'a1') }));
  r = await seat(fake, 'wait', { timeout: '0.2' });
  assert.equal(r.code, 0);
  assert.match(r.first, /^NOT_YOUR_TURN phase=meet current=A/);
  r = await seat(fake, 'wait', { once: true });
  assert.match(r.first, /^TURN_OVER/);
  assert.equal(r.code, 0);
  r = await seat(fake, 'wait', { seatId: 'A' });
  assert.match(r.first, /^TURN attempt=a1 nonce=abcd1234 packet=.*\/packets\/r1-A-a1\.md sha256=f{64}$/);
  assert.match(r.out, /DECLARATION:/);
  assert.ok(Buffer.byteLength(r.out) < 8192);
  assert.equal(readJson(path.join(fake.seat('A').outbox, 'last-attempt.json')).attemptId, 'a1');
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1') }));
  r = await seat(fake, 'wait', { seatId: 'A' });
  assert.match(r.first, /^TURN_OVER/, 'turn_over seat returns immediately');

  fake.setEvents([{ type: 'needs_reconcile', attemptId: 'b1', seatId: 'B' }]);
  r = await seat(fake, 'wait', {});
  assert.equal(r.code, 0);
  assert.match(r.first, /^NEEDS_RECONCILE attempt=b1/);
  fake.setEvents([{ type: 'needs_reconcile', attemptId: 'b1', seatId: 'B' }, { type: 'reconciled', attemptId: 'b1', action: 'replay' }]);
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^TURN attempt=b1/);
  // state.attempts is keyed by seatId (reducer shape): the attempt id comes from the record.
  fake.setEvents([{ type: 'needs_reconcile', attemptId: 'b1', seatId: 'B' }]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1'), attempts: { B: { attemptId: 'b1', seatId: 'B', status: 'needs_reconcile' } }, attemptLog: { b1: { attemptId: 'b1', seatId: 'B', status: 'needs_reconcile' } } }));
  r = await seat(fake, 'wait', {});
  assert.equal(r.first.split(' ')[1], 'attempt=b1', 'no seat id leaks into the attempt list');
  fake.setEvents([]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1') }));

  fake.setEvents([{ type: 'seat_left', seatId: 'B' }]);
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^LEFT/);
  assert.equal(r.code, 0);
  fake.setEvents([{ type: 'room_closed' }]);
  fake.setState(baseState({ closed: true, phase: 'closed' }));
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^ROOM_CLOSED/);
  assert.equal(r.code, 0);
  assert.ok(!/FAREWELL/.test(r.out), 'no farewell line without a farewell_issued event');
  // The farewell packet issued for this seat is pointed at; another seat's is not.
  fake.setEvents([
    { type: 'farewell_issued', packetId: 'farewell-x-A-1', seats: ['A'], path: '/r/packets/farewell-x-A-1.md', sha256: 'a'.repeat(64) },
    { type: 'farewell_issued', packetId: 'farewell-x-B-2', seats: ['B'], path: '/r/packets/farewell-x-B-2.md', sha256: 'b'.repeat(64) },
    { type: 'room_closed' },
  ]);
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^ROOM_CLOSED/);
  assert.match(r.out.split('\n')[1], /^FAREWELL packet=.*farewell-x-B-2\.md sha256=b{64} /);
  assert.equal(r.code, 0);
});

test('wait: a voided attempt with a fresh one -> TURN on line 1, the void note after it, once (CF-1)', async () => {
  const fake = makeRoom();
  fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b1' }]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1') }));
  let r = await seat(fake, 'wait', {});
  assert.match(r.first, /^TURN attempt=b1/);
  fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b1' }, { type: 'attempt_canceled', seatId: 'B', attemptId: 'b1', by: 'admin' }, { type: 'packet_issued', seatId: 'B', attemptId: 'b2' }]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b2') }));
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^TURN attempt=b2/, 'the first-line result is the new turn');
  const lines = r.out.split('\n');
  const note = lines.findIndex((l) => /NOTICE attempt=b1 status=canceled by=admin/.test(l));
  assert.ok(note > 0, `the voided attempt is reported after TURN: ${r.out}`);
  assert.match(lines[note], /^注意：/, 'the note carries no leading status word');
  assert.equal(readJson(path.join(fake.seat('B').outbox, 'last-attempt.json')).attemptId, 'b2', 'the new attempt is remembered');
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^TURN attempt=b2/);
  assert.ok(!/NOTICE/.test(r.out), 'notice is printed once');
});

test('wait: a voided attempt and no new turn -> NOTICE leads in place of TURN_OVER / NOT_YOUR_TURN', async () => {
  const fake = makeRoom();
  // A is a turn_over seat (codex-desktop): TURN_OVER path.
  fake.setEvents([{ type: 'packet_issued', seatId: 'A', attemptId: 'a1' }]);
  fake.setState(baseState({ currentSeat: 'A', attempt: attemptFor('A', 'a1') }));
  let r = await seat(fake, 'wait', { seatId: 'A' });
  assert.match(r.first, /^TURN attempt=a1/);
  fake.setEvents([{ type: 'packet_issued', seatId: 'A', attemptId: 'a1' }, { type: 'attempt_expired', seatId: 'A', attemptId: 'a1' }]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1') }));
  r = await seat(fake, 'wait', { seatId: 'A' });
  assert.equal(r.code, EXIT.TURN_OVER);
  assert.match(r.first, /^NOTICE attempt=a1 status=expired .*现在不是你的回合（phase=meet current=B）/);
  assert.equal(r.out.split('\n').length, 1, 'one line, no second status word');
  r = await seat(fake, 'wait', { seatId: 'A' });
  assert.match(r.first, /^TURN_OVER/, 'notice is printed once');
  // B is a background seat: NOT_YOUR_TURN path after the timeout.
  fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b1' }]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1') }));
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^TURN attempt=b1/);
  fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b1' }, { type: 'attempt_canceled', seatId: 'B', attemptId: 'b1', by: 'admin' }]);
  fake.setState(baseState({ currentSeat: 'A', attempt: attemptFor('A', 'a2') }));
  r = await seat(fake, 'wait', { timeout: '0.2' });
  assert.equal(r.code, EXIT.NOT_YOUR_TURN);
  assert.match(r.first, /^NOTICE attempt=b1 status=canceled by=admin .*phase=meet current=A waited=/);
  // ROOM_CLOSED keeps line 1 (and FAREWELL line 2); the note follows.
  fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b3' }]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b3') }));
  await seat(fake, 'wait', {});
  fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b3' }, { type: 'attempt_canceled', seatId: 'B', attemptId: 'b3', by: 'close' }, { type: 'farewell_issued', packetId: 'fw-B', seats: ['B'], path: '/r/packets/fw-B.md', sha256: 'b'.repeat(64) }, { type: 'room_closed' }]);
  fake.setState(baseState({ closed: true, phase: 'closed' }));
  r = await seat(fake, 'wait', {});
  assert.match(r.first, /^ROOM_CLOSED/);
  assert.match(r.out.split('\n')[1], /^FAREWELL /);
  assert.match(r.out.split('\n')[2], /^注意：NOTICE attempt=b3 status=canceled/);
});

test('submit off-turn or late: written to the outbox for the room to reject and record; the room\'s reason is printed (CF-2)', async () => {
  const fake = makeRoom();
  const g = testGuard(fake.root);
  const speech = path.join(fake.root, 'cwd-B', 'speech-x.md');
  g.writeFile(speech, '抢答');
  const outbox = fake.seat('B').outbox;
  const subs = () => (fs.existsSync(outbox) ? fs.readdirSync(outbox).filter((n) => /-s[0-9a-f]{6}\.json$/.test(n)) : []);
  fake.setEvents([]);
  fake.setState(baseState({ currentSeat: 'A', attempt: attemptFor('A', 'a1') }));
  // No service answering: the submission is still written (the room will reject and log it), PENDING + a hint.
  let r = await seat(fake, 'submit', { attempt: 'a1', file: speech, 'reply-timeout': '0.2' });
  assert.equal(r.code, EXIT.PENDING);
  assert.match(r.first, /^PENDING attempt=a1 submission=a1-s[0-9a-f]{6}/);
  assert.match(r.out, /提示：按房间当前状态，attempt=a1 不是你持有的回合（current=A\/a1）/);
  assert.equal(subs().length, 1, 'the off-turn submission reached the outbox');
  // The service answers: the printed reason is the room's (NOT_YOUR_TURN, or STALE_ATTEMPT for a voided attempt).
  const reasons = { a1: 'NOT_YOUR_TURN', b0: 'STALE_ATTEMPT' };
  const svc = autoReply(fake, 'B', (meta) => ({ status: 'REJECTED', reason: reasons[meta.attemptId] }));
  try {
    r = await seat(fake, 'submit', { attempt: 'a1', file: speech });
    assert.equal(r.code, EXIT.REJECTED);
    assert.equal(r.first, 'REJECTED reason=NOT_YOUR_TURN attempt=a1');
    fake.setEvents([{ type: 'packet_issued', seatId: 'B', attemptId: 'b0' }, { type: 'attempt_canceled', seatId: 'B', attemptId: 'b0', by: 'admin' }]);
    r = await seat(fake, 'submit', { attempt: 'b0', file: speech });
    assert.equal(r.code, EXIT.REJECTED);
    assert.equal(r.first, 'REJECTED reason=STALE_ATTEMPT attempt=b0', 'a late submission for a voided attempt carries the room\'s reason');
  } finally { svc.stop(); }
  assert.deepEqual(subs().map((n) => readJson(path.join(outbox, n)).attemptId).sort(), ['a1', 'a1', 'b0']);
});

test('submit: ACCEPTED, ACCEPTED MALFORMED, service REJECTED, PENDING; writes only the outbox', async () => {
  const fake = makeRoom();
  const g = testGuard(fake.root);
  const speech = path.join(fake.root, 'cwd-B', 'speech-b1.md');
  g.writeFile(speech, '我做完了。<<ROOM:PASS>>');
  fake.setEvents([]);
  fake.setState(baseState({ currentSeat: 'B', attempt: attemptFor('B', 'b1') }));
  let r;
  let mode = 'accept';
  const token = fs.readFileSync(path.join(fake.seatDir('B'), 'token'), 'utf8').trim();
  const svc = autoReply(fake, 'B', (meta) => {
    const body = fs.readFileSync(path.join(fake.seat('B').outbox, meta.bodyFile));
    assert.ok(verifySubmissionProof(meta, token, body), 'proof verifies with the seat token');
    if (mode === 'accept') return { status: 'ACCEPTED', seq: 3 };
    if (mode === 'malformed') return { status: 'ACCEPTED', kind: 'speech', seq: 4, malformed: 'verdict_missing', reasons: [{ code: 'verdict_missing' }], followUp: true };
    if (mode === 'reject') return { status: 'REJECTED', reason: 'STALE_ATTEMPT' };
    return null;
  });
  try {
    r = await seat(fake, 'submit', { attempt: 'b1', file: speech });
    assert.equal(r.code, 0);
    assert.equal(r.first, 'ACCEPTED attempt=b1 seq=3');
    mode = 'malformed';
    r = await seat(fake, 'submit', { attempt: 'b1', file: speech });
    assert.equal(r.code, 0);
    assert.equal(r.first, 'ACCEPTED MALFORMED verdict_missing attempt=b1 seq=4');
    assert.match(r.out, /下一个包里追问一次/);
    mode = 'reject';
    r = await seat(fake, 'submit', { attempt: 'b1', file: speech });
    assert.equal(r.code, EXIT.REJECTED);
    assert.equal(r.first, 'REJECTED reason=STALE_ATTEMPT attempt=b1');
    mode = 'silent';
    r = await seat(fake, 'submit', { attempt: 'b1', file: speech, 'reply-timeout': '0.3' });
    assert.equal(r.code, EXIT.PENDING);
    assert.match(r.first, /^PENDING attempt=b1 submission=b1-s[0-9a-f]{6}/);
  } finally { svc.stop(); }
  const outbox = fake.seat('B').outbox;
  const metas = fs.readdirSync(outbox).filter((n) => /^b1-s[0-9a-f]{6}\.json$/.test(n)).map((n) => readJson(path.join(outbox, n)));
  assert.equal(metas.length, 4, 'one fresh submission id per submit');
  for (const m of metas) { assert.equal(m.kind, 'speech'); assert.ok(fs.existsSync(path.join(outbox, m.bodyFile))); }
  for (const row of readJsonl(path.join(outbox, 'write-log.jsonl'))) {
    assert.equal(row.who, 'seat:B');
    assert.ok(isInside(row.path, outbox), row.path);
  }
  r = await seat(fake, 'submit', { attempt: 'b1' });
  assert.equal(r.code, 9);
  fake.setEvents([{ type: 'needs_reconcile', attemptId: 'b1', seatId: 'B' }]);
  const n = fs.readdirSync(outbox).length;
  r = await seat(fake, 'submit', { attempt: 'b1', file: speech });
  assert.match(r.first, /^NEEDS_RECONCILE/);
  assert.equal(r.code, 0);
  assert.equal(fs.readdirSync(outbox).length, n, 'nothing written while reconcile is pending');
});

test('structured commands: point, quote, misquoted, mark, verdict, disclose, pass, assign, artifacts', async () => {
  const fake = makeRoom({ seats: [{ seat: 'A', role: 'lead', agent: 'codex-desktop', reviews: 'B' }, { seat: 'B', role: 'executor', agent: 'claude-code' }] });
  const g = testGuard(fake.root);
  const cwdB = path.join(fake.root, 'cwd-B');
  g.mkdir(path.join(cwdB, 'src'));
  g.writeFile(path.join(cwdB, 'src', 'app.mjs'), 'export const x = 1;\n');
  g.writeFile(path.join(cwdB, 'src', 'debug.log'), 'noise');
  g.writeFile(path.join(cwdB, 'README.md'), '# demo\n');
  const draft = path.join(fake.root, 'cwd-A', 'draft.md');
  g.writeFile(draft, '- B: 实现 | 验收: ["node","--test"]\n');
  fake.setEvents([]);
  fake.setState(baseState({ attempts: [attemptFor('A', 'a1'), attemptFor('B', 'b1')] }));
  const got = [];
  const held = { A: 'a1', B: 'b1' };
  const reply = (meta) => {
    // The room, not the seat command, refuses a submission for an attempt the seat does not hold.
    if (meta.attemptId !== 'none' && held[meta.seatId] !== meta.attemptId) return { status: 'REJECTED', reason: 'NOT_YOUR_TURN' };
    got.push(meta);
    switch (meta.kind) {
      case 'point': return { status: 'ACCEPTED', itemId: `m${meta.payload.seq}p1` };
      case 'quote': return { status: 'ACCEPTED', verified: meta.payload.text === '原文' };
      case 'disclose': return { status: 'REQUESTED', id: 'dsc-1' };
      case 'artifacts': return { status: 'FROZEN', manifestSha: meta.payload.manifest.sha256, fileCount: meta.payload.manifest.fileCount };
      case 'assign': return { status: 'DRAFTED', assignments: [{ seatId: 'B' }] };
      case 'verdict': return meta.payload.verdict === 'disclose' ? { status: 'ACCEPTED', annotation: 'malformed', reason: 'disclose_missing' } : { status: 'ACCEPTED' };
      default: return { status: 'ACCEPTED' };
    }
  };
  const svcA = autoReply(fake, 'A', reply);
  const svcB = autoReply(fake, 'B', reply);
  try {
    let r = await seat(fake, 'point', { seatId: 'A', attempt: 'a1', seq: '2', text: '缺测试' });
    assert.equal(r.first, 'ACCEPTED item=m2p1');
    r = await seat(fake, 'quote', { seatId: 'A', attempt: 'a1', seq: '2', text: '原文' });
    assert.equal(r.first, 'ACCEPTED verified=true');
    r = await seat(fake, 'quote', { seatId: 'A', attempt: 'a1', seq: '2', text: '编的' });
    assert.equal(r.first, 'ACCEPTED verified=false');
    r = await seat(fake, 'misquoted', { seatId: 'A', attempt: 'a1', seq: '3', text: '我没这么说' });
    assert.match(r.first, /^ACCEPTED kind=misquoted seq=3/);
    r = await seat(fake, 'mark', { seatId: 'A', attempt: 'a1', item: 'm2p1', status: 'accepted', text: '已改' });
    assert.match(r.first, /^ACCEPTED kind=mark item=m2p1 status=accepted/);
    r = await seat(fake, 'disclose', { seatId: 'A', attempt: 'a1', argv: '["git","diff"]', reason: '看改动' });
    assert.equal(r.first, 'REQUESTED id=dsc-1');
    // W3: the quote-free documented form, a JSON file, and argv exactly as PowerShell 5.1 / cmd.exe deliver JSON.
    const rawArg = ['disclose', '--seat', fake.seatDir('A'), '--attempt', 'a1', '--arg', 'git', '--arg', 'diff', '--arg=--stat', '--reason', 'r'];
    r = await seat(fake, 'disclose', { ...parseArgs(rawArg.slice(1)), __argv: rawArg.slice(1), seatId: 'A' });
    assert.equal(r.first, 'REQUESTED id=dsc-1', r.out);
    const argvFile = path.join(fake.root, 'cwd-A', 'argv.json');
    g.writeFile(argvFile, '﻿["git","status"]');
    r = await seat(fake, 'disclose', { seatId: 'A', attempt: 'a1', 'argv-file': argvFile, reason: 'r' });
    assert.equal(r.first, 'REQUESTED id=dsc-1', r.out);
    r = await seat(fake, 'disclose', { seatId: 'A', attempt: 'a1', argv: '[git,diff]', reason: 'r' });
    assert.equal(r.first, 'REQUESTED id=dsc-1', r.out);
    r = await seat(fake, 'disclose', { seatId: 'A', attempt: 'a1', argv: "'[git,diff]'", reason: 'r' });
    assert.equal(r.first, 'REQUESTED id=dsc-1', r.out);
    r = await seat(fake, 'verdict', { seatId: 'A', attempt: 'a1', _: ['pass'], artifact: 'c'.repeat(64), text: '好' });
    assert.match(r.first, /^ACCEPTED kind=verdict verdict=pass/);
    r = await seat(fake, 'verdict', { seatId: 'A', attempt: 'a1', _: ['disclose'], artifact: 'c'.repeat(64) });
    assert.match(r.first, /^ACCEPTED MALFORMED disclose_missing kind=verdict verdict=disclose/);
    r = await seat(fake, 'assign', { seatId: 'A', attempt: 'a1', file: draft });
    assert.equal(r.first, 'DRAFTED assignments=1');
    r = await seat(fake, 'pass', { seatId: 'A', attempt: 'a1' });
    assert.equal(r.first, 'ACCEPTED kind=pass');
    const raw = ['--declare', 'src', 'README.md', '--exclude', '*.log', '--baseline', 'whole'];
    r = await seat(fake, 'artifacts', { ...parseArgs(raw), __argv: raw, attempt: 'b1' });
    assert.match(r.first, /^FROZEN manifest=[0-9a-f]{64} files=2$/, r.out);
    // A pre-turn declaration (no --attempt) is sent with attemptId 'none' and needs no turn.
    fake.setState(baseState({ attempts: [attemptFor('A', 'a1')] }));
    r = await seat(fake, 'artifacts', { seatId: 'B', declare: 'README.md', baseline: 'whole' });
    assert.match(r.first, /^FROZEN manifest=[0-9a-f]{64} files=1$/, r.out);
    fake.setState(baseState({ attempts: [attemptFor('A', 'a1'), attemptFor('B', 'b1')] }));
    // usage errors exit 9 and write nothing
    for (const [cmd, a] of [
      ['verdict', { seatId: 'A', attempt: 'a1', _: ['maybe'], artifact: 'x' }],
      ['verdict', { seatId: 'A', attempt: 'a1', _: ['pass'] }],
      ['disclose', { seatId: 'A', attempt: 'a1', argv: 'git diff', reason: 'r' }],
      ['disclose', { seatId: 'A', attempt: 'a1', argv: '["git"]' }],
      ['disclose', { seatId: 'A', attempt: 'a1', reason: 'r' }],
      ['disclose', { seatId: 'A', attempt: 'a1', 'argv-file': path.join(fake.root, 'missing.json'), reason: 'r' }],
      ['disclose', { seatId: 'A', attempt: 'a1', argv: '[,]', reason: 'r' }],
      ['mark', { seatId: 'A', attempt: 'a1', item: 'm1', status: 'ok' }],
      ['point', { seatId: 'A', attempt: 'a1', text: 'x' }],
      ['point', { seatId: 'A', attempt: 'a1', seq: '-1', text: 'x' }],
      ['quote', { seatId: 'A', attempt: 'a1', seq: '1' }],
      ['artifacts', { seatId: 'B', attempt: 'b1' }],
      ['artifacts', { seatId: 'B', attempt: 'b1', declare: 'src', baseline: 'd'.repeat(64) }],
      ['artifacts', { seatId: 'B', attempt: 'b1', declare: 'missing-dir' }],
      ['pass', { seatId: 'A' }],
    ]) {
      const e = await seat(fake, cmd, a);
      assert.equal(e.code, 9, `${cmd} ${JSON.stringify(a)} -> ${e.out}`);
    }
    // not this seat's attempt: the room rejects it
    r = await seat(fake, 'pass', { seatId: 'A', attempt: 'b1' });
    assert.equal(r.code, EXIT.REJECTED);
    assert.equal(r.first, 'REJECTED reason=NOT_YOUR_TURN attempt=b1');
  } finally { svcA.stop(); svcB.stop(); }
  const byKind = {};
  for (const m of got) if (!byKind[m.kind]) byKind[m.kind] = m;
  assert.deepEqual(got.filter((m) => m.kind === 'disclose').map((m) => m.payload.argv), [['git', 'diff'], ['git', 'diff', '--stat'], ['git', 'status'], ['git', 'diff'], ['git', 'diff']]);
  const preTurn = got.filter((m) => m.kind === 'artifacts' && m.attemptId === 'none');
  assert.equal(preTurn.length, 1);
  assert.deepEqual(preTurn[0].payload.paths, ['README.md']);
  assert.ok(verifySubmissionProof(preTurn[0], fs.readFileSync(path.join(fake.seatDir('B'), 'token'), 'utf8').trim()), "proof binds attemptId 'none'");
  assert.deepEqual(byKind.point.payload, { seq: 2, text: '缺测试' });
  assert.deepEqual(byKind.mark.payload, { item: 'm2p1', status: 'accepted', text: '已改' });
  assert.deepEqual(byKind.disclose.payload, { argv: ['git', 'diff'], reason: '看改动' });
  assert.deepEqual(byKind.pass.payload, {});
  assert.match(byKind.assign.payload.draft, /验收/);
  const art = byKind.artifacts.payload;
  assert.deepEqual(art.paths, ['src', 'README.md']);
  assert.deepEqual(art.exclude, ['*.log']);
  assert.equal(art.baseline, 'whole');
  assert.deepEqual(art.manifest.files.map((x) => x.path), ['README.md', 'src/app.mjs']);
  assert.equal(art.manifest.seatId, 'B');
  for (const m of got) {
    assert.equal(typeof m.payloadSha256, 'string');
    assert.equal(m.payloadSha256, sha256(JSON.stringify(m.payload)));
  }
  // artifacts --baseline <sha> reads the frozen manifest from the room
  const svc = createGuard({ allowed: [fake.roomDir], logPath: path.join(fake.roomDir, 'fake-service-log.jsonl'), who: 'fake-service' });
  svc.mkdir(path.join(fake.roomDir, 'artifacts', 'B'));
  svc.writeFile(path.join(fake.roomDir, 'artifacts', 'B', `${art.manifest.sha256}.json`), JSON.stringify(art.manifest));
  g.writeFile(path.join(cwdB, 'src', 'new.mjs'), 'x');
  const svcB2 = autoReply(fake, 'B', reply);
  try {
    const r = await seat(fake, 'artifacts', { seatId: 'B', attempt: 'b1', declare: 'src', baseline: art.manifest.sha256 });
    assert.match(r.first, /^FROZEN manifest=[0-9a-f]{64} files=3/, r.out);
  } finally { svcB2.stop(); }
  const second = got.filter((m) => m.kind === 'artifacts' && m.payload.baseline === art.manifest.sha256);
  assert.equal(second.length, 1);
  const last = second[0].payload.manifest;
  assert.equal(last.baseline, art.manifest.sha256);
  assert.equal(last.summary.added, 2);
  for (const id of ['A', 'B']) {
    const outbox = fake.seat(id).outbox;
    for (const row of readJsonl(path.join(outbox, 'write-log.jsonl'))) assert.ok(isInside(row.path, outbox), row.path);
  }
});

test('status: STATUS line, --whoami shows the registered audit source, --log shows the public stream', async () => {
  const fake = makeRoom({ seats: [{ seat: 'A', role: 'reviewer', agent: 'codex-desktop', audit: 'codex', 'thread-id': '01a0f000-0000-7000-8000-000000000123' }, { seat: 'B', role: 'executor', agent: 'claude-code' }] });
  let r = await seat(fake, 'status', { seatId: 'A', whoami: true });
  assert.equal(r.code, EXIT.PENDING);
  assert.match(r.first, /^NO_SERVICE/);
  assert.match(r.out, /WHOAMI seat=A role=reviewer agent=codex-desktop audit=codex thread=01a0f000-0000-7000-8000-000000000123 session=-/);
  fake.setEvents([{ type: 'needs_reconcile', attemptId: 'a0', seatId: 'A' }]);
  fake.setState(baseState({ currentSeat: 'A', attempt: attemptFor('A', 'a1'), task: { text: '任务 文本' }, messages: [{ seq: 2, seatId: 'B', text: '第一条\n发言' }] }));
  r = await seat(fake, 'status', { seatId: 'A', whoami: true, log: true });
  assert.equal(r.code, 0);
  assert.match(r.first, /^STATUS phase=meet round=1 epoch=0 current=A attempt=a1 me=A my_attempt=a1 my_status=not_joined wait_mode=turn_over order=A,B turn=1\/2 needs_reconcile=a0/);
  assert.match(r.out, /WHOAMI seat=A .*audit=codex thread=01a0f000-0000-7000-8000-000000000123/);
  assert.match(r.out, /\[user seq=1\] 任务 文本/);
  assert.match(r.out, /\[B seq=2 authority=none\] 第一条 发言/);
  r = await seat(fake, 'status', { seatId: 'B', whoami: true });
  assert.match(r.out, /WHOAMI seat=B .*audit=none/);
  assert.match(r.out, /没有登记审计源/);
  assert.equal(whoamiLine({ seatId: 'Z' }, { kind: 'claude', sessionId: 's1', cwd: '/x' }).includes('session=s1'), true);
});

test('leave writes leave.json in the outbox and prints LEFT', async () => {
  const fake = makeRoom();
  const r = await seat(fake, 'leave', {});
  assert.equal(r.code, 0);
  assert.match(r.first, /^LEFT seat=B/);
  assert.equal(readJson(path.join(fake.seat('B').outbox, 'leave.json')).seatId, 'B');
});

// ---------------------------------------------------------------- CLI (room.mjs) through lib/spawn.mjs

test('CLI: exit codes, admin dispatch, and the seat process clears its inherited environment', async () => {
  const fake = makeRoom();
  const g = testGuard(fake.root);
  const probe = path.join(fake.root, 'probe.mjs');
  g.writeFile(probe, "process.on('exit', () => { process.stderr.write('ENVKEYS ' + JSON.stringify(Object.keys(process.env)) + '\\n'); });\n");
  const env = { ROOM_CANARY_SECRET: 'canary-value-1', OPENAI_API_KEY: 'canary-value-2', NODE_OPTIONS: `--import=${new URL(`file:///${probe.replace(/\\/g, '/').replace(/^\//, '')}`).href}`, ROOM_DEV_HOME: path.join(fake.root, 'home') };
  let r = await spawnClean(process.execPath, [ROOM_MJS, 'status', '--seat', fake.seatDir('B')], { env, timeoutMs: 30000 });
  assert.equal(r.code, 8, r.stdout + r.stderr);
  assert.match(r.stdout, /^NO_SERVICE/);
  const m = /ENVKEYS (\[.*\])/.exec(r.stderr);
  assert.ok(m, `probe ran: ${r.stderr}`);
  const keys = JSON.parse(m[1]).map((k) => k.toUpperCase());
  assert.ok(!keys.includes('ROOM_CANARY_SECRET') && !keys.includes('OPENAI_API_KEY') && !keys.includes('NODE_OPTIONS'), keys.join(','));
  assert.ok(keys.every((k) => SEAT_ENV_KEEP.map((x) => x.toUpperCase()).includes(k)), keys.join(','));
  assert.ok(!r.stdout.includes('canary-value') && !r.stderr.includes('canary-value'));

  fake.setEvents([]);
  fake.setState(baseState({ currentSeat: 'A', attempt: attemptFor('A', 'a1') }));
  r = await spawnClean(process.execPath, [ROOM_MJS, 'wait', '--seat', fake.seatDir('B'), '--timeout', '0.2'], { timeoutMs: 30000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^NOT_YOUR_TURN/);
  // Off-turn submit: written for the room to reject and record; with no service it ends PENDING (8).
  r = await spawnClean(process.execPath, [ROOM_MJS, 'submit', '--seat', fake.seatDir('B'), '--attempt', 'a1', '--file', probe, '--reply-timeout', '0.3'], { timeoutMs: 30000 });
  assert.equal(r.code, 8, r.stdout + r.stderr);
  assert.match(r.stdout, /^PENDING attempt=a1 /);
  assert.match(r.stdout, /不是你持有的回合/);
  r = await spawnClean(process.execPath, [ROOM_MJS, 'verdict', 'maybe', '--seat', fake.seatDir('B'), '--attempt', 'a1'], { timeoutMs: 30000 });
  assert.equal(r.code, 9);
  assert.match(r.stderr, /^ERROR verdict needs one of pass\|reject\|disclose/);
  r = await spawnClean(process.execPath, [ROOM_MJS, 'admin', 'accept-stale', 'e'.repeat(64), '--dir', fake.roomDir], { timeoutMs: 30000 });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^QUEUED accept-stale/);
  r = await spawnClean(process.execPath, [ROOM_MJS, 'admin', 'nope', '--dir', fake.roomDir], { timeoutMs: 30000 });
  assert.equal(r.code, 9);
  r = await spawnClean(process.execPath, [ROOM_MJS, 'admin', 'show', '--dir', fake.roomDir], { env: { ROOM_DEV_HOME: path.join(fake.root, 'home') }, timeoutMs: 30000 });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^phase=meet/);
  assert.match(r.stdout, /reject_rate agent=codex-desktop .*status=insufficient/);
});

test('disclose through real Windows shells: the documented quote-free form via cmd.exe + room.cmd and PowerShell 5.1 (W3)', { skip: !WIN && 'Windows shells only' }, async () => {
  const fake = makeRoom();
  fake.setEvents([]);
  fake.setState(baseState({ attempts: [attemptFor('A', 'a1')] }));
  const got = [];
  const svc = autoReply(fake, 'A', (meta) => { got.push(meta.payload.argv); return { status: 'REQUESTED', id: `dsc-${got.length}` }; });
  const sd = fake.seatDir('A');
  const mjs = ROOM_MJS.replace(/\\/g, '/');
  try {
    // cmd.exe, through the seat's room.cmd (the JOIN.md cmd.exe line), the documented form.
    const roomCmd = path.join(sd, 'room.cmd');
    let r = await spawnClean('cmd.exe', ['/d', '/s', '/c', `${roomCmd} disclose --seat ${sd} --attempt a1 --arg git --arg diff --reason why`], { timeoutMs: 60000 });
    assert.equal(r.code, 0, `cmd.exe: ${r.stdout}${r.stderr}${r.spawnError || ''}`);
    assert.match(r.stdout, /^REQUESTED id=dsc-1/);
    // Windows PowerShell 5.1 (what Codex on Windows runs commands through), the documented form.
    r = await spawnClean('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& node ${mjs} disclose --seat ${sd.replace(/\\/g, '/')} --attempt a1 --arg git --arg diff --reason why; exit $LASTEXITCODE`], { timeoutMs: 60000 });
    assert.equal(r.code, 0, `powershell: ${r.stdout}${r.stderr}${r.spawnError || ''}`);
    assert.match(r.stdout, /^REQUESTED id=dsc-2/);
    // The old JSON example typed into PowerShell 5.1 arrives as [git,diff]; it is accepted now too.
    r = await spawnClean('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& node ${mjs} disclose --seat ${sd.replace(/\\/g, '/')} --attempt a1 --argv '["git","diff"]' --reason why; exit $LASTEXITCODE`], { timeoutMs: 60000 });
    assert.equal(r.code, 0, `powershell json: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^REQUESTED id=dsc-3/);
  } finally { svc.stop(); }
  assert.deepEqual(got, [['git', 'diff'], ['git', 'diff'], ['git', 'diff']]);
});
