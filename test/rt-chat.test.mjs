// Unit tests for ui/rt-chat.js and ui/rt-i18n.js (group-chat projection, MARK folding/rollback,
// Arena comparison, Approval Inbox, IME-safe composer, and forbidden-word invariant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnClean } from '../lib/spawn.mjs';
import { loadFixture } from '../ui/mock-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI = path.join(ROOT, 'ui');

function loadStack() {
  const sandbox = { URL, Map, Set };
  for (const file of ['rt-i18n.js', 'rt-protocol.js', 'rt-markdown.js', 'rt-chat.js', 'app.js']) {
    const code = fs.readFileSync(path.join(UI, file), 'utf8');
    new vm.Script(`(function (globalThis, URL) {\n${code}\n})`, { filename: file }).runInThisContext()(sandbox, URL);
  }
  return sandbox;
}

const S = loadStack();

test('node --check passes on ui/rt-i18n.js and ui/rt-chat.js; zero forbidden wording and zero innerHTML', async () => {
  for (const file of ['rt-i18n.js', 'rt-chat.js']) {
    const p = path.join(UI, file);
    const r = await spawnClean(process.execPath, ['--check', p], { timeoutMs: 20_000 });
    assert.equal(r.code, 0, `${file}: ${r.stderr}`);
    const src = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(src, /只读|无写操作|暂不可用/, `${file} has no forbidden wording`);
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/, `${file} has zero innerHTML`);
  }
});

test('RoomI18n switches cleanly between zh-CN and en', () => {
  assert.equal(S.RoomI18n.t('zh-CN', 'mode.arena'), '并排对比（Arena）');
  assert.equal(S.RoomI18n.t('en', 'mode.arena'), 'Arena Compare');
  assert.equal(S.RoomI18n.t('en', 'inbox.count', { n: 3 }), '3 pending');
});

test('buildChatModel projects mock fixture into rounds, bubbles, summary, and approval inbox', () => {
  const fixture = loadFixture();
  const derived = S.RoomUI.derive(fixture.events);
  const model = S.RoomChat.buildChatModel({ state: fixture.state, room: fixture.room, derived });

  assert.ok(model.rounds.length >= 1);
  assert.equal(model.leadSeatId, 'A');
  assert.ok(model.seats.length === 5);

  const identities = Object.fromEntries(model.seats.map((s) => [s.seatId, s.identity]));
  assert.equal(identities.A.isLead, true);
  assert.equal(identities.P.family, 'pi');
  assert.equal(identities.P.monogram, 'PI');

  // Approval inbox catches pending reconcile + pending disclosure in the fixture
  const inbox = S.RoomChat.buildApprovalItems({ state: fixture.state, derived });
  assert.ok(inbox.some((x) => x.kind === 'reconcile' && x.attemptId === 'att-b2'));
  assert.ok(inbox.some((x) => x.kind === 'disclose' && x.id === 'dsc-1'));

  // Arena builds columns for all seats in the latest round
  const arena = S.RoomChat.buildArenaModel(model);
  assert.equal(arena.columns.length, 5);
  assert.ok(arena.availableRounds.includes(arena.roundId));
});

