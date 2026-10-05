// Plan §13.1 #29 (仿真 + 真实; this file is the simulation layer), plan §6.4: the voided attempt's
// packet and whatever the seat wrote in it stay in the seat's own session; the room flags them at
// the head of the next packet (void notice naming the attemptId), and after an interrupt the
// superseded speeches are named and no longer forwarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#29 作废后下一回合引用作废内容：下一包带作废声明（含 attemptId），作废 attempt 不产生发言', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '作废内容' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 开题' }, { wait: {} }, { submit: 'A 汇总' }] });
    const B = createScriptedSeat({
      seatId: 'B',
      script: [
        { wait: {} },
        { point: { seq: 2, text: 'VOIDED-POINT 作废回合里提的要点' } },
        { admin: { cmd: 'cancel' } },
        { wait: {} },
        { submit: '正如我上一回合说的 VOIDED-POINT……' },
      ],
    });
    await sim.run([A, B]);
    const [b1, b2] = B.taken;
    const head = sim.packetText(b2);
    assert.ok(head.includes(`作废声明：你上一个 attempt ${b1} 已作废`), 'the next packet names the voided attempt');
    assert.ok(head.includes('不要引用或延续它们'));
    assert.equal(sim.lastEvent('packet_issued', (e) => e.attemptId === b2).voidedAttemptId, b1);
    assert.equal(sim.packetManifest(b2).voidedAttemptId, b1);
    assert.ok(!sim.state().messages.some((m) => m.attemptId === b1), 'the voided attempt produced no message');
    voidedRun = { summaryText: sim.packetText(A.taken[1]), point: sim.ofType('point_added')[0], b1 };
  });
});

let voidedRun = null;
// Only the item table is checked: B's later, accepted speech repeats the words VOIDED-POINT and is
// rightly forwarded to the lead as a speech (it is in the public record); the point from the voided
// attempt is not.
test('#29 作废回合里提交的 point 不进下一包的条目表', () => {
  assert.ok(voidedRun, 'the first #29 test ran');
  assert.equal(voidedRun.point.attemptId, voidedRun.b1);
  const t = voidedRun.summaryText;
  const at = t.indexOf('## 待回应条目表');
  assert.ok(at !== -1, 'the summary packet has an item table');
  const end = t.indexOf('\n## ', at + 1);
  const table = t.slice(at, end === -1 ? undefined : end);
  assert.ok(!table.includes(voidedRun.point.itemId), `the voided point's item ${voidedRun.point.itemId} is not in the item table`);
  assert.ok(!table.includes('作废回合里提的要点'), 'the voided point text is not in the item table');
});

test('#29 打断重开后：被取代的发言不再转发，下一包列出被取代的 seq', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '打断' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'OLD-OPENING 旧方向开题' }] })]);
    const r = await sim.admin({ cmd: 'interrupt', text: '改成方向二' });
    assert.deepEqual(r.supersededSeqs, [2]);
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: '新方向开题' }] });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }] });
    await sim.run([A, B]);
    for (const t of [A.packetText, B.packetText]) {
      assert.ok(!t.includes('OLD-OPENING'), 'superseded speech is not forwarded');
      assert.match(t, /本轮已在 epoch 1 重开。之前发出的包里 seq 2 的发言已被取代，不要再依据它们/);
    }
  });
});

test('#29 引用被取代（作废）内容的 quote 被标出', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  try {
    await sim.admin({ cmd: 'task', text: '打断后引用' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'OLD-OPENING 旧方向开题' }] })]);
    await sim.admin({ cmd: 'interrupt', text: '改方向' });
    const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { quote: { seq: 2, text: 'OLD-OPENING 旧方向开题' } }] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: '新开题' }] }), B]);
    const q = sim.lastEvent('quote_submitted');
    assert.ok(q.verified === false || (q.reason && q.reason !== 'ok'), `quote of superseded seq 2 flagged (got verified=${q.verified} reason=${q.reason})`);
  } finally { await sim.cleanup(); }
});

test('#29 打断后被取代回合里提的要点（指向更早一轮的发言）不进重开后的条目表', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '打断与要点' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const reopened = (s) => s.ofType('round_reopened').length > 0;
    const A = createScriptedSeat({
      seatId: 'A',
      script: [
        { wait: {} }, { submit: 'A 第一轮开题（seq 2）' }, { wait: {} }, { submit: 'A 第一轮汇总（seq 4）' },
        { admin: { cmd: 'start', order: ['A', 'B'] } },
        { wait: {} }, { submit: 'A 第二轮开题（seq 5）' },
        { until: reopened },
        { wait: {} }, { submit: 'A 重开后开题' }, { wait: {} }, { submit: 'A 第二轮汇总' },
      ],
    });
    const B = createScriptedSeat({
      seatId: 'B',
      script: [
        { wait: {} }, { submit: 'B 第一轮发言（seq 3）' },
        { wait: {} }, { submit: 'B 第二轮（seq 6）<<ROOM:POINT seq=3>>第一轮的问题还没解决' },
        { admin: { cmd: 'interrupt' } },
        { wait: {} }, { submit: 'B 重开后发言，不提要点' },
      ],
    });
    await sim.run([A, B]);
    const pt = sim.lastEvent('point_added');
    assert.deepEqual([pt.itemId, pt.aboutSeq], ['m3p1', 3]);
    const rr = sim.lastEvent('round_reopened');
    assert.deepEqual(rr.supersededSeqs, [5, 6]);
    assert.equal(sim.state().points.find((p) => p.itemId === 'm3p1').voided, true, 'kept, flagged, so the id is never reused');
    const sp = sim.lastEvent('summary_published');
    assert.equal(sp.version, 2);
    assert.ok(!sp.unanswered.includes('m3p1'), 'the superseded turn\'s point is not an item of the reopened round');
    const pkt = sim.packetText(A.taken[A.taken.length - 1]);
    assert.ok(!pkt.includes('| m3p1 |'), 'nor is it in the summary packet\'s table');
  });
});
