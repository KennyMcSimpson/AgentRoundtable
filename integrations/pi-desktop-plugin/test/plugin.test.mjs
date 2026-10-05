// The PI-Desktop plugin, driven through a fake host that mirrors the upstream plugin SDK
// (fake-pi-host.mjs cites the upstream lines) and running the REAL vendored room-dev service in
// this process: build the plugin folder from the working tree, load main.js the way the host does,
// start the resident service, and call the Room tool / panel channels as PI-Desktop would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildPlugin, REPO_ROOT } from '../build.mjs';
import { startFakeHost } from './fake-pi-host.mjs';

// Rooms go under a throw-away ROOM_DEV_HOME inside room-dev's test-runs root (never AppData).
const RUN_ROOT = path.join(process.env.ROOM_DEV_HOME || path.join(os.homedir(), 'room-dev'), 'test-runs');
const base = path.join(RUN_ROOT, `pi-plugin-${crypto.randomBytes(4).toString('hex')}`);
const savedHome = process.env.ROOM_DEV_HOME;
process.env.ROOM_DEV_HOME = path.join(base, 'home');
const ROOMS = path.join(base, 'home', 'rooms');
const ID = 'io.github.kennymcsimpson.governed-roundtable';
let pluginDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(80); } }
function seatDir(name) { const d = path.join(base, 'seats', name); fs.mkdirSync(d, { recursive: true }); return d; }
function events(room) {
  const p = path.join(ROOMS, room, 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}
function lockPath(room) { return path.join(ROOMS, room, 'service.lock'); }
// An external agent runs the seat command from its JOIN.md in its own process (async, so the room
// service in this process keeps ticking).
function runSeatCommand(prefix, args) {
  const m = /^node (\S+)$/.exec(prefix);
  assert.ok(m, `JOIN.md command prefix is node <room.mjs>: ${prefix}`);
  return new Promise((resolve) => {
    execFile(process.execPath, [m[1].replace(/^"|"$/g, ''), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

let host;
const completeReplies = [];
before(async () => {
  fs.mkdirSync(base, { recursive: true });
  const built = await buildPlugin({ out: path.join(base, 'build', ID), source: 'worktree' });
  pluginDir = built.out;
  host = await startFakeHost({
    pluginDir,
    dataDir: path.join(base, 'plugin-data'),
    complete: async (input) => {
      const next = completeReplies.shift();
      if (next instanceof Error) throw next;
      return { text: next || '托管席位的发言：同意，补充一点。', modelKey: input.modelKey, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    },
  });
});
after(async () => {
  if (host) await host.unload();
  if (savedHome === undefined) delete process.env.ROOM_DEV_HOME; else process.env.ROOM_DEV_HOME = savedHome;
  await fs.promises.rm(base, { recursive: true, force: true });
});

const S1 = 'session-pi-one';
const S2 = 'session-pi-two';
const S3 = 'session-pi-three';

test('build --source head copies the committed bytes and records the HEAD commit', async (t) => {
  const git = (args) => new Promise((resolve) => execFile('git', ['-C', REPO_ROOT, ...args], { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? null : out)));
  const head = await git(['rev-parse', 'HEAD']);
  if (!head) { t.skip('not a git checkout'); return; }
  const committed = await git(['ls-tree', '--name-only', 'HEAD', '--', 'integrations/pi-desktop-plugin/plugin/manifest.json']);
  if (!committed || !committed.length) { t.skip('the plugin is not committed yet'); return; }
  const r = await buildPlugin({ out: path.join(base, 'build-head', ID), source: 'head' });
  const vend = JSON.parse(fs.readFileSync(path.join(r.out, 'room-dev', 'VENDORED.json'), 'utf8'));
  assert.equal(vend.roomDevCommit, head.toString('utf8').trim());
  assert.equal(vend.source, 'head');
  for (const [rel, src] of [['room-dev/lib/api.mjs', 'lib/api.mjs'], ['core.mjs', 'integrations/pi-desktop-plugin/plugin/core.mjs']]) {
    const blob = await git(['cat-file', 'blob', `HEAD:${src}`]);
    assert.ok(blob && Buffer.compare(blob, fs.readFileSync(path.join(r.out, ...rel.split('/')))) === 0, `${rel} is the committed blob`);
  }
});

test('loads like the host: tool, command and service registered with the manifest permissions only', async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, 'room-dev', 'room.mjs')), 'room-dev engine vendored');
  const vend = JSON.parse(fs.readFileSync(path.join(pluginDir, 'room-dev', 'VENDORED.json'), 'utf8'));
  assert.match(vend.roomDevCommit, /^[0-9a-f]{40}$/);
  assert.ok(!fs.existsSync(path.join(pluginDir, 'room-dev', 'ui', 'mock-server.mjs')));
  const tool = host.tools.get('Room');
  assert.ok(tool, 'Room tool registered');
  assert.equal(tool.descriptor.risk, 'high');
  assert.deepEqual(tool.descriptor.schema, host.manifest.contributes.agentTools[0].schema);
  for (const word of ['task', 'start', 'close', 'approve-disclose', 'deny-disclose', 'accept-stale', 'say', 'skip', 'retry']) {
    assert.ok(!tool.descriptor.schema.properties.action.enum.includes(word), `${word} is not a tool action`);
  }
  assert.ok(host.commands.has('roundtable.openPanel'));
  assert.equal(host.serviceStart.started.length, 1);
  assert.ok(host.serviceStart.started[0].ms < 5000, 'service start returns within the 5 s budget');
  await host.command('roundtable.openPanel');
  assert.equal(host.panelOpen, 1);
  const used = new Set(host.calls.map((c) => c.api));
  assert.ok(!used.has('desktop.invoke') && !used.has('desktop.listOperations'), 'no desktop control');
});

test('create a room from a PI conversation: rooms root, service lock, JOIN.md for the external seat, creator bound by ctx.sessionId', async () => {
  const r = await host.tool('Room', {
    action: 'create', room: 'r1', preset: 'discussion', joinAs: 'A',
    seats: [
      { seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('A') },
      { seat: 'B', role: 'participant', agent: 'pi', cwd: seatDir('B') },
      { seat: 'X', role: 'participant', agent: 'claude-code', cwd: seatDir('X') },
    ],
  }, { sessionId: S1 });
  assert.equal(r.status, 'CREATED', JSON.stringify(r));
  assert.equal(path.resolve(r.roomDir), path.resolve(ROOMS, 'r1'));
  assert.equal(r.joined, 'A');
  const x = r.seats.find((s) => s.seat === 'X');
  assert.ok(x.joinPath && fs.existsSync(x.joinPath), 'external seat has its JOIN.md');
  const lock = JSON.parse(fs.readFileSync(lockPath('r1'), 'utf8'));
  assert.equal(lock.pid, process.pid, 'the room service runs in the plugin process');
  const seatA = JSON.parse(fs.readFileSync(path.join(ROOMS, 'r1', 'seats', 'A', 'seat.json'), 'utf8'));
  assert.equal(seatA.agent, 'pi-user');
  assert.equal(seatA.waitMode, 'manual', 'PI seats wait manually: no upstream API wakes a conversation from a service');
  assert.equal(seatA.wake.enabled, false, 'no wake registered');
  const list = await host.tool('Room', { action: 'list' }, { sessionId: S1 });
  const room = list.rooms.find((x2) => x2.room === 'r1');
  assert.equal(room.served, 'here');
  assert.equal(room.seats.find((s) => s.seat === 'A').binding, 'you');
  assert.equal(room.seats.find((s) => s.seat === 'B').binding, 'free');
  assert.ok(!JSON.stringify(list).includes(S1), 'the listing does not echo session ids');
});

test('identity comes from ctx.sessionId only: forged or foreign identities are refused', async () => {
  const forged = await host.tool('Room', { action: 'wait', room: 'r1', sessionId: S1 }, { sessionId: S2 });
  assert.equal(forged.error, 'IDENTITY_FROM_CONTEXT_ONLY');
  const forgedSeat = await host.tool('Room', { action: 'create', room: 'r9', preset: 'discussion', seats: [{ seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('A'), sessionId: S2 }] }, { sessionId: S2 });
  assert.equal(forgedSeat.error, 'IDENTITY_FROM_CONTEXT_ONLY');
  assert.ok(!fs.existsSync(path.join(ROOMS, 'r9')), 'nothing created');
  const noCtx = await host.tool('Room', { action: 'list' }, { sessionId: '' });
  assert.equal(noCtx.error, 'NO_SESSION');
  const notJoined = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S2 });
  assert.equal(notJoined.error, 'NOT_JOINED');
  const takeA = await host.tool('Room', { action: 'join', room: 'r1', seat: 'A' }, { sessionId: S2 });
  assert.equal(takeA.error, 'SEAT_TAKEN');
  const takeX = await host.tool('Room', { action: 'join', room: 'r1', seat: 'X' }, { sessionId: S2 });
  assert.equal(takeX.error, 'NOT_A_PI_SEAT');
  const joinB = await host.tool('Room', { action: 'join', room: 'r1', seat: 'B' }, { sessionId: S2 });
  assert.equal(joinB.status, 'JOINED', JSON.stringify(joinB));
  const asA = await host.tool('Room', { action: 'status', room: 'r1', seat: 'A' }, { sessionId: S2 });
  assert.equal(asA.error, 'NOT_YOUR_SEAT');
  const second = await host.tool('Room', { action: 'join', room: 'r1', seat: 'A' }, { sessionId: S1 });
  assert.equal(second.status, 'JOINED', 'joining your own seat again is idempotent');
  const third = await host.tool('Room', { action: 'join', room: 'r1', seat: 'B' }, { sessionId: S3 });
  assert.equal(third.error, 'SEAT_TAKEN');
});

test('room administration is not reachable from the Room tool', async () => {
  for (const action of ['task', 'start', 'close', 'approve-disclose', 'deny-disclose', 'accept-stale', 'say', 'unbind', 'serve']) {
    const r = await host.tool('Room', { action, room: 'r1' }, { sessionId: S1 });
    assert.equal(r.error, 'ADMIN_ONLY_IN_PANEL', `${action}: ${JSON.stringify(r)}`);
  }
  const sneaky = await host.tool('Room', { action: 'status', room: 'r1', cmd: 'start' }, { sessionId: S1 });
  assert.equal(sneaky.error, 'UNKNOWN_FIELD');
  assert.ok(!events('r1').some((e) => e.type === 'task_set' || e.type === 'round_started' || e.type === 'room_closed'), 'no admin event came from the tool');
  const plan = await host.tool('Room', { action: 'list' }, { sessionId: S1, mode: 'plan' }).catch((e) => e);
  assert.equal(plan.code, 'PERMISSION_DENIED', 'upstream hides the tool in Plan mode (no planSafeActions reach the broker)');
});

test('a round: PI seats wait and submit through the tool, the external seat through its JOIN.md commands', async () => {
  // Before the user starts: not your turn, end the turn.
  const early = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S1 });
  assert.ok(['TURN_OVER', 'NOT_YOUR_TURN'].includes(early.status), JSON.stringify(early));
  assert.match(early.instruction, /End your turn now/);

  assert.equal((await host.panel('roundtable/admin', { room: 'r1', cmd: 'task', text: '讨论：给 parser 加 --strict 是否值得' })).ok, true);
  assert.equal((await host.panel('roundtable/admin', { room: 'r1', cmd: 'start', order: 'A,X,B' })).ok, true);

  const tA = await until(async () => { const r = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S1 }); return r.status === 'TURN' ? r : null; });
  assert.ok(tA, 'A gets its turn');
  assert.equal(tA.packetVerified, true);
  assert.match(tA.packet, /authority=user/);
  assert.match(tA.packet, /--strict/);
  assert.match(tA.instruction, /submit/);
  const offB = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S2 });
  assert.ok(['TURN_OVER', 'NOT_YOUR_TURN'].includes(offB.status), 'B is told to end its turn');
  assert.ok(await until(() => host.toasts.some((t) => /seat A's turn/.test(t.message))), 'the user is told whose turn it is');
  const offTurn = await host.tool('Room', { action: 'submit', room: 'r1', attempt: tA.attempt, text: '我是 B，想替 A 说话' }, { sessionId: S2 });
  assert.notEqual(offTurn.status, 'ACCEPTED', 'B cannot submit into A\'s attempt');
  const sA = await host.tool('Room', { action: 'submit', room: 'r1', attempt: tA.attempt, text: '开题：值得，理由是……' }, { sessionId: S1 });
  assert.equal(sA.status, 'ACCEPTED', JSON.stringify(sA));
  assert.match(sA.instruction, /end your turn now/);

  // X: the external agent, exactly as room-dev's JOIN.md tells it.
  const join = fs.readFileSync(path.join(ROOMS, 'r1', 'seats', 'X', 'JOIN.md'), 'utf8');
  const call = /^调用方式：(.+) <命令> --seat (\S+)$/m.exec(join);
  assert.ok(call, 'JOIN.md names the seat command');
  const [prefix, seatArg] = [call[1], call[2]];
  const st = await runSeatCommand(prefix, ['status', '--seat', seatArg]);
  assert.match(st.out, /^STATUS/m, st.out + st.err);
  const wX = await until(async () => { const r = await runSeatCommand(prefix, ['wait', '--seat', seatArg, '--once']); return /^TURN /m.test(r.out) ? r : null; }, 20000);
  assert.ok(wX, 'X gets its turn through the vendored room.mjs');
  const attemptX = /^TURN attempt=(\S+)/m.exec(wX.out)[1];
  const speech = path.join(seatDir('X'), `speech-${attemptX}.md`);
  fs.writeFileSync(speech, '回应：同意 A，补充测试要求。\n');
  const subX = await runSeatCommand(prefix, ['submit', '--seat', seatArg, '--attempt', attemptX, '--file', speech]);
  assert.match(subX.out, /^ACCEPTED/m, subX.out + subX.err);

  const tB = await until(async () => { const r = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S2 }); return r.status === 'TURN' ? r : null; });
  assert.ok(tB, 'B gets its turn');
  assert.match(tB.packet, /authority=none/, 'other seats arrive as authority=none blocks');
  const pB = await host.tool('Room', { action: 'pass', room: 'r1', attempt: tB.attempt }, { sessionId: S2 });
  assert.equal(pB.status, 'ACCEPTED', JSON.stringify(pB));

  const tS = await until(async () => { const r = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S1 }); return r.status === 'TURN' ? r : null; });
  assert.ok(tS, 'A gets the summary turn');
  const sum = await host.tool('Room', { action: 'submit', room: 'r1', attempt: tS.attempt, text: '汇总：同意加 --strict。' }, { sessionId: S1 });
  assert.equal(sum.status, 'ACCEPTED');
  const done = await until(async () => (await host.panel('roundtable/room', { room: 'r1' })).phase === 'done');
  assert.ok(done, 'round done');
  const ev = events('r1');
  const speakers = ev.filter((e) => e.type === 'submission_accepted').map((e) => e.seatId);
  assert.deepEqual(speakers, ['A', 'X', 'B', 'A']);
  assert.ok(ev.some((e) => e.type === 'summary_published'));
});

