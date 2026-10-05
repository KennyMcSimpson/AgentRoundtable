// Plan §13.1 #7 (仿真): one seat answers `room pass`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, FAKE_CODEX } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#7 一席位 room pass：其他席位仍被唤醒', async () => {
  const sim = await createSim({
    preset: 'discussion',
    seats: [
      { seatId: 'A', role: 'lead' },
      { seatId: 'B', role: 'participant' },
      { seatId: 'C', role: 'participant', waitMode: 'turn_over', wakeThread: 'room-C' },
    ],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'pass 不阻塞' });
    await sim.admin({ cmd: 'start', order: ['A', 'B', 'C'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 开题' }, { wait: {} }, { submit: 'A 汇总' }] });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { pass: true }] });
    const C = createScriptedSeat({ seatId: 'C', script: [{ wait: {} }, { submit: 'C 发言' }] });
    await sim.run([A, B, C]);
    const bAcc = sim.lastEvent('submission_accepted', (e) => e.seatId === 'B');
    assert.equal(bAcc.kind, 'pass');
    assert.equal(bAcc.annotation, 'none');
    assert.equal(B.lastReply.status, 'ACCEPTED');
    const cPkt = sim.lastEvent('packet_issued', (e) => e.seatId === 'C');
    assert.ok(cPkt && cPkt.seq > bAcc.seq, 'C gets its packet after B passed');
    const wake = sim.lastEvent('wake_pushed', (e) => e.seatId === 'C');
    assert.ok(wake, 'C is woken');
    assert.equal(wake.attemptId, cPkt.attemptId);
    assert.equal(wake.command_ok, true);
    assert.equal(sim.spawnCalls.filter((c) => c.file === FAKE_CODEX).length, 1);
    assert.ok(sim.ofType('submission_accepted').some((e) => e.seatId === 'C'));
    assert.equal(sim.lastEvent('round_done').summary, 'published');
  });
});
