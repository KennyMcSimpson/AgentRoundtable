// Plan §13.1 #27 (仿真): invalid topologies are refused when the room is built (lib/admin.mjs
// cmdAddSeat runs lib/supervision.mjs validateRoom on the candidate room).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim } from '../../sim/driver.mjs';
import { validateRoom } from '../../lib/supervision.mjs';

const roomJson = (sim) => JSON.parse(fs.readFileSync(path.join(sim.roomDir, 'room.json'), 'utf8'));

test('#27 执行席位被指定为主力：建房失败（admin add-seat 拒绝，room.json 不变）', async () => {
  const sim = await createSim({ preset: 'implement-review', start: false, seats: [{ seatId: 'A', role: 'lead' }] });
  await sim.check(async () => {
    // the room names B as its lead before B is added as an executor
    sim.patchRoom({ leadSeatId: 'B' });
    const before = fs.readFileSync(path.join(sim.roomDir, 'room.json'), 'utf8');
    assert.throws(() => sim.addSeat({ seatId: 'B', role: 'executor' }), (e) => /房间配置不成立/.test(e.message) && /执行席位 B 不能兼主力/.test(e.message));
    assert.equal(fs.readFileSync(path.join(sim.roomDir, 'room.json'), 'utf8'), before, 'room.json unchanged');
    assert.ok(!fs.existsSync(path.join(sim.roomDir, 'seats', 'B')), 'no seat directory for B');
    // the same rule as a pure check
    const v = validateRoom({ preset: 'implement-review', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor', lead: true }] });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.code === 'EXECUTOR_IS_LEAD'));
  });
});

test('#27 B 审 C 且 C 审 B：审查边成环，建房失败', async () => {
  const sim = await createSim({ preset: 'division', start: false, seats: [{ seatId: 'A', role: 'lead' }] });
  await sim.check(async () => {
    const out = sim.addSeat({ seatId: 'B', role: 'executor', reviews: ['C'] });
    assert.ok(out.some((l) => /提示（建房完成前需解决）：席位 B 声明审查不存在的席位 C/.test(l)), 'a forward reference is only a hint while seats are being added');
    const before = roomJson(sim);
    assert.throws(() => sim.addSeat({ seatId: 'C', role: 'executor', reviews: ['B'] }), (e) => /房间配置不成立/.test(e.message) && /审查边成环/.test(e.message));
    assert.deepEqual(roomJson(sim).seats.map((s) => s.seatId), before.seats.map((s) => s.seatId), 'C was not added');
    assert.deepEqual(roomJson(sim).seats.map((s) => s.seatId), ['A', 'B']);
    // a valid alternative is accepted: C reviewed by the lead by default
    sim.addSeat({ seatId: 'D', role: 'executor' });
    assert.deepEqual(roomJson(sim).seats.map((s) => s.seatId), ['A', 'B', 'D']);
  });
});

test('#27 主力 / 审方领活、一份产物两个审方：同样在建房时被拒', async () => {
  const sim = await createSim({ preset: 'implement-review', start: false, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor' }, { seatId: 'R', role: 'reviewer', reviews: ['B'] }] });
  await sim.check(async () => {
    assert.throws(() => sim.addSeat({ seatId: 'S', role: 'reviewer', reviews: ['B'] }), (e) => /有 2 个审方/.test(e.message));
    const v = validateRoom({ preset: 'implement-review', seats: [{ seatId: 'A', role: 'lead', takesWork: true }, { seatId: 'R', role: 'reviewer', takesWork: true }, { seatId: 'B', role: 'executor' }] });
    assert.deepEqual(v.errors.map((e) => e.code).sort(), ['LEAD_TAKES_WORK', 'REVIEWER_TAKES_WORK']);
  });
});
