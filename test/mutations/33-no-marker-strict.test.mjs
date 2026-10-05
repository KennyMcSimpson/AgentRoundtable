// Mutation for plan §13.1 #33: a room that takes a missing verdict marker as pass (no malformed,
// no follow-up, a default pass) must turn the case red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryWith, missingFirst, missingInvariants } from '../cases/33-verdict-markers.test.mjs';

test('#33 变异 no-marker-strict：缺失的 verdict 标记被当成 pass，用例变红', async () => {
  // The mutated room asks no follow-up, so the lead's script has only the first answer.
  const r = await summaryWith(missingFirst, null, { mutate: 'no-marker-strict' });
  try {
    assert.deepEqual(r.sim.state().mutate, ['no-marker-strict']);
    assert.throws(() => missingInvariants(r), (e) => e instanceof assert.AssertionError);
    assert.deepEqual(r.verdicts.map((v) => v.verdict), ['pass'], 'the mutated room recorded a default pass');
  } finally { await r.sim.cleanup(); }
});
