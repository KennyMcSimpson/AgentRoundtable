// Embedding API (lib/api.mjs): a full implement-review round driven in-process exactly as an
// embedding host would: createRoom, addSeat, openRoom, seat clients, admin through the running service.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testRunsRoot, randomHex } from '../lib/common.mjs';
import { createRoom, addSeat, openRoom, seatClient, admin, toArgv, parseResultLine, turnPacketPath } from '../lib/api.mjs';

const roots = [];
after(async () => { for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true }); });

function base() {
  const b = path.join(testRunsRoot(), `api-${randomHex(5)}`);
  fs.mkdirSync(b, { recursive: true });
  roots.push(b);
  return b;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } }

test('toArgv / parseResultLine', () => {
  assert.deepEqual(toArgv({ seat: 'S', once: true, skip: false, n: null, arg: ['git', '--stat'], declare: ['a', 'b'] }),
    ['--seat', 'S', '--once', '--arg', 'git', '--arg=--stat', '--declare', 'a', 'b']);
  assert.deepEqual(parseResultLine('TURN attempt=a1 nonce=n packet=C:/x.md sha256=ab'), { status: 'TURN', fields: { attempt: 'a1', nonce: 'n', packet: 'C:/x.md', sha256: 'ab' } });
  assert.equal(turnPacketPath('TURN attempt=a1 nonce=n packet=C:/x.md sha256=ab'), 'C:/x.md');
  assert.equal(turnPacketPath('TURN attempt=a1 nonce=n packet=C:/Users/First Last/room-dev/rooms/r 1/packets/p.md sha256=ab'), 'C:/Users/First Last/room-dev/rooms/r 1/packets/p.md');
  assert.equal(turnPacketPath('TURN_OVER nothing'), null);
});

test('in-process implement-review round through the embedding API, nothing printed, no process exit', async () => {
  const b = base();
  const roomDir = path.join(b, 'rooms', 'r1');
  const cwdA = path.join(b, 'seats', 'A'); const cwdB = path.join(b, 'seats', 'B');
  fs.mkdirSync(cwdA, { recursive: true }); fs.mkdirSync(cwdB, { recursive: true });
  const origWrite = process.stdout.write;
  let printed = '';
  process.stdout.write = (c, ...r) => { printed += String(c); return true; };
  let room;
  try {
    const init = await createRoom({ dir: roomDir, id: 'r1', preset: 'implement-review', wall: 600 });
    assert.equal(init.status, 'INIT', JSON.stringify(init));
    assert.equal(init.roomDir, path.resolve(roomDir));
    const sa = await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'codex-desktop', wait: 'turn_over', cwd: cwdA });
    assert.equal(sa.status, 'SEAT', JSON.stringify(sa));
    assert.ok(sa.joinPath && fs.existsSync(sa.joinPath));
    const sb = await addSeat({ dir: roomDir, seat: 'B', role: 'executor', agent: 'pi-user', wait: 'background', cwd: cwdB });
    assert.equal(sb.status, 'SEAT');
    const bad = await addSeat({ dir: roomDir, seat: 'A', role: 'lead', cwd: cwdA });
    assert.equal(bad.status, 'ERROR', 'duplicate seat refused as a result, not a throw');

    room = await openRoom({ roomDir, tickMs: 50 });
    assert.equal((await room.admin('task', { text: 'Write hello.mjs' })).ok !== false, true);
    await room.admin('start', { order: ['A', 'B', 'A'] });
    const A = seatClient({ roomDir, seatId: 'A' });
    const B = seatClient({ roomDir, seatId: 'B' });

    // Work phase: B is the executor.
    const wB = await until(async () => { const r = await B.wait({ timeoutSec: 1 }); return r.status === 'TURN' ? r : null; });
    assert.ok(wB, 'B gets its Work turn');
    assert.match(B.readPacket(wB.fields.packet), /authority=user/);
    fs.writeFileSync(path.join(cwdB, 'hello.mjs'), "console.log('hello room');\n");
    const fr = await B.artifacts({ attemptId: wB.fields.attempt, paths: [path.join(cwdB, 'hello.mjs')], baseline: 'none' });
    assert.equal(fr.status, 'FROZEN', JSON.stringify(fr));
    const manifest = fr.fields.manifest;
    const subB = await B.submit({ attemptId: wB.fields.attempt, text: 'Created hello.mjs' });
    assert.equal(subB.status, 'ACCEPTED', JSON.stringify(subB));

    // Meet: A, B, A.
    for (const [cli, text] of [[A, 'Opening'], [B, 'Response'], [A, 'Review']]) {
      const w = await until(async () => { const r = await cli.wait({ timeoutSec: 1, once: cli === A }); return r.status === 'TURN' ? r : null; });
      assert.ok(w, `${cli.seatId} gets a meet turn`);
      const s = await cli.submit({ attemptId: w.fields.attempt, text });
      assert.equal(s.status, 'ACCEPTED', JSON.stringify(s));
    }
    // Summary: A gives a verdict on B's frozen manifest.
    const wS = await until(async () => { const r = await A.wait({ once: true }); return r.status === 'TURN' ? r : null; });
    assert.ok(wS, 'A gets the summary turn');
    const v = await A.verdict({ attemptId: wS.fields.attempt, value: 'pass', artifact: manifest, text: 'Approved' });
    assert.equal(v.status, 'ACCEPTED', JSON.stringify(v));
    const sum = await A.submit({ attemptId: wS.fields.attempt, text: 'Summary: passed' });
    assert.equal(sum.status, 'ACCEPTED');
    const done = await until(() => room.view().phase === 'done');
    assert.ok(done, `round done, phase=${room.view().phase}`);
    const view = room.view();
    assert.ok(Array.isArray(view.items));
    assert.ok(room.events().some((e) => e.type === 'summary_published'));
    const show = await admin('show', { dir: roomDir });
    assert.equal(show.code, 0);
    assert.ok(show.lines.some((l) => /verdict=pass/.test(l)), show.lines.join('\n'));
  } finally {
    if (room) await room.close();
    process.stdout.write = origWrite;
  }
  // The test runner talks to its parent over this same stdout in a binary protocol, so look only for
  // what the room itself would print: status words at a line start and service/event log lines.
  const roomLines = printed.split(/\r?\n/).filter((l) => /^(TURN|TURN_OVER|NOT_YOUR_TURN|ACCEPTED|REJECTED|QUEUED|SEAT|INIT|JOIN|FROZEN|STATUS|NOTICE|ROOM_CLOSED|LEFT|ERROR)\b|^\[(service|event|room|admin|hosted|wake)/.test(l));
  assert.deepEqual(roomLines, [], `the API printed to stdout: ${roomLines.slice(0, 5).join(' | ')}`);
  assert.ok(!fs.existsSync(path.join(roomDir, 'service.lock')), 'close() removed service.lock');
  // The seat's draft lives in its own outbox, nowhere else.
  assert.ok(fs.readdirSync(path.join(cwdB, '.room-outbox', 'B', 'drafts')).length >= 1);
  assert.deepEqual(fs.readdirSync(cwdB).sort(), ['.room-outbox', 'hello.mjs']);
});

