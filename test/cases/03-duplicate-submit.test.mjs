// Plan §13.1 #3 (simulation + mutation): the same attempt submitted twice. Mutation: test/mutations/03-no-dedupe.test.mjs.
// The duplicate is written in the same breath as the first submission, and the service is then
// crashed and restarted while the next seat holds its turn, so every outbox file is seen by two
// service instances: dedupe has to hold across the restart, not just within one run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, attemptOutcomes, fileJudgements, FAKE_CODEX, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

export async function scenario({ mutate } = {}) {
  const sim = await createSim({
    preset: 'discussion', mutate,
    seats: [
      { seatId: 'A', role: 'lead' },
      { seatId: 'B', role: 'participant', waitMode: 'turn_over', wakeThread: 'room-B' },
    ],
  });
  await sim.admin({ cmd: 'task', text: 'Duplicate submit for the same attempt' });
  await sim.admin({ cmd: 'start', order: ['A', 'B'] });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} },
      { submit: 'A-FIRST initial submission', async: true },
      { submit: 'A-SECOND duplicate submission for the same attempt', attempt: (s) => s.taken[0], async: true },
      { awaitReplies: true },
      { until: (sim) => !!sim.holding('B') },
      { crashService: true },
      { restartService: true },
      { admin: (s, sim) => ({ cmd: 'reconcile', attemptId: sim.svc.state.holding.B, action: 'replay' }) },
      { wait: {} },
      { submit: 'Summary from A' },
    ],
  });
  const B = createScriptedSeat({
    seatId: 'B',
    script: [
      { wait: {} },
      { until: (sim) => sim.ofType('reconciled').length > 0 },
      { submit: 'Speech from B' },
    ],
  });
  await sim.run([A, B]);
  return { sim, A, B };
}

export function invariants({ sim, A }) {
  const evs = sim.events();
  const a1 = A.taken[0];
  const [first, second] = A.writes;
  // only the first is recorded
  const acc = evs.filter((e) => e.type === 'submission_accepted' && e.attemptId === a1);
  assert.equal(acc.length, 1, 'exactly one accepted submission for the attempt');
  assert.equal(acc[0].file, `${first.subId}.json`, 'the first submission is the one recorded');
  assert.match(acc[0].text, /A-FIRST/);
  assert.ok(!sim.state().messages.some((m) => /A-SECOND/.test(m.text)), 'the second submission never becomes a message');
  const rej = evs.filter((e) => e.type === 'submission_rejected' && e.file === `${second.subId}.json`);
  assert.equal(rej.length, 1, 'the duplicate is rejected once');
  // every outbox file judged exactly once, across the restart
  for (const [k, c] of fileJudgements(evs)) assert.equal(c, 1, `outbox file ${k} judged once (judged ${c} times)`);
  assert.equal(sim.reply('A', first.subId).status, 'ACCEPTED', "the first submission's reply still says ACCEPTED after the restart");
  for (const o of attemptOutcomes(evs)) assert.equal(o.terminals.length, 1, `attempt ${o.attemptId} has one terminal`);
  // the next seat is woken once
  const bMeet = evs.filter((e) => e.type === 'packet_issued' && e.seatId === 'B' && e.phase === 'meet');
  assert.equal(bMeet.length, 1, 'B gets one packet for its turn');
  const wakes = evs.filter((e) => e.type === 'wake_pushed' && e.seatId === 'B');
  assert.equal(wakes.length, 1, 'B is woken once');
  assert.equal(wakes[0].attemptId, bMeet[0].attemptId);
  assert.equal(sim.spawnCalls.filter((c) => c.file === FAKE_CODEX && c.args.includes('room-B')).length, 1, 'one codex queue push');
  assert.equal(sim.lastEvent('round_done').summary, 'published');
}

if (isMain(import.meta.url)) {
  test('#3 Duplicate submit for the same attempt: only first recorded; next seat woken once (no re-judging after service restart)', async () => {
    const r = await scenario();
    await r.sim.check(() => invariants(r));
  });
}
