// Plan §13.1 #16a (仿真 + 真实 +变异; this file is the simulation layer). Mutation:
// test/mutations/16a-no-recompute.test.mjs. The artifact is edited from outside (the executor's
// working directory, not through the room) after it was frozen and before the reviewer's verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

export async function scenario({ mutate, edit = true } = {}) {
  const sim = await createSim({
    preset: 'implement-review', mutate,
    seats: [
      { seatId: 'A', role: 'lead' },
      { seatId: 'B', role: 'executor', files: { 'src/app.mjs': 'export const x = 1;\n', 'README.md': '# demo\n' } },
    ],
  });
  await sim.admin({ cmd: 'task', text: '实现 app.mjs' });
  await sim.admin({ cmd: 'start' });
  const B = createScriptedSeat({
    seatId: 'B',
    script: [
      { wait: {} },
      { artifacts: { paths: ['src', 'README.md'] } },
      { submit: 'B：实现完成，改了 src/app.mjs' },
      { wait: {} },
      { submit: 'B：汇报完毕' },
    ],
  });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} },
      { submit: 'A：开题，B 请汇报' },
      { wait: {} },
      ...(edit ? [{ editFile: { seat: 'B', path: 'src/app.mjs', text: 'export const x = 2; // 审查途中被改\n' } }] : []),
      { verdict: 'pass', artifact: (s, sim) => sim.latestManifest('B'), text: '符合验收' },
      { submit: 'A：汇总' },
    ],
  });
  await sim.run([A, B]);
  return { sim, A, B, sha: sim.latestManifest('B') };
}

export function invariants({ sim, sha }) {
  const rc = sim.lastEvent('artifacts_recomputed', (e) => e.manifestSha === sha);
  assert.ok(rc, 'the room recomputes the frozen manifest when the verdict arrives');
  assert.equal(rc.stale, true, 'the edit makes the manifest stale');
  assert.deepEqual(rc.changed.map((c) => c.path), ['src/app.mjs']);
  const vr = sim.lastEvent('verdict_recorded', (e) => e.artifactSha === sha);
  assert.equal(vr.verdict, 'pass', 'the verdict value itself is kept');
  assert.equal(vr.annotation, 'stale', 'the verdict is annotated stale');
  assert.equal(vr.entersSummary, false);
  const sp = sim.lastEvent('summary_published');
  assert.deepEqual(sp.verdicts, [], 'the summary does not include the stale verdict');
  assert.deepEqual(sp.excluded.map((v) => [v.artifactSha, v.annotation]), [[sha, 'stale']]);
}

if (isMain(import.meta.url)) {
  test('#16a 审查中改产物：复算发现变化，verdict 记 stale；汇总不含', async () => {
    const r = await scenario();
    await r.sim.check(() => invariants(r));
  });

  test('#16a 对照：审查中没有改产物时 verdict 不是 stale 并进入汇总', async () => {
    const r = await scenario({ edit: false });
    await r.sim.check(() => {
      const vr = r.sim.lastEvent('verdict_recorded');
      assert.equal(vr.annotation, 'none');
      const sp = r.sim.lastEvent('summary_published');
      assert.deepEqual(sp.verdicts.map((v) => [v.verdict, v.authorized, v.verified]), [['pass', true, true]]);
      assert.deepEqual(sp.verified.map((x) => [x.artifactSha, x.verified]), [[r.sha, true]], "the reviewer's clean pass marks the artifact verified");
    });
  });
}
