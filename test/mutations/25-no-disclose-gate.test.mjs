// Mutation for plan §13.1 #25: a room that runs disclosure requests without the user's approval
// must turn the case red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants, runs } from '../cases/25-disclose-unapproved.test.mjs';

test('#25 mutation no-disclose-gate: disclosure request executes without approval and the case fails', async () => {
  const r = await scenario({ mutate: 'no-disclose-gate' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-disclose-gate']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /approval|requested/.test(e.message));
    assert.ok(runs(r.sim).length > 0, 'the mutated room started a child before any approval');
  } finally { await r.sim.cleanup(); }
});
