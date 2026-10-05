// Plan §13.1 #6a (仿真): a seat that does not hand in before its wall clock. Plan §4.3 rule 7: the
// room does not drop the seat on its own; the turn holds until the user waits (retry), skips or
// reassigns, and only an explicit skip puts the absence into the summary, with a marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#6a 席位超时未交卷：expired；回合停住等用户决定（等 / 跳过 / 改派），跳过的席位在汇总里带缺席标记', async () => {
  const sim = await createSim({
    preset: 'discussion', init: { wall: 60 },
    seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }, { seatId: 'C', role: 'participant' }, { seatId: 'D', role: 'participant' }],
  });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '超时处理' });
    await sim.admin({ cmd: 'start', order: ['A', 'B', 'C', 'D'] });
    await sim.tick();
    const a1 = sim.holding('A');
    assert.ok(a1);

    // 等: before the deadline the attempt stays open
    sim.clock.advance(30_000);
    await sim.tick(2);
    assert.equal(sim.state().attemptLog[a1].status, 'pending', 'before the wall clock the user can simply wait');
    assert.equal(sim.ofType('attempt_expired').length, 0);

    // 超时: past the deadline -> expired, and the turn does NOT move on by itself
    sim.clock.advance(31_000);
    await sim.tick();
    const ex = sim.lastEvent('attempt_expired');
    assert.equal(ex && ex.attemptId, a1);
    assert.equal(ex.hold, true);
    assert.equal(sim.state().attemptLog[a1].status, 'expired');
    assert.deepEqual([sim.state().awaitingDecision.seatId, sim.state().awaitingDecision.attemptId], ['A', a1]);
    await sim.tick(3);
    assert.equal(sim.holding('B'), null, 'no packet for B until the user decides');
    assert.equal(sim.holding('A'), null);
    assert.equal(sim.ofType('packet_issued').length, 1);

    // 等（retry）: the same seat gets a fresh attempt for the same turn; the packet names the expired one
    const rr = await sim.admin({ cmd: 'retry' });
    assert.equal(rr.ok, true);
    const a2 = sim.holding('A');
    assert.ok(a2 && a2 !== a1);
    assert.equal(sim.state().awaitingDecision, null);
    assert.match(sim.packetText(a2), new RegExp(`作废声明：你上一个 attempt ${a1} 已作废`));
    assert.equal((await sim.admin({ cmd: 'retry' })).error, 'NO_DECISION_PENDING');
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 重试后开题' }] });
    await sim.run([A]);
    const b1 = sim.holding('B');
    assert.ok(b1, 'B is next once A spoke');

    // B also runs out; 跳过: the user skips B
    sim.clock.advance(61_000);
    await sim.tick();
    assert.equal(sim.state().awaitingDecision.seatId, 'B');
    assert.equal(sim.holding('C'), null);
    assert.equal((await sim.admin({ cmd: 'skip' })).ok, true);
    const sk = sim.lastEvent('seat_skipped');
    assert.deepEqual([sk.seatId, sk.by], ['B', 'admin']);
    assert.equal(sim.state().awaitingDecision, null);
    const c1 = sim.holding('C');
    assert.ok(c1, 'C is next after the skip');

    // C runs out; 改派: the user hands C's turn to D
    sim.clock.advance(61_000);
    await sim.tick();
    assert.equal(sim.state().awaitingDecision.seatId, 'C');
    assert.equal((await sim.admin({ cmd: 'reassign', seatId: 'C', toSeatId: 'D', text: 'C 无响应，改由 D 回答' })).ok, true);
    assert.equal(sim.state().attemptLog[c1].status, 'expired');
    sim.assertEvents([{ type: 'epoch_bumped', reason: 'reassign', fromSeat: 'C', toSeat: 'D' }]);
    assert.equal(sim.state().awaitingDecision, null);
    const D = createScriptedSeat({ seatId: 'D', script: [{ wait: {} }, { submit: 'D 接手 C 的回合' }, { wait: {} }, { submit: 'D 自己的回合' }] });
    await sim.run([D]);
    assert.match(sim.packetText(D.taken[0]), /改派说明：C 无响应，改由 D 回答/);
    assert.equal(sim.state().epoch, 1);
    // A's late hand-in for the expired attempt is refused; the summary packet carries the marker
    const A2 = createScriptedSeat({ seatId: 'A', script: [{ submit: '迟到的开题', attempt: a1 }, { wait: {} }, { submit: 'A 的汇总：B 缺席' }] });
    await sim.run([A2]);
    assert.equal(A2.replies[0].reply.reason, 'STALE_ATTEMPT');
    assert.match(sim.packetText(A2.taken[0]), /缺席标记：席位 B 在 meet 阶段由用户跳过/);
    const sp = sim.lastEvent('summary_published');
    assert.deepEqual(sp.absent, [{ seatId: 'B', phase: 'meet', by: 'admin', attemptId: null }], 'only the explicit skip is an absence, with its marker');
    assert.equal(sim.lastEvent('round_done').summary, 'published');
  });
});

test('#6a 对照：无预设（P-1）房间不设决定闸门，超时后照旧轮到下一位', async () => {
  const sim = await createSim({ init: { wall: 60 }, seats: [{ seatId: 'A', role: 'participant' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'p-1' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.tick();
    sim.clock.advance(61_000);
    await sim.tick();
    assert.equal(sim.lastEvent('attempt_expired').hold, undefined);
    assert.ok(sim.holding('B'));
  });
});
