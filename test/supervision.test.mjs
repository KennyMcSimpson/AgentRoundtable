// Tests for lib/supervision.mjs. Pure-function tests plus one guarded append to a temp
// adjudications file under testRunsRoot()\<random> (never AppData). Plan rows covered:
// #9 (tainted), #25 (unapproved disclosure not executed), #26 (argv outside allowlist refused),
// #27 (room validation), #28 (reject-rate signal), #30 (argv change after approval = new request),
// #35 (reverse preconditions / epoch), #36 (executors passing each other do not verify),
// #32 (same cwd warning).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appRoot, testRunsRoot, isInside } from '../lib/common.mjs';
import {
  ROLES, VERDICTS, DISCLOSURE_STATES, DEFAULT_ALLOWLIST,
  takesWork, isLead, isReviewer, producesArtifacts,
  reviewGraph, resolveReviewers, reviewerFor,
  validateRoom, validateDivisionRound,
  canReverse, reverse,
  bindVerdict, authorizedVerdict, verifiedStatus,
  tainted, auditLabel,
  matchAllowlist, effectiveAllowlist, sameArgv, checkTrailingArgs,
  requestDisclosure, approveDisclosure, denyDisclosure, canExecuteDisclosure, executeDisclosure,
  defaultAdjudicationsPath, appendAdjudication, readAdjudications, rejectRateSignal,
} from '../lib/supervision.mjs';
import { createGuard } from '../lib/guard.mjs';

const seat = (seatId, role, extra = {}) => ({ seatId, role, cwd: `C:\\work\\${seatId}`, declaredTier: 'readonly', ...extra });
const n2 = () => ({ schema_version: 2, id: 'r', preset: 'implement-review', seats: [seat('A', 'lead', { reviews: ['B'] }), seat('B', 'executor', { declaredTier: 'workspace' })] });
const n3 = () => ({ schema_version: 2, id: 'r', preset: 'division', seats: [seat('A', 'lead'), seat('B', 'executor', { cwd: 'C:\\work\\B' }), seat('C', 'executor', { cwd: 'C:\\work\\C' })] });
const codes = (r) => r.errors.map((e) => e.code);
const terminalState = () => ({ epoch: 2, roundId: 3, phase: 'done', closed: false, attempt: null });

// ---- constants ----
test('constants are ASCII protocol tokens', () => {
  assert.deepEqual([...ROLES], ['lead', 'reviewer', 'executor', 'participant']);
  assert.deepEqual([...VERDICTS], ['pass', 'reject', 'disclose']);
  assert.deepEqual([...DISCLOSURE_STATES], ['requested', 'approved', 'denied', 'executed']);
  assert.deepEqual(DEFAULT_ALLOWLIST.map((e) => [...e]), [['git', 'diff'], ['git', 'status']]);
});

// ---- role helpers ----
test('takesWork: executors, exec-tier hosted seats, takesWork flag, assignments', () => {
  assert.equal(takesWork(seat('B', 'executor')), true);
  assert.equal(takesWork(seat('A', 'lead')), false);
  assert.equal(takesWork(seat('A', 'lead', { takesWork: true })), true);
  assert.equal(takesWork(seat('P', 'participant', { hosted: { kind: 'pi', tier: 'exec' } })), true);
  assert.equal(takesWork(seat('A', 'lead'), [{ seatId: 'A', text: 'x' }]), true);
  assert.equal(takesWork(null), false);
});

test('isLead / isReviewer / producesArtifacts', () => {
  const room = { leadSeatId: 'Z', seats: [] };
  assert.equal(isLead(seat('A', 'lead')), true);
  assert.equal(isLead(seat('Z', 'participant'), room), true);
  assert.equal(isLead(seat('B', 'executor', { lead: true })), true);
  assert.equal(isLead(seat('B', 'executor')), false);
  assert.equal(isReviewer(seat('R', 'reviewer')), true);
  assert.equal(isReviewer(seat('A', 'lead', { reviews: ['B'] })), true);
  assert.equal(isReviewer(seat('A', 'lead')), false);
  assert.equal(isReviewer(seat('P', 'participant', { hosted: { kind: 'pi', tier: 'reviewer' } })), true);
  assert.equal(producesArtifacts(seat('B', 'executor')), true);
  assert.equal(producesArtifacts(seat('P', 'participant', { producesArtifacts: true })), true);
  assert.equal(producesArtifacts(seat('A', 'lead')), false);
  assert.equal(producesArtifacts(undefined), false);
});

// ---- review graph ----
test('reviewGraph: edges, unknown target, self review, cycle detection', () => {
  const ok = reviewGraph(n2());
  assert.deepEqual(ok.edges, [['A', 'B']]);
  assert.equal(ok.cycle, null);
  assert.equal(ok.errors.length, 0);

  const bad = reviewGraph({ seats: [seat('A', 'lead', { reviews: ['Q', 'A'] })] });
  assert.deepEqual(bad.errors.map((e) => e.code).sort(), ['REVIEW_SELF', 'REVIEW_TARGET_UNKNOWN']);

  const cyc = reviewGraph({ seats: [seat('A', 'lead'), seat('B', 'executor', { reviews: ['C'] }), seat('C', 'executor', { reviews: ['B'] })] });
  assert.ok(cyc.cycle, 'cycle found');
  assert.ok(cyc.errors.some((e) => e.code === 'REVIEW_CYCLE'));

  const notArr = reviewGraph({ seats: [seat('A', 'lead', { reviews: 'B' })] });
  assert.ok(notArr.errors.some((e) => e.code === 'REVIEWS_NOT_ARRAY'));

  const three = reviewGraph({ seats: [seat('A', 'reviewer', { reviews: ['B'] }), seat('B', 'reviewer', { reviews: ['C'] }), seat('C', 'reviewer', { reviews: ['A'] })] });
  assert.ok(three.cycle && three.cycle.length === 4 && three.cycle[0] === three.cycle[3]);
});

