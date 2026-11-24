// Plan §13.1 #9 is a real-layer row (one row per agent, test/real/README.md). This file is only its
// simulation part: the audit result is injected through createRoomService({audit}) so that the
// no-audit mutation (plan §12.4: removing audit must turn something red) has a case to break.
// Mutation: test/mutations/09-no-audit.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS, runToSummary, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

// What lib/audit.mjs would report for a reviewer turn whose native log shows an apply_patch.
const writeObserved = async ({ seat, attemptId }) => ({
  status: 'present_in_native', writes: [{ path: 'src/app.mjs', source: 'apply_patch', ts: '2026-10-01T08:00:30.000Z' }],
  unknownCommands: [], tainted: true, annotation: 'tainted', note: `injected audit for ${seat.seatId}/${attemptId}`,
});
const unaudited = async () => ({ status: 'unknown', writes: [], unknownCommands: [], tainted: false, annotation: null, note: 'No audit source registered: not audited' });

export async function scenario({ mutate, audit = writeObserved } = {}) {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS, mutate, audit });
  const { sha } = await runToSummary(sim);
  const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { verdict: 'pass', artifact: sha, text: 'Pass' }, { submit: 'A: summary' }] });
  await sim.run([A]);
  return { sim, sha, A };
}

export function invariants({ sim, A }) {
  const ao = sim.lastEvent('audit_observed', (e) => e.attemptId === A.taken[0]);
  assert.ok(ao, "the reviewer's turn is audited after it submits");
  assert.equal(ao.tainted, true);
  assert.deepEqual(ao.writes.map((w) => w.path), ['src/app.mjs']);
  const vr = sim.lastEvent('verdict_recorded');
  assert.equal(vr.tainted, true, 'the verdict carries the taint');
  assert.equal(vr.annotation, 'tainted');
  assert.equal(sim.state().audits[A.taken[0]].tainted, true);
}

if (isMain(import.meta.url)) {
  test('#9 (simulation, injected audit) Reviewer writes a file during review turn: audited and marked tainted', async () => {
    const r = await scenario();
    await r.sim.check(() => invariants(r));
  });

  test('#9 (simulation) Unaudited turn: recorded as unaudited (status unknown), not tainted, and never claims read-only or no writes', async () => {
    const r = await scenario({ audit: unaudited });
    await r.sim.check(() => {
      const ao = r.sim.lastEvent('audit_observed');
      assert.equal(ao.status, 'unknown');
      assert.equal(ao.tainted, false);
      assert.match(ao.note, /not audited|unaudited/i);
      assert.equal(r.sim.lastEvent('verdict_recorded').annotation, 'none');
      for (const e of r.sim.events()) assert.ok(!/read-only|no writes\b(?!\s+observed)/i.test(JSON.stringify(e)), `event ${e.seq} never claims read-only`);
    });
  });
}
