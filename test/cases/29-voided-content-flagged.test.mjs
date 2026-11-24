// Plan §13.1 #29 (simulation + real; this file is the simulation layer), plan §6.4: the voided attempt's
// packet and whatever the seat wrote in it stay in the seat's own session; the room flags them at
// the head of the next packet (void notice naming the attemptId), and after an interrupt the
// superseded speeches are named and no longer forwarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#29 Next turn after void referencing voided content: next packet carries void notice (with attemptId), voided attempt produces no speech', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Voided content' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A opening' }, { wait: {} }, { submit: 'A summary' }] });
    const B = createScriptedSeat({
      seatId: 'B',
      script: [
        { wait: {} },
        { point: { seq: 2, text: 'VOIDED-POINT point raised during voided turn' } },
        { admin: { cmd: 'cancel' } },
        { wait: {} },
        { submit: 'As I mentioned in my previous turn about VOIDED-POINT...' },
      ],
    });
    await sim.run([A, B]);
    const [b1, b2] = B.taken;
    const head = sim.packetText(b2);
    assert.ok(head.includes(`Voided attempt notice: your previous attempt ${b1} has been voided`), 'the next packet names the voided attempt');
    assert.ok(head.includes('do not quote or continue them'));
    assert.equal(sim.lastEvent('packet_issued', (e) => e.attemptId === b2).voidedAttemptId, b1);
    assert.equal(sim.packetManifest(b2).voidedAttemptId, b1);
    assert.ok(!sim.state().messages.some((m) => m.attemptId === b1), 'the voided attempt produced no message');
    voidedRun = { summaryText: sim.packetText(A.taken[1]), point: sim.ofType('point_added')[0], b1 };
  });
});

let voidedRun = null;
// Only the item table is checked: B's later, accepted speech repeats the words VOIDED-POINT and is
// rightly forwarded to the lead as a speech (it is in the public record); the point from the voided
// attempt is not.
test('#29 Points submitted during a voided turn do not enter the next packet item table', () => {
  assert.ok(voidedRun, 'the first #29 test ran');
  assert.equal(voidedRun.point.attemptId, voidedRun.b1);
  const t = voidedRun.summaryText;
  const at = t.indexOf('## Pending Item Table');
  assert.ok(at !== -1, 'the summary packet has an item table');
  const end = t.indexOf('\n## ', at + 1);
  const table = t.slice(at, end === -1 ? undefined : end);
  assert.ok(!table.includes(voidedRun.point.itemId), `the voided point's item ${voidedRun.point.itemId} is not in the item table`);
  assert.ok(!table.includes('point raised during voided turn'), 'the voided point text is not in the item table');
});

test('#29 After interrupt and reopen: superseded speeches are no longer forwarded and next packet lists superseded seqs', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Interrupt' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'OLD-OPENING old direction opening' }] })]);
    const r = await sim.admin({ cmd: 'interrupt', text: 'Switch to direction two' });
    assert.deepEqual(r.supersededSeqs, [2]);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'New direction opening' }] });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }] });
    await sim.run([A, B]);
    for (const t of [A.packetText, B.packetText]) {
      assert.ok(!t.includes('OLD-OPENING'), 'superseded speech is not forwarded');
      assert.match(t, /this round was reopened at epoch 1\. Earlier speeches seq 2 have been superseded; do not rely on them/);
    }
  });
});

test('#29 Quoting superseded (voided) content is flagged', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  try {
    await sim.admin({ cmd: 'task', text: 'Quote after interrupt' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'OLD-OPENING old direction opening' }] })]);
    await sim.admin({ cmd: 'interrupt', text: 'Change direction' });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { quote: { seq: 2, text: 'OLD-OPENING old direction opening' } }] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'New opening' }] }), B]);
    const q = sim.lastEvent('quote_submitted');
    assert.ok(q.verified === false || (q.reason && q.reason !== 'ok'), `quote of superseded seq 2 flagged (got verified=${q.verified} reason=${q.reason})`);
  } finally { await sim.cleanup(); }
});

test('#29 Points raised in a superseded turn (pointing to an earlier round speech) do not enter the reopened round item table', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Interrupt and points' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const reopened = (s) => s.ofType('round_reopened').length > 0;
    const A = createScriptedSeat({
      seatId: 'A',
      script: [
        { wait: {} }, { submit: 'A round 1 opening (seq 2)' }, { wait: {} }, { submit: 'A round 1 summary (seq 4)' },
        { admin: { cmd: 'start', order: ['A', 'B'] } },
        { wait: {} }, { submit: 'A round 2 opening (seq 5)' },
        { until: reopened },
        { wait: {} }, { submit: 'A opening after reopen' }, { wait: {} }, { submit: 'A round 2 summary' },
      ],
    });
    const B = createScriptedSeat({
      seatId: 'B',
      script: [
        { wait: {} }, { submit: 'B round 1 speech (seq 3)' },
        { wait: {} }, { submit: 'B round 2 (seq 6) <<ROOM:POINT seq=3>>Round 1 issue still unresolved' },
        { admin: { cmd: 'interrupt' } },
        { wait: {} }, { submit: 'B speech after reopen without raising points' },
      ],
    });
    await sim.run([A, B]);
    const pt = sim.lastEvent('point_added');
    assert.deepEqual([pt.itemId, pt.aboutSeq], ['m3p1', 3]);
    const rr = sim.lastEvent('round_reopened');
    assert.deepEqual(rr.supersededSeqs, [5, 6]);
    assert.equal(sim.state().points.find((p) => p.itemId === 'm3p1').voided, true, 'kept, flagged, so the id is never reused');
    const sp = sim.lastEvent('summary_published');
    assert.equal(sp.version, 2);
    assert.ok(!sp.unanswered.includes('m3p1'), "the superseded turn's point is not an item of the reopened round");
    const pkt = sim.packetText(A.taken[A.taken.length - 1]);
    assert.ok(!pkt.includes('| m3p1 |'), "nor is it in the summary packet's table");
  });
});