test('resolveReviewers: explicit edge, default lead, missing, multiple', () => {
  assert.deepEqual(resolveReviewers(n2()).reviewerOf, { B: 'A' });
  assert.deepEqual(resolveReviewers(n3()).reviewerOf, { B: 'A', C: 'A' });
  const none = resolveReviewers({ seats: [seat('B', 'executor')] });
  assert.ok(none.errors.some((e) => e.code === 'NO_REVIEWER'));
  const multi = resolveReviewers({ seats: [seat('A', 'lead', { reviews: ['B'] }), seat('R', 'reviewer', { reviews: ['B'] }), seat('B', 'executor')] });
  assert.ok(multi.errors.some((e) => e.code === 'MULTIPLE_REVIEWERS'));
  assert.equal(reviewerFor(n3(), 'C'), 'A');
  assert.equal(reviewerFor(n3(), 'A'), null);
});

// ---- validateRoom (#27) ----
test('validateRoom: valid N=2 and N=3 rooms pass with resolved reviewers', () => {
  const r2 = validateRoom(n2());
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.deepEqual(r2.reviewerOf, { B: 'A' });
  const r3 = validateRoom(n3());
  assert.equal(r3.ok, true, JSON.stringify(r3.errors));
  assert.deepEqual(r3.reviewerOf, { B: 'A', C: 'A' });
});

test('validateRoom #27: executor designated as lead fails', () => {
  const room = n3(); room.leadSeatId = 'B';
  const r = validateRoom(room);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('EXECUTOR_IS_LEAD'));
  assert.ok(codes(r).includes('MULTIPLE_LEADS'));
  const r2 = validateRoom({ preset: 'division', seats: [seat('B', 'executor', { lead: true }), seat('C', 'executor')] });
  assert.ok(codes(r2).includes('EXECUTOR_IS_LEAD'));
});

test('validateRoom #27: B reviews C and C reviews B fails on the cycle', () => {
  const room = n3();
  room.seats[1].reviews = ['C'];
  room.seats[2].reviews = ['B'];
  const r = validateRoom(room);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('REVIEW_CYCLE'));
});

test('validateRoom: lead and reviewer never take Work', () => {
  const r1 = validateRoom({ preset: 'division', seats: [seat('A', 'lead', { takesWork: true }), seat('B', 'executor')] });
  assert.ok(codes(r1).includes('LEAD_TAKES_WORK'));
  const r2 = validateRoom({ preset: 'division', seats: [seat('A', 'lead'), seat('R', 'reviewer', { hosted: { kind: 'pi', tier: 'exec' } }), seat('B', 'executor')] });
  assert.ok(codes(r2).includes('REVIEWER_TAKES_WORK'));
  const r3 = validateRoom(n3(), { assignments: [{ seatId: 'A', text: 'x' }] });
  assert.ok(codes(r3).includes('LEAD_TAKES_WORK'));
});

test('validateRoom: structural errors (no seats, dup id, bad role, no lead, unknown leadSeatId)', () => {
  assert.ok(codes(validateRoom(null)).includes('ROOM_INVALID'));
  assert.ok(codes(validateRoom({ seats: [] })).includes('NO_SEATS'));
  assert.ok(codes(validateRoom({ seats: [seat('A', 'lead'), seat('A', 'executor')] })).includes('SEAT_ID_DUPLICATE'));
  assert.ok(codes(validateRoom({ seats: [seat('A', 'boss')] })).includes('ROLE_INVALID'));
  assert.ok(codes(validateRoom({ seats: [{ role: 'lead' }] })).includes('SEAT_ID_MISSING'));
  assert.ok(codes(validateRoom({ preset: 'discussion', seats: [seat('P', 'participant')] })).includes('NO_LEAD'));
  // legacy P-1 room without preset: no lead required
  const legacy = validateRoom({ seats: [seat('A', 'reviewer', { reviews: ['B'] }), seat('B', 'executor')] });
  assert.equal(legacy.ok, true, JSON.stringify(legacy.errors));
  assert.ok(codes(validateRoom({ preset: 'division', leadSeatId: 'Q', seats: [seat('A', 'lead'), seat('B', 'executor')] })).includes('LEAD_UNKNOWN'));
  assert.ok(codes(validateRoom({ preset: 'division', seats: [seat('A', 'lead'), seat('P', 'participant', { lead: true })] })).includes('PARTICIPANT_IS_LEAD'));
});

test('validateRoom: warnings do not block', () => {
  const room = n2(); room.seats[0].declaredTier = 'full';
  room.seats.push(seat('C', 'executor', { reviews: ['B'] }));
  room.seats[0].reviews = [];
  const r = validateRoom(room);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.code === 'REVIEWER_WRITE_TIER'));
  assert.ok(r.warnings.some((w) => w.code === 'EXECUTOR_REVIEWS'));
  assert.deepEqual(r.reviewerOf, { B: 'C', C: 'A' });
});

