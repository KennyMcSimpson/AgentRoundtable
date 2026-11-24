// Mutation for plan §13.1 #4: without the attempt check the late submission for the voided
// attempt is accepted and the old turn comes back as a message; the case must turn red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/04-late-submit-after-void.test.mjs';

test('#4 mutation no-attempt-check: late submission after void is accepted, reviving the old turn, and the case fails', async () => {
  const r = await scenario({ mutate: 'no-attempt-check' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-attempt-check']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /dropped|no accepted submission|never becomes a message|single terminal/.test(e.message));
  } finally { await r.sim.cleanup(); }
});
