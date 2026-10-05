// Plan §13.1 #13 (真实 layer in the plan; this is the simulation part with the fake Pi provider
// from lib/hosted/pi.mjs). The fake prompt is held open after its first answer, standing in for
// pi's retry after agent_end: createPiSeat's prompt() resolves only when the agent has settled, so
// the next seat must not get its packet while the hosted turn is still running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { createFakeProvider } from '../../lib/hosted/pi.mjs';

test('#13 内置 Pi（假 provider）在 agent_end 后 retry：下一席位等到 settled 才拿到包', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = false;
  const provider = createFakeProvider({
    script: [async () => { entered = true; await gate; return { text: 'Pi 重试结束后的最终发言', usage: { input: 50, output: 20, cached: 0 } }; }],
  });
  const sim = await createSim({
    preset: 'discussion', piProvider: provider, piApiKey: 'sk-sim-fake-key-0000',
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'P', role: 'participant', hosted: 'pi:discussion' }, { seatId: 'C', role: 'participant' }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '托管席位 settled' });
    await sim.admin({ cmd: 'start', order: ['A', 'P', 'C'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 开题' }] })], { settle: false });
    const pPkt = sim.lastEvent('packet_issued', (e) => e.seatId === 'P');
    assert.ok(pPkt, 'P got its packet');
    // the hosted prompt is in flight and has not settled
    for (let i = 0; i < 5; i++) { await sim.tick(1, { settle: false }); await new Promise((r) => setImmediate(r)); }
    assert.equal(entered, true, 'the fake provider is running the prompt');
    sim.clock.advance(60_000);
    await sim.tick(3, { settle: false });
    assert.equal(sim.ofType('packet_issued', (e) => e.seatId === 'C').length, 0, 'C gets nothing while P has not settled');
    assert.equal(sim.state().currentSeat, 'P');
    // settle -> the result drains on the next tick, then C is issued
    release();
    await sim.svc.settle();
    await sim.tick(2);
    const pAcc = sim.lastEvent('submission_accepted', (e) => e.seatId === 'P');
    assert.ok(pAcc, "P's settled answer is accepted");
    assert.equal(pAcc.source, 'hosted');
    assert.match(pAcc.text, /重试结束后的最终发言/);
    const cPkt = sim.lastEvent('packet_issued', (e) => e.seatId === 'C');
    assert.ok(cPkt && cPkt.seq > pAcc.seq, 'C is issued after P settled');
    assert.equal(provider.calls.prompt, 1, 'one prompt; the room did not re-prompt');
  });
});