// ---- validateDivisionRound (#32) ----
test('validateDivisionRound: valid sheet; acceptance commands collected', () => {
  const r = validateDivisionRound(n3(), [
    { seatId: 'B', text: 'Implement parser', acceptance: [['node', '--test', 'parser.test.mjs']] },
    { seatId: 'C', text: 'Implement CLI entrypoint', acceptance: [['node', 'cli.mjs', '--help']] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(r.acceptance, [{ seatId: 'B', argv: ['node', '--test', 'parser.test.mjs'] }, { seatId: 'C', argv: ['node', 'cli.mjs', '--help'] }]);
  assert.deepEqual(r.cwdBySeat, { B: 'C:\\work\\B', C: 'C:\\work\\C' });
});

test('validateDivisionRound #32: same cwd declared by two seats is a warning requiring confirmation', () => {
  // Two spellings of one directory on this host OS: case and a trailing separator on Windows; only the
  // trailing separator on POSIX, where case makes a different directory.
  const [b, c] = process.platform === 'win32' ? ['C:\\shared\\proj', 'c:\\shared\\PROJ\\'] : ['/shared/proj', '/shared/proj/'];
  const r = validateDivisionRound(n3(), [
    { seatId: 'B', text: 'x', cwd: b },
    { seatId: 'C', text: 'y', cwd: c },
  ]);
  assert.equal(r.ok, true);
  const w = r.warnings.find((x) => x.code === 'SAME_CWD');
  assert.ok(w, 'SAME_CWD warning');
  assert.equal(w.requiresConfirm, true);
  assert.deepEqual(w.seats, ['B', 'C']);
});

test('validateDivisionRound: errors for lead/reviewer/participant assignment, unknown seat, duplicates, bad acceptance', () => {
  const room = n3(); room.seats.push(seat('R', 'reviewer'), seat('P', 'participant'));
  const r = validateDivisionRound(room, [
    { seatId: 'A', text: 'x' }, { seatId: 'R', text: 'x' }, { seatId: 'P', text: 'x' }, { seatId: 'Q', text: 'x' },
    { seatId: 'B', text: 'x' }, { seatId: 'B', text: 'y' }, { seatId: 'C', acceptance: [['']] }, { text: 'no seat' },
  ]);
  assert.equal(r.ok, false);
  const c = codes(r);
  for (const code of ['LEAD_TAKES_WORK', 'REVIEWER_TAKES_WORK', 'PARTICIPANT_TAKES_WORK', 'ASSIGNMENT_SEAT_UNKNOWN', 'ASSIGNMENT_DUPLICATE', 'ASSIGNMENT_TEXT_MISSING', 'ACCEPTANCE_ARGV_INVALID', 'ASSIGNMENT_SEAT_MISSING']) assert.ok(c.includes(code), code);
  assert.ok(codes(validateDivisionRound(n3(), [])).includes('NO_ASSIGNMENTS'));
  assert.ok(codes(validateDivisionRound(n3(), [{ seatId: 'B', text: 'x', acceptance: 'node' }])).includes('ACCEPTANCE_NOT_ARRAY'));
});

// ---- canReverse / reverse (#35) ----
test('canReverse #35: pending attempt refused; terminal ok; work in progress refused; closed refused', () => {
  assert.equal(canReverse({ ...terminalState(), attempt: { attemptId: 'a1' } }).reason, 'ATTEMPT_PENDING');
  assert.equal(canReverse({ ...terminalState(), attempts: { a2: { attemptId: 'a2', status: 'pending' } } }).reason, 'ATTEMPT_PENDING');
  assert.equal(canReverse({ ...terminalState(), work: { attempts: [{ attemptId: 'w1' }] } }).reason, 'ATTEMPT_PENDING');
  assert.equal(canReverse({ ...terminalState(), attempts: { a2: { attemptId: 'a2', status: 'submitted' } } }).ok, true);
  assert.equal(canReverse({ ...terminalState(), phase: 'work' }).reason, 'WORK_IN_PROGRESS');
  assert.equal(canReverse({ ...terminalState(), closed: true }).reason, 'ROOM_CLOSED');
  assert.equal(canReverse(null).reason, 'NO_STATE');
  assert.deepEqual(canReverse(terminalState()), { ok: true, reason: null });
});

test('reverse #35: N=2 swaps roles, lead follows reviewer, epoch+1, tiers reset', () => {
  const r = reverse(n2(), terminalState());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.roles, { A: 'executor', B: 'lead' });
  assert.deepEqual(r.reviews, { A: [], B: ['A'] });
  assert.deepEqual(r.redeclare.sort(), ['A', 'B']);
  assert.equal(r.event.type, 'direction_reversed');
  assert.equal(r.event.epoch, 3);
  assert.deepEqual(r.event.before, { reviewer: ['A'], executor: ['B'], lead: 'A' });
  assert.deepEqual(r.event.after, { reviewer: ['B'], executor: ['A'], lead: 'B' });
  assert.deepEqual(r.epochEvent, { type: 'epoch_bumped', epoch: 3, reason: 'reverse' });
  assert.ok(r.room.seats.every((s) => s.declaredTier === null));
  assert.equal(validateRoom(r.room).ok, true);
  // reversing again returns to the original direction
  const back = reverse(r.room, { ...terminalState(), epoch: 3 });
  assert.equal(back.ok, true);
  assert.deepEqual(back.roles, { A: 'lead', B: 'executor' });
  assert.equal(back.event.epoch, 4);
});

test('reverse: refused on pending attempt, on invalid room, and when the result would be invalid', () => {
  assert.equal(reverse(n2(), { ...terminalState(), attempt: { attemptId: 'a9' } }).reason, 'ATTEMPT_PENDING');
  const bad = n3(); bad.leadSeatId = 'B';
  assert.equal(reverse(bad, terminalState()).reason, 'ROOM_INVALID');
  // One lead reviewing two executors: after reversal A would have two reviewers.
  const r3 = reverse(n3(), terminalState());
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'INVALID_AFTER_REVERSE');
  assert.ok(r3.errors.some((e) => e.code === 'MULTIPLE_REVIEWERS'));
  assert.equal(reverse({ preset: 'discussion', seats: [seat('A', 'lead'), seat('P', 'participant')] }, terminalState()).reason, 'NOTHING_TO_REVERSE');
});

// ---- bindVerdict (#16a/#16b) ----
test('bindVerdict: none when manifest matches and nothing changed', () => {
  const r = bindVerdict({ verdict: { seatId: 'A', verdict: 'pass', artifactSha: 'm1' }, manifest: { manifestSha: 'm1' }, recompute: { changed: [], stale: false } });
  assert.equal(r.annotation, 'none');
  assert.equal(r.entersSummary, true);
  assert.equal(r.verdict.artifactSha, 'm1');
});

test('bindVerdict #16a: recompute shows change -> stale, not in summary; #16b accepted_stale', () => {
  const rec = { changed: [{ path: 'a.js', from: 'x', to: 'y' }], stale: true };
  const r = bindVerdict({ verdict: { seatId: 'A', verdict: 'pass', artifactSha: 'm1' }, manifest: { sha256: 'm1' }, recompute: rec });
  assert.equal(r.annotation, 'stale');
  assert.equal(r.entersSummary, false);
  assert.equal(r.reason, 'ARTIFACTS_CHANGED');
  const acc = bindVerdict({ verdict: { seatId: 'A', verdict: 'pass', artifactSha: 'm1' }, manifest: { sha256: 'm1' }, recompute: rec, staleAccepted: { manifestSha: 'm1', changed: [{ path: 'a.js', from: 'x', to: 'y' }] } });
  assert.equal(acc.annotation, 'accepted_stale');
  assert.equal(acc.entersSummary, true);
  const other = bindVerdict({ verdict: { seatId: 'A', verdict: 'pass', artifactSha: 'm1' }, manifest: { sha256: 'm1' }, recompute: rec, staleAccepted: { manifestSha: 'm2', changed: rec.changed } });
  assert.equal(other.annotation, 'stale');
});

test('bindVerdict: a stale acceptance covers only the change list the user saw (no blanket true)', () => {
  const rec = { changed: [{ path: 'a.js', from: 'x', to: 'y' }, { path: 'evil.js', from: null, to: 'z' }], stale: true };
  const v = { seatId: 'A', verdict: 'pass', artifactSha: 'm1' };
  // `true` used to accept anything; it no longer does.
  assert.equal(bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: rec, staleAccepted: true }).annotation, 'stale');
  // An acceptance without a change list covers nothing.
  assert.equal(bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: rec, staleAccepted: { manifestSha: 'm1' } }).annotation, 'stale');
  // a.js was accepted; evil.js appeared afterwards.
  const partial = bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: rec, staleAccepted: { manifestSha: 'm1', changed: [rec.changed[0]] } });
  assert.equal(partial.annotation, 'stale');
  assert.equal(partial.reason, 'STALE_CHANGED_SINCE_ACCEPT');
  // a.js changed again after the acceptance (different new hash): not covered.
  const again = bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: { changed: [{ path: 'a.js', from: 'x', to: 'w' }], stale: true }, staleAccepted: { manifestSha: 'm1', changed: [rec.changed[0]] } });
  assert.equal(again.annotation, 'stale');
  assert.equal(bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: rec, staleAccepted: { manifestSha: 'm1', changed: rec.changed } }).annotation, 'accepted_stale');
  // A recompute error is covered only by an acceptance of that same error.
  const errRec = { changed: [], stale: true, error: 'EACCES' };
  assert.equal(bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: errRec, staleAccepted: { manifestSha: 'm1', changed: [] } }).annotation, 'stale');
  assert.equal(bindVerdict({ verdict: v, manifest: { manifestSha: 'm1' }, recompute: errRec, staleAccepted: { manifestSha: 'm1', changed: [], error: 'EACCES' } }).annotation, 'accepted_stale');
});

