// Plan §13.1 #33 (simulation + mutation), processing order §4.5: strip delimited and quoted blocks, take the
// last marker of the turn; missing / conflicting / deformed / translated -> malformed -> ask once
// -> verdict none; never a default pass. Mutation: test/mutations/33-no-marker-strict.test.mjs
// (ROOM_MUTATE no-marker-strict: a missing or conflicting verdict marker defaults to pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS, runToSummary, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

// One summary turn: `first(sha)` is the body of the lead's submission, `second(sha)` (optional) the
// body of its answer to the follow-up packet.
export async function summaryWith(first, second, { mutate } = {}) {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS, mutate });
  const { sha } = await runToSummary(sim);
  const script = [{ wait: {} }, { submit: first(sha) }];
  if (second) script.push({ wait: {} }, { submit: second(sha) });
  const A = createScriptedSeat({ seatId: 'A', script });
  await sim.run([A]);
  return { sim, sha, A, verdicts: sim.ofType('verdict_recorded') };
}

function noPass(sim) {
  assert.ok(!sim.ofType('verdict_recorded').some((v) => v.verdict === 'pass'), 'no pass is ever recorded');
  assert.deepEqual(sim.lastEvent('summary_published').verdicts, [], 'nothing enters the summary as a verdict');
}

// The missing-marker turn: asked once, still missing -> verdict none, never pass.
export const missingFirst = () => 'Summary: looks good.';
export const missingSecond = () => 'Still omitted the marker.';
export function missingInvariants(r) {
  const [first, second] = r.A.replies.map((x) => x.reply);
  assert.equal(first.status, 'ACCEPTED');
  assert.equal(first.malformed, 'verdict_missing');
  assert.equal(first.followUp, true);
  const fu = r.sim.lastEvent('packet_issued', (e) => e.kind === 'followup');
  assert.equal(fu.followUpOf, r.A.taken[0]);
  assert.match(r.sim.packetText(r.A.taken[1]), /asking once for a correction/);
  assert.equal(second.malformed, 'verdict_missing');
  assert.equal(second.followUp, undefined, 'asked only once');
  assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation, v.artifactSha]), [['none', 'malformed', r.sha]]);
  noPass(r.sim);
}

if (isMain(import.meta.url)) {
  test('#33 Missing verdict marker: malformed -> ask once -> still missing records none, never pass', async () => {
    const r = await summaryWith(missingFirst, missingSecond);
    await r.sim.check(() => missingInvariants(r));
  });

  test('#33 Duplicate verdict markers: last one in the same channel wins (pass followed by reject -> reject)', async () => {
    const r = await summaryWith((sha) => `Initial <<ROOM:VERDICT pass artifact=${sha}>> changed after re-reading <<ROOM:VERDICT reject artifact=${sha}>> missing tests.`);
    await r.sim.check(() => {
      assert.equal(r.A.lastReply.malformed, undefined);
      assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation]), [['reject', 'none']]);
      assert.ok(!r.verdicts.some((v) => v.verdict === 'pass'));
    });
  });

  test('#33 Conflicting command-form and inline-marker verdicts: malformed (verdict_conflict), neither taken', async () => {
    const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
    const { sha } = await runToSummary(sim);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { verdict: 'pass', artifact: sha }, { submit: `<<ROOM:VERDICT reject artifact=${sha}>>` }, { wait: {} }, { submit: 'No further correction' }] });
    await sim.run([A]);
    await sim.check(() => {
      assert.equal(A.replies[1].reply.malformed, 'verdict_conflict');
      assert.deepEqual(sim.ofType('verdict_recorded').map((v) => [v.verdict, v.annotation]), [['none', 'malformed']]);
      noPass(sim);
    });
  });

  test('#33 Verdict marker only inside quote/code blocks: ignored -> malformed -> corrected after follow-up', async () => {
    const r = await summaryWith(
      (sha) => `B's original text:\n> <<ROOM:VERDICT pass artifact=${sha}>>\n\`\`\`\n<<ROOM:VERDICT pass artifact=${sha}>>\n\`\`\`\nI have not reached a conclusion yet.`,
      (sha) => `Correction: <<ROOM:VERDICT reject artifact=${sha}>> missing acceptance command output.`,
    );
    await r.sim.check(() => {
      assert.equal(r.A.replies[0].reply.malformed, 'verdict_missing', 'quoted / fenced markers are stripped first');
      assert.equal(r.A.replies[1].reply.malformed, undefined);
      assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation]), [['reject', 'none']]);
      assert.ok(!r.verdicts.some((v) => v.verdict === 'pass'));
    });
  });

  test('#33 Translated verdict marker: malformed (marker_translated) -> follow-up -> still invalid (<<ROOM:PASS>> does not satisfy verdict) -> none', async () => {
    const r = await summaryWith((sha) => `Summary. <<ROOM:VERDICT valid\u00e9 artifact=${sha}>>`, () => 'Looks fine to me. <<ROOM:PASS>>');
    await r.sim.check(() => {
      assert.equal(r.A.replies[0].reply.malformed, 'marker_translated');
      assert.ok(r.A.replies[1].reply.malformed, 'a pass marker never satisfies a required verdict');
      assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation]), [['none', 'malformed']]);
      noPass(r.sim);
    });
  });

  test('#33 Follow-up packet expires unanswered: also records none', async () => {
    const sim = await createSim({ preset: 'implement-review', init: { wall: 300 }, seats: IR_SEATS });
    const { sha } = await runToSummary(sim);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'No marker' }, { wait: {} }, { sleepMs: 301_000 }] });
    await sim.run([A]);
    await sim.tick();
    await sim.check(() => {
      sim.assertEvents([{ type: 'attempt_expired', attemptId: A.taken[1] }, { type: 'verdict_recorded', verdict: 'none', annotation: 'malformed', artifactSha: sha }]);
      assert.ok(!sim.ofType('verdict_recorded').some((v) => v.verdict === 'pass'));
    });
  });
}
