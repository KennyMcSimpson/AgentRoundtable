// Token usage accounting (plan §4.3 rule 8, §7.5; INTERFACES §7 lib/usage.mjs).
// Hosted seats report usage; embedded seats cannot, so their usage is unknown. Unknown is a state,
// not a number: it is never summed as 0, and a total that nothing known contributed to stays null.
// The pause rule only ever fires on known tokens: when cumulative known tokens reach the cap,
// the room pauses after the current attempt reaches a terminal state (the service applies the timing; this module answers the question).
// Pure functions: accumulate() returns a new object and never mutates its input.

function known(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }

function emptyTotals() {
  return { input: null, output: null, cached: null, tokens: null, knownReports: 0, unknownReports: 0 };
}

export function emptyUsage() {
  return { totals: emptyTotals(), bySeat: {}, attempts: {}, unknownSeats: [], lastReport: null };
}

// A report is known when both input and output are non-negative finite numbers. `cached` is optional
// and only enters the cached sum when it is itself known; it never affects the known/unknown verdict.
export function classifyReport(ev = {}) {
  const ok = known(ev.input) && known(ev.output);
  return {
    known: ok,
    input: ok ? ev.input : null,
    output: ok ? ev.output : null,
    cached: ok && known(ev.cached) ? ev.cached : null,
    source: ev.source || null,
  };
}

function addTo(totals, r) {
  const t = { ...totals };
  if (!r.known) { t.unknownReports += 1; return t; }
  t.knownReports += 1;
  t.input = (t.input || 0) + r.input;
  t.output = (t.output || 0) + r.output;
  if (r.cached != null) t.cached = (t.cached || 0) + r.cached;
  t.tokens = t.input + t.output;
  return t;
}

function rebuildTotals(attempts, filter) {
  let t = emptyTotals();
  for (const key of Object.keys(attempts).sort()) {
    const a = attempts[key];
    if (filter && !filter(a)) continue;
    t = addTo(t, a);
  }
  return t;
}

// accumulate(usageState, usage_reported) -> new usageState
//   usageState : the object from emptyUsage() (null/undefined starts fresh).
//   event      : {type:'usage_reported', seatId, attemptId, input, output, cached, source} — the
//                `type` field is optional; any other event type is ignored and the same state returns.
// One attempt contributes once: a later report for the same (seatId, attemptId) replaces the earlier
// one (hosted seats may report partial usage while streaming). Totals are recomputed from the
// per-attempt table, so the result does not depend on report order.
export function accumulate(state, ev) {
  const base = state && typeof state === 'object' ? state : emptyUsage();
  if (!ev || typeof ev !== 'object') return base;
  if (ev.type && ev.type !== 'usage_reported') return base;
  const seatId = ev.seatId == null ? 'unknown' : String(ev.seatId);
  const attemptId = ev.attemptId == null ? `anon-${Object.keys(base.attempts || {}).length + 1}` : String(ev.attemptId);
  const r = { ...classifyReport(ev), seatId, attemptId };
  const attempts = { ...(base.attempts || {}), [`${seatId}/${attemptId}`]: r };
  const bySeat = {};
  for (const key of Object.keys(attempts)) {
    const sid = attempts[key].seatId;
    if (!bySeat[sid]) bySeat[sid] = rebuildTotals(attempts, (a) => a.seatId === sid);
  }
  const unknownSeats = Object.keys(bySeat).filter((sid) => bySeat[sid].unknownReports > 0).sort();
  return {
    totals: rebuildTotals(attempts),
    bySeat,
    attempts,
    unknownSeats,
    lastReport: { seatId, attemptId, known: r.known, source: r.source, ts: ev.ts || null },
  };
}

// Convenience for the service: an embedded seat's attempt reached a terminal state with no report.
export function markUnknown(state, { seatId, attemptId, source = 'declared' } = {}) {
  return accumulate(state, { type: 'usage_reported', seatId, attemptId, input: null, output: null, cached: null, source });
}

// isPaused({totals, maxTokens}) -> boolean. True only when the KNOWN token sum reaches maxTokens.
// No limit (null/0/negative/non-number) or no known usage -> false.
export function isPaused({ totals, maxTokens } = {}) {
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const tokens = totals && totals.tokens;
  if (!known(tokens)) return false;
  return tokens >= limit;
}

// Richer answer for the UI: status ∈ paused | ok | unlimited | unknown.
//   unknown = there is a limit but nothing known has been reported yet (cannot judge).
export function budgetStatus({ totals, maxTokens } = {}) {
  const limit = Number(maxTokens);
  const t = totals || emptyTotals();
  const knownTokens = known(t.tokens) ? t.tokens : null;
  if (!Number.isFinite(limit) || limit <= 0) return { status: 'unlimited', paused: false, knownTokens, maxTokens: null, unknownReports: t.unknownReports || 0 };
  if (knownTokens == null) return { status: 'unknown', paused: false, knownTokens, maxTokens: limit, unknownReports: t.unknownReports || 0 };
  const paused = knownTokens >= limit;
  return { status: paused ? 'paused' : 'ok', paused, knownTokens, maxTokens: limit, unknownReports: t.unknownReports || 0, remaining: Math.max(0, limit - knownTokens) };
}

function fmt(n) { return n == null ? 'Unknown' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// English one-liner for the seat bar / usage view. Never prints an unknown as 0.
export function formatUsage(usage, { maxTokens } = {}) {
  const u = usage && usage.totals ? usage : emptyUsage();
  const t = u.totals;
  const parts = [];
  if (t.tokens == null) parts.push('Known usage: none');
  else parts.push(`Known usage ${fmt(t.tokens)} tokens (input ${fmt(t.input)}, output ${fmt(t.output)}${t.cached != null ? `, cached ${fmt(t.cached)}` : ''})`);
  if (t.unknownReports > 0) parts.push(`${t.unknownReports} more turn(s) with Unknown usage${u.unknownSeats && u.unknownSeats.length ? ` (seats: ${u.unknownSeats.join(', ')})` : ''}`);
  const b = budgetStatus({ totals: t, maxTokens });
  if (b.status === 'paused') parts.push(`Cap ${fmt(b.maxTokens)} reached; pausing after current attempt finishes`);
  else if (b.status === 'ok') parts.push(`Cap ${fmt(b.maxTokens)}, remaining ${fmt(b.remaining)}`);
  else if (b.status === 'unknown') parts.push(`Cap ${fmt(b.maxTokens)}, no known usage yet to compare`);
  return parts.join('; ');
}