test('bindVerdict: mismatched manifest, no manifest, invalid verdict, missing verdict -> stale', () => {
  assert.equal(bindVerdict({ verdict: { verdict: 'reject', artifactSha: 'm2' }, manifest: { manifestSha: 'm1' } }).reason, 'MANIFEST_MISMATCH');
  assert.equal(bindVerdict({ verdict: { verdict: 'pass' }, manifest: null }).reason, 'NO_MANIFEST');
  assert.equal(bindVerdict({ verdict: { verdict: 'approve' }, manifest: { manifestSha: 'm1' } }).reason, 'VERDICT_INVALID');
  assert.equal(bindVerdict({}).reason, 'NO_VERDICT');
  // verdict without artifactSha binds to the frozen one
  const r = bindVerdict({ verdict: { verdict: 'reject' }, manifest: { manifestSha: 'm1' } });
  assert.equal(r.annotation, 'none');
  assert.equal(r.verdict.artifactSha, 'm1');
  assert.equal(r.verdict.verdict, 'reject');
});

// ---- authorizedVerdict / verifiedStatus (#36) ----
test('authorizedVerdict #36: executors passing each other are not the reviewer', () => {
  const room = n3();
  assert.equal(authorizedVerdict(room, { seatId: 'A', verdict: 'pass' }, 'B'), true);
  assert.equal(authorizedVerdict(room, { seatId: 'C', verdict: 'pass' }, 'B'), false);
  assert.equal(authorizedVerdict(room, { seatId: 'B', verdict: 'pass' }, 'C'), false);
  assert.equal(authorizedVerdict(room, null, 'B'), false);
});

test('verifiedStatus: only an authorized untainted pass with none/accepted_stale verifies', () => {
  assert.deepEqual(verifiedStatus({ verdict: { verdict: 'pass' }, annotation: 'none', authorized: true }), { verified: true, reason: null });
  assert.equal(verifiedStatus({ verdict: 'pass', annotation: 'accepted_stale' }).verified, true);
  assert.equal(verifiedStatus({ verdict: 'pass', authorized: false }).reason, 'NOT_REVIEWER');
  assert.equal(verifiedStatus({ verdict: 'pass', tainted: true }).reason, 'TAINTED');
  assert.equal(verifiedStatus({ verdict: 'reject' }).reason, 'REJECTED');
  assert.equal(verifiedStatus({ verdict: 'disclose' }).reason, 'DISCLOSURE_PENDING');
  assert.equal(verifiedStatus({ verdict: 'none' }).reason, 'NO_PASS');
  assert.equal(verifiedStatus({ verdict: 'pass', annotation: 'stale' }).reason, 'ANNOTATION_STALE');
  assert.equal(verifiedStatus({ verdict: 'pass', annotation: 'malformed' }).reason, 'ANNOTATION_MALFORMED');
});

