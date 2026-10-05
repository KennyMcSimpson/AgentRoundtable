// Mutation for plan §13.1 #20: without the attempt check a submission with a mismatched attemptId
// is taken as the held attempt's; the case must turn red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/20-mismatched-attempt.test.mjs';

test('#20 变异 no-attempt-check：错配 attemptId 的提交被当成持有 attempt 接受，用例变红', async () => {
  const r = await scenario({ mutate: 'no-attempt-check' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-attempt-check']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /dropped and recorded|never becomes a message|exactly one accepted|one terminal|no item/.test(e.message));
  } finally { await r.sim.cleanup(); }
});
