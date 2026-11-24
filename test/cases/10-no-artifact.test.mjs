// Plan §13.1 #10 (artifact layer; this file is its simulation part): a Work report that claims completion
// with an empty artifact set is recorded as no_artifact (work_no_artifact event, reply annotation,
// summary_published.noArtifact, and a marker line in the lead's summary packet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

async function workThenSummary(bSteps) {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
  await sim.admin({ cmd: 'task', text: 'Implement app.mjs' });
  await sim.admin({ cmd: 'start' });
  const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, ...bSteps, { submit: 'B: implementation complete' }, { wait: {} }, { submit: 'B: report complete' }] });
  // The lead reviews whatever B froze (an empty set too), so its summary carries a verdict then.
  const summary = (seat, s) => { const sha = s.latestManifest('B'); return { submit: sha ? `A: summary <<ROOM:VERDICT reject artifact=${sha}>>` : 'A: summary' }; };
  const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A: opening' }, { wait: {} }, summary] });
  await sim.run([A, B]);
  return { sim, A, B };
}

function noArtifactInvariants({ sim, A, B }, reason) {
  const ev = sim.lastEvent('work_no_artifact');
  assert.ok(ev, 'the room records no_artifact');
  assert.deepEqual([ev.seatId, ev.attemptId, ev.reason], ['B', B.taken[0], reason]);
  const workReply = B.replies.find((r) => r.kind === 'speech' && r.attemptId === B.taken[0]).reply;
  assert.equal(workReply.annotation, 'no_artifact');
  assert.ok(workReply.notes.some((n) => n.code === 'no_artifact'));
  assert.match(sim.packetText(A.taken[1]), /no_artifact: seat B reported Work complete/);
  assert.deepEqual(sim.lastEvent('summary_published').noArtifact.map((x) => [x.seatId, x.reason]), [['B', reason]]);
}

test('#10 Claiming completion without declaring any artifacts: recorded as no_artifact', async () => {
  const r = await workThenSummary([]);
  await r.sim.check(() => noArtifactInvariants(r, 'none_declared'));
});

test('#10 Claiming completion with an empty declared artifact set (fileCount 0): recorded as no_artifact', async () => {
  const r = await workThenSummary([{ artifacts: { paths: ['src'], exclude: ['**'] } }]);
  await r.sim.check(() => {
    assert.equal(r.sim.lastEvent('artifacts_frozen').fileCount, 0);
    noArtifactInvariants(r, 'empty');
  });
});

test('#10 Control: Work report with non-empty frozen artifacts is not recorded as no_artifact', async () => {
  const r = await workThenSummary([{ artifacts: { paths: ['src', 'README.md'] } }]);
  await r.sim.check(() => {
    assert.equal(r.sim.ofType('work_no_artifact').length, 0);
    assert.equal(r.B.replies.find((x) => x.kind === 'speech').reply.annotation, undefined);
    assert.deepEqual(r.sim.lastEvent('summary_published').noArtifact, []);
  });
});
