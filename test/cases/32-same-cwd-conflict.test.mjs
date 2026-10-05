// Plan §13.1 #32 (仿真 + 真实; this file is the simulation layer): two Work seats in one directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { isInside } from '../../lib/common.mjs';

test('#32 两席位声明同一目录并改同一文件：建席时警告；冲突列在界面状态里（conflicts），房间不合并', async () => {
  const sim = await createSim({
    preset: 'implement-review',
    seats: [
      { seatId: 'A', role: 'lead' },
      { seatId: 'B', role: 'executor', files: { 'shared.txt': 'v0\n', 'b-only.txt': 'b\n' } },
      { seatId: 'C', role: 'executor', cwdOf: 'B', files: { 'c-only.txt': 'c\n' } },
    ],
  });
  await sim.check(async () => {
    assert.ok(sim.seatOutput.C.some((l) => /席位 B 用同一个工作目录/.test(l)), 'admin add-seat warns about the shared directory');
    await sim.admin({ cmd: 'task', text: '同目录两席位' });
    await sim.admin({ cmd: 'start' });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { editFile: { path: 'shared.txt', text: 'B 改的版本\n' } }, { artifacts: { paths: ['shared.txt', 'b-only.txt'] } }, { submit: 'B 完成' }] });
    const C = createScriptedSeat({ seatId: 'C', script: [{ wait: {} }, { ticks: 2 }, { editFile: { path: 'shared.txt', text: 'C 改的版本\n' } }, { artifacts: { paths: ['shared.txt', 'c-only.txt'] } }, { submit: 'C 完成' }] });
    await sim.run([B, C]);
    const v = sim.state();
    assert.equal(v.conflicts.length, 1, `one conflict: ${JSON.stringify(v.conflicts)}`);
    assert.equal(v.conflicts[0].path, 'shared.txt');
    assert.deepEqual([...v.conflicts[0].seats].sort(), ['B', 'C']);
    assert.match(v.conflicts[0].detail, /房间不自动合并/);
    assert.deepEqual(sim.diskState().conflicts, v.conflicts, 'state.json (what the UI reads) carries the conflict');
    assert.equal(fs.readFileSync(path.join(sim.cwdOf.B, 'shared.txt'), 'utf8'), 'C 改的版本\n', 'the room did not touch the file');
    const wl = sim.writeLog();
    assert.ok(wl.length > 0);
    assert.ok(!wl.some((w) => isInside(w.path, sim.cwdOf.B)), 'no room write inside the shared directory');
    // the two frozen snapshots keep each seat's own version
    const shaB = sim.ofType('artifacts_frozen', (e) => e.seatId === 'B')[0].manifestSha;
    const shaC = sim.ofType('artifacts_frozen', (e) => e.seatId === 'C')[0].manifestSha;
    assert.equal(fs.readFileSync(path.join(sim.roomDir, 'snapshots', 'B', shaB, 'shared.txt'), 'utf8'), 'B 改的版本\n');
    assert.equal(fs.readFileSync(path.join(sim.roomDir, 'snapshots', 'C', shaC, 'shared.txt'), 'utf8'), 'C 改的版本\n');
  });
});

test('#32 分工模式：任务单里两席位同一工作目录 -> 确认任务单要用户显式确认（CONFIRM_REQUIRED）', async () => {
  const sim = await createSim({
    preset: 'division',
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor', files: { 'x.txt': 'x\n' } }, { seatId: 'C', role: 'executor', cwdOf: 'B' }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '分工' });
    await sim.admin({ cmd: 'start' });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { assign: '- B: 改 x.txt 的前半 | 验收: ["git","status"]\n- C: 改 x.txt 的后半 | 验收: ["git","status"]\n' }, { submit: '任务单草案见 assign' }] });
    await sim.run([A]);
    assert.equal(sim.lastEvent('task_drafted').draft.assignments.length, 2);
    const r1 = await sim.admin({ cmd: 'confirm-task' });
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'CONFIRM_REQUIRED');
    assert.match(r1.message, /同一个工作目录/);
    assert.equal(sim.state().phase, 'assign', 'the room stays before Work');
    assert.equal(sim.ofType('task_confirmed').length, 0);
    const r2 = await sim.admin({ cmd: 'confirm-task', confirmSameCwd: true });
    assert.equal(r2.ok, true);
    await sim.tick();
    assert.equal(sim.state().phase, 'work');
    assert.ok(sim.lastEvent('task_confirmed').warnings.some((w) => w.code === 'SAME_CWD'));
  });
});
