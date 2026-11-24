// Plan §13.1 #27 (simulation): invalid topologies are refused when the room is built (lib/admin.mjs
// cmdAddSeat runs lib/supervision.mjs validateRoom on the candidate room).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim } from '../../sim/driver.mjs';
import { validateRoom } from '../../lib/supervision.mjs';

const roomJson = (sim) => JSON.parse(fs.readFileSync(path.join(sim.roomDir, 'room.json'), 'utf8'));

test('#27 Executor designated as lead: room setup fails (admin add-seat refuses, room.json unchanged)', async () => {
  const sim = await createSim({ preset: 'implement-review', start: false, seats: [{ seatId: 'A', role: 'lead' }] });
  await sim.check(async () => {
    // the room names B as its lead before B is added as an executor
    sim.patchRoom({ leadSeatId: 'B' });
    const before = fs.readFileSync(path.join(sim.roomDir, 'room.json'), 'utf8');
    assert.throws(() => sim.addSeat({ seatId: 'B', role: 'executor' }), (e) => /Invalid room configuration/.test(e.message) && /Executor seat B cannot also be lead/.test(e.message));
    assert.equal(fs.readFileSync(path.join(sim.roomDir, 'room.json'), 'utf8'), before, 'room.json unchanged');
    assert.ok(!fs.existsSync(path.join(sim.roomDir, 'seats', 'B')), 'no seat directory for B');
    // the same rule as a pure check
    const v = validateRoom({ preset: 'implement-review', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor', lead: true }] });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.code === 'EXECUTOR_IS_LEAD'));
  });
});

test('#27 B reviews C and C reviews B: review cycle detected, room setup fails', async () => {
  const sim = await createSim({ preset: 'division', start: false, seats: [{ seatId: 'A', role: 'lead' }] });
  await sim.check(async () => {
    const out = sim.addSeat({ seatId: 'B', role: 'executor', reviews: ['C'] });
    assert.ok(out.some((l) => /Note \(resolve before starting\): Seat B declares review of non-existent seat C/.test(l)), 'a forward reference is only a hint while seats are being added');
    const before = roomJson(sim);
    assert.throws(() => sim.addSeat({ seatId: 'C', role: 'executor', reviews: ['B'] }), (e) => /Invalid room configuration/.test(e.message) && /Review cycle detected/.test(e.message));
    assert.deepEqual(roomJson(sim).seats.map((s) => s.seatId), before.seats.map((s) => s.seatId), 'C was not added');
    assert.deepEqual(roomJson(sim).seats.map((s) => s.seatId), ['A', 'B']);
    // a valid alternative is accepted: C reviewed by the lead by default
    sim.addSeat({ seatId: 'D', role: 'executor' });
    assert.deepEqual(roomJson(sim).seats.map((s) => s.seatId), ['A', 'B', 'D']);
  });
});

test('#27 Lead/reviewer taking Work and multiple reviewers for one artifact: refused at room setup', async () => {
  const sim = await createSim({ preset: 'implement-review', start: false, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor' }, { seatId: 'R', role: 'reviewer', reviews: ['B'] }] });
  await sim.check(async () => {
    assert.throws(() => sim.addSeat({ seatId: 'S', role: 'reviewer', reviews: ['B'] }), (e) => /have 2 reviewers/.test(e.message));
    const v = validateRoom({ preset: 'implement-review', seats: [{ seatId: 'A', role: 'lead', takesWork: true }, { seatId: 'R', role: 'reviewer', takesWork: true }, { seatId: 'B', role: 'executor' }] });
    assert.deepEqual(v.errors.map((e) => e.code).sort(), ['LEAD_TAKES_WORK', 'REVIEWER_TAKES_WORK']);
  });
});
