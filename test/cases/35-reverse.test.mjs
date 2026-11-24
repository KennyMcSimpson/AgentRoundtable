// Plan §13.1 #35 (simulation): reversing direction (admin reverse).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#35 Direction reversal: refused when attempt pending; increments epoch and swaps roles when terminal', async () => {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Direction reversal' });
    await sim.admin({ cmd: 'start' });
    await sim.tick();
    // Work attempt of B is open
    let r = await sim.admin({ cmd: 'reverse' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ATTEMPT_PENDING');
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { artifacts: { paths: ['src'] } }, { submit: 'B done' }, { wait: {} }, { submit: 'B report' }] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { do: async (s, sm) => { s.reverseDuringMeet = await sm.admin({ cmd: 'reverse' }); } }, { submit: 'A opening' }, { wait: {} }, { verdict: 'reject', artifact: (s, sm) => sm.latestManifest('B') }, { submit: 'A summary' }] });
    await sim.run([A, B]);
    assert.equal(A.reverseDuringMeet.ok, false, 'refused while the lead holds a meet attempt');
    assert.equal(A.reverseDuringMeet.error, 'ATTEMPT_PENDING');
    assert.equal(sim.ofType('direction_reversed').length, 0);
    assert.equal(sim.state().epoch, 0);
    assert.equal(sim.state().phase, 'done');

    // every attempt terminal -> reverse
    r = await sim.admin({ cmd: 'reverse' });
    assert.equal(r.ok, true);
    assert.equal(r.epoch, 1);
    assert.deepEqual(r.roles, { A: 'executor', B: 'lead' });
    const dr = sim.lastEvent('direction_reversed');
    assert.deepEqual(dr.before, { reviewer: ['A'], executor: ['B'], lead: 'A' });
    assert.deepEqual(dr.after.lead, 'B');
    assert.deepEqual(dr.after.executor, ['A']);
    sim.assertEvents(['direction_reversed', { type: 'epoch_bumped', epoch: 1, reason: 'reverse' }]);
    assert.equal(sim.state().epoch, 1);
    assert.equal(sim.state().roles.A, 'executor');

    // the next round runs with the swapped roles: A works, B leads
    await sim.admin({ cmd: 'start' });
    await sim.tick();
    assert.deepEqual(sim.lastEvent('work_started').seats, ['A']);
    assert.equal(sim.lastEvent('round_started').lead, 'B');
    const wp = sim.lastEvent('packet_issued');
    assert.deepEqual([wp.seatId, wp.phase, wp.epoch], ['A', 'work', 1]);
  });
});
