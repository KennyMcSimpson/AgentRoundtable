// Mutation for plan §13.1 #3: a service started with mutate=no-dedupe (and, separately, with the
// ROOM_MUTATE environment variable) must break the case's invariant. The test passes when the
// mutated service re-judges an outbox file the first instance already judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from '../cases/03-duplicate-submit.test.mjs';

async function expectRed(run) {
  const r = await run();
  try {
    assert.equal(r.sim.state().mutate.includes('no-dedupe'), true, 'the service really runs mutated');
    assert.throws(() => invariants(r), (e) => e instanceof assert.AssertionError && /judged once|rejected once|still says ACCEPTED|exactly one accepted/.test(e.message));
  } finally { await r.sim.cleanup(); }
}

test('#3 mutation no-dedupe (option): without deduplication the same outbox file is re-judged and the case fails', async () => {
  await expectRed(() => scenario({ mutate: 'no-dedupe' }));
});

test('#3 mutation no-dedupe (ROOM_MUTATE env var): same invariant fails', async () => {
  const saved = process.env.ROOM_MUTATE;
  process.env.ROOM_MUTATE = 'no-dedupe';
  try {
    await expectRed(() => scenario({}));
  } finally {
    if (saved === undefined) delete process.env.ROOM_MUTATE; else process.env.ROOM_MUTATE = saved;
  }
});
