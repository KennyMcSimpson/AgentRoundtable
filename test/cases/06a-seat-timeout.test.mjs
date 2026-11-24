// Plan §13.1 #6a (simulation): a seat that does not hand in before its wall clock. Plan §4.3 rule 7: the
// room does not drop the seat on its own; the turn holds until the user waits (retry), skips or
// reassigns, and only an explicit skip puts the absence into the summary, with a marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#6a Seat times out without submitting: expired; turn holds for user decision (wait/skip/reassign), skipped seat carries absence marker in summary', async () => {
  const sim = await createSim({
    preset: 'discussion', init: { wall: 60 },
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }, { seatId: 'C', role: 'participant' }, { seatId: 'D', role: 'participant' }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Timeout handling' });
    await sim.admin({ cmd: 'start', order: ['A', 'B', 'C', 'D'] });
    await sim.tick();
    const a1 = sim.holding('A');
    assert.ok(a1);

    // Wait: before the deadline the attempt stays open
    sim.clock.advance(30_000);
    await sim.tick(2);
    assert.equal(sim.state().attemptLog[a1].status, 'pending', 'before the wall clock the user can simply wait');
    assert.equal(sim.ofType('attempt_expired').length, 0);

    // Timeout: past the deadline -> expired, and the turn does NOT move on by itself
    sim.clock.advance(31_000);
    await sim.tick();
    const ex = sim.lastEvent('attempt_expired');
    assert.equal(ex && ex.attemptId, a1);
    assert.equal(ex.hold, true);
    assert.equal(sim.state().attemptLog[a1].status, 'expired');
    assert.deepEqual([sim.state().awaitingDecision.seatId, sim.state().awaitingDecision.attemptId], ['A', a1]);
    await sim.tick(3);
    assert.equal(sim.holding('B'), null, 'no packet for B until the user decides');
    assert.equal(sim.holding('A'), null);
    assert.equal(sim.ofType('packet_issued').length, 1);

    // Wait (retry): the same seat gets a fresh attempt for the same turn; the packet names the expired one
    const rr = await sim.admin({ cmd: 'retry' });
    assert.equal(rr.ok, true);
    const a2 = sim.holding('A');
    assert.ok(a2 && a2 !== a1);
    assert.equal(sim.state().awaitingDecision, null);
    assert.match(sim.packetText(a2), new RegExp(`Voided attempt notice: your previous attempt ${a1} has been voided`));
    assert.equal((await sim.admin({ cmd: 'retry' })).error, 'NO_DECISION_PENDING');
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A opening after retry' }] });
    await sim.run([A]);
    const b1 = sim.holding('B');
    assert.ok(b1, 'B is next once A spoke');

    // B also runs out; skip: the user skips B
    sim.clock.advance(61_000);
    await sim.tick();
    assert.equal(sim.state().awaitingDecision.seatId, 'B');
    assert.equal(sim.holding('C'), null);
    assert.equal((await sim.admin({ cmd: 'skip' })).ok, true);
    const sk = sim.lastEvent('seat_skipped');
    assert.deepEqual([sk.seatId, sk.by], ['B', 'admin']);
    assert.equal(sim.state().awaitingDecision, null);
    const c1 = sim.holding('C');
    assert.ok(c1, 'C is next after the skip');

    // C runs out; reassign: the user hands C's turn to D
    sim.clock.advance(61_000);
    await sim.tick();
    assert.equal(sim.state().awaitingDecision.seatId, 'C');
    assert.equal((await sim.admin({ cmd: 'reassign', seatId: 'C', toSeatId: 'D', text: 'C did not respond, reassigned to D' })).ok, true);
    assert.equal(sim.state().attemptLog[c1].status, 'expired');
    sim.assertEvents([{ type: 'epoch_bumped', reason: 'reassign', fromSeat: 'C', toSeat: 'D' }]);
    assert.equal(sim.state().awaitingDecision, null);
    const D = createScriptedSeat({ seatId: 'D', script: [{ wait: {} }, { submit: "D taking over C's turn" }, { wait: {} }, { submit: "D's own turn" }] });
    await sim.run([D]);
    assert.match(sim.packetText(D.taken[0]), /Reassignment note: C did not respond, reassigned to D/);
    assert.equal(sim.state().epoch, 1);
    // A's late hand-in for the expired attempt is refused; the summary packet carries the marker
    const A2 = createScriptedSeat({ seatId: 'A', script: [{ submit: 'Late opening', attempt: a1 }, { wait: {} }, { submit: 'Summary from A: B absent' }] });
    await sim.run([A2]);
    assert.equal(A2.replies[0].reply.reason, 'STALE_ATTEMPT');
    assert.match(sim.packetText(A2.taken[0]), /Absence marker: seat B was skipped by the user during phase meet/);
    const sp = sim.lastEvent('summary_published');
    assert.deepEqual(sp.absent, [{ seatId: 'B', phase: 'meet', by: 'admin', attemptId: null }], 'only the explicit skip is an absence, with its marker');
    assert.equal(sim.lastEvent('round_done').summary, 'published');
  });
});

test('#6a Control: preset-less (P-1) room has no decision gate and advances to the next seat on timeout', async () => {
  const sim = await createSim({ init: { wall: 60 }, seats: [{ seatId: 'A', role: 'participant' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'p-1' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.tick();
    sim.clock.advance(61_000);
    await sim.tick();
    assert.equal(sim.lastEvent('attempt_expired').hold, undefined);
    assert.ok(sim.holding('B'));
  });
});
