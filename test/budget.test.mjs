import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimMessages, computePins, mergeDropped, sumBytes, describeDropped } from '../lib/budget.mjs';

const msg = (seq, text, extra = {}) => ({ seq, text, ...extra });
const bytes = (s) => Buffer.byteLength(s, 'utf8');

test('trimMessages: under budget keeps everything, dropped is empty', () => {
  const messages = [msg(2, 'aaaa'), msg(3, 'bbbb'), msg(4, 'cccc')];
  const r = trimMessages({ messages, pinnedSeqs: [], maxBytes: 100 });
  assert.deepEqual(r.kept.map((m) => m.seq), [2, 3, 4]);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.bytes, 12);
  assert.equal(r.overBudget, false);
});

test('trimMessages: no maxBytes means no budget', () => {
  const r = trimMessages({ messages: [msg(2, 'x'.repeat(1000))] });
  assert.equal(r.kept.length, 1);
  assert.deepEqual(r.dropped, []);
});

test('trimMessages: over budget drops oldest first, whole messages', () => {
  const messages = [msg(2, 'a'.repeat(40)), msg(3, 'b'.repeat(40)), msg(4, 'c'.repeat(40)), msg(5, 'd'.repeat(40))];
  const r = trimMessages({ messages, pinnedSeqs: [], maxBytes: 90 });
  assert.deepEqual(r.kept.map((m) => m.seq), [4, 5]);
  assert.deepEqual(r.dropped, [{ fromSeq: 2, toSeq: 3 }]);
  assert.equal(r.bytes, 80);
  assert.equal(r.overBudget, false);
  // never a partial message: the kept texts are intact
  assert.equal(r.kept[0].text, 'c'.repeat(40));
});

test('trimMessages: pinned messages survive even when older', () => {
  const messages = [msg(2, 'a'.repeat(40)), msg(3, 'b'.repeat(40)), msg(4, 'c'.repeat(40)), msg(5, 'd'.repeat(40))];
  const r = trimMessages({ messages, pinnedSeqs: [2], maxBytes: 90 });
  assert.deepEqual(r.kept.map((m) => m.seq), [2, 5]);
  assert.deepEqual(r.dropped, [{ fromSeq: 3, toSeq: 4 }]);
});

test('trimMessages: a kept message between dropped ones splits the range', () => {
  const messages = [2, 3, 4, 5, 6, 7].map((s) => msg(s, 'x'.repeat(10)));
  const r = trimMessages({ messages, pinnedSeqs: [4, 7], maxBytes: 20 });
  assert.deepEqual(r.kept.map((m) => m.seq), [4, 7]);
  assert.deepEqual(r.dropped, [{ fromSeq: 2, toSeq: 3 }, { fromSeq: 5, toSeq: 6 }]);
});

test('trimMessages: pins alone over budget -> overBudget true, pins still kept', () => {
  const messages = [msg(2, 'a'.repeat(50)), msg(3, 'b'.repeat(50))];
  const r = trimMessages({ messages, pinnedSeqs: [2, 3], maxBytes: 10 });
  assert.deepEqual(r.kept.map((m) => m.seq), [2, 3]);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.overBudget, true);
});

test('trimMessages: custom sizeOf and unsorted input; input not mutated', () => {
  const messages = [msg(5, 'e'), msg(2, 'b'), msg(4, 'd'), msg(3, 'c')];
  const snapshot = JSON.stringify(messages);
  const r = trimMessages({ messages, pinnedSeqs: new Set([3]), maxBytes: 25, sizeOf: () => 10 });
  assert.deepEqual(r.kept.map((m) => m.seq), [3, 5]);
  assert.deepEqual(r.dropped, [{ fromSeq: 2, toSeq: 2 }, { fromSeq: 4, toSeq: 4 }]);
  assert.equal(JSON.stringify(messages), snapshot);
});

test('trimMessages: default sizeOf is UTF-8 byte length (multi-byte UTF-8 chars count by bytes)', () => {
  const messages = [msg(2, 'éè'), msg(3, 'ok')];
  const r = trimMessages({ messages, maxBytes: 4 });
  assert.deepEqual(r.kept.map((m) => m.seq), [3]);
  assert.equal(bytes('éè'), 4);
  assert.equal(sumBytes(messages), bytes('éè') + 2);
});

test('computePins: current round, quotes (numbers and objects), explicit quoted, summary, extra', () => {
  const messages = [
    msg(2, 'old', { roundId: 1 }),
    msg(3, 'old quoted later', { roundId: 1 }),
    msg(4, 'cur', { roundId: 2, quotes: [3, { seq: 2 }] }),
    msg(5, 'no round info'),
  ];
  const pins = computePins({ messages, roundId: 2, quotedSeqs: [9], summarySeq: 7, extra: [11] });
  assert.deepEqual([...pins].sort((a, b) => a - b), [2, 3, 4, 7, 9, 11]);
  assert.equal(pins.has(5), false, 'a message without roundId is not pinned by the round rule');
});

test('computePins: without roundId nothing is pinned by round', () => {
  const pins = computePins({ messages: [msg(2, 'a', { roundId: 1 })] });
  assert.equal(pins.size, 0);
});

test('mergeDropped: overlapping and touching ranges collapse, sorted output', () => {
  const r = mergeDropped([{ fromSeq: 5, toSeq: 6 }, { fromSeq: 2, toSeq: 3 }], [{ fromSeq: 4, toSeq: 4 }, { fromSeq: 9, toSeq: 10 }, { fromSeq: 10, toSeq: 12 }]);
  assert.deepEqual(r, [{ fromSeq: 2, toSeq: 6 }, { fromSeq: 9, toSeq: 12 }]);
  assert.deepEqual(mergeDropped([], undefined), []);
  assert.deepEqual(mergeDropped([{ fromSeq: 'x', toSeq: 1 }]), []);
});

test('describeDropped renders human-readable English ranges', () => {
  assert.equal(describeDropped([{ fromSeq: 2, toSeq: 5 }, { fromSeq: 9, toSeq: 9 }]), 'seq 2–5, seq 9');
  assert.equal(describeDropped([]), '');
});
