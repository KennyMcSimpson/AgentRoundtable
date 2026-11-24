/* ui/app.js - AgentRoundtable Room Workspace UI. Plain ES2020 classic script, zero build step, zero framework.
 *
 * Data flow
 *   GET /api/stream?since=N   SSE live push (automatic fallback to 2 s polling)
 *   GET /api/state            fallback poll -> base reducer state (INTERFACES sections 4 / 8)
 *   GET /api/events?since=N   fallback poll -> event tail folded client-side into `derived` (RoomUI.derive)
 *   POST /api/admin           per action    -> JSON body { token, cmd, ...params }
 *
 * Security & correctness invariants:
 * - Admin token is read from URL fragment (#<token>) and scrubbed via history.replaceState; kept in memory only.
 * - Zero HTML-string injection: every DOM node is constructed with createElement / createTextNode.
 * - Zero browser storage APIs or cookies. Theme toggle is strictly in-memory.
 * - Audit observations never claim a seat is write-free; they report only "No writes observed under this method".
 * - Everything under `RoomUI` is DOM-free so it can be loaded in Node vm by test/ui.test.mjs.
 */
(function () {
  'use strict';

  var UNKNOWN = 'Unknown';

  // ---------------------------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------------------------
  function isObj(v) { return v !== null && typeof v === 'object'; }
  function u(v) { return v === null || v === undefined || v === '' ? UNKNOWN : String(v); }
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function shortSha(s) { return typeof s === 'string' && s.length > 16 ? s.slice(0, 16) : u(s); }
  function fmtTs(ts) {
    if (!ts) return UNKNOWN;
    var d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtArgv(argv) {
    if (!Array.isArray(argv)) return UNKNOWN;
    return argv.map(String).join(' ');
  }
  function fmtBytes(n) {
    n = num(n);
    if (n === null) return UNKNOWN;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtCompactNum(n) {
    n = num(n);
    if (n === null) return UNKNOWN;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
    return String(n);
  }

  // /api/state may be the state itself or { state, room }. Room config may also sit inside the state.
  function unwrapState(payload) {
    if (!isObj(payload)) return { state: {}, room: null };
    var state = isObj(payload.state) ? payload.state : payload;
    var room = isObj(payload.room) ? payload.room : (isObj(state.room) ? state.room : (isObj(state.config) ? state.config : null));
    return { state: state, room: room };
  }
  // /api/events may be an array or { events | items | rows: [...] }.
  function unwrapEvents(payload) {
    if (Array.isArray(payload)) return payload;
    if (!isObj(payload)) return [];
    var arr = payload.events || payload.items || payload.rows;
    return Array.isArray(arr) ? arr : [];
  }

  // ---------------------------------------------------------------------------------------------
  // Event folding (client-side derived model over INTERFACES section 4 event types)
  // ---------------------------------------------------------------------------------------------
  var RECEIPT_BY_AUDIT = { present_in_native: 'present', header_only: 'header_only', unknown: 'unknown' };
  var TERMINAL = { submitted: 1, failed: 1, canceled: 1, expired: 1, work_partial: 1 };

  function emptyDerived() {
    return {
      lastSeq: 0,
      epoch: null,
      roundId: null,
      phase: null,
      roundKey: 0,                 // bumps on round_started / round_reopened; wakes count per key
      seatStatus: {},              // seatId -> { status, ts }
      task: null,                  // { text, sha256, ts }
      taskDraft: null,             // { seatId, attemptId, draft, ts, seq }
      taskConfirmed: null,         // { assignments, by, ts }
      phases: [],                  // phase_changed
      messages: {},                // msgSeq -> { seq, seatId, role, text, attemptId, ts, escaped }
      stream: [],                  // ordered stream entries { seq, ts, kind, ... }
      attempts: {},                // attemptId -> { attemptId, seatId, packetId, roundId, issuedAt, terminal, class, deadline }
      packets: {},                 // packetId -> { packetId, seatId, attemptId, ts, bytes, sha256, receipt, auditTs, superseded }
      attemptPacket: {},           // attemptId -> packetId
      artifacts: {},               // manifestSha -> { ... frozen fields, recomputed, staleAccepted, verdicts: [] }
      verdicts: [],                // verdict_recorded
      disclosures: {},             // id -> { id, seatId, attemptId, argv, reason, status, by, denyReason, exec }
      items: {},                   // itemId -> { itemId, seatId, attemptId, aboutSeq, text, mark }
      quotes: [],                  // quote_submitted
      misquoted: [],               // misquoted_declared
      summaries: [],               // summary_published
      supersededNotices: [],       // superseded_notice
      reversals: [],               // direction_reversed
      reconcile: {},               // attemptId -> { attemptId, seatId, status: 'needs_reconcile'|'reconciled', action, ts }
      userMessages: [],            // user_message_queued
      reopened: [],                // round_reopened
      failures: [],                // seat_failed
      usage: {},                   // seatId -> { attempts: { attemptId -> { input, output, cached, known, source } }, sources: {} }
      wakes: [],                   // wake_pushed that pushed { seatId, attemptId, ok, by, detail, ts, roundKey }
      wakeRefusals: [],            // wake_pushed with refused (nothing pushed; manual wake required)
      noArtifact: [],              // work_no_artifact
      audits: [],                  // audit_observed
      rejected: [],                // submission_rejected
      skips: [],
      farewells: [],
      workPartial: [],
      counts: {}                   // event type -> count
    };
  }

  function pushStream(d, ev, entry) {
    entry.seq = ev.seq;
    entry.ts = ev.ts;
    d.stream.push(entry);
  }
  function ensureArtifact(d, sha) {
    if (!sha) return null;
    if (!d.artifacts[sha]) d.artifacts[sha] = { manifestSha: sha, verdicts: [], recomputed: null, staleAccepted: null };
    return d.artifacts[sha];
  }
  function markTerminal(d, attemptId, terminal, extra) {
    if (!attemptId) return;
    if (!d.attempts[attemptId]) d.attempts[attemptId] = { attemptId: attemptId, seatId: extra && extra.seatId || null };
    var a = d.attempts[attemptId];
    if (!a.terminal) { a.terminal = terminal; if (extra) Object.assign(a, extra); }
  }

  function fold(d, ev) {
    if (!isObj(ev) || typeof ev.type !== 'string') return d;
    if (num(ev.seq) !== null && ev.seq > d.lastSeq) d.lastSeq = ev.seq;
    d.counts[ev.type] = (d.counts[ev.type] || 0) + 1;
    switch (ev.type) {
      case 'seat_joined': d.seatStatus[ev.seatId] = { status: 'joined', ts: ev.ts }; break;
      case 'seat_left':
        d.seatStatus[ev.seatId] = { status: 'left', ts: ev.ts };
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' left' });
        break;
      case 'task_set':
        d.task = { text: ev.text, sha256: ev.sha256, ts: ev.ts };
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'User task set (sha ' + shortSha(ev.sha256) + ')' });
        break;
      case 'round_started':
        d.roundId = num(ev.roundId); if (num(ev.epoch) !== null) d.epoch = ev.epoch; d.roundKey += 1;
        pushStream(d, ev, {
          kind: 'marker',
          tone: 'info',
          roundId: num(ev.roundId),
          text: 'Round ' + u(ev.roundId) + ' started · order: ' + (Array.isArray(ev.order) ? ev.order.join(', ') : UNKNOWN)
        });
        break;
      case 'phase_changed':
        d.phase = ev.to;
        d.phases.push({ from: ev.from, to: ev.to, roundId: ev.roundId, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Phase ' + u(ev.from) + ' → ' + u(ev.to) });
        break;
      case 'packet_issued': {
        d.attempts[ev.attemptId] = Object.assign(d.attempts[ev.attemptId] || {}, {
          attemptId: ev.attemptId, seatId: ev.seatId, packetId: ev.packetId, issuedAt: ev.ts, deadline: ev.deadline,
          roundId: ev.roundId !== undefined ? ev.roundId : d.roundId,
          terminal: (d.attempts[ev.attemptId] || {}).terminal || null
        });
        Object.keys(d.packets).forEach(function (pid) { if (d.packets[pid].seatId === ev.seatId && !d.packets[pid].superseded) d.packets[pid].superseded = ev.packetId; });
        d.packets[ev.packetId] = { packetId: ev.packetId, seatId: ev.seatId, attemptId: ev.attemptId, ts: ev.ts, bytes: ev.bytes, sha256: ev.sha256, receipt: 'sent', auditTs: null, superseded: null };
        d.attemptPacket[ev.attemptId] = ev.packetId;
        break;
      }
      case 'packet_resent': {
        if (d.packets[ev.packetId]) Object.assign(d.packets[ev.packetId], { bytes: ev.bytes, sha256: ev.sha256, resend: ev.resend, resentAt: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Packet ' + u(ev.packetId) + ' receipt unknown; resent (attempt #' + u(ev.resend) + ', with idempotency note)' });
        break;
      }
      case 'submission_accepted': {
        var m = {
          seq: ev.msgSeq, seatId: ev.seatId, role: ev.role, text: ev.text, attemptId: ev.attemptId, ts: ev.ts,
          escaped: ev.escaped, sha256: ev.sha256, authority: 'none', annotation: ev.annotation || null, malformed: ev.malformed || null
        };
        if (num(ev.msgSeq) !== null) d.messages[ev.msgSeq] = m;
        markTerminal(d, ev.attemptId, 'submitted', { seatId: ev.seatId });
        pushStream(d, ev, { kind: 'message', msg: m });
        break;
      }
      case 'submission_rejected':
        d.rejected.push({ seatId: ev.seatId, attemptId: ev.attemptId, reason: ev.reason, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' submission rejected: ' + u(ev.reason) });
        break;
      case 'attempt_canceled':
        markTerminal(d, ev.attemptId, 'canceled', { seatId: ev.seatId, by: ev.by });
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' attempt ' + u(ev.attemptId) + ' canceled (' + u(ev.by) + ')' });
        break;
      case 'attempt_expired':
        markTerminal(d, ev.attemptId, 'expired', { seatId: ev.seatId });
        pushStream(d, ev, {
          kind: 'marker',
          tone: 'bad',
          text: 'Seat ' + u(ev.seatId) + ' attempt ' + u(ev.attemptId) + ' timed out' + (ev.hold ? '; awaiting user decision: retry / skip / reassign' : '')
        });
        break;
      case 'seat_skipped':
        d.skips.push({ seatId: ev.seatId, attemptId: ev.attemptId, by: ev.by, ts: ev.ts });
        if (ev.attemptId) markTerminal(d, ev.attemptId, 'canceled', { seatId: ev.seatId, by: 'skip' });
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' skipped (' + u(ev.by) + ')' });
        break;
      case 'epoch_bumped': if (num(ev.epoch) !== null) d.epoch = ev.epoch; break;
      case 'round_done':
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Round ' + u(ev.roundId) + ' completed' });
        break;
      case 'room_closed':
        d.phase = 'closed';
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Room closed' });
        break;
      case 'wake_pushed': {
        var ok = ev.command_ok !== undefined ? ev.command_ok : ev.ok;
        // A refused wake (THREAD_BUSY / IDLE_UNKNOWN) pushed nothing: it is not counted toward W.
        if (ev.refused) {
          d.wakeRefusals.push({ seatId: ev.seatId, attemptId: ev.attemptId, refused: ev.refused, detail: ev.detail, ts: ev.ts, roundKey: d.roundKey });
          pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' wake refused (' + u(ev.refused) + '): manual wake required' });
          break;
        }
        d.wakes.push({ seatId: ev.seatId, attemptId: ev.attemptId, ok: ok, by: ev.by, detail: ev.detail, ts: ev.ts, roundKey: d.roundKey });
        break;
      }
      case 'work_no_artifact':
        d.noArtifact.push({ seatId: ev.seatId, attemptId: ev.attemptId, roundId: ev.roundId, reason: ev.reason, manifestSha: ev.manifestSha || null, ts: ev.ts });
        pushStream(d, ev, {
          kind: 'marker',
          tone: 'bad',
          text: 'Seat ' + u(ev.seatId) + ' finished Work with ' + (ev.reason === 'empty' ? 'an empty frozen artifact set' : 'no frozen artifacts') + ': marked no_artifact'
        });
        break;
      case 'task_drafted':
        d.taskDraft = { seatId: ev.seatId, attemptId: ev.attemptId, draft: ev.draft, ts: ev.ts, seq: ev.seq };
        d.taskConfirmed = null;
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Lead ' + u(ev.seatId) + ' drafted task assignments, awaiting confirmation' });
        break;
      case 'task_confirmed':
        d.taskConfirmed = { assignments: ev.assignments, by: ev.by, ts: ev.ts };
        pushStream(d, ev, { kind: 'marker', tone: 'ok', text: 'Task assignments confirmed' });
        break;
      case 'work_started':
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Work phase started: ' + (Array.isArray(ev.seats) ? ev.seats.join(', ') : UNKNOWN) });
        break;
      case 'work_partial':
        d.workPartial.push({ roundId: ev.roundId, seatId: ev.seatId, attemptId: ev.attemptId, ts: ev.ts });
        markTerminal(d, ev.attemptId, 'work_partial', { seatId: ev.seatId });
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' work timed out; marked work_partial' });
        break;
      case 'artifacts_frozen': {
        var art = ensureArtifact(d, ev.manifestSha);
        if (art) Object.assign(art, { seatId: ev.seatId, roundId: ev.roundId, baseline: ev.baseline, fileCount: ev.fileCount, bytes: ev.bytes, excluded: ev.excluded, copyTorn: ev.copyTorn, frozenAt: ev.ts });
        break;
      }
      case 'artifacts_recomputed': {
        var art2 = ensureArtifact(d, ev.manifestSha);
        if (art2) {
          if (!art2.seatId) art2.seatId = ev.seatId;
          art2.recomputed = { changed: Array.isArray(ev.changed) ? ev.changed : [], stale: !!ev.stale, ts: ev.ts };
        }
        if (ev.stale) pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Artifact ' + shortSha(ev.manifestSha) + ' became stale on recompute; excluded from summary' });
        break;
      }
      case 'stale_accepted': {
        var art3 = ensureArtifact(d, ev.manifestSha);
        if (art3) art3.staleAccepted = { by: ev.by, changed: ev.changed, ts: ev.ts };
        break;
      }
      case 'point_added':
        d.items[ev.itemId] = { itemId: ev.itemId, seatId: ev.seatId, attemptId: ev.attemptId, aboutSeq: ev.aboutSeq, text: ev.text, mark: null, ts: ev.ts };
        break;
      case 'quote_submitted': {
        var qSeq = num(ev.quotedSeq) !== null ? ev.quotedSeq : (num(ev.aboutSeq) !== null ? ev.aboutSeq : ev.seq);
        d.quotes.push({ seatId: ev.seatId, attemptId: ev.attemptId, seq: qSeq, text: ev.text, verified: typeof ev.verified === 'boolean' ? ev.verified : null, ts: ev.ts });
        break;
      }
      case 'item_marked': {
        if (!d.items[ev.itemId]) d.items[ev.itemId] = { itemId: ev.itemId, mark: null };
        d.items[ev.itemId].mark = { by: ev.by, status: ev.status, text: ev.text, ts: ev.ts };
        break;
      }
      case 'misquoted_declared':
        d.misquoted.push({ seatId: ev.seatId, aboutSeq: ev.aboutSeq, text: ev.text, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Seat ' + u(ev.seatId) + ' disputed quote at seq ' + u(ev.aboutSeq) });
        break;
      case 'verdict_recorded': {
        // authorized: verdict came from the producer's resolved reviewer (only those bind);
        // tainted / annotations: full annotation list so a taint is never hidden by another mark.
        var v = {
          seatId: ev.seatId, attemptId: ev.attemptId, artifactSha: ev.artifactSha, verdict: ev.verdict, annotation: ev.annotation, evidence: ev.evidence, ts: ev.ts, seq: ev.seq,
          authorized: typeof ev.authorized === 'boolean' ? ev.authorized : null,
          tainted: !!ev.tainted || (Array.isArray(ev.annotations) && ev.annotations.indexOf('tainted') !== -1),
          annotations: Array.isArray(ev.annotations) ? ev.annotations.slice() : (ev.annotation ? [ev.annotation] : []),
          producer: ev.producer || null
        };
        d.verdicts.push(v);
        var art4 = ensureArtifact(d, ev.artifactSha);
        if (art4) art4.verdicts.push(v);
        break;
      }
      case 'disclose_requested':
        d.disclosures[ev.id] = { id: ev.id, seatId: ev.seatId, attemptId: ev.attemptId, argv: ev.argv, reason: ev.reason, status: 'requested', ts: ev.ts };
        break;
      case 'disclose_approved':
        if (d.disclosures[ev.id]) { d.disclosures[ev.id].status = 'approved'; d.disclosures[ev.id].by = ev.by; }
        break;
      case 'disclose_denied':
        if (d.disclosures[ev.id]) { d.disclosures[ev.id].status = 'denied'; d.disclosures[ev.id].by = ev.by; d.disclosures[ev.id].denyReason = ev.reason; }
        break;
      case 'disclose_executed':
        if (d.disclosures[ev.id]) {
          d.disclosures[ev.id].status = 'executed';
          d.disclosures[ev.id].exec = { manifestSha: ev.manifestSha, exitCode: ev.exitCode, outputSha256: ev.outputSha256, truncated: ev.truncated, privatePath: ev.privatePath, ts: ev.ts };
        }
        break;
      case 'summary_published': {
        var s = {
          version: ev.version, seatId: ev.seatId, attemptId: ev.attemptId,
          unanswered: Array.isArray(ev.unanswered) ? ev.unanswered : [],
          supersedes: ev.supersedes === undefined ? null : ev.supersedes,
          ts: ev.ts, seq: ev.seq,
          verdicts: Array.isArray(ev.verdicts) ? ev.verdicts : [],
          excluded: Array.isArray(ev.excluded) ? ev.excluded : [],
          verified: Array.isArray(ev.verified) ? ev.verified : null,
          absent: Array.isArray(ev.absent) ? ev.absent : [],
          noArtifact: Array.isArray(ev.noArtifact) ? ev.noArtifact : []
        };
        d.summaries.push(s);
        pushStream(d, ev, { kind: 'summary', summary: s });
        break;
      }
      case 'superseded_notice':
        d.supersededNotices.push({ forSeat: ev.forSeat, oldVersion: ev.oldVersion, newVersion: ev.newVersion, packetId: ev.packetId, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Superseded notice → Seat ' + u(ev.forSeat) + ': Summary v' + u(ev.oldVersion) + ' superseded by v' + u(ev.newVersion) + ' (packet ' + u(ev.packetId) + ')' });
        break;
      case 'direction_reversed':
        if (num(ev.epoch) !== null) d.epoch = ev.epoch;
        d.reversals.push({ epoch: ev.epoch, before: ev.before, after: ev.after, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Roles reversed: epoch ' + u(ev.epoch) });
        break;
      case 'needs_reconcile':
        d.reconcile[ev.attemptId] = { attemptId: ev.attemptId, seatId: ev.seatId, status: 'needs_reconcile', ts: ev.ts };
        pushStream(d, ev, { kind: 'marker', tone: 'bad', text: 'Pending attempt ' + u(ev.attemptId) + ' (Seat ' + u(ev.seatId) + ') found after restart; awaiting reconcile' });
        break;
      case 'reconciled': {
        var r = d.reconcile[ev.attemptId] || { attemptId: ev.attemptId };
        r.status = 'reconciled'; r.action = ev.action; r.reconciledAt = ev.ts;
        d.reconcile[ev.attemptId] = r;
        if (ev.action === 'void') markTerminal(d, ev.attemptId, 'canceled', { by: 'void' });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Attempt ' + u(ev.attemptId) + ' reconciled: ' + (ev.action === 'replay' ? 'replayed' : ev.action === 'void' ? 'voided' : u(ev.action)) });
        break;
      }
      case 'user_message_queued': {
        // Message seq is `msgSeq`; `ev.seq` is the event envelope seq. Missing msgSeq renders as Unknown.
        var umSeq = num(ev.msgSeq) !== null ? ev.msgSeq : null;
        d.userMessages.push({ seq: umSeq, eventSeq: ev.seq, text: ev.text, ts: ev.ts });
        pushStream(d, ev, { kind: 'user', text: ev.text, msgSeq: umSeq });
        break;
      }
      case 'round_reopened':
        if (num(ev.epoch) !== null) d.epoch = ev.epoch;
        d.roundKey += 1;
        d.reopened.push({ epoch: ev.epoch, supersededSeqs: ev.supersededSeqs, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'warn', text: 'Round reopened: epoch ' + u(ev.epoch) + ', superseded seqs: ' + (Array.isArray(ev.supersededSeqs) && ev.supersededSeqs.length ? ev.supersededSeqs.join(', ') : '(none)') });
        break;
      case 'seat_failed':
        d.failures.push({ seatId: ev.seatId, attemptId: ev.attemptId, class: ev.class, detail: ev.detail, ts: ev.ts });
        markTerminal(d, ev.attemptId, 'failed', { seatId: ev.seatId, class: ev.class });
        pushStream(d, ev, { kind: 'marker', tone: 'bad', text: 'Seat ' + u(ev.seatId) + ' failed: failed(' + u(ev.class) + ')' + (ev.detail ? ' · ' + ev.detail : '') });
        break;
      case 'usage_reported': {
        // Same rule as lib/usage.mjs: known only when input and output are both non-negative numbers.
        var sid = ev.seatId === undefined || ev.seatId === null ? 'unknown' : String(ev.seatId);
        var us = d.usage[sid] || (d.usage[sid] = { attempts: {}, sources: {} });
        var knownRep = num(ev.input) !== null && num(ev.output) !== null && ev.input >= 0 && ev.output >= 0;
        us.attempts[ev.attemptId ? String(ev.attemptId) : 'anon-' + u(ev.seq)] = {
          input: knownRep ? ev.input : null,
          output: knownRep ? ev.output : null,
          cached: knownRep && num(ev.cached) !== null ? ev.cached : null,
          known: knownRep,
          source: ev.source || null
        };
        if (ev.source) us.sources[ev.source] = (us.sources[ev.source] || 0) + 1;
        break;
      }
      case 'farewell_issued':
        d.farewells.push({ packetId: ev.packetId, seats: ev.seats, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'Farewell packet issued: ' + (Array.isArray(ev.seats) ? ev.seats.join(', ') : UNKNOWN) });
        break;
      case 'audit_observed': {
        var a = {
          seatId: ev.seatId, attemptId: ev.attemptId, status: ev.status,
          writes: Array.isArray(ev.writes) ? ev.writes : [],
          unknownCommands: Array.isArray(ev.unknownCommands) ? ev.unknownCommands : [],
          opened: Array.isArray(ev.opened) ? ev.opened : [],
          tainted: !!ev.tainted, ts: ev.ts
        };
        d.audits.push(a);
        var pid = d.attemptPacket[ev.attemptId];
        if (pid && d.packets[pid]) { d.packets[pid].receipt = RECEIPT_BY_AUDIT[ev.status] || 'unknown'; d.packets[pid].auditTs = ev.ts; }
        if (a.tainted) {
          pushStream(d, ev, {
            kind: 'marker',
            tone: 'bad',
            text: 'Audit: Seat ' + u(ev.seatId) + ' in attempt ' + u(ev.attemptId) + (a.writes.length ? ' had observed write operations' : ' ran non-allowlisted commands') + '; marked tainted'
          });
        }
        break;
      }
      default: break;
    }
    return d;
  }

  function derive(events) {
    var d = emptyDerived();
    (Array.isArray(events) ? events : []).forEach(function (ev) { fold(d, ev); });
    return d;
  }

  // ---------------------------------------------------------------------------------------------
  // View-model helpers (pure)
  // ---------------------------------------------------------------------------------------------
  function seatList(state, room, d) {
    var cfg = (room && Array.isArray(room.seats)) ? room.seats : (Array.isArray(state.seatConfigs) ? state.seatConfigs : []);
    var byId = Object.create(null);
    var hasId = function (id) { return Object.prototype.hasOwnProperty.call(byId, id); };
    cfg.forEach(function (s) { if (s && s.seatId) byId[s.seatId] = Object.assign({}, s); });
    var ids = Object.keys(byId);
    var extra = [].concat(Object.keys(isObj(state.seats) ? state.seats : {}), Object.keys(d.seatStatus), Array.isArray(state.order) ? state.order : []);
    extra.forEach(function (id) { if (id && !hasId(id)) { byId[id] = { seatId: id }; ids.push(id); } });
    return ids.map(function (id) {
      var s = byId[id];
      var st = (isObj(state.seats) && Object.prototype.hasOwnProperty.call(state.seats, id) && isObj(state.seats[id])) ? state.seats[id] : {};
      var ds = (Object.prototype.hasOwnProperty.call(d.seatStatus, id) && d.seatStatus[id]) || {};
      s.status = st.status || ds.status || null;
      s.retained = st.retained !== undefined ? st.retained : (s.retained !== undefined ? s.retained : null);
      s.isCurrent = state.currentSeat === id || (isObj(state.attempt) && state.attempt.seatId === id);
      return s;
    });
  }
  function seatForm(seat) {
    return isObj(seat.hosted) ? 'Hosted' : (seat.hosted === null || seat.audit !== undefined || seat.cwd ? 'Embedded' : UNKNOWN);
  }
  function seatAgent(seat) {
    if (isObj(seat.hosted)) return u(seat.hosted.kind) + (seat.hosted.tier ? '/' + seat.hosted.tier : '');
    if (typeof seat.agent === 'string' && seat.agent) return seat.agent;
    if (isObj(seat.audit) && seat.audit.kind) return seat.audit.kind;
    return UNKNOWN;
  }
  function auditSource(seat) {
    if (!isObj(seat.audit)) return seat.audit === null ? 'Unregistered' : UNKNOWN;
    var id = seat.audit.threadId || seat.audit.sessionId;
    return u(seat.audit.kind) + (id ? ' ' + id : ' (thread/session unregistered)');
  }
  function lastAuditFor(d, seatId) {
    for (var i = d.audits.length - 1; i >= 0; i--) if (d.audits[i].seatId === seatId) return d.audits[i];
    return null;
  }
  // Honest observation wording: never claims a guarantee, only what was observed under this method.
  function auditObservation(seat, d) {
    var a = lastAuditFor(d, seat.seatId);
    if (!a) return { text: 'Unaudited', tone: 'warn' };
    if (a.tainted) return { text: 'tainted (' + a.writes.length + ' write(s), ' + a.unknownCommands.length + ' unknown command(s) observed)', tone: 'bad' };
    if (a.status === 'unknown') return { text: 'Unaudited (log not found)', tone: 'warn' };
    if (a.writes.length) return { text: 'Observed ' + a.writes.length + ' write(s), ' + a.unknownCommands.length + ' unknown command(s) (non-review turn, not tainted)', tone: 'info' };
    if (a.unknownCommands.length) return { text: 'No writes observed; ' + a.unknownCommands.length + ' unknown command(s) unclassified', tone: 'warn' };
    return { text: 'No writes observed under this method', tone: 'ok' };
  }
  function wakesThisRound(d, seatId) { return d.wakes.filter(function (w) { return w.seatId === seatId && w.roundKey === d.roundKey; }).length; }
  function wakesTotal(d, seatId) { return d.wakes.filter(function (w) { return w.seatId === seatId; }).length; }

  function latestSummary(d) { return d.summaries.length ? d.summaries[d.summaries.length - 1] : null; }
  function verifiedFor(d, sha) {
    for (var i = d.summaries.length - 1; i >= 0; i--) {
      var list = d.summaries[i].verified;
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) if (list[j] && list[j].artifactSha === sha) return list[j];
    }
    return null;
  }
  function awaitingDecision(state) {
    var g = isObj(state) && isObj(state.awaitingDecision) ? state.awaitingDecision : null;
    return g && g.seatId ? g : null;
  }
  function wakeRefusalsFor(d, seatId) { return d.wakeRefusals.filter(function (w) { return w.seatId === seatId; }); }
  function itemStatus(item, d) {
    if (item.mark && item.mark.status) return item.mark.status;
    var s = latestSummary(d);
    if (s && s.unanswered.indexOf(item.itemId) !== -1) return 'unanswered';
    if (s && item.ts && s.ts && item.ts <= s.ts) return 'unknown';
    return 'pending';
  }
  function itemMisquoted(item, d) { return d.misquoted.some(function (m) { return num(item.aboutSeq) !== null && m.aboutSeq === item.aboutSeq; }); }

  function attemptsNeedingReconcile(d, state) {
    var rows = Object.keys(d.reconcile).map(function (k) { return d.reconcile[k]; }).filter(function (r) { return r.status === 'needs_reconcile'; });
    var extra = Array.isArray(state.needsReconcile) ? state.needsReconcile : (isObj(state.reconcile) && Array.isArray(state.reconcile.pending) ? state.reconcile.pending : []);
    extra.forEach(function (x) { var id = isObj(x) ? x.attemptId : x; if (id && !d.reconcile[id]) rows.push({ attemptId: id, seatId: isObj(x) ? x.seatId : null, status: 'needs_reconcile' }); });
    return rows;
  }
  function sideEffectHint(row, d, seats) {
    var a = d.attempts[row.attemptId] || {};
    var seat = seats.filter(function (s) { return s.seatId === (row.seatId || a.seatId); })[0] || {};
    var art = Object.keys(d.artifacts).map(function (k) { return d.artifacts[k]; }).filter(function (x) { return x.seatId === seat.seatId && x.recomputed && x.recomputed.changed.length; });
    var hint = seat.role === 'executor' || (d.phase === 'work')
      ? 'This seat may have already modified files; the room never re-runs work on behalf of any seat—inspect and reconcile inside that agent directly.'
      : 'Non-execution turn; side effects unknown.';
    return { hint: hint, changed: art.length ? art[0].recomputed.changed : [] };
  }

  function mergeConflicts(state, d) {
    var fromState = Array.isArray(state.conflicts) ? state.conflicts : (isObj(state.merge) && Array.isArray(state.merge.conflicts) ? state.merge.conflicts : null);
    if (fromState) return fromState.map(function (c) { return { path: c.path, seats: c.seats, manifests: c.manifests, detail: c.detail || c.reason || null, source: 'state' }; });
    var byPath = {};
    Object.keys(d.artifacts).forEach(function (sha) {
      var art = d.artifacts[sha];
      if (!art.recomputed) return;
      art.recomputed.changed.forEach(function (ch) {
        if (!ch || !ch.path) return;
        var row = byPath[ch.path] || (byPath[ch.path] = { path: ch.path, seats: [], manifests: [], source: 'derived' });
        if (row.seats.indexOf(art.seatId) === -1) row.seats.push(art.seatId);
        row.manifests.push({ manifestSha: sha, from: ch.from, to: ch.to });
      });
    });
    return Object.keys(byPath).map(function (p) { return byPath[p]; }).filter(function (r) { return r.seats.length >= 2; });
  }

  function receiptRows(d) {
    return Object.keys(d.packets).map(function (k) { return d.packets[k]; }).sort(function (a, b) { return (a.ts || '') < (b.ts || '') ? 1 : -1; });
  }

  function seatUsage(state, d, seatId) {
    var ev = d.usage[seatId];
    if (ev) {
      var r = { input: null, output: null, cached: null, knownReports: 0, unknownReports: 0, sources: Object.keys(ev.sources) };
      Object.keys(ev.attempts).sort().forEach(function (k) {
        var a = ev.attempts[k];
        if (!a.known) { r.unknownReports += 1; return; }
        r.knownReports += 1;
        r.input = (r.input || 0) + a.input; r.output = (r.output || 0) + a.output;
        if (a.cached !== null) r.cached = (r.cached || 0) + a.cached;
      });
      return r;
    }
    var us = isObj(state) && isObj(state.usage) ? state.usage : null;
    var row = us && isObj(us.bySeat) && isObj(us.bySeat[seatId]) ? us.bySeat[seatId] : (us && isObj(us.seats) && isObj(us.seats[seatId]) ? us.seats[seatId] : null);
    if (!row) return null;
    return {
      input: num(row.input), output: num(row.output), cached: num(row.cached),
      knownReports: num(row.knownReports) !== null ? row.knownReports : null,
      unknownReports: num(row.unknownReports) !== null ? row.unknownReports : null,
      sources: Array.isArray(row.sources) ? row.sources : (row.source ? [row.source] : [])
    };
  }

  function usageSummary(state, room, d) {
    state = isObj(state) ? state : {};
    var us = isObj(state.usage) ? state.usage : {};
    var budget = isObj(state.budget) ? state.budget : (room && isObj(room.budget) ? room.budget : {});
    var maxTokens = num(us.maxTokens) !== null ? us.maxTokens : (budget.maxTokens === null ? null : num(budget.maxTokens));
    var capKnown = num(us.maxTokens) !== null || budget.maxTokens === null || num(budget.maxTokens) !== null;
    var known = null, unknownReports = 0;
    var seatIds = Object.keys(d.usage);
    if (seatIds.length) {
      seatIds.forEach(function (sid) {
        var r = seatUsage(state, d, sid);
        if (r.input !== null && r.output !== null) known = (known || 0) + r.input + r.output;
        unknownReports += r.unknownReports;
      });
    } else if (isObj(us.totals)) {
      known = num(us.totals.tokens) !== null ? us.totals.tokens : (num(us.totals.input) !== null && num(us.totals.output) !== null ? us.totals.input + us.totals.output : null);
      unknownReports = num(us.totals.unknownReports) || 0;
    }
    var paused = null;
    if (typeof us.paused === 'boolean') paused = us.paused;
    else if (typeof state.paused === 'boolean') paused = state.paused;
    else if (isObj(state.budgetStatus) && typeof state.budgetStatus.paused === 'boolean') paused = state.budgetStatus.paused;
    else if (capKnown && (maxTokens === null || maxTokens <= 0)) paused = false;
    else if (maxTokens !== null && known !== null) paused = known >= maxTokens;
    return { knownTokens: known, unknownReports: unknownReports, maxTokens: capKnown ? maxTokens : undefined, packetMaxBytes: num(budget.packetMaxBytes), paused: paused };
  }

  function projectedTurns(state) {
    if (num(state.projectedTurns) !== null) return state.projectedTurns;
    if (Array.isArray(state.order) && num(state.turnIndex) !== null) return Math.max(0, state.order.length - state.turnIndex);
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Actions: every button maps to an admin command name. `cmd: null` = contract names no command.
  // ---------------------------------------------------------------------------------------------
  var ACTIONS = {
    'task': { cmd: 'task', label: 'Submit Task', build: function (p) { return { text: p.text }; }, needs: ['text'] },
    'start': { cmd: 'start', label: 'Start / Resume', build: function (p) { return { order: String(p.order || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean) }; }, needs: ['order'] },
    'cancel': { cmd: 'cancel', label: 'Cancel Attempt', confirm: 'Cancel the active attempt? The seat will receive a fresh attempt on the next tick.' },
    'skip': { cmd: 'skip', label: 'Skip Turn', confirm: 'Skip the current seat turn and mark it absent in the summary?' },
    'retry': { cmd: 'retry', label: 'Retry', build: function (p) { return p && p.seatId ? { seatId: p.seatId } : {}; }, confirm: 'Issue a fresh attempt for the same seat to retry this turn?' },
    'wake': { cmd: 'wake', label: 'Wake', build: function (p) { return { seatId: p.seatId }; }, needs: ['seatId'] },
    'close': { cmd: 'close', label: 'Close Room', confirm: 'Close this room? Farewell packets will be issued and seat commands will receive ROOM_CLOSED.' },
    'say': { cmd: 'say', label: 'Send Message', build: function (p) { return { text: p.text }; }, needs: ['text'] },
    'interrupt': { cmd: 'interrupt', label: 'Interrupt & Reopen', confirm: 'Interrupt and reopen the current round? Epoch will increment and the active attempt will be voided.', build: function (p) { return p.text ? { text: p.text } : {}; } },
    'confirm-task': { cmd: 'confirm-task', label: 'Confirm Task', confirm: 'Confirm the task draft and transition to Work (or Meet)?' },
    'reverse': { cmd: 'reverse', label: 'Reverse Roles', confirm: 'Swap reviewer and executor roles? Epoch will increment. Requires the current attempt to be terminal.' },
    'reconcile': { cmd: 'reconcile', label: 'Reconcile', build: function (p) { return { attemptId: p.attemptId, action: p.action }; }, needs: ['attemptId', 'action'] },
    'reassign': { cmd: 'reassign', label: 'Reassign', build: function (p) { return { seatId: p.seatId, toSeatId: p.toSeatId, text: p.text || '' }; }, needs: ['seatId', 'toSeatId'], confirm: 'Reassign this turn to another seat? Epoch will increment and the current attempt will be voided.' },
    'approve-disclose': { cmd: 'approve-disclose', label: 'Approve Disclosure', build: function (p) { return { id: p.id }; }, needs: ['id'], confirm: 'Approve this disclosure request? The service will execute the allowlisted command inside an isolated artifact snapshot and store output privately.' },
    'deny-disclose': { cmd: 'deny-disclose', label: 'Deny Disclosure', build: function (p) { return { id: p.id, reason: typeof p.reason === 'string' ? p.reason.trim() : '' }; }, needs: ['id', 'reason'], confirm: 'Deny this disclosure request? The required reason will be recorded in the event stream.' },
    'accept-stale': { cmd: 'accept-stale', label: 'Accept Stale', build: function (p) { return { manifestSha: p.manifestSha }; }, needs: ['manifestSha'], confirm: 'Accept the stale diff snapshot? Changed files will be admitted as-is without requiring a fresh review.' },
    'change-cap': { cmd: null, label: 'Change Cap', reason: 'INTERFACES defines no admin command for changing budget.maxTokens live. Stop the service, edit room.json, and restart.' },
    'merge-apply': { cmd: null, label: 'Apply', reason: 'INTERFACES defines no admin command for automatic merge resolution. Resolve conflicting files directly inside each agent workspace.' },
    'merge-discard': { cmd: null, label: 'Discard', reason: 'INTERFACES defines no admin command for discarding workspace changes from the room service.' },
    'seat-regenerate': { cmd: null, label: 'Regenerate', reason: 'INTERFACES defines no admin command for regenerating seat packages via HTTP; run `room admin add-seat` in the terminal.' },
    'seat-revoke': { cmd: null, label: 'Revoke', reason: 'INTERFACES defines no admin command for revoking seat credentials via HTTP.' }
  };

  function buildCommand(actionKey, params) {
    var a = ACTIONS[actionKey];
    if (!a) throw new Error('Unknown action ' + actionKey);
    if (!a.cmd) throw new Error(a.reason);
    var body = a.build ? a.build(params || {}) : {};
    (a.needs || []).forEach(function (k) {
      var v = body[k];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) throw new Error('Missing parameter ' + k);
    });
    return Object.assign({ cmd: a.cmd }, body);
  }

  var RoomUI = {
    UNKNOWN: UNKNOWN, u: u, fmtTs: fmtTs, fmtBytes: fmtBytes, fmtArgv: fmtArgv, shortSha: shortSha,
    unwrapState: unwrapState, unwrapEvents: unwrapEvents, emptyDerived: emptyDerived, fold: fold, derive: derive,
    seatList: seatList, seatForm: seatForm, seatAgent: seatAgent, auditSource: auditSource, auditObservation: auditObservation,
    wakesThisRound: wakesThisRound, wakesTotal: wakesTotal, latestSummary: latestSummary, itemStatus: itemStatus, itemMisquoted: itemMisquoted,
    verifiedFor: verifiedFor, awaitingDecision: awaitingDecision, wakeRefusalsFor: wakeRefusalsFor,
    attemptsNeedingReconcile: attemptsNeedingReconcile, sideEffectHint: sideEffectHint, mergeConflicts: mergeConflicts, receiptRows: receiptRows,
    seatUsage: seatUsage, usageSummary: usageSummary,
    projectedTurns: projectedTurns, ACTIONS: ACTIONS, buildCommand: buildCommand, TERMINAL: TERMINAL
  };
  if (typeof globalThis !== 'undefined') globalThis.RoomUI = RoomUI;

  // ---------------------------------------------------------------------------------------------
  // Browser part
  // ---------------------------------------------------------------------------------------------
  if (typeof document === 'undefined') return;

  var POLL_MS = 2000;
  var STEPPER_PHASES = ['assign', 'work', 'meet', 'summary'];
  var app = {
    token: '', state: {}, room: null, derived: emptyDerived(), events: [], view: 'stream',
    online: null, lastRender: '', timer: null, inflight: false,
    lang: 'en', theme: 'light',
    streamMode: 'chat', seatFilter: '', showMarkers: false, arenaRoundId: null,
    expandedBubbles: {}, highlightedSeq: null, highlightTimer: null,
    sse: null, sseConnected: false, composing: false
  };

  function getI18n() { return typeof globalThis !== 'undefined' && globalThis.RoomI18n ? globalThis.RoomI18n : null; }
  function getChat() { return typeof globalThis !== 'undefined' && globalThis.RoomChat ? globalThis.RoomChat : null; }
  function tUi(key, params, fallback) {
    var i18n = getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(app.lang, key, params);
    return fallback !== undefined ? fallback : key;
  }

  function detectInitialTheme() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { /* ignore */ }
    }
    return 'light';
  }
  function applyTheme(next) {
    app.theme = next === 'dark' ? 'dark' : 'light';
    if (document.documentElement) {
      if (document.documentElement.dataset) document.documentElement.dataset.theme = app.theme;
      else if (typeof document.documentElement.setAttribute === 'function') document.documentElement.setAttribute('data-theme', app.theme);
    }
    var btn = document.getElementById('btn-theme');
    if (btn) {
      btn.textContent = app.theme === 'dark' ? tUi('theme.light', null, 'Light') : tUi('theme.dark', null, 'Dark');
      btn.title = tUi('theme.toggleTitle', null, 'Toggle light / dark theme');
    }
  }

  function clear(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) appendChildren(el, arguments[i]);
    return el;
  }
  function appendChildren(el, c) {
    if (!el || c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { appendChildren(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function badge(text, tone) { return h('span', { class: 'badge' + (tone ? ' ' + tone : ''), text: text }); }
  function kv(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (p) { dl.appendChild(h('dt', { text: p[0] })); dl.appendChild(h('dd', null, p[1])); });
    return dl;
  }
  function empty(text) { return h('div', { class: 'empty', text: text || '(none)' }); }
  function table(headers, rows) {
    var t = h('table', { class: 'table' });
    t.appendChild(h('thead', null, h('tr', null, headers.map(function (x) { return h('th', { text: x }); }))));
    var tb = h('tbody');
    if (!rows.length) tb.appendChild(h('tr', null, h('td', { colspan: String(headers.length) }, empty())));
    rows.forEach(function (r) { tb.appendChild(r); });
    t.appendChild(tb);
    return t;
  }
  // td(attrs?, ...children): a leading plain object (not a DOM node, not an array) is the attribute map.
  function td() {
    var args = Array.prototype.slice.call(arguments);
    var attrs = args.length && isObj(args[0]) && !args[0].nodeType && !Array.isArray(args[0]) ? args.shift() : null;
    var el = h('td', attrs);
    args.forEach(function (c) { appendChildren(el, c); });
    return el;
  }
  function toneFor(status) {
    if (['submitted', 'accepted', 'present', 'pass', 'ok', 'joined', 'approved', 'executed', 'reconciled', 'confirmed'].indexOf(status) !== -1) return 'ok';
    if (['failed', 'expired', 'reject', 'rejected', 'tainted', 'denied', 'bad', 'needs_reconcile', 'left', 'unanswered', 'malformed', 'closed'].indexOf(status) !== -1) return 'bad';
    if (['canceled', 'work_partial', 'stale', 'header_only', 'unknown', 'deferred', 'disclose', 'requested', 'paused', 'pending', 'drafted'].indexOf(status) !== -1) return 'warn';
    return 'info';
  }

  function toast(text, tone) {
    var box = document.getElementById('toasts');
    if (!box) return;
    var el = h('div', { class: 'toast ' + (tone || ''), text: text });
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
  }

  // ---- token ----
  function readTokenFromFragment() {
    var frag = (location.hash || '').replace(/^#/, '').trim();
    if (!frag) return '';
    // Accept "#<token>" and "#token=<token>" (never a query string).
    var m = /^token=(.+)$/.exec(frag);
    return m ? m[1] : frag;
  }
  function setToken(t) {
    app.token = t || '';
    var el = document.getElementById('hdr-token');
    if (el) {
      el.textContent = app.token ? tUi('hdr.tok.ok', null, 'Loaded') : tUi('hdr.tok.missing', null, 'Not loaded');
      el.className = 'tok ' + (app.token ? 'tok-ok' : 'tok-missing');
    }
    var bar = document.getElementById('token-bar');
    if (bar && bar.classList) bar.classList.toggle('hidden', !!app.token);
    document.querySelectorAll('[data-action]').forEach(function (el2) {
      var key = el2.getAttribute('data-action');
      var a = ACTIONS[key];
      if (!a) return;
      var ctl = el2.tagName === 'FORM' ? el2.querySelector('button[type=submit]') : el2;
      if (!ctl) return;
      if (!a.cmd) {
        ctl.disabled = true;
        ctl.title = a.reason;
        if (!el2.querySelector('.unavailable')) el2.appendChild(h('span', { class: 'unavailable', text: a.reason }));
        return;
      }
      ctl.disabled = !app.token;
      ctl.title = app.token ? ('POST /api/admin cmd=' + a.cmd) : 'Admin token not loaded';
    });
  }

  // ---- network ----
  function fetchJson(url, opts) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    var o = Object.assign({ cache: 'no-store', credentials: 'same-origin' }, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (res) {
      return res.text().then(function (txt) {
        var body = null;
        try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = { error: 'NOT_JSON', raw: txt.slice(0, 200) }; }
        return { ok: res.ok, status: res.status, body: body };
      });
    }).finally(function () { if (t) clearTimeout(t); });
  }
  function setOnline(ok, detail) {
    app.online = ok;
    var el = document.getElementById('hdr-conn');
    if (!el) return;
    if (ok) {
      var prefix = app.sseConnected ? tUi('hdr.conn.sse', null, 'Live (SSE)') : tUi('hdr.conn.poll', null, 'Online (Poll)');
      el.textContent = prefix;
      el.title = 'Last synced ' + fmtTs(new Date().toISOString());
    } else {
      el.textContent = tUi('hdr.conn.offline', null, 'Offline') + (detail ? ' (' + detail + ')' : '');
      el.title = detail ? String(detail) : 'Disconnected';
    }
    el.className = 'conn ' + (ok ? 'conn-ok' : 'conn-bad');
  }
  function applyStatePayload(payload) {
    var un = unwrapState(payload);
    var since = app.derived.lastSeq || 0;
    app.state = un.state;
    if (un.room) app.room = un.room;
    if (num(app.state.lastSeq) !== null && since > 0 && app.state.lastSeq < since) {
      app.derived = emptyDerived();
      app.events = [];
      app.lastRender = '';
      return true;
    }
    return false;
  }
  function ingestEvent(ev) {
    if (!isObj(ev) || num(ev.seq) === null || ev.seq <= (app.derived.lastSeq || 0)) return false;
    app.events.push(ev);
    fold(app.derived, ev);
    return true;
  }
  function connectSse() {
    if (typeof EventSource === 'undefined' || app.sse) return;
    var since = app.derived.lastSeq || 0;
    var es;
    try { es = new EventSource('/api/stream?since=' + encodeURIComponent(String(since))); } catch (e) { return; }
    app.sse = es;
    es.addEventListener('open', function () {
      app.sseConnected = true;
      setOnline(true);
    });
    es.addEventListener('snapshot', function (ev) {
      try {
        var data = JSON.parse(ev.data);
        applyStatePayload(data);
        app.sseConnected = true;
        setOnline(true);
        render();
      } catch (e) { /* ignore malformed frame */ }
    });
    es.addEventListener('room_event', function (ev) {
      try {
        var data = JSON.parse(ev.data);
        if (ingestEvent(data)) render();
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('state', function (ev) {
      try {
        var data = JSON.parse(ev.data);
        applyStatePayload(data);
        setOnline(true);
        render();
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('room_closed', function (ev) {
      try {
        var data = JSON.parse(ev.data);
        applyStatePayload(data);
      } catch (e) { /* ignore */ }
      try { es.close(); } catch (e) { /* ignore */ }
      app.sse = null;
      app.sseConnected = false;
      setOnline(true);
      render();
    });
    es.addEventListener('error', function () {
      app.sseConnected = false;
      if (es.readyState === 2) { app.sse = null; }
      setOnline(false, 'SSE');
    });
  }
  function poll() {
    if (app.inflight) return;
    app.inflight = true;
    var since = app.derived.lastSeq || 0;
    Promise.all([
      fetchJson('/api/state'),
      fetchJson('/api/events?since=' + encodeURIComponent(String(since)))
    ]).then(function (res) {
      var st = res[0], evs = res[1];
      if (!st.ok) { setOnline(false, 'state ' + st.status); return; }
      var reset = applyStatePayload(st.body);
      if (!reset && evs.ok) {
        var list = unwrapEvents(evs.body).filter(function (e) { return isObj(e) && num(e.seq) !== null && e.seq > (app.derived.lastSeq || 0); });
        list.sort(function (a, b) { return a.seq - b.seq; });
        list.forEach(function (e) { ingestEvent(e); });
      }
      setOnline(true);
      render();
      if (!app.sse && !(app.state && app.state.closed)) connectSse();
    }).catch(function (e) {
      setOnline(false, e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network error');
    }).finally(function () { app.inflight = false; });
  }

  function runAction(key, params) {
    var a = ACTIONS[key];
    if (!a) return Promise.resolve();
    if (!a.cmd) { toast(a.reason, 'bad'); return Promise.resolve(); }
    if (!app.token) { toast('Admin token not loaded. Open with #<token> or paste admin.token at the top.', 'bad'); return Promise.resolve(); }
    var body;
    try { body = buildCommand(key, params); } catch (e) { toast(e.message, 'bad'); return Promise.resolve(); }
    if (a.confirm && !window.confirm(a.confirm + '\n\nCommand: ' + a.cmd + ' ' + JSON.stringify(Object.assign({}, body, { cmd: undefined })))) return Promise.resolve();
    body.token = app.token; // body only; never a query string
    return fetchJson('/api/admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (res) {
      if (res.ok && (!res.body || res.body.ok !== false)) {
        toast('Submitted ' + a.cmd + (res.body && res.body.queued ? ' → ' + res.body.queued : ''), 'ok');
        if (a.cmd === 'start' || a.cmd === 'interrupt' || a.cmd === 'reverse') {
          document.querySelectorAll('.rt-controls-drawer, .rt-danger-disclosure').forEach(function (dEl) { dEl.open = false; });
        }
        setTimeout(poll, 300);
      } else {
        var err = res.body && (res.body.error || res.body.reason || res.body.message);
        toast('Action ' + a.cmd + ' failed: HTTP ' + res.status + (err ? ' ' + err : ''), 'bad');
      }
    }).catch(function (e) { toast('Action ' + a.cmd + ' failed: ' + ((e && e.message) || 'network error'), 'bad'); });
  }
  function actionButton(key, params, label, extraClass) {
    var a = ACTIONS[key];
    var b = h('button', { class: 'btn-small ' + (extraClass || ''), type: 'button' }, label || a.label, ' ', a.cmd ? h('code', { text: a.cmd }) : null);
    if (!a.cmd) { b.disabled = true; b.title = a.reason; }
    else {
      b.disabled = !app.token;
      b.title = app.token ? 'POST /api/admin cmd=' + a.cmd : 'Admin token not loaded';
      b.addEventListener('click', function () { var p = typeof params === 'function' ? params() : params; if (p !== null) runAction(key, p); });
    }
    return b;
  }
  function formValues(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) o[el.name] = el.value; });
    return o;
  }

  function switchTab(viewName) {
    app.view = viewName;
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === app.view); });
    document.querySelectorAll('.view').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === app.view); });
    app.lastRender = '';
    render();
  }
  function jumpToSeq(seq) {
    app.view = 'stream';
    app.streamMode = 'chat';
    app.seatFilter = '';
    app.highlightedSeq = seq;
    if (app.highlightTimer) clearTimeout(app.highlightTimer);
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === 'stream'); });
    document.querySelectorAll('.view').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === 'stream'); });
    app.lastRender = '';
    render();
    var target = document.querySelector('#chat-view [data-seq="' + String(seq) + '"]');
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    app.highlightTimer = setTimeout(function () {
      app.highlightedSeq = null;
      app.lastRender = '';
      render();
    }, 1600);
  }
  function renderApprovalInboxBox() {
    var chat = getChat();
    var box = document.getElementById('approval-inbox');
    if (!chat || !box || typeof chat.renderApprovalInbox !== 'function') return;
    chat.renderApprovalInbox(document, box, {
      state: app.state,
      room: app.room,
      derived: app.derived,
      lang: app.lang,
      hasToken: !!app.token,
      onAction: function (key, params) { runAction(key, params); },
      onJumpTab: switchTab
    });
  }

  function renderPhaseStepper(phaseVal) {
    var stepper = document.getElementById('hdr-stepper');
    if (!stepper || typeof stepper.querySelectorAll !== 'function') return;
    var isDiscussionOnly = !!(
      app.room &&
      (app.room.preset === 'discussion' || (!app.room.preset && !app.derived.taskDraft && !(app.state && app.state.taskConfirmed) && Object.keys(app.derived.artifacts || {}).length === 0)) &&
      phaseVal !== 'assign' &&
      phaseVal !== 'work'
    );
    var activeIdx = STEPPER_PHASES.indexOf(phaseVal);
    var allDone = phaseVal === 'done' || phaseVal === 'closed';
    var steps = stepper.querySelectorAll('.step');
    var seps = stepper.querySelectorAll('.step-sep');
    for (var i = 0; i < steps.length; i += 1) {
      var st = steps[i];
      var name = st.getAttribute('data-step');
      var idx = STEPPER_PHASES.indexOf(name);
      var hideStep = isDiscussionOnly && (name === 'assign' || name === 'work');
      if (st.classList && typeof st.classList.toggle === 'function') {
        st.classList.toggle('hidden', hideStep);
        st.classList.toggle('is-done', allDone || (activeIdx > -1 && idx < activeIdx));
        st.classList.toggle('is-active', !allDone && activeIdx > -1 && idx === activeIdx);
      }
      if (seps[i] && seps[i].classList && typeof seps[i].classList.toggle === 'function') {
        seps[i].classList.toggle('hidden', hideStep);
      }
    }
  }

  function resolveRosterIdentity(seat, leadSeatId) {
    var chat = getChat();
    if (chat && typeof chat.resolveSeatIdentity === 'function') {
      return chat.resolveSeatIdentity(seat.seatId, seat, leadSeatId);
    }
    var clean = String(seat.seatId || '').replace(/[^A-Za-z0-9]/g, '');
    return {
      seatId: seat.seatId || '—',
      family: isObj(seat.hosted) && seat.hosted.kind === 'pi' ? 'pi' : 'other',
      familyLabel: seatAgent(seat),
      monogram: clean ? clean.slice(0, 2).toUpperCase() : 'RT',
      isLead: seat.role === 'lead' || seat.seatId === leadSeatId
    };
  }

  function renderSidebarSeats() {
    var box = document.getElementById('sidebar-seats');
    if (!box) return;
    clear(box);
    var seats = seatList(app.state, app.room, app.derived);
    if (!seats.length) {
      box.appendChild(empty('No seats yet.'));
      return;
    }
    var leadSeatId = null;
    for (var i = 0; i < seats.length; i += 1) {
      if (seats[i].role === 'lead') { leadSeatId = seats[i].seatId; break; }
    }
    seats.forEach(function (seat) {
      var ident = resolveRosterIdentity(seat, leadSeatId);
      var obs = auditObservation(seat, app.derived);
      var cls = 'roster-card' + (seat.isCurrent ? ' is-current' : '') + (app.seatFilter === seat.seatId ? ' is-filtered' : '');
      var roleText = seat.role ? tUi('role.' + seat.role, null, seat.role) : '';
      var subText = ident.familyLabel + (seat.isCurrent ? ' · Active turn' : (roleText ? ' · ' + roleText : ''));
      var card = h('button', {
        type: 'button',
        class: cls,
        'data-family': ident.family,
        title: 'Seat ' + seat.seatId + ' · ' + obs.text,
        onclick: function () {
          app.seatFilter = app.seatFilter === seat.seatId ? '' : seat.seatId;
          if (app.view !== 'stream') {
            app.streamMode = 'chat';
            switchTab('stream');
          } else {
            app.streamMode = 'chat';
            app.lastRender = '';
            render();
          }
        }
      },
        h('span', { class: 'rt-avatar sm', 'aria-hidden': 'true', text: ident.monogram }),
        h('span', { class: 'roster-info' },
          h('span', { class: 'roster-title', text: 'Seat ' + seat.seatId + (ident.isLead ? ' ★' : '') }),
          h('span', { class: 'roster-sub', text: subText })
        ),
        h('span', { class: 'roster-dot ' + (obs.tone || ''), title: obs.text, 'aria-hidden': 'true' })
      );
      box.appendChild(card);
    });
  }

  function renderSidebarUsage() {
    var box = document.getElementById('sidebar-usage');
    if (!box) return;
    clear(box);
    var sum = usageSummary(app.state, app.room, app.derived);
    var valText = sum.knownTokens === null
      ? UNKNOWN
      : (sum.maxTokens ? (fmtCompactNum(sum.knownTokens) + ' / ' + fmtCompactNum(sum.maxTokens)) : fmtCompactNum(sum.knownTokens));
    var meterMax = sum.maxTokens && sum.maxTokens > 0 ? sum.maxTokens : Math.max(sum.knownTokens || 1, 1);
    var meterVal = sum.knownTokens !== null ? Math.min(sum.knownTokens, meterMax) : 0;
    var meterCls = 'budget-meter' + (sum.paused ? ' is-paused' : (sum.knownTokens !== null ? ' is-ok' : ''));
    var subParts = [];
    if (sum.paused === true) subParts.push('Paused at cap');
    else if (sum.maxTokens === null) subParts.push('Uncapped');
    else if (sum.knownTokens !== null) subParts.push('Active budget');
    else subParts.push('Awaiting reports');
    if (sum.unknownReports) subParts.push(sum.unknownReports + ' unknown');

    box.appendChild(h('div', { class: 'usage-mini-head' },
      h('span', { text: 'Token Budget' }),
      h('span', { class: 'usage-mini-val', text: valText })
    ));
    box.appendChild(h('progress', { class: meterCls, max: String(meterMax), value: String(meterVal) }));
    box.appendChild(h('div', { class: 'usage-mini-sub', text: subParts.join(' · ') }));
    box.appendChild(h('button', {
      type: 'button',
      class: 'usage-mini-link',
      text: 'Inspect usage →',
      onclick: function () { switchTab('usage'); }
    }));
  }

  function renderTaskObjective() {
    var d = app.derived, s = app.state;
    var box = document.getElementById('task-box');
    var preview = document.getElementById('task-card-preview');
    if (!box) return;
    clear(box);
    var task = isObj(s.task) ? s.task : d.task;
    if (task && task.text) {
      if (preview) preview.textContent = String(task.text).replace(/\s+/g, ' ').trim();
      box.appendChild(h('p', { class: 'task-objective-text', text: String(task.text) }));
    } else {
      if (preview) preview.textContent = 'No task assigned yet';
      box.appendChild(empty('No task assigned yet. Submit one in Task Draft or via CLI `room admin task`.'));
    }
    var confirmed = d.taskConfirmed || (isObj(s.taskConfirmed) ? s.taskConfirmed : null);
    var draft = d.taskDraft || (isObj(s.taskDraft) ? { draft: s.taskDraft } : null);
    var assignments = (confirmed && Array.isArray(confirmed.assignments))
      ? confirmed.assignments
      : (draft && isObj(draft.draft) && Array.isArray(draft.draft.assignments) ? draft.draft.assignments : []);
    var seenCmds = {};
    var chips = [];
    assignments.forEach(function (a) {
      if (!a || !Array.isArray(a.acceptance)) return;
      a.acceptance.forEach(function (cmd) {
        var str = fmtArgv(cmd);
        if (str && str !== UNKNOWN && !seenCmds[str]) {
          seenCmds[str] = 1;
          chips.push(h('code', { class: 'task-accept-chip', text: str }));
        }
      });
    });
    if (chips.length) {
      box.appendChild(h('div', { class: 'task-accept-row' }, h('span', { text: 'Acceptance:' }), chips));
    }
  }

  // ---- rendering ----
  function render() {
    var s = app.state, d = app.derived;
    var key = [d.lastSeq, s.updatedAt, s.phase, s.currentSeat, app.view, app.streamMode, app.seatFilter, app.showMarkers ? 1 : 0, app.arenaRoundId || '', app.highlightedSeq || '', app.lang, app.token ? 1 : 0].join('|');
    renderHeader();
    if (key === app.lastRender) return;
    app.lastRender = key;
    renderApprovalInboxBox();
    renderTabCounts();
    renderSidebarSeats();
    renderSidebarUsage();
    var fn = VIEWS[app.view];
    if (fn) fn();
  }
  function renderHeader() {
    var s = app.state, d = app.derived;
    var roomId = (app.room && app.room.id) || s.roomId || s.id;
    var hdrRoom = document.querySelector('#hdr-room');
    if (hdrRoom) {
      clear(hdrRoom);
      hdrRoom.appendChild(h('b', { text: u(roomId) }));
    }
    var phaseVal = s.phase || d.phase;
    renderPhaseStepper(phaseVal);
    var hdrPhase = document.querySelector('#hdr-phase');
    if (hdrPhase) {
      clear(hdrPhase);
      hdrPhase.appendChild(h('b', { class: 'badge ' + toneFor(phaseVal), text: u(phaseVal) }));
    }
    var hdrRound = document.querySelector('#hdr-round');
    if (hdrRound) {
      clear(hdrRound);
      appendChildren(hdrRound, ['R', h('b', { text: u(s.roundId !== undefined ? s.roundId : d.roundId) }), ' · E', h('b', { text: u(s.epoch !== undefined ? s.epoch : d.epoch) })]);
    }
    var cur = s.currentSeat || (isObj(s.attempt) && s.attempt.seatId) || null;
    var hdrTurn = document.querySelector('#hdr-turn');
    if (hdrTurn) {
      clear(hdrTurn);
      appendChildren(hdrTurn, ['Turn ', h('b', { text: cur ? cur + (isObj(s.attempt) && s.attempt.attemptId ? ' / ' + s.attempt.attemptId : '') : '—' })]);
    }
    var seqB = document.querySelector('#hdr-seq b');
    if (seqB) seqB.textContent = String(Math.max(d.lastSeq, num(s.lastSeq) || 0));
  }
  function renderTabCounts() {
    var d = app.derived, s = app.state;
    var counts = {
      stream: d.stream.length,
      seats: seatList(s, app.room, d).length,
      task: d.taskDraft && !d.taskConfirmed ? 1 : 0,
      items: Object.keys(d.items).filter(function (k) { return itemStatus(d.items[k], d) === 'unanswered'; }).length,
      verdicts: Object.keys(d.disclosures).filter(function (k) { return d.disclosures[k].status === 'requested'; }).length,
      recovery: attemptsNeedingReconcile(d, s).length + (awaitingDecision(s) ? 1 : 0),
      merge: mergeConflicts(s, d).length
    };
    document.querySelectorAll('.tab').forEach(function (b) {
      var v = b.getAttribute('data-view');
      var c = b.querySelector('.count');
      if (counts[v]) { if (!c) { c = h('span', { class: 'count' }); b.appendChild(c); } c.textContent = String(counts[v]); }
      else if (c) b.removeChild(c);
    });
  }

  var VIEWS = {};

  function renderStreamOrderChips(seats) {
    var box = document.getElementById('stream-order-chips');
    var input = document.getElementById('stream-order-input');
    if (!box || !input) return;
    clear(box);
    (seats || []).forEach(function (s) {
      var sid = s && s.seatId;
      if (!sid) return;
      var chip = h('button', { type: 'button', class: 'rt-order-chip', text: '+ ' + sid });
      chip.addEventListener('click', function () {
        var cur = input.value.split(/[\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
        cur.push(sid);
        input.value = cur.join(',');
      });
      box.appendChild(chip);
    });
  }

  VIEWS.stream = function () {
    var d = app.derived, s = app.state;
    var chat = getChat();
    var mode = chat ? app.streamMode : 'log';
    var modeBar = document.querySelector('#view-stream .rt-mode-bar');
    if (modeBar && modeBar.classList) modeBar.classList.toggle('hidden', !chat);
    var chatBox = document.getElementById('chat-view');
    var arenaBox = document.getElementById('arena-view');
    var rawWrap = document.getElementById('raw-log-wrap');
    document.querySelectorAll('#stream-mode-tabs .rt-mode-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-stream-mode') === mode);
    });
    if (chatBox && chatBox.classList) chatBox.classList.toggle('hidden', mode !== 'chat');
    if (arenaBox && arenaBox.classList) arenaBox.classList.toggle('hidden', mode !== 'arena');
    if (rawWrap && rawWrap.classList) rawWrap.classList.toggle('hidden', mode !== 'log');
    renderTaskObjective();
    renderStreamOrderChips(seatList(s, app.room, d));

    if (chat && (mode === 'chat' || mode === 'arena')) {
      try {
        var chatModel = chat.buildChatModel({ state: s, room: app.room, derived: d });
        if (mode === 'chat' && chatBox) {
          chat.renderGroupChat(document, chatBox, chatModel, {
            lang: app.lang,
            seatFilter: app.seatFilter,
            showMarkers: app.showMarkers,
            expandedMap: app.expandedBubbles,
            highlightedSeq: app.highlightedSeq,
            hideRoundTopic: true,
            onJumpToSeq: jumpToSeq,
            onSetSeatFilter: function (sid) { app.seatFilter = sid; app.lastRender = ''; render(); },
            onToggleMarkers: function (v) { app.showMarkers = v; app.lastRender = ''; render(); },
            onRerender: function () { app.lastRender = ''; render(); }
          });
          return;
        }
        if (mode === 'arena' && arenaBox) {
          chat.renderArenaView(document, arenaBox, chatModel, {
            lang: app.lang,
            selectedRoundId: app.arenaRoundId,
            hideRoundTopic: true,
            onSelectRound: function (rId) { app.arenaRoundId = rId; app.lastRender = ''; render(); },
            onJumpToChat: jumpToSeq
          });
          return;
        }
      } catch (e) {
        if (chatBox && chatBox.classList) chatBox.classList.toggle('hidden', true);
        if (arenaBox && arenaBox.classList) arenaBox.classList.toggle('hidden', true);
        if (rawWrap && rawWrap.classList) rawWrap.classList.toggle('hidden', false);
      }
    }

    var ol = document.getElementById('stream');
    clear(ol);
    if (!d.stream.length) { ol.appendChild(h('li', { class: 'marker', text: 'No events yet.' })); return; }
    var msgs = isObj(s.messages) && Array.isArray(s.messages) ? s.messages : [];
    var quotesBySeat = {};
    d.quotes.forEach(function (q) { (quotesBySeat[q.attemptId] = quotesBySeat[q.attemptId] || []).push(q); });
    d.stream.forEach(function (e) {
      var li;
      if (e.kind === 'message') {
        var m = e.msg;
        var fromState = msgs.filter(function (x) { return x.seq === m.seq; })[0];
        var mm = fromState ? Object.assign({}, m, fromState) : m;
        var annot = mm.annotation && mm.annotation !== 'none' ? mm.annotation : (mm.malformed ? 'malformed: ' + mm.malformed : null);
        li = h('li', { class: 'message' },
          h('div', { class: 'head' },
            badge('seq ' + u(mm.seq)),
            h('b', { text: 'Seat ' + u(mm.seatId) }),
            badge(u(mm.role), 'info'),
            badge('authority=' + u(mm.authority || 'none')),
            badge('attempt ' + u(mm.attemptId)),
            annot ? badge(String(annot), toneFor(String(annot).split(':')[0])) : null,
            num(mm.escaped) ? badge('escaped ×' + mm.escaped, 'warn') : null,
            h('span', { text: fmtTs(mm.ts) })
          ),
          h('div', { class: 'body', text: mm.text === undefined ? UNKNOWN : String(mm.text) })
        );
        var qs = quotesBySeat[mm.attemptId] || [];
        qs.forEach(function (q) {
          var orig = d.messages[q.seq] || msgs.filter(function (x) { return x.seq === q.seq; })[0];
          li.appendChild(h('div', { class: 'quote' },
            badge('Quote seq ' + u(q.seq), q.verified === true ? 'ok' : q.verified === false ? 'bad' : 'warn'),
            ' ',
            q.verified === true ? 'Quote verified' : q.verified === false ? 'Quote mismatch: excerpt not found in original' : 'Quote verification ' + UNKNOWN,
            h('div', { class: 'orig', text: 'Excerpt: ' + u(q.text) }),
            orig ? h('div', { class: 'orig', text: 'Original: ' + String(orig.text).slice(0, 600) + (String(orig.text).length > 600 ? ' …' : '') }) : h('div', { class: 'orig', text: 'Original: ' + UNKNOWN })
          ));
        });
        var pts = Object.keys(d.items).map(function (k) { return d.items[k]; }).filter(function (it) { return it.attemptId === mm.attemptId; });
        if (pts.length) li.appendChild(h('div', { class: 'refs', text: 'Items: ' + pts.map(function (it) { return it.itemId + ' (about seq ' + u(it.aboutSeq) + ')'; }).join('; ') }));
        var vs = d.verdicts.filter(function (v) { return v.attemptId === mm.attemptId; });
        vs.forEach(function (v) {
          li.appendChild(h('div', { class: 'refs' },
            'verdict ', badge(u(v.verdict), toneFor(v.verdict)),
            ' artifact ' + shortSha(v.artifactSha),
            v.annotation && v.annotation !== 'none' ? [' annotation ', badge(String(v.annotation), toneFor(String(v.annotation)))] : null
          ));
        });
      } else if (e.kind === 'summary') {
        var sm = e.summary;
        li = h('li', { class: 'summary' },
          h('div', { class: 'head' },
            badge('Summary v' + u(sm.version), 'info'),
            h('b', { text: 'Lead ' + u(sm.seatId) }),
            badge('attempt ' + u(sm.attemptId)),
            sm.supersedes !== null && sm.supersedes !== undefined ? badge('supersedes v' + sm.supersedes, 'warn') : null,
            h('span', { text: fmtTs(sm.ts) })
          ),
          h('div', { class: 'body' }, sm.unanswered.length ? [badge('Unanswered: ' + sm.unanswered.length, 'bad'), ' ' + sm.unanswered.join(', ')] : badge('All items marked', 'ok')),
          sm.absent.length ? h('div', { class: 'refs' }, badge('Absent', 'warn'), ' ' + sm.absent.map(function (a) { return 'Seat ' + u(a.seatId) + ' (' + u(a.phase) + ', ' + (a.by === 'admin' ? 'skipped by admin' : u(a.by)) + ')'; }).join('; ')) : null,
          sm.noArtifact.length ? h('div', { class: 'refs' }, badge('no_artifact', 'bad'), ' ' + sm.noArtifact.map(function (n) { return 'Seat ' + u(n.seatId) + ' (' + (n.reason === 'empty' ? 'empty artifact set' : 'no frozen artifact') + ')'; }).join('; ')) : null,
          sm.verified ? h('div', { class: 'refs' }, sm.verified.map(function (x) { return [badge(x.verified ? 'Verified' : 'Unverified', x.verified ? 'ok' : 'warn'), ' artifact ' + shortSha(x.artifactSha) + (x.producer ? ' (Seat ' + x.producer + ')' : '') + (x.verified ? '' : ' · ' + u(x.reason)), ' ']; })) : null
        );
      } else if (e.kind === 'user') {
        li = h('li', { class: 'user' },
          h('div', { class: 'head' }, badge('User Message', 'user'), badge('seq ' + u(e.msgSeq)), h('span', { class: 'hint', text: 'event #' + u(e.seq) }), ' ', h('span', { text: fmtTs(e.ts) })),
          h('div', { class: 'body', text: u(e.text) })
        );
      } else {
        li = h('li', { class: 'marker ' + (e.tone || '') }, badge('seq ' + u(e.seq)), ' ', e.text, ' ', h('span', { class: 'hint', text: fmtTs(e.ts) }));
      }
      ol.appendChild(li);
    });
  };

  VIEWS.seats = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var rows = seats.map(function (seat) {
      var obs = auditObservation(seat, d);
      var w = isObj(seat.wake) ? seat.wake : null;
      var maxPerTurn = w && num(w.maxPerTurn) !== null ? w.maxPerTurn : (w && w.enabled ? 1 : null);
      var tr = h('tr', { class: seat.isCurrent ? 'current' : '' });
      tr.append(
        td(h('b', { text: seat.seatId }), seat.name && seat.name !== seat.seatId ? ' ' + seat.name : ''),
        td(seatForm(seat)),
        td(seatAgent(seat)),
        td(badge(u(seat.role), 'info')),
        td(u(seat.waitMode), ' · wakes ', String(wakesThisRound(d, seat.seatId)), ' / W=', u(maxPerTurn), w && w.enabled === false ? [' ', badge('push off', 'warn')] : '',
          (function () { var rf = wakeRefusalsFor(d, seat.seatId).filter(function (x) { return x.roundKey === d.roundKey; }); return rf.length ? [' ', badge('manual wake required (' + rf[rf.length - 1].refused + ')', 'warn')] : ''; })()),
        td('Declared ', badge(u(seat.declaredTier)), ' · Observed ', badge(obs.text, obs.tone)),
        td(h('span', { class: 'mono', text: auditSource(seat) })),
        td(badge(u(seat.status), toneFor(seat.status)), seat.isCurrent ? [' ', badge('Current turn', 'info')] : ''),
        td(seat.retained === null || seat.retained === undefined ? UNKNOWN : (typeof seat.retained === 'boolean' ? (seat.retained ? 'Yes' : 'No') : String(seat.retained))),
        td({ class: 'actions-cell' },
          actionButton('skip', {}, 'Skip'),
          actionButton('reassign', function () { var to = window.prompt('Reassign to which seat ID?'); if (!to) return null; var text = window.prompt('Optional note'); return { seatId: seat.seatId, toSeatId: to, text: text || '' }; }, 'Reassign'),
          actionButton('cancel', {}, 'Cancel'),
          actionButton('wake', { seatId: seat.seatId }, 'Wake'))
      );
      return tr;
    });
    var t = document.getElementById('seats-table');
    t.replaceWith(table(['Seat', 'Mode', 'Agent', 'Role', 'Wait / Wakes', 'Declared Tier / Audit Observation', 'Audit Source', 'Status', 'Retained', 'Actions'], rows));
    document.querySelector('#view-seats .table').id = 'seats-table';
  };

  VIEWS.packets = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var list = document.getElementById('packets-list');
    clear(list);
    if (!seats.length) { list.appendChild(empty('No seats configured.')); return; }
    seats.forEach(function (seat) {
      var roomDir = seat.roomDir || s.roomDir || (app.room && app.room.dir) || null;
      var joinPath = roomDir ? roomDir.replace(/[\\/]+$/, '') + '/seats/' + seat.seatId + '/JOIN.md' : UNKNOWN;
      var w = isObj(seat.wake) ? seat.wake : null;
      var credState = seat.tokenState || (seat.token === null ? 'Revoked' : (seat.joinSha256 ? 'Issued (inside seat package)' : UNKNOWN));
      var card = h('div', { class: 'card' },
        h('h4', null, 'Seat ' + seat.seatId, badge(u(seat.role), 'info'), badge(u(seat.status), toneFor(seat.status))),
        kv([
          ['JOIN.md', h('code', { text: joinPath })],
          ['JOIN sha256', h('code', { text: shortSha(seat.joinSha256) })],
          ['Credential status', credState],
          ['Transport', seat.transport ? String(seat.transport) : 'File-based (default)'],
          ['Working dir', h('code', { text: u(seat.cwd) })],
          ['Outbox', h('code', { text: u(seat.outbox) })],
          ['Wake push', w ? (w.enabled ? 'Enabled' : 'Disabled') : UNKNOWN],
          ['Registered thread', w && w.thread ? h('code', { text: String(w.thread) + ' (' + u(w.kind) + ')' }) : (w && w.enabled === false ? 'Unregistered' : UNKNOWN)],
          ['Max wakes / turn (W)', w && num(w.maxPerTurn) !== null ? String(w.maxPerTurn) : (w && w.enabled ? '1 (default)' : UNKNOWN)],
          ['Total wakes', String(wakesTotal(d, seat.seatId))]
        ]),
        h('div', { class: 'actions' }, actionButton('seat-regenerate', {}, 'Regenerate'), actionButton('seat-revoke', {}, 'Revoke'), h('span', { class: 'unavailable', text: ACTIONS['seat-regenerate'].reason }))
      );
      list.appendChild(card);
    });
  };

  VIEWS.task = function () {
    var d = app.derived, s = app.state;
    var box = document.getElementById('task-draft');
    clear(box);
    var draft = d.taskDraft || (isObj(s.taskDraft) ? { draft: s.taskDraft, seatId: s.taskDraft.seatId } : null);
    var confirmed = d.taskConfirmed || (isObj(s.taskConfirmed) ? s.taskConfirmed : null);
    var status = confirmed ? 'confirmed' : (draft ? 'drafted' : 'none');
    box.append(h('h4', null, 'Task Draft ', badge(status === 'confirmed' ? 'Confirmed' : status === 'drafted' ? 'Awaiting Confirmation' : 'No Draft', toneFor(status))));
    var assignments = (confirmed && Array.isArray(confirmed.assignments)) ? confirmed.assignments : (draft && isObj(draft.draft) && Array.isArray(draft.draft.assignments) ? draft.draft.assignments : []);
    if (draft) box.append(kv([['Drafted by', u(draft.seatId)], ['Attempt', u(draft.attemptId)], ['Drafted at', fmtTs(draft.ts)]]));
    if (confirmed) box.append(kv([['Confirmed at', fmtTs(confirmed.ts)], ['Confirmed by', u(confirmed.by)]]));
    if (assignments.length) {
      var rows = assignments.map(function (a) {
        return h('tr', null,
          td(h('b', { text: u(a.seatId) })),
          td(h('pre', { text: u(a.text) })),
          td(h('code', { text: Array.isArray(a.acceptance) ? a.acceptance.map(function (x) { return fmtArgv(x); }).join('\n') : UNKNOWN }))
        );
      });
      box.append(h('div', { class: 'scroll-x' }, table(['Seat', 'Assignment', 'Acceptance Commands (auto-allowlisted)'], rows)));
    } else box.append(empty('No assignments drafted yet. Lead runs `room assign --file`, or enter a manual specification below.'));
    if (draft && isObj(draft.draft) && draft.draft.text) box.append(h('h4', { text: 'Draft Body' }), h('pre', { text: String(draft.draft.text) }));
    var btn = document.getElementById('btn-confirm-task');
    if (btn) {
      btn.disabled = !app.token || status !== 'drafted';
      btn.title = status !== 'drafted' ? 'No pending draft to confirm' : btn.title;
    }
  };

  VIEWS.items = function () {
    var d = app.derived, s = app.state;
    var items = Array.isArray(s.items)
      ? s.items.map(function (x) {
        var marked = x.status && x.status !== 'open' ? { status: x.status, by: x.markedBy || x.by, text: x.markText } : null;
        return Object.assign({}, x, { aboutSeq: x.aboutSeq !== undefined ? x.aboutSeq : x.seq, mark: x.mark || marked });
      })
      : Object.keys(d.items).map(function (k) { return d.items[k]; });
    items.sort(function (a, b) { return (num(a.aboutSeq) || 0) - (num(b.aboutSeq) || 0) || String(a.itemId).localeCompare(String(b.itemId)); });
    var rows = items.map(function (it) {
      var st = itemStatus(it, d);
      var mis = itemMisquoted(it, d);
      var label = { accepted: 'Accepted', rejected: 'Rejected', deferred: 'Deferred', unanswered: 'Unanswered', pending: 'Pending', unknown: UNKNOWN }[st] || u(st);
      return h('tr', { class: st === 'unanswered' ? 'highlight' : '' },
        td(h('code', { text: u(it.itemId) })),
        td(u(it.seatId)),
        td('seq ' + u(it.aboutSeq), mis ? [' ', badge('Misquote disputed', 'warn')] : ''),
        td(h('pre', { text: u(it.text) })),
        td(badge(label, toneFor(st))),
        td(it.mark ? [u(it.mark.by), ': ', u(it.mark.text)] : '—')
      );
    });
    var t = document.getElementById('items-table');
    t.replaceWith(table(['Item', 'Seat', 'About', 'Text', 'Mark', 'Lead Note'], rows));
    document.querySelector('#view-items .table').id = 'items-table';
    var ul = document.getElementById('misquoted-list');
    clear(ul);
    if (!d.misquoted.length) ul.appendChild(h('li', { class: 'empty', text: 'No misquote declarations.' }));
    d.misquoted.forEach(function (m) {
      ul.appendChild(h('li', null, badge('Seat ' + u(m.seatId), 'warn'), ' disputed quote at seq ' + u(m.aboutSeq) + ': ', h('span', { text: u(m.text) }), ' ', h('span', { class: 'hint', text: fmtTs(m.ts) })));
    });
  };

  VIEWS.verdicts = function () {
    var d = app.derived, s = app.state;
    var list = document.getElementById('artifacts-list');
    clear(list);
    var arts = Object.keys(d.artifacts).map(function (k) { return d.artifacts[k]; });
    if (!arts.length) list.appendChild(empty('No frozen artifacts yet (executors declare via `room artifacts --declare`).'));
    arts.forEach(function (art) {
      var stale = art.recomputed && art.recomputed.stale;
      var card = h('div', { class: 'card' },
        h('h4', null,
          'Artifact ', h('code', { text: shortSha(art.manifestSha) }),
          badge('Seat ' + u(art.seatId), 'info'),
          stale ? badge(art.staleAccepted ? 'accepted_stale' : 'stale', 'warn') : (art.recomputed ? badge('Recompute clean', 'ok') : badge('Not recomputed')),
          art.copyTorn ? badge('copyTorn', 'bad') : null
        ),
        kv([
          ['Manifest SHA', h('code', { text: u(art.manifestSha) })],
          ['Round', u(art.roundId)],
          ['Baseline', u(art.baseline)],
          ['Files', u(art.fileCount)],
          ['Size', fmtBytes(art.bytes)],
          ['Excluded', Array.isArray(art.excluded) && art.excluded.length ? art.excluded.join(', ') : (Array.isArray(art.excluded) ? '(none)' : UNKNOWN)],
          ['Frozen at', fmtTs(art.frozenAt)],
          ['Recompute', art.recomputed ? fmtTs(art.recomputed.ts) + (stale ? ' · stale' : ' · matched') : 'Not recomputed']
        ])
      );
      if (art.recomputed && art.recomputed.changed.length) {
        card.appendChild(h('h4', { text: 'Stale diff (' + art.recomputed.changed.length + ' file(s))' }));
        card.appendChild(h('div', { class: 'diff' }, art.recomputed.changed.map(function (c) {
          return h('div', null, h('code', { text: u(c.path) }), ' ', h('span', { class: 'from', text: shortSha(c.from) }), ' → ', h('span', { class: 'to', text: shortSha(c.to) }));
        })));
      }
      if (art.staleAccepted) card.appendChild(h('div', { class: 'hint', text: 'Admin accepted stale diff (' + fmtTs(art.staleAccepted.ts) + ')' }));
      card.appendChild(h('h4', { text: 'Verdicts (' + art.verdicts.length + ')' }));
      if (!art.verdicts.length) card.appendChild(empty('No verdicts recorded yet.'));
      var ver = verifiedFor(d, art.manifestSha);
      card.appendChild(h('div', null,
        'Verification: ',
        ver ? badge(ver.verified ? 'Verified' : 'Unverified', ver.verified ? 'ok' : 'warn') : badge('Unverified (no summary yet)', 'warn'),
        ver && !ver.verified && ver.reason ? ' ' + ver.reason : '',
        ver && ver.by ? ' · Reviewer ' + ver.by : ''
      ));
      art.verdicts.forEach(function (v) {
        var audit = d.audits.filter(function (a) { return a.attemptId === v.attemptId; }).pop();
        // Only the producer's resolved reviewer binds (authorized === true); other verdicts stay non-binding opinions.
        var who = v.authorized === true ? [' Reviewer ', h('b', { text: u(v.seatId) })] : [' ', badge('Non-reviewer opinion (excluded)', 'warn'), ' Seat ', h('b', { text: u(v.seatId) })];
        var anns = (v.annotations || []).filter(function (x) { return x && x !== v.annotation && x !== 'none'; });
        var row = h('div', { class: 'card' },
          h('div', null,
            badge(u(v.verdict), toneFor(v.verdict)), who,
            ' · attempt ', h('code', { text: u(v.attemptId) }),
            ' · annotation ', badge(u(v.annotation), toneFor(String(v.annotation))),
            anns.map(function (x) { return [' ', badge(x, toneFor(x))]; }),
            v.tainted && v.annotation !== 'tainted' ? [' ', badge('tainted', 'bad')] : null,
            ' · ', fmtTs(v.ts)
          ),
          v.evidence ? h('pre', { text: typeof v.evidence === 'string' ? v.evidence : JSON.stringify(v.evidence, null, 1) }) : null
        );
        if (audit && audit.tainted) {
          row.appendChild(h('div', null, badge('Taint evidence', 'bad'), ' Observed during review turn:'));
          row.appendChild(h('ul', { class: 'plain' },
            audit.writes.map(function (w) {
              var label = typeof w === 'string' ? w : (u(w.op || w.source) + ' ' + u(w.path || w.command));
              return h('li', null, h('code', { text: label }));
            }),
            audit.unknownCommands.map(function (c) {
              var label = typeof c === 'string'
                ? c
                : (Array.isArray(c.argv) ? fmtArgv(c.argv) : (u(c.command) + (c.reason ? ' (' + c.reason + ')' : '')));
              return h('li', null, 'Unknown command: ', h('code', { text: label }));
            })
          ));
        } else if (!audit) row.appendChild(h('div', { class: 'hint', text: 'This turn was unaudited.' }));
        card.appendChild(row);
      });
      card.appendChild(h('div', { class: 'actions' },
        actionButton('interrupt', { text: 'Re-review artifact ' + art.manifestSha }, 'Re-review'),
        stale && !art.staleAccepted ? actionButton('accept-stale', { manifestSha: art.manifestSha }, 'Accept Stale') : null
      ));
      list.appendChild(card);
    });
    var dl = document.getElementById('disclosures-list');
    clear(dl);
    var ds = Object.keys(d.disclosures).map(function (k) { return d.disclosures[k]; });
    if (!ds.length) dl.appendChild(empty('No disclosure requests.'));
    ds.forEach(function (q) {
      var card = h('div', { class: 'card' },
        h('h4', null, 'Disclosure ', h('code', { text: u(q.id) }), badge(u(q.status), toneFor(q.status)), badge('Seat ' + u(q.seatId), 'info')),
        kv([
          ['argv', h('code', { text: fmtArgv(q.argv) })],
          ['Reason', u(q.reason)],
          ['Attempt', u(q.attemptId)],
          ['Requested at', fmtTs(q.ts)],
          ['Decision', q.status === 'denied' ? 'Denied' + (q.denyReason ? ': ' + q.denyReason : '') : q.by ? 'By ' + q.by : '—']
        ])
      );
      if (q.exec) {
        card.appendChild(kv([
          ['Executed on manifest', shortSha(q.exec.manifestSha)],
          ['Exit code', u(q.exec.exitCode)],
          ['Output sha256', shortSha(q.exec.outputSha256)],
          ['Truncated', q.exec.truncated ? 'Yes' : 'No'],
          ['Private output', h('code', { text: u(q.exec.privatePath) })]
        ]));
      }
      if (q.status === 'requested') {
        card.appendChild(h('div', { class: 'actions' },
          actionButton('approve-disclose', { id: q.id }, 'Approve Disclosure', 'primary'),
          actionButton('deny-disclose', function () { var why = window.prompt('Denial reason (required)'); return why === null ? null : { id: q.id, reason: why }; }, 'Deny Disclosure', 'danger')
        ));
      }
      dl.appendChild(card);
    });
    var hint = document.getElementById('adjudication-hint');
    if (hint) {
      var adj = isObj(s.adjudications) ? s.adjudications : null;
      hint.textContent = adj
        ? ('Reject rate: n=' + u(adj.n) + ', k=' + u(adj.k) + (adj.hint ? ' · ' + adj.hint : (num(adj.n) !== null && adj.n < 14 ? ' · insufficient sample (n < 14)' : '')))
        : 'Reject rate: Unknown (service did not supply adjudications summary)';
    }
  };

  VIEWS.receipts = function () {
    var d = app.derived;
    var rows = receiptRows(d).map(function (p) {
      var a = d.attempts[p.attemptId] || {};
      var label = { sent: 'sent', header_only: 'header_only', present: 'present', unknown: 'unknown' }[p.receipt] || UNKNOWN;
      return h('tr', null,
        td(h('code', { text: u(p.packetId) })),
        td(u(p.seatId)),
        td(h('code', { text: u(p.attemptId) })),
        td(fmtTs(p.ts)),
        td(fmtBytes(p.bytes)),
        td(badge(label, toneFor(p.receipt)), p.superseded ? [' ', badge('superseded by ' + p.superseded, 'warn')] : ''),
        td(p.auditTs ? fmtTs(p.auditTs) : 'Unaudited'),
        td(badge(u(a.terminal || 'pending'), toneFor(a.terminal || 'pending'))),
        td({ class: 'actions-cell' }, actionButton('wake', { seatId: p.seatId }, 'Resend'))
      );
    });
    var t = document.getElementById('receipts-table');
    t.replaceWith(table(['Packet', 'Seat', 'Attempt', 'Issued', 'Size', 'Receipt', 'Audited At', 'Attempt State', 'Actions'], rows));
    document.querySelector('#view-receipts .table').id = 'receipts-table';
  };

  VIEWS.usage = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var sum = usageSummary(s, app.room, d);
    var paused = sum.paused;
    var box = document.getElementById('usage-summary');
    clear(box);
    box.append(
      h('h4', null, 'Usage ', paused === null ? badge('paused ' + UNKNOWN) : badge(paused ? 'paused' : 'Active', paused ? 'warn' : 'ok')),
      paused ? h('div', { class: 'notice warn', text: 'Known token total has reached the budget cap: packet issuance pauses after the current attempt finishes. Update the cap and resume.' }) : null,
      kv([
        ['Known tokens (input + output)', sum.knownTokens === null ? UNKNOWN : String(sum.knownTokens) + ' tokens (reporting seats only)'],
        ['Turns with unknown usage', String(sum.unknownReports)],
        ['Token cap', sum.maxTokens === undefined ? UNKNOWN : (sum.maxTokens === null ? 'Uncapped' : String(sum.maxTokens))],
        ['Packet size cap', sum.packetMaxBytes !== null ? fmtBytes(sum.packetMaxBytes) : UNKNOWN],
        ['Projected remaining turns', u(projectedTurns(s))],
        ['Total wakes pushed', String(d.wakes.length)]
      ])
    );
    var rows = seats.map(function (seat) {
      var us = seatUsage(s, d, seat.seatId);
      var known = !!us && us.input !== null && us.output !== null;
      return h('tr', null,
        td(h('b', { text: seat.seatId })),
        td(seatForm(seat)),
        td(known ? String(us.input) : UNKNOWN),
        td(known ? String(us.output) : UNKNOWN),
        td(known && us.cached !== null ? String(us.cached) : UNKNOWN),
        td(us && us.sources.length ? us.sources.join(', ') + (us.unknownReports ? ' (' + us.unknownReports + ' turn(s) unknown)' : '') : (isObj(seat.hosted) ? 'Hosted seat, awaiting report' : 'Embedded seat, unknown to room')),
        td(String(wakesThisRound(d, seat.seatId)) + ' / ' + String(wakesTotal(d, seat.seatId))),
        td(d.failures.filter(function (f) { return f.seatId === seat.seatId; }).map(function (f) { return badge('failed(' + u(f.class) + ')', 'bad'); }))
      );
    });
    var t = document.getElementById('usage-table');
    t.replaceWith(table(['Seat', 'Mode', 'Input', 'Output', 'Cached', 'Source', 'Wakes (Round/Total)', 'Failures'], rows));
    document.querySelector('#view-usage .table').id = 'usage-table';
    var orderInput = document.querySelector('#form-continue input[name=order]');
    if (orderInput && !orderInput.value && Array.isArray(s.order) && s.order.length) orderInput.placeholder = 'Seat order (default: ' + s.order.join(',') + ')';
  };

  VIEWS.recovery = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var list = document.getElementById('recovery-list');
    clear(list);
    var g = awaitingDecision(s);
    if (g) {
      list.appendChild(h('div', { class: 'card' },
        h('h4', null, 'Awaiting User Decision ', badge('Timeout', 'bad'), badge('Seat ' + u(g.seatId), 'info')),
        kv([['Attempt', h('code', { text: u(g.attemptId) })], ['Phase', u(g.phase)], ['Round', u(g.roundId)], ['Epoch', u(g.epoch)]]),
        h('div', { class: 'notice warn', text: 'This seat timed out without submitting. Governed rooms never auto-skip: retry (fresh attempt), skip (mark absent), or reassign to another seat.' }),
        h('div', { class: 'actions' },
          actionButton('retry', { seatId: g.seatId }, 'Retry', 'primary'),
          actionButton('skip', {}, 'Skip (mark absent)'),
          actionButton('reassign', function () { var to = window.prompt('Reassign to which seat ID?'); if (!to) return null; var text = window.prompt('Optional note'); return { seatId: g.seatId, toSeatId: to, text: text || '' }; }, 'Reassign')
        )
      ));
    }
    var rows = attemptsNeedingReconcile(d, s);
    if (!rows.length && !g) list.appendChild(empty('No pending attempts require reconciliation.'));
    rows.forEach(function (r) {
      var a = d.attempts[r.attemptId] || {};
      var se = sideEffectHint(r, d, seats);
      var card = h('div', { class: 'card' },
        h('h4', null, 'Attempt ', h('code', { text: u(r.attemptId) }), badge('needs_reconcile', 'bad'), badge('Seat ' + u(r.seatId || a.seatId), 'info')),
        kv([['Packet', u(a.packetId)], ['Issued', fmtTs(a.issuedAt)], ['Deadline', fmtTs(a.deadline)], ['Detected at', fmtTs(r.ts)]]),
        h('div', { class: 'notice warn', text: se.hint })
      );
      if (se.changed.length) {
        card.appendChild(h('div', { class: 'diff' },
          h('div', { text: 'Frozen artifact diff:' }),
          se.changed.map(function (c) { return h('div', null, h('code', { text: u(c.path) }), ' ', h('span', { class: 'from', text: shortSha(c.from) }), ' → ', h('span', { class: 'to', text: shortSha(c.to) })); })
        ));
      }
      card.appendChild(h('div', { class: 'actions' },
        actionButton('reconcile', { attemptId: r.attemptId, action: 'replay' }, 'Replay (seat can submit)', 'primary'),
        actionButton('reconcile', { attemptId: r.attemptId, action: 'void' }, 'Void (bumps epoch)', 'danger')
      ));
      list.appendChild(card);
    });
    var done = Object.keys(d.reconcile).map(function (k) { return d.reconcile[k]; }).filter(function (r) { return r.status === 'reconciled'; });
    if (done.length) {
      list.appendChild(h('div', { class: 'card' },
        h('h4', { text: 'Reconciled' }),
        h('ul', { class: 'plain' }, done.map(function (r) {
          return h('li', null, h('code', { text: r.attemptId }), ' → ', badge(r.action === 'replay' ? 'Replayed' : r.action === 'void' ? 'Voided' : u(r.action), 'ok'), ' ', h('span', { class: 'hint', text: fmtTs(r.reconciledAt) }));
        }))
      ));
    }
  };

  VIEWS.merge = function () {
    var d = app.derived, s = app.state;
    var conflicts = mergeConflicts(s, d);
    var rows = conflicts.map(function (c) {
      return h('tr', { class: 'highlight' },
        td(h('code', { text: u(c.path) })),
        td((Array.isArray(c.seats) ? c.seats : []).map(function (x) { return badge(u(x), 'info'); })),
        td(h('div', { class: 'diff' }, (Array.isArray(c.manifests) ? c.manifests : []).map(function (m) {
          return h('div', null, h('code', { text: shortSha(m.manifestSha) }), ' ', h('span', { class: 'from', text: shortSha(m.from) }), ' → ', h('span', { class: 'to', text: shortSha(m.to) }));
        }))),
        td(c.detail ? String(c.detail) : (c.source === 'derived' ? 'Derived from recomputed artifact diffs across seats' : '')),
        td({ class: 'actions-cell' }, actionButton('merge-apply', {}, 'Apply'), actionButton('merge-discard', {}, 'Discard'), h('div', { class: 'unavailable', text: ACTIONS['merge-apply'].reason }))
      );
    });
    var t = document.getElementById('merge-table');
    t.replaceWith(table(['File', 'Seats', 'Manifests & Hashes', 'Details', 'Actions'], rows));
    document.querySelector('#view-merge .table').id = 'merge-table';
  };

  VIEWS.contract = function () {
    var d = app.derived, s = app.state;
    var box = document.getElementById('contract-box');
    clear(box);
    var c = isObj(s.contract) ? s.contract : {};
    var wl = isObj(c.writeLog) ? c.writeLog : (isObj(s.writeLog) ? s.writeLog : null);
    box.appendChild(h('div', { class: 'card' },
      h('h4', { text: 'write-log Summary (Invariant 1: Scoped Writes Only)' }),
      wl ? kv([
        ['Total writes', u(wl.total)],
        ['Out-of-scope writes', h('span', null, badge(String(num(wl.outside) === null ? UNKNOWN : wl.outside), num(wl.outside) === 0 ? 'ok' : 'bad'))],
        ['By actor', isObj(wl.byWho) ? Object.keys(wl.byWho).map(function (k) { return k + '=' + wl.byWho[k]; }).join(', ') : UNKNOWN],
        ['Last write', fmtTs(wl.lastTs)]
      ]) : empty('Unknown (service did not provide contract.writeLog; verify with contract/check-writes.mjs)'),
      h('p', { class: 'hint', text: 'Wording note: write-log is self-reported by the room guard and supports only "no out-of-scope writes observed under this method".' })
    ));
    var cr = isObj(c.controlRun) ? c.controlRun : null;
    box.appendChild(h('div', { class: 'card' },
      h('h4', { text: 'Control Run (Invariant 1: Full Run With Zero Agent Changes)' }),
      cr ? kv([
        ['Result', badge(cr.ok === true ? 'Zero diff' : cr.ok === false ? 'Diff detected' : UNKNOWN, cr.ok === true ? 'ok' : cr.ok === false ? 'bad' : 'warn')],
        ['Diff entries', u(cr.diffEntries)],
        ['Ran at', fmtTs(cr.ranAt)],
        ['Report', h('code', { text: u(cr.reportPath) })]
      ]) : empty('Unknown (service did not provide contract.controlRun; run contract/control-run.mjs)')
    ));
    var opened = Array.isArray(c.auditOpened) ? c.auditOpened : [];
    d.audits.forEach(function (a) { a.opened.forEach(function (f) { if (opened.indexOf(f) === -1) opened.push(f); }); });
    box.appendChild(h('div', { class: 'card' },
      h('h4', { text: 'Files Opened by Auditor (Invariant 5: Subset of Registered Threads / Sessions)' }),
      opened.length ? h('ul', { class: 'plain' }, opened.map(function (f) { return h('li', null, h('code', { text: typeof f === 'string' ? f : JSON.stringify(f) })); })) : empty('Unknown (no audit_observed.opened or contract.auditOpened supplied)'),
      h('p', { class: 'hint', text: 'Total audits: ' + d.audits.length + ', tainted: ' + d.audits.filter(function (a) { return a.tainted; }).length + ', unknown: ' + d.audits.filter(function (a) { return a.status === 'unknown'; }).length + '.' })
    ));
    var counts = Object.keys(d.counts).sort().map(function (k) { return k + '=' + d.counts[k]; }).join(', ');
    box.appendChild(h('div', { class: 'card' },
      h('h4', { text: 'Event Counts (Fetched by This Page)' }),
      h('div', { class: 'mono', text: counts || '(none)' })
    ));
  };

  // ---- export (client side, no admin command; kept self-contained for test/app.test.mjs) ----
  function exportEvidence() {
    var inApp = typeof window !== 'undefined' && !!window.roomApp && window.roomApp.isApp === true && typeof window.roomApp.saveEvidence === 'function';
    var payload = { exportedAt: new Date().toISOString(), note: (inApp ? 'Exported by desktop app' : 'Exported by browser') + ': polled state and events; credentials excluded.', state: app.state, room: app.room, events: app.events, derivedSummary: { lastSeq: app.derived.lastSeq, counts: app.derived.counts, audits: app.derived.audits, receipts: receiptRows(app.derived) } };
    var text = JSON.stringify(payload, null, 1);
    var name = 'room-evidence-' + ((app.room && app.room.id) || 'room') + '-' + Date.now() + '.json';
    if (inApp) {
      var fail = function (why) { toast('Evidence export failed: ' + (why || 'Unknown error'), 'bad'); };
      var p;
      try { p = window.roomApp.saveEvidence(name, text); } catch (e) { fail(e && e.message); return; }
      Promise.resolve(p).then(function (r) {
        if (r && r.saved === true) toast('Exported evidence JSON: ' + r.path, 'ok');
        else if (r && r.canceled === true) toast('Evidence export canceled.', '');
        else fail(r && r.error);
      }, function (e) { fail(e && e.message); });
      return;
    }
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast('Exported evidence JSON', 'ok');
  }

  // ---- boot ----
  function clearFragment() {
    if (typeof history !== 'undefined' && history && typeof history.replaceState === 'function') {
      history.replaceState(null, '', location.pathname);
    }
  }
  function boot() {
    applyTheme(detectInitialTheme());
    var themeBtn = document.getElementById('btn-theme');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        applyTheme(app.theme === 'dark' ? 'light' : 'dark');
      });
    }
    setToken(readTokenFromFragment());
    clearFragment();
    window.addEventListener('hashchange', function () {
      var next = readTokenFromFragment();
      if (next) { setToken(next); clearFragment(); }
      render();
    });
    var tokenForm = document.getElementById('token-form');
    if (tokenForm) {
      tokenForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('token-input');
        var v = input ? input.value.trim() : '';
        if (input) input.value = '';
        if (v) { clearFragment(); setToken(v); app.lastRender = ''; render(); }
      });
    }
    var modeTabs = document.getElementById('stream-mode-tabs');
    if (modeTabs) {
      modeTabs.addEventListener('click', function (e) {
        var b = e.target && typeof e.target.closest === 'function' ? e.target.closest('.rt-mode-btn') : null;
        if (!b) return;
        app.streamMode = b.getAttribute('data-stream-mode') || 'chat';
        app.lastRender = '';
        render();
      });
    }
    var compInput = document.getElementById('composer-input');
    if (compInput) {
      compInput.addEventListener('compositionstart', function () { app.composing = true; });
      compInput.addEventListener('compositionend', function () { app.composing = false; });
      compInput.addEventListener('keydown', function (ev) {
        var chat = getChat();
        var form = document.getElementById('form-say');
        var submitNow = function () {
          if (!form) return;
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else runAction('say', formValues(form)).then(function () { if (typeof form.reset === 'function') form.reset(); });
        };
        if (chat && typeof chat.handleComposerKeyDown === 'function') {
          chat.handleComposerKeyDown(ev, { composing: app.composing, locked: !app.token || !compInput.value.trim(), onSubmit: submitNow });
        }
      });
    }
    var tabsEl = document.getElementById('tabs');
    if (tabsEl) {
      tabsEl.addEventListener('click', function (e) {
        var b = e.target && typeof e.target.closest === 'function' ? e.target.closest('.tab') : null;
        if (!b) return;
        switchTab(b.getAttribute('data-view'));
      });
    }
    document.querySelectorAll('form[data-action]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var key = form.getAttribute('data-action');
        var vals = formValues(form);
        if (key === 'start' && !vals.order && Array.isArray(app.state.order)) vals.order = app.state.order.join(',');
        if (key === 'interrupt' && form.id === 'form-deny-task' && !vals.text) vals.text = 'Task draft rejected';
        runAction(key, vals).then(function () { if (key === 'say' || key === 'task') form.reset(); });
      });
    });
    document.querySelectorAll('button[data-action]').forEach(function (btn) {
      var key = btn.getAttribute('data-action');
      if (key === 'export-evidence') { btn.addEventListener('click', exportEvidence); return; }
      btn.addEventListener('click', function () { runAction(key, {}); });
    });
    poll();
    connectSse();
    app.timer = setInterval(function () { if (!app.sseConnected) poll(); }, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
