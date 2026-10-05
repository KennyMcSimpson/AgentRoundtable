// Mutation for plan §13.1 #16a: without the recompute the edit made during review goes unnoticed
// and the stale verdict enters the summary; the case must turn red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/16a-stale-during-review.test.mjs';

test('#16a 变异 no-recompute：审查中改过的产物不再被发现，stale verdict 进入汇总，用例变红', async () => {
  const r = await scenario({ mutate: 'no-recompute' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-recompute']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /recomputes|stale|summary/.test(e.message));
    assert.equal(r.sim.lastEvent('verdict_recorded').annotation, 'none', 'the mutated room records the verdict as clean');
  } finally { await r.sim.cleanup(); }
});
