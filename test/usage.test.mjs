import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage, classifyReport, accumulate, markUnknown, isPaused, budgetStatus, formatUsage } from '../lib/usage.mjs';

const rep = (seatId, attemptId, input, output, cached, source = 'hosted') => ({ type: 'usage_reported', seatId, attemptId, input, output, cached, source });

test('emptyUsage: nothing known, totals are null not 0', () => {
  const u = emptyUsage();
  assert.equal(u.totals.tokens, null);
  assert.equal(u.totals.input, null);
  assert.equal(u.totals.knownReports, 0);
  assert.equal(u.totals.unknownReports, 0);
});

test('classifyReport: known needs input and output; cached optional', () => {
  assert.equal(classifyReport({ input: 10, output: 5 }).known, true);
  assert.equal(classifyReport({ input: 10, output: 5 }).cached, null);
  assert.equal(classifyReport({ input: 10, output: 5, cached: 3 }).cached, 3);
  assert.equal(classifyReport({ input: null, output: 5 }).known, false);
  assert.equal(classifyReport({ input: 10 }).known, false);
  assert.equal(classifyReport({ input: -1, output: 5 }).known, false);
  assert.equal(classifyReport({ input: '10', output: 5 }).known, false);
  assert.equal(classifyReport({ input: NaN, output: 5 }).known, false);
  assert.equal(classifyReport({}).known, false);
});

test('accumulate: known reports sum per seat and overall', () => {
  let u = accumulate(null, rep('P', 'a1', 100, 50, 20));
  u = accumulate(u, rep('P', 'a2', 10, 5, 0));
  u = accumulate(u, rep('Q', 'a3', 1, 1));
  assert.equal(u.totals.input, 111);
  assert.equal(u.totals.output, 56);
  assert.equal(u.totals.cached, 20);
  assert.equal(u.totals.tokens, 167);
  assert.equal(u.totals.knownReports, 3);
  assert.equal(u.totals.unknownReports, 0);
  assert.equal(u.bySeat.P.tokens, 165);
  assert.equal(u.bySeat.Q.tokens, 2);
  assert.deepEqual(u.unknownSeats, []);
});

test('accumulate: unknown report never becomes 0; totals stay null when nothing is known', () => {
  const u = accumulate(undefined, rep('B', 'a1', null, null, null, 'declared'));
  assert.equal(u.totals.tokens, null);
  assert.equal(u.totals.input, null);
  assert.equal(u.totals.unknownReports, 1);
  assert.equal(u.totals.knownReports, 0);
  assert.deepEqual(u.unknownSeats, ['B']);
  assert.equal(u.bySeat.B.tokens, null);
});

test('accumulate: mixed known and unknown -> known sum plus unknown count, per seat too', () => {
  let u = accumulate(null, rep('P', 'a1', 100, 50));
  u = accumulate(u, rep('B', 'a2', undefined, undefined, undefined, 'declared'));
  u = accumulate(u, rep('P', 'a3', 1, 1));
  assert.equal(u.totals.tokens, 152);
  assert.equal(u.totals.unknownReports, 1);
  assert.equal(u.totals.knownReports, 2);
  assert.deepEqual(u.unknownSeats, ['B']);
  assert.equal(u.bySeat.B.unknownReports, 1);
  assert.equal(u.bySeat.P.unknownReports, 0);
});

test('accumulate: a later report for the same attempt replaces the earlier one (order independent)', () => {
  let u = accumulate(null, rep('P', 'a1', 10, 10));
  u = accumulate(u, rep('P', 'a1', 30, 20));
  assert.equal(u.totals.tokens, 50);
  assert.equal(u.totals.knownReports, 1);
  // unknown -> known upgrade for the same attempt removes the unknown mark
  let v = accumulate(null, rep('P', 'a1', null, null));
  assert.equal(v.totals.unknownReports, 1);
  v = accumulate(v, rep('P', 'a1', 5, 5));
  assert.equal(v.totals.unknownReports, 0);
  assert.equal(v.totals.tokens, 10);
  assert.deepEqual(v.unknownSeats, []);
});

