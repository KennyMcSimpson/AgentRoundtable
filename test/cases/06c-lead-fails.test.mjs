// Plan §13.1 #6c (仿真): the lead fails its summary turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#6c 主力失败：本轮结束时汇总标为缺失（round_done summary=missing），不生成汇总版本', async () => {
  const sim = await createSim({ preset: 'discussion', init: { wall: 120 }, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '主力失败' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 开题' }, { wait: {} }, { sleepMs: 121_000 }] });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B 发言' }] });
    await sim.run([A, B]);
    await sim.tick();
    const summaryAttempt = A.taken[1];
    assert.equal(sim.state().attemptLog[summaryAttempt].phase, 'summary');
    // the expired summary turn holds for the user's decision (#6a); the round is not marked done
    sim.assertEvents([{ type: 'attempt_expired', attemptId: summaryAttempt, hold: true }]);
    assert.equal(sim.ofType('round_done').length, 0, 'a failed summary does not end the round by itself');
    assert.equal(sim.state().phase, 'summary');
    assert.equal((await sim.admin({ cmd: 'skip' })).ok, true);
    sim.assertEvents([{ type: 'attempt_expired', attemptId: summaryAttempt }, { type: 'seat_skipped', seatId: 'A', phase: 'summary' }, { type: 'round_done', summary: 'missing' }]);
    assert.equal(sim.ofType('summary_published').length, 0, 'no summary version is published');
    assert.equal(sim.state().phase, 'done');
    assert.equal(sim.state().summary, null);

    // round 2: the lead's summary turn ends by the user's skip instead of the wall clock
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const A2 = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 第二轮开题' }, { wait: {} }, { admin: { cmd: 'skip' } }] });
    const B2 = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B 第二轮' }] });
    await sim.run([A2, B2]);
    assert.equal(sim.lastEvent('round_done').summary, 'missing');
    assert.equal(sim.ofType('round_done').length, 2);
  });
});
