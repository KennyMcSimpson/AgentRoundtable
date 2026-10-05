// Plan §13.1 #25 (仿真 +变异). Mutation: test/mutations/25-no-disclose-gate.test.mjs (ROOM_MUTATE
// no-disclose-gate: requests run without the user's approval). The fake spawn records every child
// the service would start; nothing really runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS, runToSummary, FAKE_CODEX, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { snapshot } from '../../lib/workspace.mjs';

export const runs = (sim) => sim.spawnCalls.filter((c) => c.file !== FAKE_CODEX);

export async function scenario({ mutate } = {}) {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS, mutate, spawnHandler: () => ({ stdout: 'diff --git a/src/app.mjs b/src/app.mjs\n' }) });
  const { sha } = await runToSummary(sim);
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} },
      { disclose: { argv: ['git', 'diff'], reason: '看改动' } },
      { disclose: { argv: ['git', 'status'], reason: '看状态' } },
      { verdict: 'disclose', artifact: sha, text: '先看 diff 再定' },
      { submit: '需要披露后再给结论' },
    ],
  });
  await sim.run([A]);
  // time passes, ticks run, the round ends
  sim.clock.advance(600_000);
  await sim.tick(5);
  return { sim, sha, A };
}

// Before any approval: nothing ran, nothing was approved, both requests still wait.
export function invariants({ sim, A }) {
  const [d1, d2] = A.replies.slice(0, 2).map((r) => r.reply);
  assert.deepEqual([d1.requestStatus, d2.requestStatus], ['requested', 'requested']);
  assert.equal(sim.lastEvent('verdict_recorded').verdict, 'disclose');
  assert.equal(runs(sim).length, 0, 'no child process before approval');
  assert.equal(sim.ofType('disclose_executed').length, 0);
  assert.equal(sim.ofType('disclose_approved').length, 0);
  for (const id of [d1.id, d2.id]) assert.equal(sim.state().disclosures[id].status, 'requested');
}

if (isMain(import.meta.url)) {
  test('#25 未批准的披露：未执行（批准前零子进程；拒绝后也不执行；只有批准后才在快照副本里执行一次）', async () => {
    const r = await scenario();
    const { sim, sha, A } = r;
    await sim.check(async () => {
      invariants(r);
      const [d1, d2] = A.replies.slice(0, 2).map((x) => x.reply);
      // denied -> still not executed, and cannot be approved afterwards
      assert.equal((await sim.admin({ cmd: 'deny-disclose', id: d2.id, reason: '不需要' })).ok, true);
      assert.equal((await sim.admin({ cmd: 'approve-disclose', id: d2.id })).ok, false);
      assert.equal(runs(sim).length, 0, 'a denied request never runs');
      // approved -> exactly one run, inside the snapshot copy
      assert.equal((await sim.admin({ cmd: 'approve-disclose', id: d1.id })).ok, true);
      assert.equal(runs(sim).length, 1);
      assert.deepEqual(runs(sim)[0].args, ['diff']);
      assert.ok(runs(sim)[0].opts.cwd.replace(/\\/g, '/').includes(`/snapshots/B/${sha}`), 'runs in the snapshot copy, not the seat cwd');
      const ex = sim.lastEvent('disclose_executed');
      assert.deepEqual([ex.id, ex.exitCode, ex.manifestSha], [d1.id, 0, sha]);
      assert.equal((await sim.admin({ cmd: 'approve-disclose', id: d1.id })).ok, false, 'an executed request is not run again');
      assert.equal(runs(sim).length, 1);
    });
  });

  test('#25 快照副本与冻结清单不一致（声明后、复制前文件被改）：记 snapshotStale，批准的披露也不在这份副本里执行', async () => {
    let simRef = null;
    // Between declareArtifacts hashing the files and snapshot() copying them, the file changes.
    const racingSnapshot = async (manifest, cwd, dest, o) => {
      simRef.editFile('B', 'src/app.mjs', 'export const x = 99; // 冻结途中被改\n');
      return snapshot(manifest, cwd, dest, o);
    };
    const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS, snapshot: racingSnapshot });
    simRef = sim;
    await sim.check(async () => {
      const { sha } = await runToSummary(sim);
      const fr = sim.lastEvent('artifacts_frozen');
      assert.equal(fr.snapshotStale, true, 'the copy does not match the frozen manifest');
      assert.deepEqual(fr.snapshotChanged.map((c) => c.path), ['src/app.mjs']);
      assert.equal(sim.state().artifacts[sha].snapshotStale, true);
      const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { disclose: { argv: ['git', 'diff'], reason: '看改动' } }, { submit: `<<ROOM:VERDICT disclose artifact=${sha}>> 先看 diff` }] });
      await sim.run([A]);
      const d = A.replies[0].reply;
      const ap = await sim.admin({ cmd: 'approve-disclose', id: d.id });
      assert.deepEqual([ap.ok, ap.error], [false, 'SNAPSHOT_STALE']);
      assert.equal(runs(sim).length, 0, 'nothing runs in a copy that differs from the freeze');
      assert.deepEqual([sim.lastEvent('disclose_denied').by, sim.lastEvent('disclose_denied').reason], ['room', 'SNAPSHOT_STALE']);
      assert.equal(sim.ofType('disclose_executed').length, 0);
    });
  });
}
