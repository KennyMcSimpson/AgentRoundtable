// Plan §13.1 #5 (simulation + real; this file is the simulation layer). Two doors: the real seat command
// (lib/seat.mjs cmdSubmit, in-process) writes the record and prints the service's rejection, and a
// hand-written outbox record is rejected the same way. Every out-of-turn record is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSim } from '../../sim/driver.mjs';
import { createScriptedSeat } from '../../sim/scripted-seat.mjs';
import { cmdSubmit } from '../../lib/seat.mjs';

test('#5 Submit when not your turn: rejected and recorded', async () => {
  const sim = await createSim({ preset: 'discussion', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'participant' }] });
  await sim.check(async () => {
    await sim.admin({ cmd: 'task', text: 'Out-of-turn submission' });
    await sim.admin({ cmd: 'start', order: ['A', 'B'] });
    await sim.tick();
    const a1 = sim.holding('A');
    assert.ok(a1, 'A holds the turn');

    // the real seat command: writes the record, and the reason it prints is the room's own
    // rejection (lib/seat.mjs has no local turn refusal, so the service records every attempt)
    const lines = [];
    const body = path.join(sim.cwdOf.B, 'speech.md');
    sim.editFile('B', 'speech.md', 'B speaking out of turn');
    let done = false;
    const pending = cmdSubmit({ seat: sim.seatDir('B'), attempt: a1, file: body }, { out: (l) => lines.push(l), pollMs: 10 }).finally(() => { done = true; });
    for (let i = 0; i < 400 && !done; i++) { await sim.tick(); await new Promise((r) => setTimeout(r, 10)); }
    const code = await pending;
    assert.equal(code, 2, 'exit code 2 (REJECTED)');
    assert.match(lines[0], /^REJECTED reason=NOT_YOUR_TURN/);
    assert.equal(sim.ofType('submission_rejected', (e) => e.seatId === 'B').length, 1, 'the service judged and recorded it');
    assert.ok(fs.existsSync(sim.seatRecord('B').outbox));

    // a record written anyway: rejected by the service and recorded
    const B = createScriptedSeat({ seatId: 'B', script: [{ submit: 'B out-of-turn direct outbox write', attempt: a1 }, { submit: 'B with fabricated attempt', attempt: 'a1-9-000000' }] });
    await sim.run([B]);
    const rej = sim.ofType('submission_rejected', (e) => e.seatId === 'B');
    assert.deepEqual(rej.map((e) => e.reason), ['NOT_YOUR_TURN', 'NOT_YOUR_TURN', 'NOT_YOUR_TURN']);
    assert.deepEqual(rej.map((e) => e.attemptId), [a1, a1, 'a1-9-000000']);
    assert.deepEqual(B.replies.map((r) => r.reply.status), ['REJECTED', 'REJECTED']);
    assert.ok(!sim.ofType('submission_accepted').some((e) => e.seatId === 'B'));
    assert.equal(sim.holding('A'), a1, "A's turn is untouched");
    assert.equal(sim.state().messages.length, 0);
  });
});