test('openRoom passes hostedProviders through: a lane seat speaks without any key', async () => {
  const b = base();
  const roomDir = path.join(b, 'rooms', 'r2');
  const cwdA = path.join(b, 'seats', 'A'); const cwdL = path.join(b, 'seats', 'L');
  fs.mkdirSync(cwdA, { recursive: true }); fs.mkdirSync(cwdL, { recursive: true });
  await createRoom({ dir: roomDir, id: 'r2', preset: 'discussion' });
  await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'generic', wait: 'background', cwd: cwdA });
  const sl = await addSeat({ dir: roomDir, seat: 'L', role: 'participant', hosted: 'lane:claude-code', cwd: cwdL });
  assert.equal(sl.status, 'SEAT', JSON.stringify(sl));
  const prompts = [];
  const room = await openRoom({ roomDir, tickMs: 50, hostedProviders: { lane: () => ({ busy: false, prompt: async (t) => { prompts.push(t); return { text: 'Lane speech', stopReason: 'end_turn', usage: null }; } }) } });
  try {
    await room.admin('task', { text: 'Discussion' });
    await room.admin('start', {});
    const A = seatClient({ roomDir, seatId: 'A' });
    const w = await until(async () => { const r = await A.wait({ timeoutSec: 1 }); return r.status === 'TURN' ? r : null; });
    await A.submit({ attemptId: w.fields.attempt, text: 'Opening' });
    const ok = await until(() => room.events().some((e) => e.type === 'submission_accepted' && e.seatId === 'L'));
    assert.ok(ok, 'lane seat spoke');
    assert.equal(prompts.length, 1);
  } finally { await room.close(); }
});

