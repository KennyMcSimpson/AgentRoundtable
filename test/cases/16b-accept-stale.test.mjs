// Plan §13.1 #16b (仿真): the user accepts the stale manifest (admin accept-stale).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, invariants } from './16a-stale-during-review.test.mjs';
import { queue } from '../../lib/admin.mjs';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

const tainting = async ({ seat, attemptId }) => (seat.seatId === 'A'
  ? { status: 'present_in_native', writes: [{ path: 'src/app.mjs', source: 'apply_patch' }], unknownCommands: [], tainted: true, annotation: 'tainted', note: `injected for ${attemptId}` }
  : { status: 'present_in_native', writes: [], unknownCommands: [], tainted: false, annotation: null, note: 'clean' });

// A lead, B executor, C participant. C's Meet verdict on B's artifact makes the room recompute it
// (src/app.mjs was edited after the freeze); the user accepts that stale state; then, optionally, a
// new file appears before A's binding verdict in the summary turn.
async function acceptThenChange({ addFile, audit }) {
  const sim = await createSim({
    preset: 'implement-review', audit,
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor', files: { 'src/app.mjs': 'export const x = 1;\n' } }, { seatId: 'C', role: 'participant' }],
  });
  await sim.admin({ cmd: 'task', text: '实现 app.mjs' });
  await sim.admin({ cmd: 'start' });
  const out = { early: null, accept: null };
  const sha = () => sim.latestManifest('B');
  const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { artifacts: { paths: ['src'] } }, { submit: 'B：完成' }, { wait: {} }, { submit: 'B：汇报' }] });
  const C = createScriptedSeat({
    seatId: 'C',
    script: [
      { wait: {} },
      { do: async (seat, s) => { out.early = await s.admin({ cmd: 'accept-stale', manifestSha: sha() }); } },
      { editFile: { seat: 'B', path: 'src/app.mjs', text: 'export const x = 2; // 冻结后被改\n' } },
      () => ({ submit: `C：我看过了 <<ROOM:VERDICT pass artifact=${sha()}>>` }),
      { do: async (seat, s) => { out.accept = await s.admin({ cmd: 'accept-stale', manifestSha: sha() }); } },
      ...(addFile ? [{ editFile: { seat: 'B', path: 'src/evil.mjs', text: 'export const evil = true;\n' } }] : []),
    ],
  });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} }, { submit: 'A：开题' },
      { wait: {} },
      // C accepts and (optionally) adds the file in one advance, so both precede A's verdict
      { until: (s) => s.ofType('stale_accepted').length > 0 },
      () => ({ verdict: 'pass', artifact: sha(), text: '通过' }),
      { submit: 'A：汇总' },
    ],
  });
  await sim.run([B, C, A]);
  return { sim, sha: sha(), out };
}

test('#16b 用户接受 stale：记 accepted_stale，该 verdict 计入', async () => {
  const r = await scenario();
  const { sim, sha } = r;
  await sim.check(async () => {
    invariants(r);
    // through the real admin queue (lib/admin.mjs), as `admin accept-stale <sha>` does
    const out = [];
    assert.equal(queue(sim.roomDir, 'accept-stale', { manifestSha: sha }, { out: (l) => out.push(l) }), 0);
    assert.match(out[0], /^QUEUED accept-stale/);
    await sim.tick();
    const sa = sim.lastEvent('stale_accepted');
    assert.equal(sa.manifestSha, sha);
    assert.equal(sa.by, 'admin');
    assert.deepEqual(sa.changed.map((c) => c.path), ['src/app.mjs']);
    const v = sim.state().verdicts.find((x) => x.artifactSha === sha);
    assert.equal(v.annotation, 'accepted_stale');
    assert.equal(v.entersSummary, true);
    assert.equal(sim.diskState().verdicts.find((x) => x.artifactSha === sha).annotation, 'accepted_stale', 'state.json shows it too');
    assert.ok(sim.writeLog().some((w) => w.who === 'admin' && /admin-queue/.test(w.path)), 'the request went through the admin queue');
  });
});

test('#16b accept-stale 只接受用户看到的那份变化：复算之前接受被拒（NOT_STALE）；接受之后又多出的文件让 verdict 仍是 stale、不进汇总', async () => {
  const { sim, sha, out } = await acceptThenChange({ addFile: true });
  await sim.check(async () => {
    assert.deepEqual([out.early.ok, out.early.error], [false, 'NOT_STALE'], 'nothing was recomputed yet: nothing to accept');
    assert.equal(out.accept.ok, true);
    const sa = sim.lastEvent('stale_accepted');
    assert.deepEqual(sa.changed.map((c) => c.path), ['src/app.mjs'], 'the acceptance records the change list the user saw');
    const va = sim.lastEvent('verdict_recorded', (e) => e.seatId === 'A');
    assert.equal(va.annotation, 'stale', 'src/evil.mjs appeared after the acceptance');
    assert.equal(va.entersSummary, false);
    assert.equal(va.evidence.reason, 'STALE_CHANGED_SINCE_ACCEPT');
    assert.deepEqual(va.evidence.changed.map((c) => c.path), ['src/app.mjs', 'src/evil.mjs']);
    const sp = sim.lastEvent('summary_published');
    assert.deepEqual(sp.verdicts, [], 'neither verdict enters the summary');
    assert.deepEqual(sp.excluded.map((v) => [v.seatId, v.annotation]).sort(), [['A', 'stale'], ['C', 'not_reviewer']]);
    assert.equal(sp.verified.find((x) => x.artifactSha === sha).verified, false);
  });
});

test('#16b 接受 stale 不抹掉 taint：同时 stale 与 tainted 的 verdict 接受后仍标 tainted，汇总条目带着 taint', async () => {
  const { sim, out } = await acceptThenChange({ addFile: false, audit: tainting });
  await sim.check(async () => {
    assert.equal(out.accept.ok, true);
    const va = sim.lastEvent('verdict_recorded', (e) => e.seatId === 'A');
    assert.deepEqual([va.annotation, va.entersSummary, va.tainted], ['tainted', true, true]);
    assert.deepEqual(va.annotations, ['accepted_stale', 'tainted']);
    const sp = sim.lastEvent('summary_published');
    const inc = sp.verdicts.find((v) => v.seatId === 'A');
    assert.ok(inc, 'the accepted verdict enters the summary');
    assert.equal(inc.tainted, true, 'the summary entry still shows the taint');
    assert.deepEqual(inc.annotations, ['accepted_stale', 'tainted']);
    assert.equal(inc.verified, false, 'a tainted pass is never 已验证');
    assert.equal(sp.verified[0].reason, 'TAINTED');
  });
});
