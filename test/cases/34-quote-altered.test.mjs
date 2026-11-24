// Plan §13.1 #34 (simulation), §7.4: quotes are checked verbatim against the quoted seq.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';

test('#34 Quote with an altered word: flagged (verified=false, not_verbatim); verbatim quote verified=true', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Quote verification' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    const A = createScriptedSeat({ seatId: 'A', script: [{ wait: {} }, { submit: 'We decided to do a canary rollout first, then a full launch.' }, { wait: {} }, { submit: 'Summary' }] });
    const B = createScriptedSeat({
      seatId: 'B',
      script: [
        { wait: {} },
        { quote: { seq: 2, text: 'canary rollout first, then a full launch' } },
        { quote: { seq: 2, text: 'canary rollout first, then a complete launch' } },
        { quote: { seq: 9, text: 'nonexistent message' } },
        { submit: '<<ROOM:QUOTE seq=2>>We decided to do a gray rollout<<ROOM:END>> altered inline quote' },
      ],
    });
    await sim.run([A, B]);
    const [ok, changed, missing] = B.replies.slice(0, 3).map((r) => r.reply);
    assert.deepEqual([ok.verified, ok.reason], [true, 'ok']);
    assert.deepEqual([changed.verified, changed.reason], [false, 'not_verbatim']);
    assert.deepEqual([missing.verified, missing.reason], [false, 'seq_not_found']);
    const qs = sim.ofType('quote_submitted');
    assert.deepEqual(qs.map((q) => [q.quotedSeq, q.verified]), [[2, true], [2, false], [9, false], [2, false]]);
    assert.equal(qs[3].reason, 'not_verbatim', 'the text-marker form is checked the same way');
    assert.ok(sim.state().quotes.filter((q) => !q.verified).length === 3, 'the flags are in the state the UI reads');
  });
});