test('a hosted seat records --model; the lane provider factory sees it on seat.hosted.model; embedded seats refuse --model', async () => {
  const b = base();
  const roomDir = path.join(b, 'rooms', 'r3');
  const cwdA = path.join(b, 'seats', 'A'); const cwdL = path.join(b, 'seats', 'L');
  fs.mkdirSync(cwdA, { recursive: true }); fs.mkdirSync(cwdL, { recursive: true });
  await createRoom({ dir: roomDir, id: 'r3', preset: 'discussion' });
  const bad = await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'claude-code', cwd: cwdA, model: 'example-model-x' });
  assert.equal(bad.status, 'ERROR', 'an embedded agent picks its own model');
  const badId = await addSeat({ dir: roomDir, seat: 'L', role: 'participant', hosted: 'lane:custom-provider', cwd: cwdL, model: 'bad model; rm' });
  assert.equal(badId.status, 'ERROR', 'model ids are a restricted charset');
  await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'generic', wait: 'background', cwd: cwdA });
  const sl = await addSeat({ dir: roomDir, seat: 'L', role: 'participant', hosted: 'lane:custom-provider', cwd: cwdL, model: 'example-model-x' });
  assert.equal(sl.status, 'SEAT', JSON.stringify(sl));
  assert.match(sl.lines[0], /hosted=lane:custom-provider:discussion model=example-model-x/);
  const seatJson = JSON.parse(fs.readFileSync(path.join(roomDir, 'seats', 'L', 'seat.json'), 'utf8'));
  assert.deepEqual(seatJson.hosted, { kind: 'lane', lane: 'custom-provider', tier: 'discussion', model: 'example-model-x' });
  assert.match(fs.readFileSync(path.join(roomDir, 'seats', 'L', 'JOIN.md'), 'utf8'), /Model: example-model-x/);
  const seen = [];
  const room = await openRoom({ roomDir, tickMs: 50, hostedProviders: { lane: ({ seat }) => { seen.push(seat.hosted); return { busy: false, prompt: async () => ({ text: 'Hosted seat speech', stopReason: 'end_turn', usage: null }) }; } } });
  try {
    await room.admin('task', { text: 'Discussion' });
    await room.admin('start', {});
    const A = seatClient({ roomDir, seatId: 'A' });
    const w = await until(async () => { const r = await A.wait({ timeoutSec: 1 }); return r.status === 'TURN' ? r : null; });
    await A.submit({ attemptId: w.fields.attempt, text: 'Opening' });
    await until(() => room.events().some((e) => e.type === 'submission_accepted' && e.seatId === 'L'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'example-model-x', 'the host reads the model from seat.hosted.model');
  } finally { await room.close(); }
});

test('seatClient.wait: a rooms root with a space in it still yields the whole packet path', async () => {
  const b = path.join(base(), 'with space');
  const roomDir = path.join(b, 'rooms', 'r1');
  const cwdA = path.join(b, 'seats', 'A');
  fs.mkdirSync(cwdA, { recursive: true });
  assert.equal((await createRoom({ dir: roomDir, id: 'r1', preset: 'discussion' })).status, 'INIT');
  assert.equal((await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'pi-user', wait: 'manual', cwd: cwdA })).status, 'SEAT');
  const room = await openRoom({ roomDir, tickMs: 50 });
  try {
    await room.admin('task', { text: 'Discussion' });
    await room.admin('start', {});
    const A = seatClient({ roomDir, seatId: 'A' });
    const w = await until(async () => { const r = await A.wait({ once: true }); return r.status === 'TURN' ? r : null; });
    assert.ok(w, 'A gets its turn');
    assert.ok(w.fields.packet.includes('with space'), w.fields.packet);
    assert.match(A.readPacket(w.fields.packet), /authority=user/);
  } finally {
    await room.close();
  }
});

test('addSeat: explicit --agent antigravity gets background wait without wake; --agent generic on an antigravity folder stays generic', async () => {
  const b = base();
  const roomDir = path.join(b, 'rooms', 'r-agy');
  const cwdA = path.join(b, 'seats', 'A');
  const cwdGeneric = path.join(b, 'seats', 'antigravity');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdGeneric, { recursive: true });
  assert.equal((await createRoom({ dir: roomDir, id: 'r-agy', preset: 'discussion' })).status, 'INIT');
  const sa = await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'antigravity', cwd: cwdA });
  assert.equal(sa.status, 'SEAT', JSON.stringify(sa));
  const seatA = JSON.parse(fs.readFileSync(path.join(roomDir, 'seats', 'A', 'seat.json'), 'utf8'));
  assert.equal(seatA.agent, 'antigravity');
  assert.equal(seatA.waitMode, 'background');
  assert.equal(seatA.wake.enabled, false);
  assert.match(fs.readFileSync(path.join(roomDir, 'seats', 'A', 'JOIN.md'), 'utf8'), /JOIN variant antigravity/);

  const sb = await addSeat({ dir: roomDir, seat: 'B', role: 'participant', agent: 'generic', cwd: cwdGeneric });
  assert.equal(sb.status, 'SEAT', JSON.stringify(sb));
  const seatB = JSON.parse(fs.readFileSync(path.join(roomDir, 'seats', 'B', 'seat.json'), 'utf8'));
  assert.equal(seatB.agent, 'generic', 'no implicit folder-name upgrade from generic to antigravity');
  assert.equal(seatB.waitMode, 'manual');
});
