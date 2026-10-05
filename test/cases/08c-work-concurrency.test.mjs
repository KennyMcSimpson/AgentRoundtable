// Plan §13.1 #8c (仿真): a third Work seat with maxWorkConcurrent=2. Its `room wait` (the real seat
// command, in-process, --once) and the scripted wait both see no turn until one of the first two
// Work attempts reaches a terminal state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, attemptOutcomes } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { cmdWait } from '../../lib/seat.mjs';

test('#8c 第 3 个 Work 席位：它的 wait 在前两个之一终态前不返回', async () => {
  const sim = await createSim({
    preset: 'implement-review', init: { 'max-work': 2 },
    seats: [
      { seatId: 'A', role: 'lead' },
      { seatId: 'B', role: 'executor', files: { 'b.txt': 'b\n' } },
      { seatId: 'C', role: 'executor', files: { 'c.txt': 'c\n' } },
      { seatId: 'D', role: 'executor', files: { 'd.txt': 'd\n' } },
    ],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '三个执行席位并发' });
    await sim.admin({ cmd: 'start' });
    await sim.tick(2);
    assert.equal(sim.state().phase, 'work');
    assert.deepEqual(Object.keys(sim.state().holding).sort(), ['B', 'C']);
    const lines = [];
    assert.equal(await cmdWait({ seat: sim.seatDir('D'), once: true }, { out: (l) => lines.push(l) }), 0);
    assert.match(lines[0], /^TURN_OVER /, 'the real `room wait --once` returns no turn for D');

    const work = (id, holdTicks) => createScriptedSeat({
      seatId: id,
      script: [{ wait: {} }, { ticks: holdTicks }, { artifacts: { paths: [`${id.toLowerCase()}.txt`] } }, { submit: `${id} 完成` }],
    });
    const B = work('B', 3);
    const C = work('C', 6);
    const D = work('D', 0);
    await sim.run([B, C, D]);

    const evs = sim.events();
    const outcomes = attemptOutcomes(evs).filter((o) => o.phase === 'work');
    const end = (id) => outcomes.find((o) => o.seatId === id).terminals[0].seq;
    const dIssued = outcomes.find((o) => o.seatId === 'D').issuedSeq;
    assert.ok(dIssued > Math.min(end('B'), end('C')), `D's packet (seq ${dIssued}) after the first terminal of B/C (${end('B')}, ${end('C')})`);
    assert.ok(dIssued > end('B') && dIssued < end('C'), 'D got the slot B freed while C still held its own');
    assert.ok(D.waits[0].seq >= end('B'), "D's scripted wait returned only after B's terminal");
    // never more than two live Work attempts at any point of the event stream
    let live = 0; let peak = 0;
    const openIds = new Set();
    for (const e of evs) {
      if (e.type === 'packet_issued' && e.phase === 'work') { openIds.add(e.attemptId); live++; peak = Math.max(peak, live); }
      if (['submission_accepted', 'attempt_canceled', 'attempt_expired', 'work_partial', 'seat_failed', 'seat_skipped'].includes(e.type) && openIds.has(e.attemptId)) { openIds.delete(e.attemptId); live--; }
    }
    assert.equal(peak, 2);
    assert.equal(sim.ofType('artifacts_frozen').length, 3);
  });
});
