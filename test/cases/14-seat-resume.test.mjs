// Plan §13.1 #14 (simulation + real; this file is the simulation layer): the same seat resumes after the
// room service restarted while it held its turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

async function resumeRoom() {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.admin({ cmd: 'task', text: 'Same-seat resume' });
  await sim.admin({ cmd: 'start', order: ['A', 'B'] });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} },
      { crashService: true },
      { restartService: true },
      { wait: { accept: ['NEEDS_RECONCILE'] } },
      { admin: (s) => ({ cmd: 'reconcile', attemptId: s.taken[0], action: 'replay' }) },
      { wait: { fresh: false } },
    ],
  });
  await sim.run([A]);
  return { sim, A };
}

test('#14 Same-seat resume: already-received (confirmed) packet is not resent; replay returns the same attempt and packet', async () => {
  const { sim, A } = await resumeRoom();
  await sim.check(async () => {
    const a1 = A.taken[0];
    assert.equal(A.waits[1].status, 'NEEDS_RECONCILE', 'after the restart the seat is told to wait for the user');
    assert.equal(A.waits[2].status, 'TURN');
    assert.equal(A.waits[2].attemptId, a1, 'the same attempt comes back after replay');
    assert.deepEqual(A.taken, [a1]);
    const issued = sim.ofType('packet_issued', (e) => e.seatId === 'A');
    assert.equal(issued.length, 1, 'no second packet for the packet the seat already took');
    assert.equal(A.packetPath, issued[0].path);
    sim.assertEvents([{ type: 'needs_reconcile', attemptId: a1 }, { type: 'reconciled', attemptId: a1, action: 'replay', receipt: 'sent' }]);
    assert.equal(sim.ofType('packet_resent').length, 0, 'a packet the seat confirmed taking is not re-sent');
    const A2 = createScriptedSeat({ seatId: 'A', script: [{ submit: 'Submitted after replay', attempt: a1 }] });
    await sim.run([A2]);
    assert.equal(A2.lastReply.status, 'ACCEPTED');
    assert.ok(sim.holding('B'), 'the room moves on');

    // the other path: the user voids the attempt instead -> a new packet that names the voided one
    await sim.crashService();
    await sim.restartService();
    const b1 = sim.holding('B');
    assert.equal((await sim.admin({ cmd: 'reconcile', attemptId: b1, action: 'void' })).ok, true);
    await sim.tick();
    const b2 = sim.holding('B');
    assert.ok(b2 && b2 !== b1);
    assert.ok(sim.packetText(b2).includes(`Voided attempt notice: your previous attempt ${b1} has been voided`));
  });
});

// The packet was issued but the seat never recorded taking it (no last-attempt.json naming the
// attempt) when the service went down: its receipt is unknown, so replay re-sends it.
test('#14 Unknown-receipt packet is resent with "ignore duplicates" notice', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Unknown receipt' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const a1 = sim.holding('A');
    assert.ok(a1, 'A holds an issued attempt');
    const originalPath = sim.ofType('packet_issued', (e) => e.attemptId === a1)[0].path;
    await sim.crashService();
    await sim.restartService();
    sim.assertEvents([{ type: 'needs_reconcile', attemptId: a1 }]);
    const r = await sim.admin({ cmd: 'reconcile', attemptId: a1, action: 'replay' });
    assert.equal(r.ok, true);
    assert.equal(r.receipt, 'unknown');
    sim.assertEvents([{ type: 'reconciled', attemptId: a1, action: 'replay', receipt: 'unknown' }, { type: 'packet_resent', attemptId: a1, resend: 1, reason: 'receipt_unknown' }]);
    assert.equal(sim.ofType('packet_issued', (e) => e.seatId === 'A').length, 1, 'a re-send is the same attempt, not a new packet_issued');
    const att = sim.state().attemptLog[a1];
    assert.equal(att.status, 'pending');
    assert.notEqual(att.path, originalPath);
    assert.ok(!fs.readFileSync(originalPath, 'utf8').includes('If you already received it, ignore duplicates'), 'the packet as first issued is left as it was');
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'Submitted after receiving resend' }] });
    await sim.run([A]);
    assert.equal(A.waits[0].attemptId, a1, 'the same attempt comes back');
    assert.equal(A.packetPath, att.path);
    assert.match(A.packetText, /If you already received it, ignore duplicates/);
    assert.ok(A.packetText.includes(`[ROOM:${att.nonce}:seat=room authority=room`), 'the notice is a room block under the packet nonce');
    assert.equal(A.lastReply.status, 'ACCEPTED');
  });
});
