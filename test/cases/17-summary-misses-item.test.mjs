// Plan §13.1 #17 (仿真 +变异). Mutation: test/mutations/17-no-unanswered.test.mjs (ROOM_MUTATE
// no-unanswered: the room stops computing summary_published.unanswered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, isMain } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

export async function scenario({ mutate } = {}) {
  const sim = await createSim({ preset: 'discussion', mutate, seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }, { seatId: 'C', role: 'participant' }] });
  await sim.admin({ cmd: 'task', text: '条目表' });
  await sim.admin({ cmd: 'start', order: ['A', 'B', 'C'] });
  const A = createScriptedSeat({
    seatId: 'A',
    script: [
      { wait: {} }, { submit: 'A：开题（seq 2）' },
      { wait: {} },
      { mark: { item: 'm2p1', status: 'accepted', text: '收下 B 的要点' } },
      { mark: { item: 'm4', status: 'deferred', text: '下一轮再议' } },
      { submit: 'A：汇总，漏掉了 B 的第二个要点和 B 的发言本身' },
    ],
  });
  const B = createScriptedSeat({
    seatId: 'B',
    script: [
      { wait: {} },
      { point: { seq: 2, text: '开题缺验收标准' } },
      { point: { seq: 2, text: '开题没写回滚' } },
      { submit: 'B：两点意见（seq 3）' },
    ],
  });
  const C = createScriptedSeat({ seatId: 'C', script: [{ wait: {} }, { submit: 'C：同意（seq 4）' }] });
  await sim.run([A, B, C]);
  return { sim, A, B, C };
}

export function invariants({ sim, A, B }) {
  assert.deepEqual(B.replies.slice(0, 2).map((r) => r.reply.item), ['m2p1', 'm2p2']);
  const pkt = sim.packetText(A.taken[1]);
  for (const id of ['m2p1', 'm2p2', 'm3', 'm4']) assert.ok(pkt.includes(`| ${id} |`), `item ${id} is in the summary packet's table`);
  const sp = sim.lastEvent('summary_published');
  assert.deepEqual([...sp.unanswered].sort(), ['m2p2', 'm3'], 'the two items the lead did not mark are unanswered');
  assert.deepEqual(sim.ofType('item_marked').map((e) => [e.itemId, e.status]), [['m2p1', 'accepted'], ['m4', 'deferred']]);
  assert.equal(sp.version, 1);
}

if (isMain(import.meta.url)) {
  test('#17 汇总漏一条：漏标的条目被标为未回应（summary_published.unanswered）', async () => {
    const r = await scenario();
    await r.sim.check(() => invariants(r));
  });

  test('#17 只有汇总回合的牵头席位能标条目：参与者在 Meet 里给自己的条目标 accepted 不算数，仍是未回应', async () => {
    const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }, { seatId: 'C', role: 'participant' }] });
    await sim.check(async () => {
      await sim.admin({ cmd: 'task', text: '条目标记权限' });
      await sim.admin({ cmd: 'start', order: ['A', 'B', 'C'] });
      const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A：开题（seq 2）' }, { wait: {} }, { submit: 'A：汇总，没有标任何条目' }] });
      const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B：意见（seq 3）' }] });
      const C = createScriptedSeat({
        seatId: 'C',
        script: [{ wait: {} }, { mark: { item: 'm3', status: 'rejected', text: '命令通道' } }, { submit: 'C：意见（seq 4）<<ROOM:MARK item=m4 status=accepted>>我自己的条目已解决' }],
      });
      await sim.run([A, B, C]);
      assert.equal(sim.ofType('item_marked').length, 0, 'no mark from a non-lead seat is recorded');
      const cReply = C.replies.find((r) => r.kind === 'speech').reply;
      assert.equal(cReply.status, 'ACCEPTED');
      const note = cReply.notes.find((n) => n.code === 'mark_not_permitted');
      assert.deepEqual([...note.items].sort(), ['m3', 'm4']);
      const sp = sim.lastEvent('summary_published');
      assert.deepEqual([...sp.unanswered].sort(), ['m3', 'm4'], "C's own mark does not answer its item");
    });
  });

  // GOV-6: the lead files its own point about B's message and marks that point in the same summary
  // turn. The point is the lead's paraphrase, not B's item: B's m3 stays and stays unanswered.
  test('#17 汇总者给别人的发言加一条自己的要点再标掉：原条目 m3 仍在，仍是未回应', async () => {
    const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
    await sim.check(async () => {
      await sim.admin({ cmd: 'task', text: '条目替换' });
      await sim.admin({ cmd: 'start', order: ['A', 'B'] });
      const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A：开题（seq 2）' }, { wait: {} }, { submit: 'A：汇总 <<ROOM:POINT seq=3>> 无关紧要 <<ROOM:MARK item=m3p1 status=rejected>>' }] });
      const B = createScriptedSeat({ seatId: 'B', script: [{ wait: {} }, { submit: 'B：要害意见（seq 3）' }] });
      await sim.run([A, B]);
      assert.ok(sim.ofType('point_added').some((e) => e.itemId === 'm3p1' && e.seatId === 'A'), "the lead's point was recorded");
      const sp = sim.lastEvent('summary_published');
      assert.ok(sp, 'the summary was published');
      assert.ok(sp.unanswered.includes('m3'), `B's own item m3 is still unanswered: ${JSON.stringify(sp.unanswered)}`);
      assert.ok(!sim.ofType('item_marked').some((e) => e.itemId === 'm3'), 'nothing marked m3 itself');
    });
  });
}
