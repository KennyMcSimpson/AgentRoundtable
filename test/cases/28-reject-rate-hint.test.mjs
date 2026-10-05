// Plan §13.1 #28 (仿真): seven rooms, two authorized passes each, one shared cross-room
// adjudications.jsonl (injected path inside this case's own directory, never the real appRoot()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim, IR_SEATS, runToSummary } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { testRunsRoot, randomHex, readJsonl } from '../../lib/common.mjs';
import { cmdShow } from '../../lib/admin.mjs';

async function passRound(sim, round) {
  if (round > 1) sim.clock.advance(1000); // a new declaration time -> a new manifest to judge
  const { sha } = await runToSummary(sim, { task: `第 ${round} 轮实现` });
  await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { verdict: 'pass', artifact: sha, text: '通过' }, { submit: `第 ${round} 轮汇总` }] })]);
  return sha;
}

test('#28 跨 7 个房间各 2 次 pass：n=14 且零驳回时提示出现；n<14 显示样本不足', async () => {
  const shared = path.join(testRunsRoot(), `adj-${randomHex(5)}`);
  const adjudicationsPath = path.join(shared, 'adjudications.jsonl');
  try {
    let last = null;
    for (let room = 1; room <= 7; room++) {
      const sim = await createSim({ preset: 'implement-review', seats: IR_SEATS, adjudicationsPath, id: `adj${room}` });
      await sim.check(async () => {
        const s1 = await passRound(sim, 1);
        const s2 = await passRound(sim, 2);
        assert.notEqual(s1, s2);
        assert.equal(sim.ofType('verdict_recorded', (e) => e.verdict === 'pass' && e.authorized === true).length, 2);
        const sig = sim.state().adjudications;
        assert.equal(sig.n, room * 2);
        assert.equal(sig.k, 0);
        if (room < 7) {
          assert.equal(sig.status, 'insufficient');
          assert.equal(sig.hint, `样本不足（${room * 2}/14）`);
        } else {
          assert.equal(sig.status, 'suspicious');
          assert.match(sig.hint, /^审方可能没在工作：14 次 verdict 零驳回/);
          showLines = [];
          cmdShow({ dir: sim.roomDir, adjudications: adjudicationsPath, messages: false }, { out: (l) => showLines.push(l) });
        }
        last = sig;
      });
    }
    const entries = readJsonl(adjudicationsPath);
    assert.equal(entries.length, 14);
    assert.equal(new Set(entries.map((e) => e.roomId)).size, 7);
    assert.ok(entries.every((e) => e.verdict === 'pass' && e.reviewerAgent === 'generic' && e.preset === 'implement-review'));
    assert.equal(last.status, 'suspicious');
  } finally {
    if (!process.env.ROOM_SIM_KEEP) fs.rmSync(shared, { recursive: true, force: true });
  }
});

let showLines = null;
test('#28 admin show 也打印同一条提示（默认审方 = 主力）', () => {
  assert.ok(showLines, 'the 7-room test ran first');
  assert.ok(showLines.some((l) => /^reject_rate agent=generic preset=implement-review n=14 k=0 status=suspicious 审方可能没在工作/.test(l)), `admin show prints the hint; got: ${showLines.filter((l) => /reject_rate/.test(l)).join(' | ')}`);
});