// ---- tainted (#9) ----
test('tainted #9: a write or an unknown command in a reviewer turn taints; unaudited does not', () => {
  assert.equal(tainted({ status: 'present_in_native', writes: [{ tool: 'apply_patch', path: 'a.js' }], unknownCommands: [], tainted: true }), true);
  assert.equal(tainted({ status: 'present_in_native', writes: [], unknownCommands: [['rm', '-rf', 'x']], tainted: false }), true);
  assert.equal(tainted({ status: 'present_in_native', writes: [], unknownCommands: [] }), false);
  assert.equal(tainted({ status: 'unknown' }), false);
  assert.equal(tainted(null), false);
  assert.equal(tainted({ tainted: true }), true);
});

test('auditLabel: never says read-only', () => {
  assert.equal(auditLabel(null).code, 'unaudited');
  assert.equal(auditLabel({ status: 'unknown', writes: [] }).text, 'Unaudited');
  assert.equal(auditLabel({ status: 'present_in_native', writes: [{}] }).code, 'tainted');
  const clean = auditLabel({ status: 'header_only', writes: [], unknownCommands: [] });
  assert.equal(clean.code, 'no_write_observed');
  assert.ok(!/read-only/i.test(clean.text));
  assert.ok(clean.text.includes('No writes observed'));
});

// ---- allowlist ----
test('matchAllowlist: argv prefix, exact elements, no shell parsing', () => {
  const list = [['git', 'diff'], ['git', 'status'], ['node', '--test', 'parser.test.mjs']];
  assert.deepEqual(matchAllowlist(['git', 'diff', '--stat'], list), ['git', 'diff']);
  assert.deepEqual(matchAllowlist(['git', 'status'], list), ['git', 'status']);
  assert.equal(matchAllowlist(['git', 'push'], list), null);
  assert.equal(matchAllowlist(['git diff'], list), null, 'joined string is not parsed');
  assert.equal(matchAllowlist(['Git', 'diff'], list), null, 'case-sensitive');
  assert.equal(matchAllowlist(['node', '--test'], list), null, 'argv shorter than the entry');
  assert.deepEqual(matchAllowlist(['git', 'diff'], [['git']]), ['git'], 'one-element prefix');
  assert.equal(matchAllowlist([], list), null);
  assert.equal(matchAllowlist(['git', 'diff'], null), null);
  assert.equal(matchAllowlist(['git', 'diff'], [[], ['git', 'diff']]).length, 2);
});

test('effectiveAllowlist: room list plus acceptance commands, deduplicated, default when missing', () => {
  const l = effectiveAllowlist([['git', 'diff'], ['git', 'diff']], [['node', 'cli.mjs', '--help'], { seatId: 'B', argv: ['node', '--test'] }, 'bad']);
  assert.deepEqual(l, [['git', 'diff'], ['node', 'cli.mjs', '--help'], ['node', '--test']]);
  assert.deepEqual(effectiveAllowlist(undefined, undefined), [['git', 'diff'], ['git', 'status']]);
  assert.deepEqual(effectiveAllowlist([], []), []);
});

