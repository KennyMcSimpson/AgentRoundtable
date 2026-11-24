// Plan §13.1 #32 (simulation + real; this file is the simulation layer): two Work seats in one directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { isInside } from '../../lib/common.mjs';

test('#32 Two seats share a working directory and edit the same file: warning on add-seat; conflicts listed in UI state, room never auto-merges', async () => {
  const sim = await createSim({
    preset: 'implement-review',
    seats: [
      { seatId: 'A', role: 'lead' },
      { seatId: 'B', role: 'executor', files: { 'shared.txt': 'v0\n', 'b-only.txt': 'b\n' } },
      { seatId: 'C', role: 'executor', cwdOf: 'B', files: { 'c-only.txt': 'c\n' } },
    ],
  });
  await sim.check(async () => {
    assert.ok(sim.seatOutput.C.some((l) => /seat\(s\) B share this working directory/.test(l)), 'admin add-seat warns about the shared directory');
    await sim.admin({ cmd: 'task', text: 'Two seats in same directory' });
    await sim.admin({ cmd: 'start' });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { editFile: { path: 'shared.txt', text: 'Version edited by B\n' } }, { artifacts: { paths: ['shared.txt', 'b-only.txt'] } }, { submit: 'B done' }] });
    const C = createScriptedSeat({ seatId: 'C', script: [{ wait: {} }, { ticks: 2 }, { editFile: { path: 'shared.txt', text: 'Version edited by C\n' } }, { artifacts: { paths: ['shared.txt', 'c-only.txt'] } }, { submit: 'C done' }] });
    await sim.run([B, C]);
    const v = sim.state();
    assert.equal(v.conflicts.length, 1, `one conflict: ${JSON.stringify(v.conflicts)}`);
    assert.equal(v.conflicts[0].path, 'shared.txt');
    assert.deepEqual([...v.conflicts[0].seats].sort(), ['B', 'C']);
    assert.match(v.conflicts[0].detail, /never auto-merges/);
    assert.deepEqual(sim.diskState().conflicts, v.conflicts, 'state.json (what the UI reads) carries the conflict');
    assert.equal(fs.readFileSync(path.join(sim.cwdOf.B, 'shared.txt'), 'utf8'), 'Version edited by C\n', 'the room did not touch the file');
    const wl = sim.writeLog();
    assert.ok(wl.length > 0);
    assert.ok(!wl.some((w) => isInside(w.path, sim.cwdOf.B)), 'no room write inside the shared directory');
    // the two frozen snapshots keep each seat's own version
    const shaB = sim.ofType('artifacts_frozen', (e) => e.seatId === 'B')[0].manifestSha;
    const shaC = sim.ofType('artifacts_frozen', (e) => e.seatId === 'C')[0].manifestSha;
    assert.equal(fs.readFileSync(path.join(sim.roomDir, 'snapshots', 'B', shaB, 'shared.txt'), 'utf8'), 'Version edited by B\n');
    assert.equal(fs.readFileSync(path.join(sim.roomDir, 'snapshots', 'C', shaC, 'shared.txt'), 'utf8'), 'Version edited by C\n');
  });
});

test('#32 Division mode: two seats sharing a working directory in task sheet require explicit confirmation (CONFIRM_REQUIRED)', async () => {
  const sim = await createSim({
    preset: 'division',
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor', files: { 'x.txt': 'x\n' } }, { seatId: 'C', role: 'executor', cwdOf: 'B' }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Division' });
    await sim.admin({ cmd: 'start' });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { assign: '- B: edit first half of x.txt | acceptance: ["git","status"]\n- C: edit second half of x.txt | acceptance: ["git","status"]\n' }, { submit: 'Task draft submitted via assign' }] });
    await sim.run([A]);
    assert.equal(sim.lastEvent('task_drafted').draft.assignments.length, 2);
    const r1 = await sim.admin({ cmd: 'confirm-task' });
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'CONFIRM_REQUIRED');
    assert.match(r1.message, /share the same working directory/);
    assert.equal(sim.state().phase, 'assign', 'the room stays before Work');
    assert.equal(sim.ofType('task_confirmed').length, 0);
    const r2 = await sim.admin({ cmd: 'confirm-task', confirmSameCwd: true });
    assert.equal(r2.ok, true);
    await sim.tick();
    assert.equal(sim.state().phase, 'work');
    assert.ok(sim.lastEvent('task_confirmed').warnings.some((w) => w.code === 'SAME_CWD'));
  });
});
