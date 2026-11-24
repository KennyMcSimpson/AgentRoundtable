/* ui/rt-i18n.js - zero-dependency pure-English UI dictionary for AgentRoundtable.
 * Classic ES2020 IIFE exposing globalThis.RoomI18n (DOM-free, safe in Node vm).
 */
(function () {
  'use strict';

  var DEFAULT_LANG = 'en';
  var SUPPORTED = ['en'];

  function normalizeLang() {
    return 'en';
  }

  var DICT = {
    en: {
      'brand.room': 'AgentRoundtable',
      'brand.lobby': 'AgentRoundtable',
      'theme.light': 'Light',
      'theme.dark': 'Dark',
      'theme.toggleTitle': 'Toggle light / dark theme',
      'hdr.room': 'Room',
      'hdr.phase': 'Phase',
      'hdr.round': 'Round',
      'hdr.turn': 'Turn',
      'hdr.root': 'Rooms Dir',
      'hdr.conn.sse': 'Live (SSE)',
      'hdr.conn.poll': 'Online (Poll)',
      'hdr.conn.offline': 'Offline',
      'hdr.conn.unknown': 'Connecting',
      'hdr.tok.ok': 'Loaded',
      'hdr.tok.missing': 'Not loaded',
      'hdr.daemon.badge': 'Daemon Mode',
      'hdr.daemon.resumed': 'Auto-resumed {n} active',
      'hdr.daemon.open': '{n} running',

      'tab.stream': 'Stream',
      'tab.seats': 'Seats',
      'tab.packets': 'Packets',
      'tab.task': 'Task Draft',
      'tab.items': 'Items',
      'tab.verdicts': 'Verdicts',
      'tab.receipts': 'Receipts',
      'tab.usage': 'Usage',
      'tab.recovery': 'Recovery',
      'tab.merge': 'Merge',
      'tab.contract': 'Contract',

      'mode.chat': 'Group Chat',
      'mode.arena': 'Arena Compare',
      'mode.log': 'Raw Log',

      'inbox.title': 'Action Required',
      'inbox.count': '{n} pending',
      'inbox.taskDraft': 'Lead {seat} drafted task assignments awaiting confirmation',
      'inbox.confirmTask': 'Confirm Task',
      'inbox.viewTask': 'Review Draft',
      'inbox.awaiting': 'Seat {seat} timed out in {phase} — choose next action',
      'inbox.reconcile': 'Pending attempt {attempt} (Seat {seat}) needs reconciliation',
      'inbox.disclose': 'Seat {seat} requested disclosure: {argv}',
      'inbox.retry': 'Retry',
      'inbox.skip': 'Skip',
      'inbox.replay': 'Replay',
      'inbox.void': 'Void',
      'inbox.approve': 'Approve',
      'inbox.deny': 'Deny',
      'inbox.denyPrompt': 'Denial reason (required)',

      'chat.roundTitle': 'Round {round}',
      'chat.topicLabel': 'Objective: ',
      'chat.pendingTopic': 'Queued Task: ',
      'chat.empty': 'No messages yet. Start a round or send a message below.',
      'chat.leadBadge': 'Lead',
      'chat.summaryTitle': 'Summary v{version}',
      'chat.summaryPrev': 'Previous Summary',
      'chat.summaryMerged': 'Folded {n} official mark(s) onto target messages',
      'chat.truncated': 'Body exceeded display cap; showing first 60,000 characters',
      'chat.expand': 'Show full message',
      'chat.collapse': 'Collapse',
      'chat.quoteHeader': 'Quote #{seq} ({seat})',
      'chat.quoteSeqOnly': 'Quote #{seq}',
      'chat.jumpToQuote': 'Jump to #{seq}',
      'chat.quoteVerified': 'Verified',
      'chat.quoteMismatch': 'Mismatch',
      'chat.claimBadge': 'Speaker Claim · Unverified',
      'chat.claimPoint': 'Point about #{seq}',
      'chat.claimVerdict': 'Claimed verdict={verdict}',
      'chat.claimDisclose': 'Disclosure Request',
      'chat.claimMisquoted': 'Disputed Quote #{seq}',
      'chat.claimAssign': 'Assignment Draft',
      'chat.claimPass': 'PASS (skipped turn)',
      'chat.authMark': 'Official Mark: {status}',
      'chat.authPoint': 'Item {id} · {status}',
      'chat.authVerdict': 'Official verdict: {verdict}',
      'chat.nonReviewer': 'Non-reviewer opinion (excluded)',
      'chat.verified': 'Verified',
      'chat.unverified': 'Unverified',
      'chat.unattachedItems': 'Unattached items this round',
      'chat.unattachedVerdicts': 'Unattached verdicts this round',
      'chat.userMsg': 'User Message',
      'chat.systemEvent': 'Room Event',
      'chat.showMarkers': 'System events',
      'chat.composerPlaceholder': 'Queue a message for seats (Ctrl+Enter to send, Enter for newline)…',
      'chat.composerSend': 'Send',
      'chat.composerInterrupt': 'Interrupt & Reopen',
      'chat.composerInterruptPlaceholder': 'Interrupt note (optional)',
      'chat.composerStart': 'Start Round',
      'chat.orderToggle': 'Seat Order',
      'chat.orderPlaceholder': 'Seat order, e.g. A,B,A (optional)',
      'chat.seatFilterAll': 'All Seats',

      'arena.title': 'Arena Compare',
      'arena.roundLabel': 'Round',
      'arena.latestRound': 'Round {round}',
      'arena.empty': 'No seat speeches in this round to compare yet.',
      'arena.noSpeech': 'No speech in this round',
      'arena.messagesCount': '{n} msg',
      'arena.messagesCountPlural': '{n} msgs',
      'arena.jumpChat': 'Jump to Chat ↗',
      'arena.syncTask': 'Objective: ',

      'role.lead': 'Lead',
      'role.executor': 'Executor',
      'role.reviewer': 'Reviewer',
      'role.participant': 'Participant',
      'status.accepted': 'Accepted',
      'status.rejected': 'Rejected',
      'status.deferred': 'Deferred',
      'status.unanswered': 'Unanswered',
      'status.open': 'Open',
      'status.pending': 'Pending',
      'status.unknown': 'Unknown',
      'phase.idle': 'Idle',
      'phase.assign': 'Assign',
      'phase.work': 'Work',
      'phase.meet': 'Meet',
      'phase.summary': 'Summary',
      'phase.reconcile': 'Reconcile',
      'phase.done': 'Done',
      'phase.closed': 'Closed',

      'lobby.tab.rooms': 'Rooms',
      'lobby.tab.create': 'New Room',
      'lobby.refresh': 'Refresh',
      'lobby.createBtn': 'New Room',
      'lobby.conn.sse': 'Live (SSE)',
      'lobby.conn.ok': 'Online',
      'lobby.conn.bad': 'Disconnected',
      'lobby.tok.ok': 'Loaded',
      'lobby.tok.missing': 'Not loaded',
    },
  };

  function t(lang, key, params) {
    var table = DICT[DEFAULT_LANG];
    var s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    if (!params) return s;
    return String(s).replace(/\{([A-Za-z0-9_]+)\}/g, function (_, name) {
      return Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
        ? String(params[name])
        : '';
    });
  }

  var RoomI18n = {
    DEFAULT_LANG: DEFAULT_LANG,
    SUPPORTED: SUPPORTED,
    normalizeLang: normalizeLang,
    t: t,
    DICT: DICT,
  };

  if (typeof globalThis !== 'undefined') globalThis.RoomI18n = RoomI18n;
})();
