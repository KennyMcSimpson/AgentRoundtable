// Plan §13.1 #4 (仿真 + 真实 +变异; this file is the simulation layer). Mutation:
// test/mutations/04-no-attempt-check.test.mjs. The plan names the record late_submit_dropped; the
// service records it as submission_rejected with reason STALE_ATTEMPT (INTERFACES §4 has no
// late_submit_dropped type).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, attemptOutcomes, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import path from 'node:path';
import { cmdSubmit } from '../../lib/seat.mjs';

export async function scenario({ mutate } = {}) {
  const sim = await createSim({
    preset: 'discussion', mutate,
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }],
  });
  await sim.admin({ cmd: 'task', text: '作废后迟到提交' });
  await sim.admin({ cmd: 'start', order: ['A', 'B'] });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} },
      { admin: { cmd: 'cancel' } },
      { wait: {} },
      { submit: 'LATE-OLD 旧 attempt 迟到的提交', attempt: (s) => s.taken[0] },
      { submit: 'A 新 attempt 的发言' },
      { wait: {} },
      { submit: 'A 的汇总' },
    ],
  });
  const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B 的发言' }] });
  await sim.run([A, B]);
  return { sim, A, B };
}

export function invariants({ sim, A }) {
  const evs = sim.events();
  const [old, fresh] = A.taken;
  assert.ok(old && fresh && old !== fresh, 'the cancel produced a fresh attempt');
  const late = A.writes[0];
  const rej = evs.find((e) => e.type === 'submission_rejected' && e.file === `${late.subId}.json`);
  assert.ok(rej, 'the late submission is recorded as dropped');
  assert.equal(rej.attemptId, old);
  assert.equal(rej.reason, 'STALE_ATTEMPT');
  assert.equal(A.replyFor(late.subId).status, 'REJECTED');
  // the old turn does not come back
  assert.ok(!evs.some((e) => e.type === 'submission_accepted' && e.attemptId === old), 'no accepted submission for the voided attempt');
  assert.ok(!sim.state().messages.some((m) => /LATE-OLD/.test(m.text)), 'the late text never becomes a message');
  assert.equal(sim.state().attemptLog[old].status, 'canceled');
  const o = attemptOutcomes(evs).find((x) => x.attemptId === old);
  assert.deepEqual(o.terminals.map((t) => t.type), ['attempt_canceled'], 'the voided attempt keeps its single terminal');
  assert.equal(sim.state().attemptLog[fresh].status, 'submitted');
}

if (isMain(import.meta.url)) {
  test('#4 作废后迟到提交：记 late_submit_dropped（submission_rejected STALE_ATTEMPT）；旧回合不复活', async () => {
    const r = await scenario();
    await r.sim.check(() => invariants(r));
  });

  // The real seat command (lib/seat.mjs cmdSubmit) for an attempt that was canceled while the seat
  // holds no newer one: the seat writes it (CF-2), the service rejects it STALE_ATTEMPT, not
  // NOT_YOUR_TURN.
  test('#4 真实 submit 命令：已取消的 attempt、席位手里没有新 attempt -> STALE_ATTEMPT', async () => {
    const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
    await sim.check(async () => {
      await sim.admin({ cmd: 'task', text: '迟到的真实提交' });
      await sim.admin({ cmd: 'start', order: ['B', 'A'] });
      await sim.tick();
      const old = sim.holding('B');
      assert.ok(old, 'B holds its Meet attempt');
      // B's turn is skipped by the user: the attempt ends, the turn moves on to A.
      assert.equal((await sim.admin({ cmd: 'skip' })).ok, true);
      await sim.tick();
      assert.ok(!sim.holding('B'), 'B holds nothing now');
      assert.ok(sim.holding('A'), 'the turn moved on to A');
      const lines = [];
      sim.editFile('B', 'late.md', 'LATE 已被跳过的回合');
      let done = false;
      const pending = cmdSubmit({ seat: sim.seatDir('B'), attempt: old, file: path.join(sim.cwdOf.B, 'late.md') }, { out: (l) => lines.push(l), pollMs: 10 }).finally(() => { done = true; });
      for (let i = 0; i < 400 && !done; i++) { await sim.tick(); await new Promise((r) => setTimeout(r, 10)); }
      const code = await pending;
      assert.equal(code, 2, 'exit code 2 (REJECTED)');
      assert.match(lines[0], /^REJECTED reason=STALE_ATTEMPT/);
      const rej = sim.ofType('submission_rejected', (e) => e.seatId === 'B' && e.attemptId === old);
      assert.equal(rej.length, 1, 'one rejection recorded');
      assert.equal(rej[0].reason, 'STALE_ATTEMPT');
      assert.ok(!sim.state().messages.some((m) => /LATE/.test(m.text)));
    });
  });
}
