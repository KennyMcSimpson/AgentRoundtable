// Mutation for plan §13.1 #15b: a room that stores seat text without escaping forged room blocks
// must turn the case red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/15-banner-forged.test.mjs';

test('#15b mutation no-escape: forged room blocks are no longer escaped and the case fails', async () => {
  const r = await scenario({ mutate: 'no-escape' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-escape']);
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /escaped|forged/.test(e.message));
    assert.equal(r.sim.lastEvent('submission_accepted', (e) => e.seatId === 'B').escaped, 0);
  } finally { await r.sim.cleanup(); }
});
