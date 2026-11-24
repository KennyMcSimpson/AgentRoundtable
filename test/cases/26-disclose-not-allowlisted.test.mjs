// Plan §13.1 #26 (simulation): a disclosure argv outside the allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS, runToSummary, FAKE_CODEX } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#26 Disclosure argv not in allowlist: room immediately denies (disclose_denied by room NOT_IN_ALLOWLIST), cannot be approved by user', async () => {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
  await sim.check(async () => {
    await runToSummary(sim);
    const A = createScriptedSeat({
      seatId: 'A',
      script: [
        { wait: {} },
        { disclose: { argv: ['node', '-e', 'require("fs").rmSync(".", {recursive:true})'], reason: 'Run a script' } },
        { disclose: { argv: ['git', 'push', 'origin'], reason: 'Same binary but not allowlisted' } },
        { disclose: { argv: ['git', 'diff', '--stat'], reason: 'Matches git diff allowlist prefix' } },
        (s, sm) => ({ submit: `<<ROOM:DISCLOSE argv=["powershell","-c","dir"]>> Inline marker request outside allowlist\n<<ROOM:VERDICT reject artifact=${sm.latestManifest('B')}>> Insufficient evidence` }),
      ],
    });
    await sim.run([A]);
    const [r1, r2, r3] = A.replies.slice(0, 3).map((r) => r.reply);
    assert.deepEqual([r1.requestStatus, r1.denyReason], ['denied', 'NOT_IN_ALLOWLIST']);
    assert.deepEqual([r2.requestStatus, r2.denyReason], ['denied', 'NOT_IN_ALLOWLIST'], 'argv prefix match: git push is not git diff/status');
    assert.equal(r3.requestStatus, 'requested', 'git diff --stat matches the git diff prefix');
    const denied = sim.ofType('disclose_denied');
    assert.equal(denied.length, 3, 'two command-form and one text-form request denied');
    assert.ok(denied.every((e) => e.by === 'room' && e.reason === 'NOT_IN_ALLOWLIST'));
    const textReq = sim.ofType('disclose_requested').find((e) => e.argv[0] === 'powershell');
    assert.ok(textReq && textReq.allowed === false);
    for (const id of [r1.id, r2.id, textReq.id]) {
      const r = await sim.admin({ cmd: 'approve-disclose', id });
      assert.equal(r.ok, false, `approve ${id} is refused`);
      assert.equal(sim.state().disclosures[id].status, 'denied');
    }
    assert.equal(sim.spawnCalls.filter((c) => c.file !== FAKE_CODEX).length, 0, 'nothing ran');
  });
});
