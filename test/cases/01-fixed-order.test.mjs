// Plan §13.1 #1 (simulation): N=3 and N=5 seats in a fixed order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, attemptOutcomes, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

const IDS = ['A', 'B', 'C', 'D', 'E'];

export async function scenario({ n = 3, cancelSeat = null, mutate } = {}) {
  const ids = IDS.slice(0, n);
  const sim = await createSim({
    preset: 'discussion', mutate,
    seats: ids.map((id, i) => ({ seatId: id, role: i === 0 ? 'lead' : 'participant' })),
  });
  await sim.admin({ cmd: 'task', text: `N=${n} fixed-order discussion` });
  await sim.admin({ cmd: 'start', order: ids });
  const seats = ids.map((id, i) => {
    const script = [{ wait: {} }];
    if (id === cancelSeat) script.push({ admin: { cmd: 'cancel' } }, { wait: {} });
    script.push({ submit: `Speech from ${id} (position ${i + 1})` });
    if (i === 0) script.push({ wait: {} }, { submit: `Summary from ${id}` });
    return createScriptedSeat({ seatId: id, script });
  });
  await sim.run(seats);
  return { sim, ids };
}

export function invariants({ sim, ids }) {
  const evs = sim.events();
  const outcomes = attemptOutcomes(evs);
  assert.ok(outcomes.length >= ids.length + 1, 'every seat had a meet attempt and the lead a summary attempt');
  for (const o of outcomes) {
    assert.equal(o.terminals.length, 1, `attempt ${o.attemptId} (${o.seatId}/${o.phase}) has exactly one terminal, got ${JSON.stringify(o.terminals)}`);
  }
  // at most one submitted per (epoch, roundId, phase, seatId): every seat holds one slot of the order
  const submitted = new Map();
  for (const o of outcomes) {
    if (o.terminals[0].type !== 'submission_accepted') continue;
    const k = `${o.epoch}|${o.roundId}|${o.phase}|${o.seatId}`;
    submitted.set(k, (submitted.get(k) || 0) + 1);
  }
  for (const [k, c] of submitted) assert.equal(c, 1, `at most one submitted for ${k}`);
  for (const id of ids) assert.equal(submitted.get(`0|1|meet|${id}`), 1, `seat ${id} submitted once in meet`);
  // order is the fixed order
  const meetSeats = outcomes.filter((o) => o.phase === 'meet' && o.terminals[0].type === 'submission_accepted').sort((a, b) => a.issuedSeq - b.issuedSeq).map((o) => o.seatId);
  assert.deepEqual(meetSeats, ids);
  // the lead's summary packet is issued only after every meet attempt reached a terminal state
  const summaryAttempt = outcomes.find((o) => o.phase === 'summary');
  assert.ok(summaryAttempt, 'summary attempt issued');
  assert.equal(summaryAttempt.seatId, ids[0]);
  const lastMeetTerminal = Math.max(...outcomes.filter((o) => o.phase === 'meet').map((o) => o.terminals[0].seq));
  assert.ok(summaryAttempt.issuedSeq > lastMeetTerminal, `summary issued at seq ${summaryAttempt.issuedSeq} after the last meet terminal ${lastMeetTerminal}`);
  assert.equal(sim.lastEvent('round_done').summary, 'published');
}

if (isMain(import.meta.url)) {
  test('#1 N=3 fixed order: each (epoch, roundId, seatId, attemptId) has exactly one terminal; each (epoch, roundId, seatId) has at most one submitted; lead summarizes only after all seats finish', async () => {
    const r = await scenario({ n: 3 });
    await r.sim.check(() => invariants(r));
  });

  test('#1 N=5 fixed order (with one cancel and reissue): same three invariants hold', async () => {
    const r = await scenario({ n: 5, cancelSeat: 'C' });
    await r.sim.check(() => {
      invariants(r);
      const c = attemptOutcomes(r.sim.events()).filter((o) => o.seatId === 'C' && o.phase === 'meet');
      assert.deepEqual(c.map((o) => o.terminals[0].type), ['attempt_canceled', 'submission_accepted'], 'the canceled attempt and its fresh attempt each end once');
    });
  });
}
