// Mutation for the audit item of plan §12.4 (remove audit): the simulation part of #9
// (test/cases/09-reviewer-write-tainted.test.mjs) must turn red when the service skips the audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/09-reviewer-write-tainted.test.mjs';

test('#9 mutation no-audit: reviewer turn is no longer audited, write verdict is no longer marked tainted, and the case fails', async () => {
  const r = await scenario({ mutate: 'no-audit' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-audit']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /audited|taint/.test(e.message));
    assert.equal(r.sim.ofType('audit_observed').length, 0);
    assert.equal(r.sim.lastEvent('verdict_recorded').tainted, false);
  } finally { await r.sim.cleanup(); }
});
