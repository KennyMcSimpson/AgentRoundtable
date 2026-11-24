// Plan §13.1 #8a (simulation), budget rule §7.6: whole messages, pins = this round's speeches, quoted
// messages and the current summary; older ones dropped first and written to the manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

const big = (tag) => `${tag} ${'datum '.repeat(1500)}`; // ~9 KB each

const covers = (dropped, seq) => dropped.some((d) => d.fromSeq <= seq && seq <= d.toSeq);

test('#8a Over budget: dropped ranges recorded in manifest; required messages (current round speeches, quoted messages, current summary) stay in packet', async () => {
  const sim = await createSim({ preset: 'discussion', init: { 'packet-max-bytes': 16000 }, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Budget trim' });
    // round 1: two big speeches (seq 2, 3) and the summary (seq 4)
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.run([
      createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: big('A1') }, { wait: {} }, { submit: 'Summary v1: received both long speeches' }] }),
      createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: big('B1') }] }),
    ]);
    assert.deepEqual(sim.state().messages.map((m) => m.seq), [2, 3, 4]);
    assert.equal(sim.state().summary.seq, 4);
    // round 2: short speeches (seq 5, 6); B quotes seq 3
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A2 round 2 opening' }, { wait: {} }, { submit: 'Summary v2' }] });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { quote: { seq: 3, text: 'B1 datum datum' } }, { submit: 'B2 round 2 response' }] });
    await sim.run([A, B]);
    assert.equal(B.replies[0].reply.verified, true);

    // A's round-2 opening packet: over budget, old round-1 speeches dropped, summary pinned
    const open = sim.packetManifest(A.taken[0]);
    assert.ok(open.dropped.length > 0, 'dropped ranges recorded in the manifest');
    assert.ok(covers(open.dropped, 2), `the oldest round-1 speech is dropped first: ${JSON.stringify(open.dropped)}`);
    for (const d of open.dropped) assert.ok(d.toSeq < 4, 'nothing newer than the round-1 speeches is dropped');
    assert.ok(open.messageSeqs.includes(4), 'the current summary is pinned');
    assert.ok(open.bytes <= 16000, `packet ${open.bytes} bytes within the budget`);
    const openEv = sim.lastEvent('packet_issued', (e) => e.attemptId === A.taken[0]);
    assert.deepEqual(openEv.dropped, open.dropped, 'the event carries the same dropped ranges');
    assert.match(sim.packetText(A.taken[0]), /Budget trim:/);

    // A's round-2 summary packet: this round's speeches, the quoted seq 3 and the summary stay in
    const sum = sim.packetManifest(A.taken[1]);
    for (const seq of [3, 4, 5, 6]) assert.ok(sum.messageSeqs.includes(seq), `seq ${seq} is in the summary packet (${sum.messageSeqs})`);
    assert.ok(covers(sum.dropped, 2) && !covers(sum.dropped, 3), `only the unpinned seq 2 is dropped: ${JSON.stringify(sum.dropped)}`);
    const txt = sim.packetText(A.taken[1]);
    assert.ok(txt.includes('B2 round 2 response') && txt.includes('A2 round 2 opening'), "this round's speeches are in the packet");
    assert.ok(!txt.includes('A1 datum'), 'the dropped speech is not');
  });
});
