// Plan §13.1 #30 (simulation): the approver changes the argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS, runToSummary, FAKE_CODEX } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

const runs = (sim) => sim.spawnCalls.filter((c) => c.file !== FAKE_CODEX);

test('#30 Disclosure argv changed on approval: treated as a new request (old denied, new pending, nothing executed)', async () => {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
  await sim.check(async () => {
    await runToSummary(sim);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { disclose: { argv: ['git', 'diff'], reason: 'Inspect changes' } }] });
    await sim.run([A]);
    const id = A.lastReply.id;
    const r = await sim.admin({ cmd: 'approve-disclose', id, argv: ['git', 'diff', '--stat'] });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ARGV_CHANGED');
    assert.ok(r.newRequestId && r.newRequestId !== id);
    assert.equal(r.newStatus, 'requested');
    const st = sim.state().disclosures;
    assert.equal(st[id].status, 'denied');
    assert.equal(st[id].denyReason, 'ARGV_CHANGED');
    assert.deepEqual(st[r.newRequestId].argv, ['git', 'diff', '--stat']);
    assert.equal(st[r.newRequestId].status, 'requested');
    assert.equal(runs(sim).length, 0, 'neither the old nor the new request ran');
    // the new request runs only when it is itself approved, with exactly its own argv
    assert.equal((await sim.admin({ cmd: 'approve-disclose', id: r.newRequestId })).ok, true);
    assert.equal(runs(sim).length, 1);
    assert.deepEqual(runs(sim)[0].args, ['diff', '--stat']);
    // changing to an argv outside the allowlist makes a new request that the room denies at once
    const B2 = createScriptedSeat({ seatId: 'A', script: [{ disclose: { argv: ['git', 'status'], reason: 'Inspect status' }, attempt: (s, sm) => sm.holding('A') }] });
    await sim.run([B2]);
    const r2 = await sim.admin({ cmd: 'approve-disclose', id: B2.lastReply.id, argv: ['node', '-v'] });
    assert.equal(r2.error, 'ARGV_CHANGED');
    assert.equal(r2.newStatus, 'denied');
    assert.equal(runs(sim).length, 1);
  });
});
