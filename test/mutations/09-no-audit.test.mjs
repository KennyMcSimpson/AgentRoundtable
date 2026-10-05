// Mutation for the audit item of plan §12.4 (去掉审计): the simulation part of #9
// (test/cases/09-reviewer-write-tainted.test.mjs) must turn red when the service skips the audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/09-reviewer-write-tainted.test.mjs';

test('#9 变异 no-audit：审方回合不再审计，写操作的 verdict 不再标 tainted，用例变红', async () => {
  const r = await scenario({ mutate: 'no-audit' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-audit']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /audited|taint/.test(e.message));
    assert.equal(r.sim.ofType('audit_observed').length, 0);
    assert.equal(r.sim.lastEvent('verdict_recorded').tainted, false);
  } finally { await r.sim.cleanup(); }
});
