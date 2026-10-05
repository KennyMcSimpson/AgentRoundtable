// Plan §13.1 #19 (仿真): the service dies mid-append and leaves a torn last line in events.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim, attemptOutcomes } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { rebuild } from '../../lib/reducer.mjs';

test('#19 撕裂的 events.jsonl 尾行：恢复到最后一条完整事件，之后的事件从新行续写', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: '撕裂尾行' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.run([createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 开题' }] })]);
    const before = sim.events();
    const lastComplete = before[before.length - 1].seq;
    await sim.crashService();
    sim.appendRaw('events.jsonl', `{"seq":${lastComplete + 1},"ts":"2026-10-01T08:00:09.000Z","type":"submission_acc`);
    const raw = fs.readFileSync(path.join(sim.roomDir, 'events.jsonl'), 'utf8');
    assert.ok(!raw.endsWith('\n'), 'the file now ends in a torn line');
    assert.equal(rebuild(sim.roomDir).state.lastSeq, lastComplete, 'rebuild stops at the last complete event');

    await sim.restartService();
    assert.ok(sim.logs.some((l) => /torn line/.test(l)), 'the service says it found a torn line');
    assert.equal(sim.state().lastSeq, lastComplete + 1, 'rebuilt to the last complete event, plus the one needs_reconcile written at start');
    // B held its turn when the service died: needs_reconcile, replay, and the room continues
    const b1 = sim.holding('B');
    assert.ok(b1);
    assert.equal(sim.lastEvent('needs_reconcile').seq, lastComplete + 1, 'the next event takes the next seq on a fresh line');
    await sim.admin({ cmd: 'reconcile', attemptId: b1, action: 'replay' });
    await sim.run([
      createScriptedSeat({ seatId: 'B', script: [{ submit: 'B 发言', attempt: b1 }] }),
      createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'A 汇总' }] }),
    ]);
    const lines = fs.readFileSync(path.join(sim.roomDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    assert.equal(parsed.filter((x) => x === null).length, 1, 'exactly one unparseable (torn) line stays in the file');
    const seqs = parsed.filter(Boolean).map((e) => e.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'complete events have contiguous seqs');
    assert.deepEqual(JSON.parse(JSON.stringify(rebuild(sim.roomDir).state)), JSON.parse(JSON.stringify(sim.svc.state)), 'rebuild equals the live state');
    for (const o of attemptOutcomes(sim.events())) assert.equal(o.terminals.length, 1);
    assert.equal(sim.lastEvent('round_done').summary, 'published');
  });
});
