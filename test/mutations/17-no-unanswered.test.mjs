// Mutation for plan §13.1 #17: without the unanswered computation the items the lead left unmarked
// are no longer flagged; the case must turn red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/17-summary-misses-item.test.mjs';

test('#17 变异 no-unanswered：汇总不再标出未回应条目，用例变红', async () => {
  const r = await scenario({ mutate: 'no-unanswered' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-unanswered']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /unanswered/.test(e.message));
    assert.deepEqual(r.sim.lastEvent('summary_published').unanswered, []);
  } finally { await r.sim.cleanup(); }
});