test('hosted seat through pi.agent.complete: text-only discussion lane, failures classified', async () => {
  const r = await host.tool('Room', {
    action: 'create', room: 'r2', preset: 'discussion', joinAs: 'A',
    seats: [
      { seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('A2') },
      { seat: 'H', role: 'participant', agent: 'complete', model: 'test/fake-model', cwd: seatDir('H') },
    ],
  }, { sessionId: S3 });
  assert.equal(r.status, 'CREATED', JSON.stringify(r));
  const bad = await host.tool('Room', { action: 'create', room: 'r3', preset: 'implement-review', seats: [{ seat: 'H', role: 'executor', agent: 'complete', model: 'test/m', cwd: seatDir('H') }] }, { sessionId: S3 });
  assert.equal(bad.error, 'BAD_ARGS', 'a text-only seat cannot be the executor');
  await host.panel('roundtable/admin', { room: 'r2', cmd: 'task', text: '讨论一个问题' });
  await host.panel('roundtable/admin', { room: 'r2', cmd: 'start' });
  const t = await until(async () => { const x = await host.tool('Room', { action: 'wait', room: 'r2' }, { sessionId: S3 }); return x.status === 'TURN' ? x : null; });
  await host.tool('Room', { action: 'submit', room: 'r2', attempt: t.attempt, text: '开题' }, { sessionId: S3 });
  assert.ok(await until(() => events('r2').some((e) => e.type === 'submission_accepted' && e.seatId === 'H')), 'H spoke');
  const call = host.completeLog.at(-1);
  assert.equal(call.modelKey, 'test/fake-model');
  assert.equal(call.messages.length, 1);
  assert.equal(call.messages[0].role, 'user');
  assert.match(call.messages[0].content, /\[ROOM:[0-9a-f]+:seat=room authority=room/);
  assert.ok(call.system.length > 0 && call.system.length <= 32 * 1024);
  assert.equal(call.includeSessionContext, undefined, 'no session context is requested');
  // The room was served from inside a tool call (create). Upstream rejects every pi.* call made from
  // a finished invocation's context; the fake does the same, so these held only because the room
  // runs outside it.
  assert.deepEqual(host.aborted.filter((a) => a.api === 'agent.complete' || a.api === 'ui.showToast'), [], 'no completion or toast ran in a finished tool invocation');
  assert.ok(events('r2').some((e) => e.type === 'usage_reported' && e.seatId === 'H' && e.input === 100 && e.output === 20));

  // A rate-limited completion becomes seat_failed {class: rate_limited}.
  completeReplies.push(Object.assign(new Error('plugin completion rate exceeded'), { code: 'RATE_LIMITED' }));
  const tS = await until(async () => { const x = await host.tool('Room', { action: 'wait', room: 'r2' }, { sessionId: S3 }); return x.status === 'TURN' ? x : null; });
  assert.ok(tS, 'A summary turn');
  await host.tool('Room', { action: 'submit', room: 'r2', attempt: tS.attempt, text: '汇总' }, { sessionId: S3 });
  assert.ok(await until(async () => (await host.panel('roundtable/room', { room: 'r2' })).phase === 'done'), 'round 1 done');
  assert.equal((await host.panel('roundtable/admin', { room: 'r2', cmd: 'start' })).ok, true);
  const t2 = await until(async () => { const x = await host.tool('Room', { action: 'wait', room: 'r2' }, { sessionId: S3 }); return x.status === 'TURN' ? x : null; });
  assert.ok(t2, 'A opens round 2');
  await host.tool('Room', { action: 'submit', room: 'r2', attempt: t2.attempt, text: '第二轮开题' }, { sessionId: S3 });
  const failed = await until(() => events('r2').find((e) => e.type === 'seat_failed' && e.seatId === 'H'), 20000);
  assert.ok(failed, 'H failed on the second round');
  assert.equal(failed.class, 'rate_limited');
});

test('panel: open the room UI through shell.openExternal, release a binding, close the room', async () => {
  const o = await host.panel('roundtable/open-ui', { room: 'r1' });
  assert.equal(o.ok, true, JSON.stringify(o));
  const url = host.external.at(-1);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{32}$/, 'loopback room UI with the admin token in the fragment');
  const rel = await host.panel('roundtable/unbind', { room: 'r1', seat: 'B' });
  assert.equal(rel.released, true);
  const nowFree = await host.tool('Room', { action: 'join', room: 'r1', seat: 'B' }, { sessionId: S3 });
  assert.equal(nowFree.status, 'JOINED', 'a released seat can be taken by another conversation');
  const twice = await host.tool('Room', { action: 'join', room: 'r1', seat: 'A' }, { sessionId: S3 });
  assert.equal(twice.error, 'SEAT_TAKEN');
  const unknown = await host.panel('roundtable/admin', { room: 'r1', cmd: 'pi-key', key: 'x' });
  assert.equal(unknown.error, 'UNKNOWN_CMD');
  const closed = await host.panel('roundtable/admin', { room: 'r1', cmd: 'close' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.ok(!fs.existsSync(lockPath('r1')), 'closing stops serving and removes service.lock');
  const w = await host.tool('Room', { action: 'wait', room: 'r1' }, { sessionId: S1 });
  assert.equal(w.status, 'ROOM_CLOSED');
  assert.ok(typeof w.farewell === 'string' && w.farewell.length > 0, 'the farewell packet is handed over');
});

test('the fake host scopes pi.* calls to the tool invocation, as upstream does', async () => {
  // A timer started during a tool call keeps the invocation's context; once the call has returned,
  // a pi.* call from it is refused (plugin-host-process.mjs 54-69, 531-557).
  const before = host.aborted.length;
  let late = null;
  host.tools.set('Probe', {
    descriptor: { name: 'Probe' },
    execute: async () => { setTimeout(() => { host.pi.ui.showToast('late', 'info').then(() => { late = 'ok'; }, (e) => { late = e.code; }); }, 10); return { ok: true }; },
  });
  try {
    await host.tool('Probe', {}, { sessionId: S1 });
    assert.ok(await until(() => late), 'the late call settled');
    assert.equal(late, 'PLUGIN_TOOL_ABORTED');
    assert.equal(host.aborted.length, before + 1);
  } finally {
    host.tools.delete('Probe');
  }
});

test('a room the user stopped in the panel is not served again by a Room tool call', async () => {
  const c = await host.tool('Room', { action: 'create', room: 'r5', preset: 'discussion', joinAs: 'A', seats: [{ seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('A5') }, { seat: 'B', role: 'participant', agent: 'pi', cwd: seatDir('B5') }] }, { sessionId: S1 });
  assert.equal(c.status, 'CREATED', JSON.stringify(c));
  const stop = await host.panel('roundtable/stop', { room: 'r5' });
  assert.deepEqual(stop, { ok: true, stopped: true });
  assert.ok(!fs.existsSync(lockPath('r5')));
  const w = await host.tool('Room', { action: 'wait', room: 'r5' }, { sessionId: S1 });
  assert.equal(w.error, 'NOT_SERVED', JSON.stringify(w));
  assert.match(w.message, /panel/);
  const p = await host.tool('Room', { action: 'pass', room: 'r5', attempt: 'x1' }, { sessionId: S1 });
  assert.equal(p.error, 'NOT_SERVED');
  const j = await host.tool('Room', { action: 'join', room: 'r5', seat: 'B' }, { sessionId: S2 });
  assert.equal(j.status, 'JOINED');
  assert.equal(j.served, 'stopped', 'join binds the seat but does not serve the room');
  assert.ok(!fs.existsSync(lockPath('r5')), 'no tool call served the room');
  const list = await host.panel('roundtable/rooms');
  assert.equal(list.rooms.find((r) => r.room === 'r5').served, 'stopped');
  // The user serves it again: tool calls work again.
  assert.equal((await host.panel('roundtable/serve', { room: 'r5' })).ok, true);
  const w2 = await host.tool('Room', { action: 'wait', room: 'r5' }, { sessionId: S1 });
  assert.ok(['TURN_OVER', 'NOT_YOUR_TURN'].includes(w2.status), JSON.stringify(w2));
  assert.equal((await host.panel('roundtable/admin', { room: 'r5', cmd: 'close' })).ok, true);
});

test('a rooms root with a space in it: wait hands over the packet and the farewell', async () => {
  const saved = process.env.ROOM_DEV_HOME;
  process.env.ROOM_DEV_HOME = path.join(base, 'home with space');
  const roomsSp = path.join(process.env.ROOM_DEV_HOME, 'rooms');
  try {
    const c = await host.tool('Room', { action: 'create', room: 'sp', preset: 'discussion', joinAs: 'A', seats: [{ seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('Asp') }] }, { sessionId: S1 });
    assert.equal(c.status, 'CREATED', JSON.stringify(c));
    assert.equal(path.resolve(c.roomDir), path.resolve(roomsSp, 'sp'));
    assert.equal((await host.panel('roundtable/admin', { room: 'sp', cmd: 'task', text: '讨论' })).ok, true);
    assert.equal((await host.panel('roundtable/admin', { room: 'sp', cmd: 'start' })).ok, true);
    const t = await until(async () => { const r = await host.tool('Room', { action: 'wait', room: 'sp' }, { sessionId: S1 }); return r.status === 'TURN' || r.error ? r : null; });
    assert.equal(t && t.status, 'TURN', JSON.stringify(t));
    assert.equal(t.packetVerified, true);
    assert.match(t.packet, /authority=user/);
    assert.equal((await host.panel('roundtable/admin', { room: 'sp', cmd: 'close' })).ok, true);
    const w = await host.tool('Room', { action: 'wait', room: 'sp' }, { sessionId: S1 });
    assert.equal(w.status, 'ROOM_CLOSED');
    assert.ok(typeof w.farewell === 'string' && w.farewell.length > 0, JSON.stringify(w));
    assert.equal(w.farewellError, undefined);
  } finally {
    process.env.ROOM_DEV_HOME = saved;
  }
});

test('a room closed from the room UI stops being served: HTTP server, heartbeat and service.lock released', async () => {
  const c = await host.tool('Room', { action: 'create', room: 'r6', preset: 'discussion', joinAs: 'A', seats: [{ seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('A6') }] }, { sessionId: S1 });
  assert.equal(c.status, 'CREATED', JSON.stringify(c));
  assert.equal((await host.panel('roundtable/open-ui', { room: 'r6' })).ok, true);
  const ui = new URL(host.external.at(-1));
  const token = ui.hash.slice(1);
  ui.hash = '';
  const res = await fetch(new URL('/api/admin', ui), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, cmd: 'close' }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(await until(() => !fs.existsSync(lockPath('r6')), 10000), 'service.lock released after a close from the room UI');
  const list = await host.panel('roundtable/rooms');
  const r6 = list.rooms.find((r) => r.room === 'r6');
  assert.equal(r6.closed, true);
  assert.notEqual(r6.served, 'here');
  await assert.rejects(fetch(new URL('/api/state', ui)), 'the loopback server is closed');
  const w = await host.tool('Room', { action: 'wait', room: 'r6' }, { sessionId: S1 });
  assert.equal(w.status, 'ROOM_CLOSED');
  assert.ok(typeof w.farewell === 'string' && w.farewell.length > 0, 'the farewell was handed out before the room was released');
});

test('the plugin never reads room-dev\'s saved Pi key, even for a room with a built-in Pi seat', async () => {
  // An empty saved-key file: room-dev's service reads it (no PowerShell needed for an empty file)
  // and logs a DPAPI_FAILED warning whenever it is allowed to look at it.
  const keyFile = path.join(process.env.ROOM_DEV_HOME, 'secrets', 'pi-key.dpapi');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, Buffer.alloc(0));
  const savedEnvKey = process.env.ROOM_PI_API_KEY;
  delete process.env.ROOM_PI_API_KEY;
  const api = await import(pathToFileURL(path.join(pluginDir, 'room-dev', 'lib', 'api.mjs')).href);
  const roomDir = path.join(ROOMS, 'k1');
  try {
    assert.equal((await api.createRoom({ dir: roomDir, id: 'k1', preset: 'discussion' })).status, 'INIT');
    assert.equal((await api.addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'pi-user', wait: 'manual', cwd: seatDir('Ak') })).status, 'SEAT');
    assert.equal((await api.addSeat({ dir: roomDir, seat: 'P', role: 'participant', hosted: 'pi:discussion', cwd: seatDir('Pk') })).status, 'SEAT');
    // Control: room-dev's own default does read the file, so the probe can see a read.
    const control = [];
    const h = await api.openRoom({ roomDir, log: (l) => control.push(String(l)) });
    assert.ok(await until(() => control.some((l) => /DPAPI_FAILED/.test(l))), `room-dev's default reads the saved key: ${control.join(' | ')}`);
    await h.close();
    // Served by the plugin: the room's own log reaches ctx.log, and no key read appears in it.
    const before = host.serviceLog.length;
    const s = await host.panel('roundtable/serve', { room: 'k1' });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.ok(await until(() => host.serviceLog.slice(before).some((l) => /room=k1/.test(l))), 'the served room logs through the service');
    await sleep(1500);
    const lines = host.serviceLog.slice(before);
    assert.ok(!lines.some((l) => /DPAPI|pi-key\.dpapi|Pi 的 key|Pi key/.test(l)), `no saved-key read: ${lines.join(' | ')}`);
    assert.equal((await host.panel('roundtable/admin', { room: 'k1', cmd: 'close' })).ok, true);
  } finally {
    if (savedEnvKey !== undefined) process.env.ROOM_PI_API_KEY = savedEnvKey;
    fs.rmSync(keyFile, { force: true });
  }
});

