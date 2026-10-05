// Plan §13.1 #36 (仿真): in the division preset two executors vote pass on each other's work.
// Only the resolved reviewer of a producing seat (here the lead, by default) gives a binding
// verdict; lib/supervision.mjs verifiedStatus is what decides 已验证.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { verifiedStatus } from '../../lib/supervision.mjs';
import { readJsonl } from '../../lib/common.mjs';

test('#36 分工模式两执行席位互投 pass：产物不被标为已验证', async () => {
  const sim = await createSim({
    preset: 'division',
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor', files: { 'b.mjs': 'b\n' } }, { seatId: 'C', role: 'executor', files: { 'c.mjs': 'c\n' } }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '分工后开会' });
    await sim.admin({ cmd: 'start' });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { assign: '- B: 写 b.mjs | 验收: ["git","status"]\n- C: 写 c.mjs | 验收: ["git","status"]\n' }, { submit: '任务单' }] })]);
    assert.equal((await sim.admin({ cmd: 'confirm-task' })).ok, true);
    const sha = (id) => sim.latestManifest(id);
    const exec = (id, other) => createScriptedSeat({
      seatId: id,
      script: [
        { wait: {} }, { artifacts: { paths: [`${id.toLowerCase()}.mjs`] } }, { submit: `${id} 完成` },
        { wait: {} }, { verdict: 'pass', artifact: () => sha(other), text: `${id} 认为 ${other} 的产物没问题` }, { submit: `${id}：我给 ${other} 投 pass` },
      ],
    });
    const A = createScriptedSeat({
      seatId: 'A',
      script: [
        { wait: {} }, { submit: 'A：开题' },
        { wait: {} },
        { verdict: 'reject', artifact: () => sha('B'), text: '缺测试' },
        { verdict: 'reject', artifact: () => sha('C'), text: '缺测试' },
        { submit: 'A：汇总' },
      ],
    });
    await sim.run([A, exec('B', 'C'), exec('C', 'B')]);
    const vs = sim.ofType('verdict_recorded');
    const mutual = vs.filter((v) => v.seatId === 'B' || v.seatId === 'C');
    assert.deepEqual(mutual.map((v) => [v.seatId, v.producer, v.verdict, v.authorized]).sort(), [['B', 'C', 'pass', false], ['C', 'B', 'pass', false]]);
    for (const id of ['B', 'C']) {
      const onIt = sim.state().verdicts.filter((v) => v.artifactSha === sha(id));
      assert.ok(onIt.length >= 2, `artifact of ${id} has the peer pass and the lead's verdict`);
      const verified = onIt.some((v) => verifiedStatus(v).verified);
      assert.equal(verified, false, `artifact of ${id} is not verified`);
      const peer = onIt.find((v) => v.seatId !== 'A');
      assert.equal(verifiedStatus(peer).reason, 'NOT_REVIEWER');
    }
    // The published summary carries only the reviewer's binding verdicts; the peers' passes are
    // listed as excluded (not_reviewer), and no artifact is marked verified.
    const sp = sim.lastEvent('summary_published');
    assert.deepEqual(sp.verdicts.map((v) => [v.seatId, v.verdict, v.authorized]), [['A', 'reject', true], ['A', 'reject', true]]);
    assert.deepEqual(sp.excluded.filter((v) => v.annotation === 'not_reviewer').map((v) => [v.seatId, v.verdict, v.authorized]).sort(), [['B', 'pass', false], ['C', 'pass', false]]);
    assert.deepEqual(sp.verified.map((x) => [x.producer, x.verified]).sort(), [['B', false], ['C', false]]);
    assert.ok(sp.verified.every((x) => x.reason === 'REJECTED'));
    const adj = readJsonl(sim.adjudicationsPath);
    assert.deepEqual(adj.map((e) => e.verdict), ['reject', 'reject'], 'only the authorized reviewer counts for the reject-rate signal');
  });
});