test('accumulate: pure (input state not mutated) and ignores other event types', () => {
  const u0 = accumulate(null, rep('P', 'a1', 1, 1));
  const snap = JSON.stringify(u0);
  const u1 = accumulate(u0, rep('P', 'a2', 1, 1));
  assert.equal(JSON.stringify(u0), snap);
  assert.notEqual(u1, u0);
  assert.equal(accumulate(u0, { type: 'packet_issued', seatId: 'P' }), u0);
  assert.equal(accumulate(u0, null), u0);
  assert.equal(u1.lastReport.attemptId, 'a2');
});

test('markUnknown: records an embedded seat attempt as unknown', () => {
  const u = markUnknown(null, { seatId: 'B', attemptId: 'a9' });
  assert.equal(u.totals.unknownReports, 1);
  assert.equal(u.attempts['B/a9'].known, false);
  assert.equal(u.attempts['B/a9'].source, 'declared');
});

test('isPaused: only known tokens at or over a positive limit pause', () => {
  assert.equal(isPaused({ totals: { tokens: 100 }, maxTokens: 100 }), true);
  assert.equal(isPaused({ totals: { tokens: 101 }, maxTokens: 100 }), true);
  assert.equal(isPaused({ totals: { tokens: 99 }, maxTokens: 100 }), false);
  assert.equal(isPaused({ totals: { tokens: null }, maxTokens: 100 }), false, 'unknown is not over');
  assert.equal(isPaused({ totals: { tokens: 1e9 }, maxTokens: null }), false, 'no limit');
  assert.equal(isPaused({ totals: { tokens: 1e9 }, maxTokens: 0 }), false);
  assert.equal(isPaused({ totals: { tokens: 1e9 }, maxTokens: 'abc' }), false);
  assert.equal(isPaused({}), false);
});

test('isPaused with accumulated state: unknown seats do not block the pause on known usage', () => {
  let u = accumulate(null, rep('P', 'a1', 600, 500));
  u = accumulate(u, rep('B', 'a2', null, null));
  assert.equal(isPaused({ totals: u.totals, maxTokens: 1000 }), true);
  assert.equal(isPaused({ totals: u.totals, maxTokens: 2000 }), false);
});

test('budgetStatus: unlimited / unknown / ok / paused', () => {
  assert.equal(budgetStatus({ totals: { tokens: 5 }, maxTokens: null }).status, 'unlimited');
  assert.equal(budgetStatus({ totals: { tokens: null, unknownReports: 2 }, maxTokens: 10 }).status, 'unknown');
  const ok = budgetStatus({ totals: { tokens: 4 }, maxTokens: 10 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.remaining, 6);
  assert.equal(ok.paused, false);
  const p = budgetStatus({ totals: { tokens: 12 }, maxTokens: 10 });
  assert.equal(p.status, 'paused');
  assert.equal(p.paused, true);
  assert.equal(p.remaining, 0);
  assert.equal(budgetStatus().status, 'unlimited');
});

test('formatUsage: Chinese summary never prints unknown as 0', () => {
  assert.match(formatUsage(emptyUsage()), /已知用量：无/);
  let u = accumulate(null, rep('P', 'a1', 1200, 345, 100));
  u = accumulate(u, rep('B', 'a2', null, null));
  const s = formatUsage(u, { maxTokens: 2000 });
  assert.match(s, /已知用量 1,545 tokens/);
  assert.match(s, /缓存 100/);
  assert.match(s, /1 个回合用量未知（席位 B）/);
  assert.match(s, /剩余 455/);
  assert.doesNotMatch(s, /\b0 tokens/);
  assert.match(formatUsage(u, { maxTokens: 1000 }), /已达上限 1,000/);
  assert.match(formatUsage(accumulate(null, rep('B', 'x', null, null)), { maxTokens: 10 }), /尚无已知用量可比/);
});