test('stopping the service while start is still reopening rooms leaves nothing served', async () => {
  assert.ok(fs.existsSync(lockPath('r2')), 'r2 is served and remembered');
  await host.stopServices();
  assert.ok(!fs.existsSync(lockPath('r2')));
  await host.startServices();   // returns at once; r2 is reopened in the background
  await host.stopServices();    // ... and stopped before that reopen has finished
  assert.ok(!fs.existsSync(lockPath('r2')), 'no service.lock after stop');
  await sleep(1500);
  assert.ok(!fs.existsSync(lockPath('r2')), 'nothing came back after stop returned');
  const list = await host.tool('Room', { action: 'list' }, { sessionId: S3 });
  assert.equal(list.serviceRunning, false);
  assert.equal(list.rooms.find((r) => r.room === 'r2').served, 'stopped');
  // start, stop, start: the room is served by the last start.
  await host.startServices();
  await host.stopServices();
  await host.startServices();
  assert.ok(await until(() => fs.existsSync(lockPath('r2'))), 'r2 is served again by the last start');
  assert.equal((await host.panel('roundtable/rooms')).rooms.find((r) => r.room === 'r2').served, 'here');
});

test('service stop removes service.lock; start serves the remembered rooms again; unload releases everything', async () => {
  assert.ok(fs.existsSync(lockPath('r2')));
  await host.stopServices();
  assert.ok(!fs.existsSync(lockPath('r2')), 'service stop removed service.lock');
  const refused = await host.tool('Room', { action: 'create', room: 'r4', preset: 'discussion', seats: [{ seat: 'A', role: 'lead', agent: 'pi', cwd: seatDir('A4') }] }, { sessionId: S1 });
  assert.equal(refused.error, 'SERVICE_NOT_RUNNING');
  const status = await host.tool('Room', { action: 'status', room: 'r2' }, { sessionId: S3 });
  assert.equal(status.status, 'STATUS', 'status reads the room files without a service');
  await host.startServices();
  assert.ok(await until(() => fs.existsSync(lockPath('r2'))), 'r2 is served again after start');
  assert.ok(!fs.existsSync(lockPath('r1')), 'the closed room stays closed');
  await host.unload();
  assert.ok(!fs.existsSync(lockPath('r2')), 'unload removed service.lock');
  host = null;
});