test('sameArgv', () => {
  assert.equal(sameArgv(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameArgv(['a', 'b'], ['a', 'b', 'c']), false);
  assert.equal(sameArgv(['a'], ['A']), false);
  assert.equal(sameArgv([], []), false);
  assert.equal(sameArgv('a', ['a']), false);
});

// ---- disclosure state machine (#25, #26, #30) ----
test('requestDisclosure #26: argv outside the allowlist is denied by the room', () => {
  const r = requestDisclosure({ argv: ['git', 'push'], reason: 'want to push', allowlist: [['git', 'diff']], seatId: 'A', attemptId: 'a1', id: 'd1', now: 't0' });
  assert.equal(r.status, 'denied');
  assert.equal(r.allowed, false);
  assert.equal(r.denyReason, 'NOT_IN_ALLOWLIST');
  assert.equal(r.deniedBy, 'room');
  assert.deepEqual(r.history, [{ to: 'denied', by: 'room', ts: 't0' }]);
  assert.equal(approveDisclosure(r).ok, false);
  assert.equal(canExecuteDisclosure(r).reason, 'NOT_APPROVED');
  const inv = requestDisclosure({ argv: 'git diff', allowlist: [['git', 'diff']] });
  assert.equal(inv.denyReason, 'ARGV_INVALID');
});

test('requestDisclosure: acceptance command from the task sheet is allowed', () => {
  const r = requestDisclosure({ argv: ['node', '--test', 'parser.test.mjs'], reason: 'acceptance check', allowlist: [['git', 'diff']], acceptanceCommands: [['node', '--test', 'parser.test.mjs']], seatId: 'A', attemptId: 'a1' });
  assert.equal(r.status, 'requested');
  assert.equal(r.allowed, true);
  assert.deepEqual(r.matched, ['node', '--test', 'parser.test.mjs']);
  assert.match(r.id, /^d[0-9a-f]{8}$/);
  assert.ok(r.requestedAt);
});

test('disclosure #25: unapproved request is never executed; approve -> execute runs the approved argv', async () => {
  let ran = null;
  const run = async (argv, ctx) => { ran = { argv, ctx }; return { exitCode: 0, outputSha256: 'o1', truncated: false, privatePath: 'private/a1/out.txt' }; };
  const req = requestDisclosure({ argv: ['git', 'diff', '--stat'], reason: 'r', allowlist: DEFAULT_ALLOWLIST, seatId: 'A', attemptId: 'a1', id: 'd2', now: 't0' });
  const notYet = await executeDisclosure(req, { run });
  assert.equal(notYet.ok, false);
  assert.equal(notYet.reason, 'NOT_APPROVED');
  assert.equal(ran, null, 'runner not called');
  assert.equal(canExecuteDisclosure(null).reason, 'NO_REQUEST');

  const ap = approveDisclosure(req, { by: 'admin', now: 't1' });
  assert.equal(ap.ok, true);
  assert.equal(ap.request.status, 'approved');
  assert.deepEqual(ap.request.approvedArgv, ['git', 'diff', '--stat']);
  assert.equal(approveDisclosure(ap.request).reason, 'INVALID_TRANSITION');
  assert.equal(canExecuteDisclosure(ap.request).ok, true);

  const noRunner = await executeDisclosure(ap.request, {});
  assert.equal(noRunner.reason, 'NO_RUNNER');

  const ex = await executeDisclosure(ap.request, { run, manifestSha: 'm1', now: 't2' });
  assert.equal(ex.ok, true);
  assert.deepEqual(ran.argv, ['git', 'diff', '--stat']);
  assert.equal(ran.ctx.manifestSha, 'm1');
  assert.equal(ex.request.status, 'executed');
  assert.deepEqual(ex.result, { exitCode: 0, outputSha256: 'o1', truncated: false, privatePath: 'private/a1/out.txt' });
  assert.deepEqual(ex.event, { type: 'disclose_executed', id: 'd2', manifestSha: 'm1', exitCode: 0, outputSha256: 'o1', truncated: false, privatePath: 'private/a1/out.txt' });
  assert.deepEqual(ex.request.history.map((h) => h.to), ['requested', 'approved', 'executed']);
  const again = await executeDisclosure(ex.request, { run });
  assert.equal(again.reason, 'ALREADY_EXECUTED');
  assert.equal(denyDisclosure(ex.request).reason, 'INVALID_TRANSITION');
});

test('disclosure #30: argv changed after approval is a new request, nothing runs', async () => {
  let calls = 0;
  const run = async () => { calls++; return { exitCode: 0 }; };
  const req = requestDisclosure({ argv: ['git', 'diff'], allowlist: DEFAULT_ALLOWLIST, seatId: 'A', attemptId: 'a1', id: 'd3' });
  const ap = approveDisclosure(req, { argv: ['git', 'diff'] });
  assert.equal(ap.ok, true);
  assert.equal(approveDisclosure(req, { argv: ['git', 'status'] }).reason, 'ARGV_CHANGED');
  const ex = await executeDisclosure(ap.request, { argv: ['git', 'diff', '--cached'], run, allowlist: DEFAULT_ALLOWLIST });
  assert.equal(ex.ok, false);
  assert.equal(ex.reason, 'ARGV_CHANGED');
  assert.equal(calls, 0);
  assert.ok(ex.newRequest);
  assert.equal(ex.newRequest.status, 'requested');
  assert.equal(ex.newRequest.supersedes, 'd3');
  assert.notEqual(ex.newRequest.id, 'd3');
  assert.deepEqual(ex.newRequest.argv, ['git', 'diff', '--cached']);
  // changed to something outside the allowlist: new request is denied by the room
  const ex2 = await executeDisclosure(ap.request, { argv: ['git', 'push'], run, allowlist: DEFAULT_ALLOWLIST });
  assert.equal(ex2.newRequest.status, 'denied');
  assert.equal(calls, 0);
  assert.equal(canExecuteDisclosure(ap.request, ['git', 'diff']).ok, true);
});

test('requestDisclosure NI-11: trailing arguments that write or read outside the snapshot are denied by the room', () => {
  const bad = [
    ['git', 'diff', '--output=C:/Users/u/.claude/CLAUDE.md'],
    ['git', 'diff', '--no-index', 'C:/Users/u/.codex/auth.json', 'x'],
    ['git', 'diff', '--no-index', 'a', 'b'],
    ['git', 'diff', '--outp=x.txt'], // git accepts unique abbreviations of long options
    ['git', 'diff', '--ext-diff'],
    ['git', 'diff', '--textconv'],
    ['git', 'diff', '-c'],
    ['git', 'diff', '--git-dir=C:/other/.git'],
    ['git', 'diff', '-OC:/x/order.txt'],
    ['git', 'diff', '../outside.txt'],
    ['git', 'diff', '--', '..\\..\\secret'],
    ['git', 'diff', '--', '/etc/passwd'],
    ['git', 'diff', 'C:relative'],
    ['git', 'diff', '\\\\server\\share\\f'],
    ['git', 'diff', 'a\u0000b'],
    ['git', 'status', '--porcelain', '--', 'C:\\Users\\u\\x'],
  ];
  for (const argv of bad) {
    const r = requestDisclosure({ argv, reason: 'r', allowlist: DEFAULT_ALLOWLIST, seatId: 'A', attemptId: 'a1', id: 'dx', now: 't0' });
    assert.equal(r.status, 'denied', JSON.stringify(argv));
    assert.equal(r.allowed, false, JSON.stringify(argv));
    assert.equal(r.deniedBy, 'room');
    assert.equal(r.denyReason, 'ARG_NOT_ALLOWED', JSON.stringify(argv));
    assert.ok(r.message.includes('Argument not allowed'), r.message);
    assert.equal(approveDisclosure(r).ok, false);
  }
  const good = [
    ['git', 'diff'],
    ['git', 'diff', '--stat'],
    ['git', 'diff', '--cached', '--name-only'],
    ['git', 'diff', '-U5', 'HEAD~1..HEAD', '--', 'src/a.mjs', 'lib\\b.mjs'],
    ['git', 'diff', '--unified=0', '--diff-filter=AM', '--no-ext-diff', '--no-textconv'],
    ['git', 'status', '--short'],
    ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
  ];
  for (const argv of good) {
    const r = requestDisclosure({ argv, reason: 'r', allowlist: DEFAULT_ALLOWLIST, seatId: 'A', attemptId: 'a1', now: 't0' });
    assert.equal(r.status, 'requested', JSON.stringify(argv));
    assert.equal(r.matchKind, 'prefix');
  }
  // checkTrailingArgs is the exported rule both gates use.
  assert.equal(checkTrailingArgs(['git', 'diff'], ['--stat']), null);
  assert.equal(checkTrailingArgs(['git', 'diff'], ['--output=x']).arg, '--output=x');
  // A non-git prefix entry: only path-safe operands may be appended, no flags.
  const nodeList = [['node', 'tools/show.mjs']];
  assert.equal(requestDisclosure({ argv: ['node', 'tools/show.mjs', 'docs/a.md'], allowlist: nodeList }).status, 'requested');
  assert.equal(requestDisclosure({ argv: ['node', 'tools/show.mjs', '--out=C:/x'], allowlist: nodeList }).denyReason, 'ARG_NOT_ALLOWED');
  assert.equal(requestDisclosure({ argv: ['node', 'tools/show.mjs', '-e'], allowlist: nodeList }).denyReason, 'ARG_NOT_ALLOWED');
});

test('requestDisclosure NI-11: acceptance commands must match exactly, not as a prefix', () => {
  const acceptanceCommands = [['node', '--test', 'parser.test.mjs']];
  const exact = requestDisclosure({ argv: ['node', '--test', 'parser.test.mjs'], allowlist: [], acceptanceCommands });
  assert.equal(exact.status, 'requested');
  assert.equal(exact.matchKind, 'exact');
  const longer = requestDisclosure({ argv: ['node', '--test', 'parser.test.mjs', '--test-reporter-destination=C:/x.txt'], allowlist: [], acceptanceCommands });
  assert.equal(longer.status, 'denied');
  assert.equal(longer.denyReason, 'NOT_IN_ALLOWLIST');
  const shorter = requestDisclosure({ argv: ['node', '--test'], allowlist: [], acceptanceCommands: [['node', '--test']] });
  assert.equal(shorter.status, 'requested');
  assert.equal(requestDisclosure({ argv: ['node', '--test', '-e', 'x'], allowlist: [], acceptanceCommands: [['node', '--test']] }).status, 'denied');
});

test('canExecuteDisclosure NI-11: defence in depth re-checks the argument rule on the approved argv', () => {
  // A request shaped like one persisted before the argument rule existed: approved, prefix-matched.
  const legacy = { id: 'd9', status: 'approved', allowed: true, matched: ['git', 'diff'], argv: ['git', 'diff', '--output=C:/x'], approvedArgv: ['git', 'diff', '--output=C:/x'], history: [] };
  const g = canExecuteDisclosure(legacy);
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'ARG_NOT_ALLOWED');
  // An exact (acceptance) match must still be exact at execution time.
  const exact = { id: 'd8', status: 'approved', allowed: true, matched: ['node', '--test'], matchKind: 'exact', argv: ['node', '--test', '-e'], approvedArgv: ['node', '--test', '-e'], history: [] };
  assert.equal(canExecuteDisclosure(exact).reason, 'ARG_NOT_ALLOWED');
  const fine = { ...exact, argv: ['node', '--test'], approvedArgv: ['node', '--test'] };
  assert.equal(canExecuteDisclosure(fine).ok, true);
  // A request rebuilt from the event log carries neither matched nor matchKind (service requestOf).
  const rebuilt = (argv) => ({ id: 'd7', status: 'approved', allowed: true, argv, approvedArgv: argv, history: [] });
  assert.equal(canExecuteDisclosure(rebuilt(['git', 'diff', '--no-index', 'C:/a', 'b'])).reason, 'ARG_NOT_ALLOWED', 'git fallback without context');
  assert.equal(canExecuteDisclosure(rebuilt(['git', 'diff', '--stat'])).ok, true);
  assert.equal(canExecuteDisclosure(rebuilt(['git', 'status', '--short'])).ok, true);
  // With the allowlist context the full rule is re-run.
  const ctx = { allowlist: DEFAULT_ALLOWLIST, acceptanceCommands: [['node', '--test', 'p.test.mjs']] };
  assert.equal(canExecuteDisclosure(rebuilt(['node', '--test', 'p.test.mjs']), undefined, ctx).ok, true);
  assert.equal(canExecuteDisclosure(rebuilt(['node', '--test', 'p.test.mjs', '--x']), undefined, ctx).reason, 'ARG_NOT_ALLOWED');
  assert.equal(canExecuteDisclosure(rebuilt(['git', 'diff', '--output=C:/x']), undefined, ctx).reason, 'ARG_NOT_ALLOWED');
  assert.equal(canExecuteDisclosure(rebuilt(['git', 'diff', 'src/a.mjs']), undefined, ctx).ok, true);
});