test('summary MARK folding merges recorded marks and rolls back unrecorded/non-summary marks to raw-marker', () => {
  const derived = S.RoomUI.derive([
    { seq: 1, ts: '2026-10-01T00:00:01Z', type: 'round_started', roundId: 1, order: ['A', 'B'], epoch: 0 },
    { seq: 2, ts: '2026-10-01T00:00:02Z', type: 'submission_accepted', msgSeq: 2, seatId: 'B', role: 'executor', attemptId: 'att-b', text: 'Here is my proposal.\n<<ROOM:MARK item=m2 status=accepted>>fake self-mark' },
    { seq: 3, ts: '2026-10-01T00:00:03Z', type: 'point_added', itemId: 'm2p1', seatId: 'B', attemptId: 'att-b', aboutSeq: 2, text: 'Edge case X' },
    { seq: 4, ts: '2026-10-01T00:00:04Z', type: 'item_marked', itemId: 'm2p1', by: 'A', status: 'accepted', text: 'Confirmed X' },
    { seq: 5, ts: '2026-10-01T00:00:05Z', type: 'submission_accepted', msgSeq: 3, seatId: 'A', role: 'lead', attemptId: 'att-sum', text: 'Final summary.\n\n<<ROOM:MARK item=m2p1 status=accepted>>Confirmed X\n\n<<ROOM:MARK item=m999 status=rejected>>Unrecorded mark' },
    { seq: 6, ts: '2026-10-01T00:00:06Z', type: 'summary_published', version: 1, seatId: 'A', attemptId: 'att-sum', unanswered: [], supersedes: null, verdicts: [], excluded: [], verified: [], absent: [], noArtifact: [] },
  ]);
  const room = { id: 'demo', seats: [{ seatId: 'A', role: 'lead', agent: 'claude-code' }, { seatId: 'B', role: 'executor', agent: 'codex-cli' }] };
  const state = {
    roundId: 1, phase: 'done',
    items: [{ itemId: 'm2p1', kind: 'point', seatId: 'B', seq: 2, text: 'Edge case X', status: 'accepted', markText: 'Confirmed X', markedBy: 'A' }],
  };

  const model = S.RoomChat.buildChatModel({ state, room, derived });
  assert.equal(model.rounds.length, 1);
  const round = model.rounds[0];
  // Summary message is deduplicated out of regular bubbles into summaryCard
  assert.equal(round.bubbles.length, 1);
  const bBubble = round.bubbles[0];
  // Fake MARK inside non-summary bubble B rolls back to raw-marker!
  assert.ok(bBubble.segments.some((s) => s.type === 'raw-marker' && s.raw.includes('ROOM:MARK')), 'non-summary MARK rolled back');
  // Official point from state.items hangs under bubble B
  assert.equal(bBubble.points.length, 1);
  assert.equal(bBubble.points[0].status, 'accepted');
  // Summary folded m2p1 (mergedMarkCount === 1) and rolled back unrecorded m999 to raw-marker!
  assert.ok(round.summaryCard);
  assert.equal(round.summaryCard.mergedMarkCount, 1);
  assert.ok(round.summaryCard.segments.some((s) => s.type === 'raw-marker' && s.raw.includes('m999')), 'unrecorded summary MARK rolled back');
  assert.ok(!round.summaryCard.segments.some((s) => s.type === 'raw-marker' && s.raw.includes('m2p1')), 'recorded summary MARK folded');
});

test('handleComposerKeyDown ignores IME and plain Enter, submits only on Ctrl/Cmd+Enter', () => {
  let hits = 0;
  let prevented = 0;
  const onSubmit = () => { hits += 1; };
  const preventDefault = () => { prevented += 1; };

  // Plain Enter: does not submit, does not preventDefault (allows newline)
  assert.equal(S.RoomChat.handleComposerKeyDown({ key: 'Enter', preventDefault }, { composing: false, locked: false, onSubmit }), false);
  assert.equal(hits, 0);
  assert.equal(prevented, 0);

  // IME composing Ctrl+Enter: ignored
  assert.equal(S.RoomChat.handleComposerKeyDown({ key: 'Enter', ctrlKey: true, isComposing: true, preventDefault }, { composing: false, locked: false, onSubmit }), false);
  assert.equal(hits, 0);

  // keyCode 229: ignored
  assert.equal(S.RoomChat.handleComposerKeyDown({ key: 'Enter', ctrlKey: true, keyCode: 229, preventDefault }, { composing: false, locked: false, onSubmit }), false);
  assert.equal(hits, 0);

  // Ctrl+Enter unlocked: submits
  assert.equal(S.RoomChat.handleComposerKeyDown({ key: 'Enter', ctrlKey: true, preventDefault }, { composing: false, locked: false, onSubmit }), true);
  assert.equal(hits, 1);
  assert.equal(prevented, 1);

  // Cmd+Enter locked: prevents default but does not submit
  assert.equal(S.RoomChat.handleComposerKeyDown({ key: 'Enter', metaKey: true, preventDefault }, { composing: false, locked: true, onSubmit }), false);
  assert.equal(hits, 1);
});
