// Plan §13.1 #24 (simulation): the hosted Pi seat (fake provider) gets HTTP 429.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { createFakeProvider } from '../../lib/hosted/pi.mjs';

test('#24 Hosted seat receives 429: recorded as failed(rate_limited) with no immediate retry', async () => {
  const provider = createFakeProvider({ script: [{ throw: Object.assign(new Error('429 Too Many Requests'), { status: 429 }) }, { text: 'Should not be called' }] });
  const sim = await createSim({
    preset: 'discussion', piProvider: provider, piApiKey: 'sk-sim-fake-key-0000',
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'P', role: 'participant', hosted: 'pi:discussion' }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Rate limit' });
    await sim.admin({ cmd: 'start', order: ['A', 'P'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A opening' }] })]);
    await sim.tick(3);
    const pPkt = sim.lastEvent('packet_issued', (e) => e.seatId === 'P');
    const sf = sim.lastEvent('seat_failed');
    assert.ok(sf, 'the hosted turn fails');
    assert.deepEqual([sf.seatId, sf.attemptId, sf.class], ['P', pPkt.attemptId, 'rate_limited']);
    assert.equal(sim.state().attemptLog[pPkt.attemptId].status, 'failed');
    // no immediate retry: time passes, ticks run, the provider is not prompted again in this round
    sim.clock.advance(120_000);
    await sim.tick(5);
    assert.equal(provider.calls.prompt, 1, 'exactly one prompt');
    assert.equal(sim.ofType('packet_issued', (e) => e.seatId === 'P').length, 1, 'no new packet for P');
    assert.equal(sim.state().phase, 'summary', 'the round moves on to the lead');
    assert.equal(sim.state().currentSeat, 'A');
  });
});