test('executeDisclosure NI-11: an approved argv that breaks the argument rule never reaches the runner', async () => {
  let calls = 0;
  const run = async () => { calls++; return { exitCode: 0 }; };
  const req = { id: 'd6', status: 'approved', allowed: true, argv: ['git', 'diff', '--output=C:/Users/u/.claude/CLAUDE.md'], approvedArgv: ['git', 'diff', '--output=C:/Users/u/.claude/CLAUDE.md'], history: [] };
  const ex = await executeDisclosure(req, { run, allowlist: DEFAULT_ALLOWLIST });
  assert.equal(ex.ok, false);
  assert.equal(ex.reason, 'ARG_NOT_ALLOWED');
  assert.equal(calls, 0);
  const ex2 = await executeDisclosure(req, { run });
  assert.equal(ex2.reason, 'ARG_NOT_ALLOWED');
  assert.equal(calls, 0);
});

test('denyDisclosure: requested or approved -> denied', () => {
  const req = requestDisclosure({ argv: ['git', 'status'], allowlist: DEFAULT_ALLOWLIST, id: 'd4', now: 't0' });
  const d = denyDisclosure(req, { by: 'admin', reason: 'not needed', now: 't1' });
  assert.equal(d.ok, true);
  assert.equal(d.request.status, 'denied');
  assert.equal(d.request.denyReason, 'not needed');
  assert.equal(canExecuteDisclosure(d.request).reason, 'NOT_APPROVED');
  const ap = approveDisclosure(req).request;
  assert.equal(denyDisclosure(ap).request.status, 'denied');
  assert.equal(denyDisclosure(null).reason, 'INVALID_TRANSITION');
  assert.equal(denyDisclosure(d.request).reason, 'INVALID_TRANSITION');
});

