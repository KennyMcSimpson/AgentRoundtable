// Plan §13.1 #26 (仿真): a disclosure argv outside the allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, IR_SEATS, runToSummary, FAKE_CODEX } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#26 披露 argv 不在白名单：房间直接拒绝（disclose_denied by room NOT_IN_ALLOWLIST），用户也批准不了', async () => {
  const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS });
  await sim.check(async () => {
    await runToSummary(sim);
    const A = createScriptedSeat({
      seatId: 'A',
      script: [
        { wait: {} },
        { disclose: { argv: ['node', '-e', 'require("fs").rmSync(".", {recursive:true})'], reason: '跑一段脚本' } },
        { disclose: { argv: ['git', 'push', 'origin'], reason: '前缀相同但不在白名单' } },
        { disclose: { argv: ['git', 'diff', '--stat'], reason: '白名单前缀 git diff 之内' } },
        (s, sm) => ({ submit: `<<ROOM:DISCLOSE argv=["powershell","-c","dir"]>> 文本标记形的越界请求\n<<ROOM:VERDICT reject artifact=${sm.latestManifest('B')}>> 证据不足` }),
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
