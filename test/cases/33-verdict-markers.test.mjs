// Plan §13.1 #33 (仿真 +变异), processing order §4.5: strip delimited and quoted blocks, take the
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
export const missingFirst = () => '汇总：看起来不错。';
export const missingSecond = () => '还是没写标记。';
export function missingInvariants(r) {
  const [first, second] = r.A.replies.map((x) => x.reply);
  assert.equal(first.status, 'ACCEPTED');
  assert.equal(first.malformed, 'verdict_missing');
  assert.equal(first.followUp, true);
  const fu = r.sim.lastEvent('packet_issued', (e) => e.kind === 'followup');
  assert.equal(fu.followUpOf, r.A.taken[0]);
  assert.match(r.sim.packetText(r.A.taken[1]), /本回合追问一次/);
  assert.equal(second.malformed, 'verdict_missing');
  assert.equal(second.followUp, undefined, 'asked only once');
  assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation, v.artifactSha]), [['none', 'malformed', r.sha]]);
  noPass(r.sim);
}

if (isMain(import.meta.url)) {
  test('#33 verdict 标记缺失：malformed → 追问一次 → 仍缺失则记 none，绝不 pass', async () => {
    const r = await summaryWith(missingFirst, missingSecond);
    await r.sim.check(() => missingInvariants(r));
  });

  test('#33 verdict 标记重复：同一通道取本回合最后一个（pass 后又 reject → reject）', async () => {
    const r = await summaryWith((sha) => `先说 <<ROOM:VERDICT pass artifact=${sha}>> 再看一遍后改口 <<ROOM:VERDICT reject artifact=${sha}>> 缺测试。`);
    await r.sim.check(() => {
      assert.equal(r.A.lastReply.malformed, undefined);
      assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation]), [['reject', 'none']]);
      assert.ok(!r.verdicts.some((v) => v.verdict === 'pass'));
    });
  });

  test('#33 命令形与文本形 verdict 冲突：malformed（verdict_conflict），不取任何一方', async () => {
    const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
    const { sha } = await runToSummary(sim);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { verdict: 'pass', artifact: sha }, { submit: `<<ROOM:VERDICT reject artifact=${sha}>>` }, { wait: {} }, { submit: '不再更正' }] });
    await sim.run([A]);
    await sim.check(() => {
      assert.equal(A.replies[1].reply.malformed, 'verdict_conflict');
      assert.deepEqual(sim.ofType('verdict_recorded').map((v) => [v.verdict, v.annotation]), [['none', 'malformed']]);
      noPass(sim);
    });
  });

  test('#33 verdict 标记只在引用块内：不算数 → malformed → 追问后用正确标记更正', async () => {
    const r = await summaryWith(
      (sha) => `B 的原话：\n> <<ROOM:VERDICT pass artifact=${sha}>>\n\`\`\`\n<<ROOM:VERDICT pass artifact=${sha}>>\n\`\`\`\n我还没有结论。`,
      (sha) => `更正：<<ROOM:VERDICT reject artifact=${sha}>> 缺少验收命令的输出。`,
    );
    await r.sim.check(() => {
      assert.equal(r.A.replies[0].reply.malformed, 'verdict_missing', 'quoted / fenced markers are stripped first');
      assert.equal(r.A.replies[1].reply.malformed, undefined);
      assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation]), [['reject', 'none']]);
      assert.ok(!r.verdicts.some((v) => v.verdict === 'pass'));
    });
  });

  test('#33 verdict 标记被翻译：malformed（marker_translated）→ 追问 → 仍无有效标记（<<ROOM:PASS>> 不满足 verdict）→ none', async () => {
    const r = await summaryWith((sha) => `汇总。<<ROOM:VERDICT 通过 artifact=${sha}>>`, () => '我认为可以。<<ROOM:PASS>>');
    await r.sim.check(() => {
      assert.equal(r.A.replies[0].reply.malformed, 'marker_translated');
      assert.ok(r.A.replies[1].reply.malformed, 'a pass marker never satisfies a required verdict');
      assert.deepEqual(r.verdicts.map((v) => [v.verdict, v.annotation]), [['none', 'malformed']]);
      noPass(r.sim);
    });
  });

  test('#33 追问包过期未答：同样记 none', async () => {
    const sim = await createSim({ preset: 'implement-review', init: { wall: 300 }, seats: IR_SEATS });
    const { sha } = await runToSummary(sim);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: '没有标记' }, { wait: {} }, { sleepMs: 301_000 }] });
    await sim.run([A]);
    await sim.tick();
    await sim.check(() => {
      sim.assertEvents([{ type: 'attempt_expired', attemptId: A.taken[1] }, { type: 'verdict_recorded', verdict: 'none', annotation: 'malformed', artifactSha: sha }]);
      assert.ok(!sim.ofType('verdict_recorded').some((v) => v.verdict === 'pass'));
    });
  });
}
