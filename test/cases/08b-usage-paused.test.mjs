// Plan §13.1 #8b (simulation): known token usage reaches budget.maxTokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#8b Cumulative token usage exceeds cap: room pauses after current turn ends and issues no new packets', async () => {
  const sim = await createSim({ preset: 'discussion', init: { 'max-tokens': 1000 }, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }, { seatId: 'C', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Usage cap' });
    await sim.admin({ cmd: 'start', order: ['A', 'B', 'C'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A opening (usage 600)', usage: { input: 500, output: 100 } }] });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B speech (usage 500, exceeds cap)', usage: { input: 400, output: 100 } }] });
    await sim.run([A]);
    assert.equal(sim.state().paused, false, 'still under the cap after A');
    assert.equal(sim.state().usage.totals.tokens, 600);
    await sim.run([B]);
    // B's turn was the one that crossed the cap: it still ends normally (accepted) ...
    const bAcc = sim.lastEvent('submission_accepted', (e) => e.seatId === 'B');
    assert.equal(bAcc.annotation, 'none');
    assert.equal(sim.state().attemptLog[B.taken[0]].status, 'submitted');
    // ... and after that terminal the room is paused: no packet for C however long we wait
    await sim.tick(5);
    sim.clock.advance(3_600_000);
    await sim.tick(5);
    const v = sim.state();
    assert.equal(v.paused, true);
    assert.equal(v.usage.status, 'paused');
    assert.equal(v.usage.totals.tokens, 1100);
    assert.equal(sim.ofType('packet_issued', (e) => e.seatId === 'C').length, 0, 'C gets no packet while paused');
    assert.equal(v.attempt, null, 'no attempt is open');
    assert.ok(sim.logs.some((l) => /paused: known tokens 1100 >= cap 1000/.test(l)));
    assert.equal(sim.ofType('attempt_canceled').length + sim.ofType('attempt_expired').length, 0, 'pausing voids nothing');
  });
});