// ---- adjudications (#28) ----
test('defaultAdjudicationsPath is under appRoot(), never AppData', () => {
  const p = defaultAdjudicationsPath();
  assert.equal(p, path.join(appRoot(), 'adjudications.jsonl'));
  if (process.env.LOCALAPPDATA && !process.env.ROOM_DEV_HOME) assert.ok(!isInside(p, process.env.LOCALAPPDATA));
});

test('appendAdjudication + readAdjudications: guarded append-only log', () => {
  const base = path.join(testRunsRoot(), Math.random().toString(16).slice(2, 10));
  const file = path.join(base, 'adj', 'adjudications.jsonl');
  try {
    const e1 = appendAdjudication(file, { roomId: 'p1', reviewerAgent: 'codex', preset: 'implement-review', verdict: 'pass', ts: '2026-10-01T00:00:00.000Z', artifactSha: 'm1', annotation: 'none' });
    assert.equal(e1.ts, '2026-10-01T00:00:00.000Z');
    const e2 = appendAdjudication(file, { roomId: 'p2', reviewerAgent: 'codex', preset: 'implement-review', verdict: 'reject' });
    assert.ok(e2.ts);
    assert.throws(() => appendAdjudication(file, { roomId: 'p3', reviewerAgent: 'codex', preset: 'x', verdict: 'approve' }), /verdict/);
    assert.throws(() => appendAdjudication(file, { reviewerAgent: 'codex', preset: 'x', verdict: 'pass' }), /roomId/);
    assert.throws(() => appendAdjudication(file, null), /object/);
    const rows = readAdjudications(file);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], e1);
    assert.equal(rows[1].verdict, 'reject');
    const log = fs.readFileSync(path.join(path.dirname(file), 'write-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(log.every((r) => r.who === 'adjudications'));
    assert.ok(log.some((r) => r.op === 'append' && r.path === path.resolve(file)));
    // a guard with a different root refuses
    const elsewhere = createGuard({ allowed: [path.join(base, 'other')], logPath: path.join(base, 'other', 'write-log.jsonl'), who: 't' });
    fs.mkdirSync(path.join(base, 'other'), { recursive: true });
    assert.throws(() => appendAdjudication(file, { roomId: 'p', reviewerAgent: 'c', preset: 'x', verdict: 'pass' }, { guard: elsewhere }), /refused/);
    assert.equal(readAdjudications(file).length, 2);
    assert.deepEqual(readAdjudications(path.join(base, 'missing.jsonl')), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('rejectRateSignal #28: 7 rooms x 2 pass -> suspicious; fewer -> insufficient; any reject -> ok', () => {
  const entries = [];
  for (let r = 1; r <= 7; r++) for (let i = 0; i < 2; i++) entries.push({ roomId: `p${r}`, reviewerAgent: 'codex', preset: 'implement-review', verdict: 'pass', ts: 't' });
  const s = rejectRateSignal(entries, { reviewerAgent: 'codex', preset: 'implement-review' });
  assert.equal(s.status, 'suspicious');
  assert.equal(s.n, 14);
  assert.equal(s.k, 0);
  assert.equal(s.rooms, 7);
  assert.ok(Math.abs(s.probability - Math.pow(0.8, 14)) < 1e-12);
  assert.ok(s.probability > 0.043 && s.probability < 0.045, 'about 4.4%');
  assert.ok(s.message.includes('Reviewer may not be catching issues'));

  const few = rejectRateSignal(entries.slice(0, 13), { reviewerAgent: 'codex', preset: 'implement-review' });
  assert.equal(few.status, 'insufficient');
  assert.equal(few.n, 13);
  assert.ok(few.message.includes('Insufficient samples'));

  const withReject = rejectRateSignal([...entries, { roomId: 'p8', reviewerAgent: 'codex', preset: 'implement-review', verdict: 'reject' }], { reviewerAgent: 'codex', preset: 'implement-review' });
  assert.equal(withReject.status, 'ok');
  assert.equal(withReject.k, 1);
  assert.equal(withReject.n, 15);
});

test('rejectRateSignal: filters by (reviewerAgent, preset); configurable threshold and rate', () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({ roomId: `a${i}`, reviewerAgent: 'claude', preset: 'division', verdict: 'pass' })),
    ...Array.from({ length: 5 }, (_, i) => ({ roomId: `b${i}`, reviewerAgent: 'codex', preset: 'division', verdict: 'pass' })),
    { roomId: 'c', reviewerAgent: 'claude', preset: 'implement-review', verdict: 'reject' },
    { roomId: 'd', reviewerAgent: 'claude', preset: 'division', verdict: 'bogus' },
  ];
  const s = rejectRateSignal(entries, { reviewerAgent: 'claude', preset: 'division', n: 5, assumedRejectRate: 0.5 });
  assert.equal(s.n, 5);
  assert.equal(s.status, 'suspicious');
  assert.equal(s.threshold, 5);
  assert.equal(s.assumedRejectRate, 0.5);
  assert.ok(Math.abs(s.probability - 0.03125) < 1e-12);
  const all = rejectRateSignal(entries, { n: 5 });
  assert.equal(all.n, 11);
  assert.equal(all.k, 1);
  assert.equal(all.status, 'ok');
  assert.equal(rejectRateSignal(null, {}).status, 'insufficient');
  assert.equal(rejectRateSignal([], { n: 0 }).threshold, 1);
});
