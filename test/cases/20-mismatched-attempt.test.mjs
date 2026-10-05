// Plan §13.1 #20 (仿真 +变异). Mutation: test/mutations/20-no-attempt-check.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, attemptOutcomes, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

export const BOGUS = 'a1-1-ffffff';

export async function scenario({ mutate } = {}) {
  const sim = await createSim({ preset: 'discussion', mutate, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.admin({ cmd: 'task', text: '错配 attemptId' });
  await sim.admin({ cmd: 'start', order: ['A', 'B'] });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} },
      { submit: 'MISMATCH 错配 attempt 的提交', attempt: BOGUS },
      { point: { seq: 1, text: '错配 attempt 的要点' }, attempt: BOGUS },
      { submit: 'A 正确 attempt 的开题' },
      { wait: {} },
      { submit: 'A 汇总' },
    ],
  });
  const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B 发言' }] });
  await sim.run([A, B]);
  return { sim, A };
}

export function invariants({ sim, A }) {
  const evs = sim.events();
  const a1 = A.taken[0];
  const [bad, badPoint, good] = A.writes;
  for (const w of [bad, badPoint]) {
    const rej = evs.find((e) => e.type === 'submission_rejected' && e.file === `${w.subId}.json`);
    assert.ok(rej, `the mismatched ${w.kind} is dropped and recorded`);
    assert.equal(rej.attemptId, BOGUS);
    assert.equal(rej.reason, 'STALE_ATTEMPT');
  }
  assert.ok(!evs.some((e) => e.type === 'point_added'), 'no item comes from the mismatched point');
  assert.ok(!sim.state().messages.some((m) => /MISMATCH/.test(m.text)), 'the mismatched speech never becomes a message');
  const acc = evs.filter((e) => e.type === 'submission_accepted' && e.attemptId === a1);
  assert.equal(acc.length, 1, "exactly one accepted submission for A's attempt");
  assert.equal(acc[0].file, `${good.subId}.json`);
  for (const o of attemptOutcomes(evs)) assert.equal(o.terminals.length, 1, `attempt ${o.attemptId} has one terminal`);
}

if (isMain(import.meta.url)) {
  test('#20 错配 attemptId 的提交：丢弃并记账（submission_rejected STALE_ATTEMPT），持有的 attempt 不受影响', async () => {
    const r = await scenario();
    await r.sim.check(() => invariants(r));
  });
}
