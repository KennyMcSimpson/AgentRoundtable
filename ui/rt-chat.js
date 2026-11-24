/* ui/rt-chat.js - zero-dependency group-chat projection, Arena side-by-side comparison,
 * sticky approval inbox, and IME-safe composer helper for AgentRoundtable.
 * Classic ES2020 IIFE exposing globalThis.RoomChat (pure model functions work in Node vm).
 *
 * Security & correctness invariants:
 * - Zero innerHTML: all DOM nodes created via document.createElement / createTextNode.
 * - Strict visual and semantic separation between speaker-prose claim cards (dashed neutral border)
 *   and host-authoritative badges (solid chips sourced strictly from state.items / derived.verdicts).
 * - Unrecorded MARK tags and MARK tags outside the active summary always roll back to verbatim
 *   raw-marker slices.
 */
(function () {
  'use strict';

  var LONG_SPEECH_CHAR_THRESHOLD = 900;
  var LONG_SPEECH_LINE_THRESHOLD = 18;

  function getProtocol() { return typeof globalThis !== 'undefined' ? globalThis.RoomProtocol : null; }
  function getMarkdown() { return typeof globalThis !== 'undefined' ? globalThis.RoomMarkdown : null; }
  function getI18n() { return typeof globalThis !== 'undefined' ? globalThis.RoomI18n : null; }

  function tr(lang, key, params) {
    var i18n = getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(lang || 'en', key, params);
    return key;
  }

  function isObj(v) { return v !== null && typeof v === 'object'; }
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function shortSha(s) { return typeof s === 'string' && s.length > 12 ? s.slice(0, 12) : String(s || ''); }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function resolveSeatIdentity(seatId, seat, leadSeatId) {
    var id = seatId || '—';
    var isLead = Boolean(seatId && ((seat && seat.role === 'lead') || seatId === leadSeatId));
    var agent = seat && typeof seat.agent === 'string' ? seat.agent.toLowerCase() : '';
    var hostedKind = seat && isObj(seat.hosted) && typeof seat.hosted.kind === 'string' ? seat.hosted.kind.toLowerCase() : '';
    var lane = seat && isObj(seat.hosted) && typeof seat.hosted.lane === 'string' ? seat.hosted.lane.toLowerCase() : '';

    if (hostedKind === 'pi' || lane === 'pi-agent' || agent === 'pi-user' || id.toUpperCase() === 'PI') {
      return { seatId: id, family: 'pi', familyLabel: hostedKind === 'pi' ? 'Built-in Pi' : 'Pi', monogram: 'PI', isLead: isLead };
    }
    if (lane === 'claude-code' || agent === 'claude-code' || /^claude/i.test(id)) {
      return { seatId: id, family: 'claude', familyLabel: 'Claude Code', monogram: 'CC', isLead: isLead };
    }
    if (agent === 'antigravity' || /^anti/i.test(id)) {
      return { seatId: id, family: 'antigravity', familyLabel: 'Antigravity', monogram: 'AG', isLead: isLead };
    }
    if (lane === 'codex-cli' || agent === 'codex-cli' || agent === 'codex-desktop' || /^codex/i.test(id)) {
      var codexLabel = agent === 'codex-desktop' ? 'Codex Desktop' : (agent === 'codex-cli' ? 'Codex CLI' : 'Codex');
      return { seatId: id, family: 'codex', familyLabel: codexLabel, monogram: 'CX', isLead: isLead };
    }
    if (lane === 'gemini' || agent === 'gemini-cli' || /^gemini/i.test(id)) {
      return { seatId: id, family: 'gemini', familyLabel: agent === 'gemini-cli' ? 'Gemini CLI' : 'Gemini', monogram: 'GM', isLead: isLead };
    }
    if (agent === 'opencode' || /^opencode/i.test(id)) {
      return { seatId: id, family: 'opencode', familyLabel: 'OpenCode', monogram: 'OC', isLead: isLead };
    }
    if (agent === 'kimi' || /^kimi/i.test(id)) {
      return { seatId: id, family: 'kimi', familyLabel: 'Kimi', monogram: 'KM', isLead: isLead };
    }
    if (agent === 'dsh' || /^dsh/i.test(id)) {
      return { seatId: id, family: 'dsh', familyLabel: 'DSH', monogram: 'DH', isLead: isLead };
    }
    if (/^deepseek/i.test(id) || /^deepseek/i.test(lane)) {
      return { seatId: id, family: 'deepseek', familyLabel: 'DeepSeek', monogram: 'DS', isLead: isLead };
    }

    var clean = String(id).replace(/[^A-Za-z0-9]/g, '');
    var monogram = clean ? clean.slice(0, 2).toUpperCase() : 'RT';
    return {
      seatId: id,
      family: 'other',
      familyLabel: (seat && seat.agent) || lane || id,
      monogram: monogram,
      isLead: isLead,
    };
  }

  function isSpeechCollapsible(segments) {
    var chars = 0;
    var lines = 0;
    for (var i = 0; i < segments.length; i += 1) {
      var seg = segments[i];
      if (seg.type === 'markdown' || seg.type === 'quote' || seg.type === 'point') {
        chars += seg.text.length;
        lines += seg.text.split(/\r?\n/).length;
      } else if (seg.type === 'assign') {
        lines += seg.items.length + (seg.extraText ? seg.extraText.split(/\r?\n/).length : 0);
      } else if (seg.type === 'raw-marker' && seg.trailingText) {
        chars += seg.trailingText.length;
        lines += seg.trailingText.split(/\r?\n/).length;
      }
    }
    return chars > LONG_SPEECH_CHAR_THRESHOLD || lines >= LONG_SPEECH_LINE_THRESHOLD;
  }

  function shortenAuthorityMarkReason(authMarkText, parsedReason) {
    if (!authMarkText) return null;
    if (!parsedReason) return authMarkText;
    var normAuth = String(authMarkText).replace(/\r\n/g, '\n');
    var normParsed = String(parsedReason).replace(/\r\n/g, '\n');
    if (normParsed.length < normAuth.length && normAuth.indexOf(normParsed) === 0 && /^\s/.test(normAuth.slice(normParsed.length))) {
      return normParsed;
    }
    return authMarkText;
  }

  function toRawMarkSegment(verbatim, itemId, status) {
    if (!verbatim) return { type: 'raw-marker', raw: '<<ROOM:MARK item=' + itemId + ' status=' + status + '>>' };
    if (verbatim.tail) {
      var seg = { type: 'raw-marker', raw: verbatim.head, trailingText: verbatim.tail };
      if (verbatim.foot) seg.closingRaw = verbatim.foot;
      return seg;
    }
    return { type: 'raw-marker', raw: verbatim.head };
  }

  function parseSpeechSafe(rawText) {
    var proto = getProtocol();
    if (proto && typeof proto.parseRoundtableSpeechDetailed === 'function') {
      return proto.parseRoundtableSpeechDetailed(rawText || '');
    }
    var txt = typeof rawText === 'string' ? rawText : String(rawText || '');
    return {
      segments: txt.trim() ? [{ type: 'markdown', text: txt.trim() }] : [],
      blankSplitMarkIndices: new Set(),
      rawMarkSlices: new Map(),
      truncated: false,
    };
  }

  function parseTargetSeqSafe(itemId, explicitSeq) {
    var proto = getProtocol();
    if (proto && typeof proto.parseItemTargetSeq === 'function') {
      return proto.parseItemTargetSeq(itemId, explicitSeq);
    }
    if (num(explicitSeq) !== null && explicitSeq >= 0) return explicitSeq;
    var m = /^m(\d+)(?:p\d+)?$/.exec(String(itemId || '').trim());
    return m ? Number(m[1]) : null;
  }

  // ---- Pure group-chat projection over RoomUI state + room + derived ----
  function buildChatModel(input) {
    var state = isObj(input && input.state) ? input.state : {};
    var room = isObj(input && input.room) ? input.room : null;
    var derived = isObj(input && input.derived) ? input.derived : {};

    var seatsRaw = (room && Array.isArray(room.seats)) ? room.seats
      : (Array.isArray(state.seatConfigs) ? state.seatConfigs : []);
    var seatById = new Map();
    for (var si = 0; si < seatsRaw.length; si += 1) {
      if (seatsRaw[si] && seatsRaw[si].seatId) seatById.set(seatsRaw[si].seatId, seatsRaw[si]);
    }
    var leadSeatId = null;
    for (var li = 0; li < seatsRaw.length; li += 1) {
      if (seatsRaw[li] && seatsRaw[li].role === 'lead') { leadSeatId = seatsRaw[li].seatId; break; }
    }
    var summaries = Array.isArray(derived.summaries) ? derived.summaries : [];
    var latestSummary = summaries.length ? summaries[summaries.length - 1] : null;
    if (!leadSeatId && latestSummary && latestSummary.seatId) leadSeatId = latestSummary.seatId;

    var stateMsgs = Array.isArray(state.messages) ? state.messages : [];
    var stateMsgBySeq = new Map();
    for (var mi = 0; mi < stateMsgs.length; mi += 1) {
      if (stateMsgs[mi] && num(stateMsgs[mi].seq) !== null) stateMsgBySeq.set(stateMsgs[mi].seq, stateMsgs[mi]);
    }

    var quotesByAttempt = new Map();
    var quotes = Array.isArray(derived.quotes) ? derived.quotes : [];
    for (var qi = 0; qi < quotes.length; qi += 1) {
      var q = quotes[qi];
      if (!q || !q.attemptId) continue;
      if (!quotesByAttempt.has(q.attemptId)) quotesByAttempt.set(q.attemptId, []);
      quotesByAttempt.get(q.attemptId).push(q);
    }

    var attempts = isObj(derived.attempts) ? derived.attempts : {};
    var stream = Array.isArray(derived.stream) ? derived.stream : [];
    var activeRoundId = num(state.roundId) !== null && state.roundId > 0
      ? state.roundId
      : (num(derived.roundId) !== null && derived.roundId > 0 ? derived.roundId : 1);

    // Find the message entry corresponding to the latest summary_published (by attemptId) so it
    // renders once as an official SummaryCard instead of duplicating as a plain bubble.
    var latestSummaryAttemptId = latestSummary && latestSummary.attemptId ? latestSummary.attemptId : null;
    var summaryMsgEntry = null;
    if (latestSummaryAttemptId) {
      for (var smi = stream.length - 1; smi >= 0; smi -= 1) {
        if (stream[smi] && stream[smi].kind === 'message' && stream[smi].msg && stream[smi].msg.attemptId === latestSummaryAttemptId) {
          summaryMsgEntry = stream[smi].msg;
          break;
        }
      }
    }

    var knownSeqSeatIds = new Map();
    var bubbleBySeq = new Map();
    var roundsMap = new Map();
    function ensureRound(rId, ts) {
      if (!roundsMap.has(rId)) {
        roundsMap.set(rId, {
          roundId: rId,
          startTime: ts || null,
          task: null,
          timeline: [],
          bubbles: [],
          unattachedItems: [],
          unattachedVerdicts: [],
          summaryCard: null,
        });
      }
      var rg = roundsMap.get(rId);
      if (!rg.startTime && ts) rg.startTime = ts;
      return rg;
    }

    var currentRound = 1;
    var lastTaskText = (isObj(state.task) && state.task.text) || (isObj(derived.task) && derived.task.text) || null;
    var summaryOwnerRoundId = null;

    for (var ei = 0; ei < stream.length; ei += 1) {
      var e = stream[ei];
      if (!e) continue;

      if (e.kind === 'marker') {
        var nextRound = num(e.roundId) !== null && e.roundId > 0 ? e.roundId : null;
        if (nextRound === null) {
          var rm = /^Round\s+(\d+)\s+started/i.exec(e.text || '');
          if (rm) nextRound = Number(rm[1]);
        }
        if (nextRound !== null) {
          currentRound = nextRound;
          ensureRound(currentRound, e.ts);
        }
        ensureRound(currentRound, e.ts).timeline.push({ kind: 'marker', seq: e.seq, ts: e.ts, tone: e.tone || 'info', text: e.text || '' });
        continue;
      }

      if (e.kind === 'user') {
        ensureRound(currentRound, e.ts).timeline.push({
          kind: 'user',
          seq: e.seq,
          msgSeq: e.msgSeq,
          ts: e.ts,
          text: e.text || '',
        });
        continue;
      }

      if (e.kind === 'summary') {
        if (latestSummary && e.summary === latestSummary) {
          summaryOwnerRoundId = currentRound;
        } else {
          ensureRound(currentRound, e.ts).timeline.push({
            kind: 'marker',
            seq: e.seq,
            ts: e.ts,
            tone: 'info',
            text: 'Summary v' + (e.summary && e.summary.version !== undefined ? e.summary.version : '?'),
          });
        }
        continue;
      }

      if (e.kind === 'message' && e.msg) {
        var m = e.msg;
        var stMsg = num(m.seq) !== null ? stateMsgBySeq.get(m.seq) : null;
        var merged = stMsg ? Object.assign({}, m, stMsg) : m;
        var att = merged.attemptId ? attempts[merged.attemptId] : null;
        var msgRound = (att && num(att.roundId) !== null && att.roundId > 0) ? att.roundId : currentRound;
        if (num(merged.seq) !== null) knownSeqSeatIds.set(merged.seq, merged.seatId || null);

        // If this message IS the latest summary's speech, keep it for the dedicated SummaryCard.
        if (summaryMsgEntry && merged.attemptId === latestSummaryAttemptId && merged.seq === summaryMsgEntry.seq) {
          summaryOwnerRoundId = msgRound;
          continue;
        }

        var detailed = parseSpeechSafe(merged.text || '');
        // Ordinary bubbles NEVER hide MARKs as official — always roll back MARKs to verbatim raw slices.
        var visibleSegs = detailed.segments.map(function (seg, segIdx) {
          if (seg.type === 'mark') return toRawMarkSegment(detailed.rawMarkSlices.get(segIdx), seg.itemId, seg.status);
          return seg;
        });

        var bubble = {
          kind: 'bubble',
          key: num(merged.seq) !== null ? ('seq-' + merged.seq) : ('ev-' + ei),
          seq: num(merged.seq),
          eventSeq: e.seq,
          roundId: msgRound,
          seatId: merged.seatId || null,
          role: merged.role || (seatById.get(merged.seatId) && seatById.get(merged.seatId).role) || null,
          attemptId: merged.attemptId || null,
          ts: merged.ts || e.ts || null,
          text: merged.text || '',
          escaped: num(merged.escaped) || 0,
          annotation: merged.annotation || null,
          malformed: merged.malformed || null,
          identity: resolveSeatIdentity(merged.seatId, seatById.get(merged.seatId), leadSeatId),
          segments: visibleSegs,
          truncated: detailed.truncated,
          quotes: (merged.attemptId && quotesByAttempt.get(merged.attemptId)) || [],
          marks: [],
          points: [],
          verdicts: [],
          collapsible: isSpeechCollapsible(visibleSegs),
        };
        var rg2 = ensureRound(msgRound, bubble.ts);
        rg2.bubbles.push(bubble);
        rg2.timeline.push(bubble);
        if (bubble.seq !== null && !bubbleBySeq.has(bubble.seq)) bubbleBySeq.set(bubble.seq, bubble);
      }
    }

    // Authoritative items: state.items when provided by service, else derived.items.
    var rawItems = Array.isArray(state.items)
      ? state.items.map(function (x) {
          var status = x.status || 'open';
          return {
            itemId: x.itemId,
            kind: x.kind || (/^m\d+p\d+$/.test(String(x.itemId || '')) ? 'point' : 'message'),
            seatId: x.seatId || null,
            seq: x.aboutSeq !== undefined ? x.aboutSeq : x.seq,
            text: x.text || '',
            status: status,
            markText: x.markText || (x.mark && x.mark.text) || null,
            markedBy: x.markedBy || (x.mark && x.mark.by) || null,
          };
        })
      : Object.keys(isObj(derived.items) ? derived.items : {}).map(function (k) {
          var it = derived.items[k];
          var markStatus = it.mark && it.mark.status ? it.mark.status : null;
          var isUnanswered = latestSummary && Array.isArray(latestSummary.unanswered) && latestSummary.unanswered.indexOf(it.itemId) !== -1;
          return {
            itemId: it.itemId,
            kind: 'point',
            seatId: it.seatId || null,
            seq: it.aboutSeq,
            text: it.text || '',
            status: markStatus || (isUnanswered ? 'unanswered' : 'open'),
            markText: it.mark ? it.mark.text : null,
            markedBy: it.mark ? it.mark.by : null,
          };
        });

    var recordedMarkableItems = new Map();
    var unattachedItems = [];

    for (var ii = 0; ii < rawItems.length; ii += 1) {
      var item = rawItems[ii];
      var targetSeq = parseTargetSeqSafe(item.itemId, item.seq);
      var targetBubble = targetSeq !== null ? bubbleBySeq.get(targetSeq) : null;
      var authMarkText = item.markText || null;

      if (item.kind !== 'point' && item.status === 'open' && targetBubble) continue;

      if (targetBubble) {
        if (item.kind === 'point') {
          (function () {
            var ptEntry = {
              itemId: item.itemId,
              seatId: item.seatId,
              status: item.status,
              text: item.text,
              reason: authMarkText,
            };
            targetBubble.points.push(ptEntry);
            if (item.status !== 'open' && item.status !== 'unanswered') {
              recordedMarkableItems.set(item.itemId, {
                status: item.status,
                trimReason: function (parsedReason) {
                  ptEntry.reason = shortenAuthorityMarkReason(authMarkText, parsedReason);
                },
              });
            }
          })();
        } else {
          (function () {
            var mkEntry = {
              itemId: item.itemId,
              status: item.status,
              reason: authMarkText,
              markedBy: item.markedBy || leadSeatId,
            };
            targetBubble.marks.push(mkEntry);
            if (item.status !== 'open' && item.status !== 'unanswered') {
              recordedMarkableItems.set(item.itemId, {
                status: item.status,
                trimReason: function (parsedReason) {
                  mkEntry.reason = shortenAuthorityMarkReason(authMarkText, parsedReason);
                },
              });
            }
          })();
        }
      } else {
        (function () {
          var cloned = Object.assign({}, item);
          unattachedItems.push(cloned);
          if (cloned.status !== 'open' && cloned.status !== 'unanswered') {
            recordedMarkableItems.set(cloned.itemId, {
              status: cloned.status,
              trimReason: function (parsedReason) {
                cloned.markText = shortenAuthorityMarkReason(authMarkText, parsedReason);
              },
            });
          }
        })();
      }
    }

    // Authoritative verdicts from derived.verdicts
    var allVerdicts = Array.isArray(derived.verdicts) ? derived.verdicts : [];
    var verifiedMap = new Map();
    if (latestSummary && Array.isArray(latestSummary.verified)) {
      for (var vi = 0; vi < latestSummary.verified.length; vi += 1) {
        var vf = latestSummary.verified[vi];
        if (vf && vf.artifactSha) verifiedMap.set(vf.artifactSha, vf);
      }
    }
    var summaryVerdicts = [];
    var unattachedVerdicts = [];
    for (var j = 0; j < allVerdicts.length; j += 1) {
      var v = allVerdicts[j];
      var vAtt = v.attemptId ? attempts[v.attemptId] : null;
      var vRound = (vAtt && num(vAtt.roundId) !== null && vAtt.roundId > 0) ? vAtt.roundId : activeRoundId;
      var vRec = Object.assign({}, v, { verifiedInfo: v.artifactSha ? (verifiedMap.get(v.artifactSha) || null) : null });
      if (latestSummaryAttemptId && v.attemptId === latestSummaryAttemptId) {
        summaryVerdicts.push(vRec);
        continue;
      }
      var rgV = roundsMap.get(vRound);
      var attached = null;
      if (rgV) {
        for (var bi = rgV.bubbles.length - 1; bi >= 0; bi -= 1) {
          if (rgV.bubbles[bi].attemptId === v.attemptId || (!v.attemptId && rgV.bubbles[bi].seatId === v.seatId)) {
            attached = rgV.bubbles[bi];
            break;
          }
        }
      }
      if (attached) attached.verdicts.push(vRec);
      else unattachedVerdicts.push({ roundId: vRound, verdict: vRec });
    }

    // Build latest SummaryCard with recorded MARK folding + raw rollback for unrecorded MARKs.
    var builtSummary = null;
    if (latestSummary) {
      var sumText = (summaryMsgEntry && summaryMsgEntry.text) || '';
      var sumDetailed = parseSpeechSafe(sumText);
      var lastRecordedSegIdx = new Map();
      sumDetailed.segments.forEach(function (seg, idx) {
        if (seg.type !== 'mark') return;
        var rec = recordedMarkableItems.get(seg.itemId);
        if (rec && rec.status === seg.status) lastRecordedSegIdx.set(seg.itemId, idx);
      });
      var foldedIndices = new Set(lastRecordedSegIdx.values());
      var visibleSumSegs = [];
      var mergedMarkCount = 0;

      sumDetailed.segments.forEach(function (seg, idx) {
        if (seg.type === 'mark') {
          if (foldedIndices.has(idx)) {
            var rec = recordedMarkableItems.get(seg.itemId);
            if (rec && sumDetailed.blankSplitMarkIndices.has(idx)) rec.trimReason(seg.reason);
            mergedMarkCount += 1;
            return;
          }
          visibleSumSegs.push(toRawMarkSegment(sumDetailed.rawMarkSlices.get(idx), seg.itemId, seg.status));
          return;
        }
        visibleSumSegs.push(seg);
      });

      builtSummary = {
        version: latestSummary.version,
        seatId: latestSummary.seatId || leadSeatId,
        seq: summaryMsgEntry && num(summaryMsgEntry.seq) !== null ? summaryMsgEntry.seq : null,
        ts: latestSummary.ts || (summaryMsgEntry && summaryMsgEntry.ts) || null,
        supersedes: latestSummary.supersedes,
        unanswered: Array.isArray(latestSummary.unanswered) ? latestSummary.unanswered.slice() : [],
        absent: Array.isArray(latestSummary.absent) ? latestSummary.absent.slice() : [],
        noArtifact: Array.isArray(latestSummary.noArtifact) ? latestSummary.noArtifact.slice() : [],
        verified: Array.isArray(latestSummary.verified) ? latestSummary.verified.slice() : [],
        verdicts: summaryVerdicts,
        segments: visibleSumSegs,
        mergedMarkCount: mergedMarkCount,
        truncated: sumDetailed.truncated,
      };
    }

    var roundIds = Array.from(roundsMap.keys()).sort(function (a, b) { return a - b; });
    if (!roundIds.length && num(state.roundId) !== null && state.roundId > 0) {
      ensureRound(state.roundId, null);
      roundIds.push(state.roundId);
    }

    var rounds = roundIds.map(function (rId, idx) {
      var rg = roundsMap.get(rId);
      var isLast = idx === roundIds.length - 1;
      rg.task = isLast ? lastTaskText : null;
      rg.unattachedItems = isLast ? unattachedItems : [];
      rg.unattachedVerdicts = unattachedVerdicts
        .filter(function (x) { return x.roundId === rId || (isLast && !roundsMap.has(x.roundId)); })
        .map(function (x) { return x.verdict; });
      if (builtSummary && (summaryOwnerRoundId === rId || (summaryOwnerRoundId === null && isLast))) {
        rg.summaryCard = builtSummary;
      }
      return rg;
    });

    var renderedSeqs = new Set();
    rounds.forEach(function (r) {
      r.bubbles.forEach(function (b) { if (b.seq !== null) renderedSeqs.add(b.seq); });
      if (r.summaryCard && r.summaryCard.seq !== null) renderedSeqs.add(r.summaryCard.seq);
    });

    var taskConfirmed = Boolean(derived.taskConfirmed || (isObj(state.taskConfirmed) && state.taskConfirmed));

    // Track completed disclosures and resolved points so finished directives auto-fold cleanly.
    var disclosureStatusByKey = new Map();
    var disMap = isObj(derived.disclosures) ? derived.disclosures : {};
    Object.keys(disMap).forEach(function (k) {
      var q = disMap[k];
      if (!q || !q.status) return;
      var argvStr = Array.isArray(q.argv) ? q.argv.join(' ') : String(q.argv || '');
      disclosureStatusByKey.set(String(q.seatId || '') + '\0' + argvStr, String(q.status));
    });
    var pointStatusByKey = new Map();
    for (var pi = 0; pi < rawItems.length; pi += 1) {
      var pIt = rawItems[pi];
      if (!pIt || pIt.kind !== 'point' || pIt.seq === null) continue;
      var pKey = String(pIt.seatId || '') + '\0' + String(pIt.seq);
      var prevSt = pointStatusByKey.get(pKey);
      // If any point on this target is still open/unanswered, keep expanded; otherwise record resolved status.
      if (pIt.status === 'open' || pIt.status === 'unanswered') pointStatusByKey.set(pKey, 'open');
      else if (prevSt !== 'open') pointStatusByKey.set(pKey, pIt.status);
    }

    return {
      pendingTask: rounds.length === 0 ? lastTaskText : null,
      taskConfirmed: taskConfirmed,
      disclosureStatusByKey: disclosureStatusByKey,
      pointStatusByKey: pointStatusByKey,
      rounds: rounds,
      latestRoundId: rounds.length ? rounds[rounds.length - 1].roundId : activeRoundId,
      knownSeqSeatIds: knownSeqSeatIds,
      renderedSeqs: renderedSeqs,
      seats: seatsRaw.map(function (s) {
        return {
          seatId: s.seatId,
          role: s.role || null,
          agent: s.agent || null,
          hosted: s.hosted || null,
          identity: resolveSeatIdentity(s.seatId, s, leadSeatId),
        };
      }),
      leadSeatId: leadSeatId,
    };
  }

  // ---- Pure Arena side-by-side projection ----
  function buildArenaModel(chatModel, requestedRoundId) {
    var rounds = (chatModel && Array.isArray(chatModel.rounds)) ? chatModel.rounds : [];
    if (!rounds.length) return { roundId: null, task: chatModel && chatModel.pendingTask || null, availableRounds: [], columns: [] };
    var target = null;
    if (num(requestedRoundId) !== null) {
      target = rounds.filter(function (r) { return r.roundId === requestedRoundId; })[0] || null;
    }
    if (!target) {
      for (var i = rounds.length - 1; i >= 0; i -= 1) {
        if (rounds[i].bubbles.length > 0) { target = rounds[i]; break; }
      }
      if (!target) target = rounds[rounds.length - 1];
    }

    var seatMap = new Map();
    var order = [];
    (chatModel.seats || []).forEach(function (s) {
      seatMap.set(s.seatId, {
        seatId: s.seatId,
        role: s.role,
        agent: s.agent,
        identity: s.identity,
        bubbles: [],
        verdicts: [],
        charCount: 0,
      });
      order.push(s.seatId);
    });

    target.bubbles.forEach(function (b) {
      var sid = b.seatId || '—';
      if (!seatMap.has(sid)) {
        seatMap.set(sid, {
          seatId: sid,
          role: b.role,
          agent: null,
          identity: b.identity,
          bubbles: [],
          verdicts: [],
          charCount: 0,
        });
        order.push(sid);
      }
      var col = seatMap.get(sid);
      col.bubbles.push(b);
      col.charCount += (b.text || '').length;
      if (b.verdicts && b.verdicts.length) col.verdicts = col.verdicts.concat(b.verdicts);
    });

    return {
      roundId: target.roundId,
      task: target.task,
      availableRounds: rounds.map(function (r) { return r.roundId; }),
      columns: order.map(function (id) { return seatMap.get(id); }),
    };
  }

  // ---- Pure IME-safe composer key handler ----
  function handleComposerKeyDown(event, opts) {
    var isIme = Boolean(
      (opts && opts.composing) ||
      event.isComposing ||
      (event.nativeEvent && event.nativeEvent.isComposing) ||
      event.keyCode === 229 ||
      (event.nativeEvent && event.nativeEvent.keyCode === 229)
    );
    if (isIme) return false;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (opts && !opts.locked && typeof opts.onSubmit === 'function') {
        opts.onSubmit();
        return true;
      }
    }
    return false;
  }

  // ---- Pure pending-approvals builder ----
  function buildApprovalItems(input) {
    var state = isObj(input && input.state) ? input.state : {};
    var derived = isObj(input && input.derived) ? input.derived : {};
    var items = [];

    var draft = derived.taskDraft || (isObj(state.taskDraft) ? { draft: state.taskDraft, seatId: state.taskDraft.seatId } : null);
    var confirmed = derived.taskConfirmed || (isObj(state.taskConfirmed) ? state.taskConfirmed : null);
    if (draft && !confirmed) {
      items.push({ kind: 'task-draft', seatId: draft.seatId || '?' });
    }

    var awaiting = isObj(state.awaitingDecision) && state.awaitingDecision.seatId ? state.awaitingDecision : null;
    if (awaiting) {
      items.push({ kind: 'awaiting', seatId: awaiting.seatId, phase: awaiting.phase || '?', attemptId: awaiting.attemptId || '' });
    }

    var recMap = isObj(derived.reconcile) ? derived.reconcile : {};
    var seenRec = new Set();
    Object.keys(recMap).forEach(function (k) {
      var r = recMap[k];
      if (r && r.status === 'needs_reconcile') {
        seenRec.add(r.attemptId);
        items.push({ kind: 'reconcile', attemptId: r.attemptId, seatId: r.seatId || '?' });
      }
    });
    var extraRec = Array.isArray(state.needsReconcile) ? state.needsReconcile : [];
    extraRec.forEach(function (x) {
      var aid = isObj(x) ? x.attemptId : x;
      if (aid && !seenRec.has(aid)) {
        seenRec.add(aid);
        items.push({ kind: 'reconcile', attemptId: aid, seatId: (isObj(x) && x.seatId) || '?' });
      }
    });

    var disMap = isObj(derived.disclosures) ? derived.disclosures : {};
    Object.keys(disMap).forEach(function (k) {
      var q = disMap[k];
      if (q && q.status === 'requested') {
        items.push({
          kind: 'disclose',
          id: q.id,
          seatId: q.seatId || '?',
          argv: Array.isArray(q.argv) ? q.argv.join(' ') : String(q.argv || ''),
        });
      }
    });

    return items;
  }

  // ---- DOM helpers (zero innerHTML) ----
  function el(doc, tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (children) {
      for (var i = 0; i < children.length; i += 1) {
        var c = children[i];
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderMdOrPre(doc, text) {
    var md = getMarkdown();
    if (md && typeof md.renderMarkdown === 'function') return md.renderMarkdown(doc, text);
    return el(doc, 'pre', { class: 'rt-md-fallback', text: text });
  }

  function statusLabel(lang, status) {
    return tr(lang, 'status.' + String(status || 'unknown'));
  }

  function statusTone(status) {
    if (status === 'accepted' || status === 'pass') return 'ok';
    if (status === 'rejected' || status === 'reject' || status === 'unanswered' || status === 'tainted') return 'bad';
    if (status === 'deferred' || status === 'disclose' || status === 'open' || status === 'stale') return 'warn';
    return 'info';
  }

  function claimBadge(doc, lang) {
    return el(doc, 'span', { class: 'rt-claim-origin', text: tr(lang, 'chat.claimBadge') });
  }

  function foldedClaim(doc, titleText, statusText, bodyNodes, extraAttrs) {
    var summaryChildren = [
      el(doc, 'span', { class: 'rt-folded-title', text: titleText }),
      statusText ? el(doc, 'span', { class: 'rt-folded-status', text: statusText }) : null,
    ];
    var det = el(doc, 'details', Object.assign({ class: 'rt-claim-folded' }, extraAttrs || {}), [
      el(doc, 'summary', { class: 'rt-folded-summary' }, summaryChildren),
      el(doc, 'div', { class: 'rt-folded-body' }, bodyNodes),
    ]);
    return det;
  }

  function renderSegments(doc, segments, ctx) {
    var frag = doc.createDocumentFragment();
    var lang = ctx.lang || 'en';
    var knownSeqSeatIds = ctx.knownSeqSeatIds || new Map();
    var renderedSeqs = ctx.renderedSeqs || new Set();
    var bubbleQuotes = ctx.quotes || [];
    var seatId = ctx.seatId || '';
    var taskConfirmed = !!ctx.taskConfirmed;
    var hasOfficialVerdict = !!ctx.hasOfficialVerdict;
    var disclosureStatusByKey = ctx.disclosureStatusByKey || new Map();
    var pointStatusByKey = ctx.pointStatusByKey || new Map();

    for (var i = 0; i < segments.length; i += 1) {
      var seg = segments[i];
      if (seg.type === 'markdown') {
        frag.appendChild(renderMdOrPre(doc, seg.text));
      } else if (seg.type === 'quote') {
        (function (qSeg) {
          var qSeat = knownSeqSeatIds.get(qSeg.seq);
          var canJump = renderedSeqs.has(qSeg.seq) && typeof ctx.onJumpToSeq === 'function';
          var headerText = qSeat
            ? tr(lang, 'chat.quoteHeader', { seq: qSeg.seq, seat: qSeat })
            : tr(lang, 'chat.quoteSeqOnly', { seq: qSeg.seq });
          var matchedQ = bubbleQuotes.filter(function (x) { return x.seq === qSeg.seq; })[0] || null;
          var verBadge = matchedQ && typeof matchedQ.verified === 'boolean'
            ? el(doc, 'span', {
                class: 'rt-chip ' + (matchedQ.verified ? 'ok' : 'bad'),
                text: tr(lang, matchedQ.verified ? 'chat.quoteVerified' : 'chat.quoteMismatch'),
              })
            : null;
          var headNode = canJump
            ? el(doc, 'button', {
                type: 'button',
                class: 'rt-quote-link',
                'data-quote-seq': String(qSeg.seq),
                title: tr(lang, 'chat.jumpToQuote', { seq: qSeg.seq }),
                onclick: function (ev) { ev.stopPropagation(); ctx.onJumpToSeq(qSeg.seq); },
              }, ['↪ ', headerText])
            : el(doc, 'div', { class: 'rt-quote-head', text: '↪ ' + headerText });
          var bq = el(doc, 'blockquote', {
            class: 'rt-quote' + (canJump ? ' is-clickable' : '') + (matchedQ && matchedQ.verified === false ? ' is-mismatch' : ''),
            'data-quote-seq': String(qSeg.seq),
          }, [
            el(doc, 'div', { class: 'rt-quote-top' }, [headNode, verBadge]),
            el(doc, 'div', { class: 'rt-quote-body', text: qSeg.text }),
          ]);
          if (canJump) bq.addEventListener('click', function () { ctx.onJumpToSeq(qSeg.seq); });
          frag.appendChild(bq);
        })(seg);
      } else if (seg.type === 'point') {
        var ptStatus = pointStatusByKey.get(String(seatId) + '\0' + String(seg.seq));
        var ptResolved = ptStatus && ptStatus !== 'open' && ptStatus !== 'unanswered';
        if (ptResolved) {
          frag.appendChild(foldedClaim(
            doc,
            tr(lang, 'chat.claimPoint', { seq: seg.seq }),
            statusLabel(lang, ptStatus),
            [renderMdOrPre(doc, seg.text)],
            { 'data-point-seq': String(seg.seq) }
          ));
        } else {
          frag.appendChild(el(doc, 'div', { class: 'rt-claim-card', 'data-point-seq': String(seg.seq) }, [
            el(doc, 'div', { class: 'rt-claim-head' }, [
              el(doc, 'code', { class: 'rt-claim-tag', text: tr(lang, 'chat.claimPoint', { seq: seg.seq }) }),
              claimBadge(doc, lang),
            ]),
            renderMdOrPre(doc, seg.text),
          ]));
        }
      } else if (seg.type === 'assign') {
        var assignBody = [];
        if (seg.items.length) {
          assignBody.push(el(doc, 'ul', { class: 'rt-assign-list' }, seg.items.map(function (row) {
            return el(doc, 'li', null, [el(doc, 'strong', { text: row.seatId }), ': ', row.task]);
          })));
        }
        if (seg.extraText) assignBody.push(renderMdOrPre(doc, seg.extraText));
        if (taskConfirmed) {
          frag.appendChild(foldedClaim(doc, tr(lang, 'chat.claimAssign'), 'Confirmed', assignBody));
        } else {
          var assignChildren = [
            el(doc, 'div', { class: 'rt-claim-head' }, [
              el(doc, 'code', { class: 'rt-claim-tag', text: tr(lang, 'chat.claimAssign') }),
              claimBadge(doc, lang),
            ]),
          ].concat(assignBody);
          frag.appendChild(el(doc, 'div', { class: 'rt-assign-card' }, assignChildren));
        }
      } else if (seg.type === 'verdict') {
        if (hasOfficialVerdict) {
          var vBody = [
            seg.artifact ? el(doc, 'code', { class: 'rt-sha', text: shortSha(seg.artifact) }) : null,
            seg.reason ? renderMdOrPre(doc, seg.reason) : null,
          ];
          frag.appendChild(foldedClaim(
            doc,
            tr(lang, 'chat.claimVerdict', { verdict: seg.verdict }),
            'Recorded',
            vBody,
            { 'data-speech-verdict': seg.verdict }
          ));
        } else {
          frag.appendChild(el(doc, 'div', { class: 'rt-claim-card', 'data-speech-verdict': seg.verdict }, [
            el(doc, 'div', { class: 'rt-claim-head' }, [
              el(doc, 'code', { class: 'rt-claim-tag', text: tr(lang, 'chat.claimVerdict', { verdict: seg.verdict }) }),
              seg.artifact ? el(doc, 'code', { class: 'rt-sha', text: shortSha(seg.artifact) }) : null,
              claimBadge(doc, lang),
            ]),
            seg.reason ? renderMdOrPre(doc, seg.reason) : null,
          ]));
        }
      } else if (seg.type === 'disclose') {
        var argvStr = seg.argv.join(' ');
        var dStatus = disclosureStatusByKey.get(String(seatId) + '\0' + argvStr);
        var dDone = dStatus && dStatus !== 'requested';
        if (dDone) {
          var dLabel = dStatus.charAt(0).toUpperCase() + dStatus.slice(1);
          frag.appendChild(foldedClaim(
            doc,
            tr(lang, 'chat.claimDisclose') + ' · ' + argvStr,
            dLabel,
            [seg.reason ? el(doc, 'div', { class: 'rt-claim-body', text: seg.reason }) : null]
          ));
        } else {
          frag.appendChild(el(doc, 'div', { class: 'rt-claim-card' }, [
            el(doc, 'div', { class: 'rt-claim-head' }, [
              el(doc, 'code', { class: 'rt-claim-tag', text: tr(lang, 'chat.claimDisclose') }),
              el(doc, 'code', { class: 'rt-sha', text: argvStr }),
              claimBadge(doc, lang),
            ]),
            seg.reason ? el(doc, 'div', { class: 'rt-claim-body', text: seg.reason }) : null,
          ]));
        }
      } else if (seg.type === 'misquoted') {
        frag.appendChild(el(doc, 'div', { class: 'rt-claim-card', 'data-misquoted-seq': String(seg.seq) }, [
          el(doc, 'div', { class: 'rt-claim-head' }, [
            el(doc, 'code', { class: 'rt-claim-tag', text: tr(lang, 'chat.claimMisquoted', { seq: seg.seq }) }),
            claimBadge(doc, lang),
          ]),
          seg.reason ? el(doc, 'div', { class: 'rt-claim-body', text: seg.reason }) : null,
        ]));
      } else if (seg.type === 'pass') {
        frag.appendChild(el(doc, 'code', { class: 'rt-pass-pill', text: tr(lang, 'chat.claimPass') }));
      } else if (seg.type === 'raw-marker') {
        if (seg.trailingText) {
          frag.appendChild(el(doc, 'div', { class: 'rt-raw-mark-block' }, [
            el(doc, 'div', { class: 'rt-claim-head' }, [
              el(doc, 'code', { class: 'rt-raw-marker', text: seg.raw }),
              claimBadge(doc, lang),
            ]),
            el(doc, 'div', { class: 'rt-raw-mark-body', text: seg.trailingText }),
            seg.closingRaw ? el(doc, 'code', { class: 'rt-raw-marker', text: seg.closingRaw }) : null,
          ]));
        } else {
          frag.appendChild(el(doc, 'code', { class: 'rt-raw-marker', text: seg.raw }));
        }
      }
    }
    return frag;
  }

  function renderVerdictRow(doc, v, lang, includeSeat) {
    var children = [
      el(doc, 'span', { class: 'rt-chip solid ' + statusTone(v.verdict), text: tr(lang, 'chat.authVerdict', { verdict: v.verdict }) }),
    ];
    if (includeSeat && v.seatId) children.push(el(doc, 'span', { class: 'rt-auth-meta', text: 'Seat ' + v.seatId }));
    if (v.authorized === false) children.push(el(doc, 'span', { class: 'rt-chip warn', text: tr(lang, 'chat.nonReviewer') }));
    if (v.annotation && v.annotation !== 'none') children.push(el(doc, 'span', { class: 'rt-chip ' + statusTone(v.annotation), text: v.annotation }));
    if (v.tainted && v.annotation !== 'tainted') children.push(el(doc, 'span', { class: 'rt-chip solid bad', text: 'tainted' }));
    if (v.verifiedInfo) {
      children.push(el(doc, 'span', {
        class: 'rt-chip solid ' + (v.verifiedInfo.verified ? 'ok' : 'warn'),
        text: tr(lang, v.verifiedInfo.verified ? 'chat.verified' : 'chat.unverified'),
      }));
    }
    if (v.artifactSha) children.push(el(doc, 'code', { class: 'rt-sha', text: shortSha(v.artifactSha) }));
    return el(doc, 'div', { class: 'rt-auth-row' }, children);
  }

  function renderAuthoritativeFoot(doc, bubble, lang) {
    var hasMarks = bubble.marks && bubble.marks.length > 0;
    var hasPoints = bubble.points && bubble.points.length > 0;
    var hasVerdicts = bubble.verdicts && bubble.verdicts.length > 0;
    if (!hasMarks && !hasPoints && !hasVerdicts) return null;

    var wrap = el(doc, 'div', { class: 'rt-auth-foot' });
    (bubble.marks || []).forEach(function (mk) {
      wrap.appendChild(el(doc, 'div', { class: 'rt-auth-row' }, [
        el(doc, 'span', { class: 'rt-chip solid ' + statusTone(mk.status), text: tr(lang, 'chat.authMark', { status: statusLabel(lang, mk.status) }) }),
        mk.markedBy ? el(doc, 'span', { class: 'rt-auth-meta', text: 'by ' + mk.markedBy }) : null,
        mk.reason ? el(doc, 'span', { class: 'rt-auth-text', text: mk.reason }) : null,
      ]));
    });
    (bubble.points || []).forEach(function (pt) {
      wrap.appendChild(el(doc, 'div', { class: 'rt-auth-row' }, [
        el(doc, 'span', { class: 'rt-chip solid ' + statusTone(pt.status), text: tr(lang, 'chat.authPoint', { id: pt.itemId, status: statusLabel(lang, pt.status) }) }),
        pt.seatId ? el(doc, 'span', { class: 'rt-auth-meta', text: 'Seat ' + pt.seatId }) : null,
        el(doc, 'span', { class: 'rt-auth-text', text: pt.text + (pt.reason ? ' — ' + pt.reason : '') }),
      ]));
    });
    (bubble.verdicts || []).forEach(function (v) {
      wrap.appendChild(renderVerdictRow(doc, v, lang, false));
    });
    return wrap;
  }

  function renderBubble(doc, bubble, chatModel, opts) {
    var lang = opts.lang || 'en';
    var expandedMap = opts.expandedMap || {};
    var isExpanded = !!expandedMap[bubble.key];
    var isCollapsed = bubble.collapsible && !isExpanded;

    var avatar = el(doc, 'div', { class: 'rt-avatar', 'aria-hidden': 'true', text: bubble.identity.monogram });
    var metaLeft = el(doc, 'div', { class: 'rt-meta-left' }, [
      el(doc, 'strong', { class: 'rt-seat-name', text: 'Seat ' + (bubble.seatId || '—') }),
      el(doc, 'span', { class: 'rt-meta-dot', text: '·' }),
      el(doc, 'span', { class: 'rt-agent-label', text: bubble.identity.familyLabel }),
      bubble.identity.isLead ? el(doc, 'span', { class: 'rt-lead-crown', text: '★ ' + tr(lang, 'chat.leadBadge') }) : null,
      bubble.role && !bubble.identity.isLead ? el(doc, 'span', { class: 'rt-role-pill', text: tr(lang, 'role.' + bubble.role) }) : null,
      bubble.annotation && bubble.annotation !== 'none' ? el(doc, 'span', { class: 'rt-chip solid ' + statusTone(bubble.annotation), text: bubble.annotation }) : null,
    ]);
    var metaRight = el(doc, 'div', { class: 'rt-meta-right' }, [
      bubble.escaped ? el(doc, 'span', { class: 'rt-chip warn', text: 'escaped ×' + bubble.escaped }) : null,
      bubble.seq !== null ? el(doc, 'code', { class: 'rt-seq-pill', text: '#' + bubble.seq }) : null,
      bubble.ts ? el(doc, 'time', { class: 'rt-time', text: fmtTime(bubble.ts) }) : null,
    ]);

    var bodyInner = el(doc, 'div', { class: 'rt-bubble-body' + (isCollapsed ? ' is-collapsed' : '') });
    bodyInner.appendChild(renderSegments(doc, bubble.segments, {
      lang: lang,
      seatId: bubble.seatId || '',
      taskConfirmed: !!chatModel.taskConfirmed,
      hasOfficialVerdict: !!(bubble.verdicts && bubble.verdicts.length),
      disclosureStatusByKey: chatModel.disclosureStatusByKey,
      pointStatusByKey: chatModel.pointStatusByKey,
      knownSeqSeatIds: chatModel.knownSeqSeatIds,
      renderedSeqs: chatModel.renderedSeqs,
      quotes: bubble.quotes,
      onJumpToSeq: opts.onJumpToSeq,
    }));
    if (bubble.truncated) {
      bodyInner.appendChild(el(doc, 'div', { class: 'rt-trunc-note', text: tr(lang, 'chat.truncated') }));
    }

    var bubbleBoxChildren = [
      el(doc, 'div', { class: 'rt-meta' }, [metaLeft, metaRight]),
      bodyInner,
    ];
    if (bubble.collapsible) {
      bubbleBoxChildren.push(el(doc, 'button', {
        type: 'button',
        class: 'rt-collapse-btn',
        onclick: function () {
          expandedMap[bubble.key] = !expandedMap[bubble.key];
          if (typeof opts.onRerender === 'function') opts.onRerender();
        },
        text: tr(lang, isCollapsed ? 'chat.expand' : 'chat.collapse'),
      }));
    }
    var authFoot = renderAuthoritativeFoot(doc, bubble, lang);
    if (authFoot) bubbleBoxChildren.push(authFoot);

    var rowAttrs = {
      class: 'rt-row' + (bubble.identity.isLead ? ' is-lead' : '') + (opts.highlightedSeq !== null && opts.highlightedSeq === bubble.seq ? ' is-highlighted' : ''),
      'data-family': bubble.identity.family,
      'data-seat': bubble.seatId || '',
    };
    if (bubble.seq !== null) rowAttrs['data-seq'] = String(bubble.seq);

    return el(doc, 'div', rowAttrs, [
      avatar,
      el(doc, 'div', { class: 'rt-col' }, [
        el(doc, 'div', { class: 'rt-bubble' }, bubbleBoxChildren),
      ]),
    ]);
  }

  function renderSummaryCard(doc, summary, chatModel, opts) {
    var lang = opts.lang || 'en';
    var children = [
      el(doc, 'div', { class: 'rt-summary-head' }, [
        el(doc, 'span', { class: 'rt-chip solid info', text: tr(lang, 'chat.summaryTitle', { version: summary.version !== undefined ? summary.version : '?' }) }),
        summary.seatId ? el(doc, 'strong', { class: 'rt-seat-name', text: 'Lead ' + summary.seatId }) : null,
        summary.supersedes !== null && summary.supersedes !== undefined ? el(doc, 'span', { class: 'rt-chip warn', text: 'supersedes v' + summary.supersedes }) : null,
        summary.mergedMarkCount > 0 ? el(doc, 'span', { class: 'rt-chip ok', text: tr(lang, 'chat.summaryMerged', { n: summary.mergedMarkCount }) }) : null,
        summary.unanswered.length ? el(doc, 'span', { class: 'rt-chip bad', text: statusLabel(lang, 'unanswered') + ': ' + summary.unanswered.join(', ') }) : null,
        el(doc, 'span', { class: 'rt-spacer' }),
        summary.seq !== null ? el(doc, 'code', { class: 'rt-seq-pill', text: '#' + summary.seq }) : null,
        summary.ts ? el(doc, 'time', { class: 'rt-time', text: fmtTime(summary.ts) }) : null,
      ]),
    ];
    if (summary.segments && summary.segments.length) {
      var body = el(doc, 'div', { class: 'rt-summary-body' });
      body.appendChild(renderSegments(doc, summary.segments, {
        lang: lang,
        knownSeqSeatIds: chatModel.knownSeqSeatIds,
        renderedSeqs: chatModel.renderedSeqs,
        onJumpToSeq: opts.onJumpToSeq,
      }));
      if (summary.truncated) body.appendChild(el(doc, 'div', { class: 'rt-trunc-note', text: tr(lang, 'chat.truncated') }));
      children.push(body);
    }
    if (summary.verdicts && summary.verdicts.length) {
      children.push(el(doc, 'div', { class: 'rt-auth-foot' }, summary.verdicts.map(function (v) {
        return renderVerdictRow(doc, v, lang, true);
      })));
    }
    if (summary.verified && summary.verified.length) {
      children.push(el(doc, 'div', { class: 'rt-auth-foot' }, summary.verified.map(function (vf) {
        return el(doc, 'div', { class: 'rt-auth-row' }, [
          el(doc, 'span', { class: 'rt-chip solid ' + (vf.verified ? 'ok' : 'warn'), text: tr(lang, vf.verified ? 'chat.verified' : 'chat.unverified') }),
          el(doc, 'code', { class: 'rt-sha', text: shortSha(vf.artifactSha) }),
          vf.producer ? el(doc, 'span', { class: 'rt-auth-meta', text: 'Seat ' + vf.producer }) : null,
          vf.by ? el(doc, 'span', { class: 'rt-auth-text', text: 'reviewed by ' + vf.by }) : null,
          !vf.verified && vf.reason ? el(doc, 'span', { class: 'rt-chip warn', text: vf.reason }) : null,
        ]);
      })));
    }
    var attrs = { class: 'rt-summary-card' };
    if (summary.seq !== null) attrs['data-seq'] = String(summary.seq);
    return el(doc, 'div', attrs, children);
  }

  function renderGroupChat(doc, container, chatModel, opts) {
    opts = opts || {};
    var lang = opts.lang || 'en';
    var seatFilter = opts.seatFilter || '';
    var showMarkers = !!opts.showMarkers;
    clearNode(container);

    var filterBar = el(doc, 'div', { class: 'rt-chat-toolbar' }, [
      el(doc, 'button', {
        type: 'button',
        class: 'rt-filter-chip' + (!seatFilter ? ' is-active' : ''),
        onclick: function () { if (opts.onSetSeatFilter) opts.onSetSeatFilter(''); },
        text: tr(lang, 'chat.seatFilterAll'),
      }),
    ].concat((chatModel.seats || []).map(function (s) {
      return el(doc, 'button', {
        type: 'button',
        class: 'rt-filter-chip' + (seatFilter === s.seatId ? ' is-active' : ''),
        'data-family': s.identity.family,
        onclick: function () { if (opts.onSetSeatFilter) opts.onSetSeatFilter(seatFilter === s.seatId ? '' : s.seatId); },
        text: s.seatId + (s.identity.isLead ? ' ★' : ''),
      });
    })).concat([
      el(doc, 'label', { class: 'rt-marker-toggle' }, [
        el(doc, 'input', {
          type: 'checkbox',
          checked: showMarkers ? true : false,
          onchange: function (ev) { if (opts.onToggleMarkers) opts.onToggleMarkers(!!ev.target.checked); },
        }),
        tr(lang, 'chat.showMarkers'),
      ]),
    ]));
    container.appendChild(filterBar);

    var stage = el(doc, 'div', { class: 'rt-stage' });
    var streamWrap = el(doc, 'div', { class: 'rt-stream' });

    if (chatModel.pendingTask && !opts.hideRoundTopic) {
      streamWrap.appendChild(el(doc, 'div', { class: 'rt-round-topic' }, [
        el(doc, 'strong', { text: tr(lang, 'chat.pendingTopic') }),
        chatModel.pendingTask,
      ]));
    }

    var renderedAny = false;
    (chatModel.rounds || []).forEach(function (rg) {
      var group = el(doc, 'div', { class: 'rt-round-group', 'data-round': String(rg.roundId) });
      var sepChildren = [
        el(doc, 'div', { class: 'rt-round-line' }, [
          el(doc, 'span', { class: 'rt-round-badge' }, [
            tr(lang, 'chat.roundTitle', { round: rg.roundId }),
            rg.startTime ? el(doc, 'time', { text: fmtTime(rg.startTime) }) : null,
          ]),
        ]),
      ];
      if (rg.task && !opts.hideRoundTopic) {
        sepChildren.push(el(doc, 'div', { class: 'rt-round-topic' }, [
          el(doc, 'strong', { text: tr(lang, 'chat.topicLabel') }),
          rg.task,
        ]));
      }
      group.appendChild(el(doc, 'div', { class: 'rt-round-sep' }, sepChildren));

      rg.timeline.forEach(function (entry) {
        if (entry.kind === 'bubble') {
          if (seatFilter && entry.seatId !== seatFilter) return;
          renderedAny = true;
          group.appendChild(renderBubble(doc, entry, chatModel, opts));
        } else if (entry.kind === 'user') {
          renderedAny = true;
          group.appendChild(el(doc, 'div', { class: 'rt-user-bubble' }, [
            el(doc, 'div', { class: 'rt-meta' }, [
              el(doc, 'div', { class: 'rt-meta-left' }, [
                el(doc, 'span', { class: 'rt-chip solid user', text: tr(lang, 'chat.userMsg') }),
              ]),
              el(doc, 'div', { class: 'rt-meta-right' }, [
                entry.msgSeq !== null && entry.msgSeq !== undefined ? el(doc, 'code', { class: 'rt-seq-pill', text: '#' + entry.msgSeq }) : null,
                entry.ts ? el(doc, 'time', { class: 'rt-time', text: fmtTime(entry.ts) }) : null,
              ]),
            ]),
            renderMdOrPre(doc, entry.text),
          ]));
        } else if (entry.kind === 'marker' && showMarkers) {
          renderedAny = true;
          group.appendChild(el(doc, 'div', { class: 'rt-sys-marker ' + (entry.tone || 'info') }, [
            el(doc, 'code', { text: '#' + entry.seq }),
            ' ',
            entry.text,
            entry.ts ? el(doc, 'time', { text: fmtTime(entry.ts) }) : null,
          ]));
        }
      });

      if (rg.unattachedItems && rg.unattachedItems.length) {
        group.appendChild(el(doc, 'div', { class: 'rt-unattached-card' }, [
          el(doc, 'div', { class: 'rt-claim-head', text: tr(lang, 'chat.unattachedItems') }),
        ].concat(rg.unattachedItems.map(function (it) {
          return el(doc, 'div', { class: 'rt-auth-row' }, [
            el(doc, 'span', { class: 'rt-chip solid ' + statusTone(it.status), text: it.itemId + ' · ' + statusLabel(lang, it.status) }),
            el(doc, 'span', { class: 'rt-auth-text', text: it.text || '' }),
          ]);
        }))));
      }

      if (rg.unattachedVerdicts && rg.unattachedVerdicts.length) {
        renderedAny = true;
        group.appendChild(el(doc, 'div', { class: 'rt-unattached-card' }, [
          el(doc, 'div', { class: 'rt-claim-head', text: tr(lang, 'chat.unattachedVerdicts') }),
        ].concat(rg.unattachedVerdicts.map(function (v) {
          return renderVerdictRow(doc, v, lang, true);
        }))));
      }

      if (rg.summaryCard) {
        renderedAny = true;
        group.appendChild(renderSummaryCard(doc, rg.summaryCard, chatModel, opts));
      }

      streamWrap.appendChild(group);
    });

    if (!renderedAny) {
      streamWrap.appendChild(el(doc, 'div', { class: 'rt-empty', text: tr(lang, 'chat.empty') }));
    }

    stage.appendChild(streamWrap);
    container.appendChild(stage);
  }

  function renderArenaView(doc, container, chatModel, opts) {
    opts = opts || {};
    var lang = opts.lang || 'en';
    var arena = buildArenaModel(chatModel, opts.selectedRoundId);
    clearNode(container);

    var header = el(doc, 'div', { class: 'rt-arena-header' }, [
      el(doc, 'span', { class: 'rt-arena-round-label', text: tr(lang, 'arena.roundLabel') }),
      el(doc, 'div', { class: 'rt-arena-pills' }, arena.availableRounds.map(function (rId) {
        return el(doc, 'button', {
          type: 'button',
          class: 'rt-filter-chip' + (rId === arena.roundId ? ' is-active' : ''),
          onclick: function () { if (opts.onSelectRound) opts.onSelectRound(rId); },
          text: tr(lang, 'arena.latestRound', { round: rId }),
        });
      })),
    ]);
    container.appendChild(header);

    if (arena.task && !opts.hideRoundTopic) {
      container.appendChild(el(doc, 'div', { class: 'rt-arena-topic' }, [
        el(doc, 'strong', { text: tr(lang, 'arena.syncTask') }),
        arena.task,
      ]));
    }

    if (!arena.columns.length) {
      container.appendChild(el(doc, 'div', { class: 'rt-empty', text: tr(lang, 'arena.empty') }));
      return;
    }

    var grid = el(doc, 'div', { class: 'rt-arena-grid' });
    arena.columns.forEach(function (col) {
      var latestV = col.verdicts && col.verdicts.length ? col.verdicts[col.verdicts.length - 1] : null;
      var msgLabel = col.bubbles.length === 1
        ? tr(lang, 'arena.messagesCount', { n: 1 })
        : tr(lang, 'arena.messagesCountPlural', { n: col.bubbles.length });
      var colHead = el(doc, 'div', { class: 'rt-arena-col-head' }, [
        el(doc, 'div', { class: 'rt-avatar sm', 'aria-hidden': 'true', text: col.identity.monogram }),
        el(doc, 'div', { class: 'rt-arena-col-title' }, [
          el(doc, 'div', { class: 'rt-arena-seat-line' }, [
            el(doc, 'strong', { text: 'Seat ' + col.seatId }),
            col.identity.isLead ? el(doc, 'span', { class: 'rt-lead-crown', text: '★' }) : null,
          ]),
          el(doc, 'span', { class: 'rt-arena-agent', text: col.identity.familyLabel }),
        ]),
        latestV
          ? el(doc, 'span', { class: 'rt-chip solid ' + statusTone(latestV.verdict), text: latestV.verdict })
          : el(doc, 'span', { class: 'rt-arena-count', text: msgLabel }),
      ]);

      var colBody = el(doc, 'div', { class: 'rt-arena-col-body' });
      var lastSeq = null;
      if (!col.bubbles.length) {
        colBody.appendChild(el(doc, 'div', { class: 'rt-empty', text: tr(lang, 'arena.noSpeech') }));
      } else {
        col.bubbles.forEach(function (b) {
          if (b.seq !== null) lastSeq = b.seq;
          var msgCard = el(doc, 'div', { class: 'rt-arena-msg' }, [
            el(doc, 'div', { class: 'rt-arena-msg-meta' }, [
              b.seq !== null ? el(doc, 'code', { class: 'rt-seq-pill', text: '#' + b.seq }) : null,
              b.ts ? el(doc, 'time', { class: 'rt-time', text: fmtTime(b.ts) }) : null,
            ]),
          ]);
          msgCard.appendChild(renderSegments(doc, b.segments, {
            lang: lang,
            seatId: b.seatId || '',
            taskConfirmed: !!chatModel.taskConfirmed,
            hasOfficialVerdict: !!(b.verdicts && b.verdicts.length),
            disclosureStatusByKey: chatModel.disclosureStatusByKey,
            pointStatusByKey: chatModel.pointStatusByKey,
            knownSeqSeatIds: chatModel.knownSeqSeatIds,
            renderedSeqs: chatModel.renderedSeqs,
            quotes: b.quotes,
            onJumpToSeq: opts.onJumpToChat,
          }));
          var foot = renderAuthoritativeFoot(doc, b, lang);
          if (foot) msgCard.appendChild(foot);
          colBody.appendChild(msgCard);
        });
      }

      var colNodes = [colHead, colBody];
      if (lastSeq !== null && typeof opts.onJumpToChat === 'function') {
        colNodes.push(el(doc, 'div', { class: 'rt-arena-col-foot' }, [
          el(doc, 'button', {
            type: 'button',
            class: 'rt-jump-chat-btn',
            onclick: function () { opts.onJumpToChat(lastSeq); },
            text: tr(lang, 'arena.jumpChat'),
          }),
        ]));
      }

      grid.appendChild(el(doc, 'section', { class: 'rt-arena-col', 'data-family': col.identity.family }, colNodes));
    });
    container.appendChild(grid);
  }

  function renderApprovalInbox(doc, container, opts) {
    if (!container) return;
    var lang = opts.lang || 'en';
    var items = buildApprovalItems({ state: opts.state, derived: opts.derived });
    clearNode(container);
    if (!items.length) {
      if (container.classList && typeof container.classList.toggle === 'function') container.classList.toggle('hidden', true);
      return;
    }
    if (container.classList && typeof container.classList.toggle === 'function') container.classList.toggle('hidden', false);

    var hasToken = !!opts.hasToken;
    var head = el(doc, 'div', { class: 'rt-inbox-head' }, [
      el(doc, 'span', { class: 'rt-inbox-dot', 'aria-hidden': 'true' }),
      el(doc, 'strong', { text: tr(lang, 'inbox.title') }),
      el(doc, 'span', { class: 'rt-chip solid warn', text: tr(lang, 'inbox.count', { n: items.length }) }),
    ]);
    var list = el(doc, 'div', { class: 'rt-inbox-list' });

    items.forEach(function (it) {
      var btns = [];
      var label = '';
      var tag = '';
      if (it.kind === 'task-draft') {
        tag = 'Task';
        label = tr(lang, 'inbox.taskDraft', { seat: it.seatId });
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small primary', disabled: !hasToken,
          onclick: function () { opts.onAction('confirm-task', {}); },
          text: tr(lang, 'inbox.confirmTask'),
        }));
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small',
          onclick: function () { opts.onJumpTab('task'); },
          text: tr(lang, 'inbox.viewTask'),
        }));
      } else if (it.kind === 'awaiting') {
        tag = 'Timeout';
        label = tr(lang, 'inbox.awaiting', { seat: it.seatId, phase: it.phase });
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small primary', disabled: !hasToken,
          onclick: function () { opts.onAction('retry', { seatId: it.seatId }); },
          text: tr(lang, 'inbox.retry'),
        }));
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small', disabled: !hasToken,
          onclick: function () { opts.onAction('skip', {}); },
          text: tr(lang, 'inbox.skip'),
        }));
      } else if (it.kind === 'reconcile') {
        tag = 'Reconcile';
        label = tr(lang, 'inbox.reconcile', { attempt: it.attemptId, seat: it.seatId });
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small primary', disabled: !hasToken,
          onclick: function () { opts.onAction('reconcile', { attemptId: it.attemptId, action: 'replay' }); },
          text: tr(lang, 'inbox.replay'),
        }));
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small danger', disabled: !hasToken,
          onclick: function () { opts.onAction('reconcile', { attemptId: it.attemptId, action: 'void' }); },
          text: tr(lang, 'inbox.void'),
        }));
      } else if (it.kind === 'disclose') {
        tag = 'Disclose';
        label = tr(lang, 'inbox.disclose', { seat: it.seatId, argv: it.argv });
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small primary', disabled: !hasToken,
          onclick: function () { opts.onAction('approve-disclose', { id: it.id }); },
          text: tr(lang, 'inbox.approve'),
        }));
        btns.push(el(doc, 'button', {
          type: 'button', class: 'btn-small danger', disabled: !hasToken,
          onclick: function () {
            var why = typeof window !== 'undefined' ? window.prompt(tr(lang, 'inbox.denyPrompt')) : '';
            if (why !== null) opts.onAction('deny-disclose', { id: it.id, reason: why });
          },
          text: tr(lang, 'inbox.deny'),
        }));
      }
      list.appendChild(el(doc, 'div', { class: 'rt-inbox-row', 'data-inbox-kind': it.kind }, [
        el(doc, 'div', { class: 'rt-inbox-left' }, [
          el(doc, 'span', { class: 'rt-inbox-tag', text: tag }),
          el(doc, 'span', { class: 'rt-inbox-text', text: label }),
        ]),
        el(doc, 'div', { class: 'rt-inbox-actions' }, btns),
      ]));
    });

    container.appendChild(head);
    container.appendChild(list);
  }

  var RoomChat = {
    LONG_SPEECH_CHAR_THRESHOLD: LONG_SPEECH_CHAR_THRESHOLD,
    LONG_SPEECH_LINE_THRESHOLD: LONG_SPEECH_LINE_THRESHOLD,
    resolveSeatIdentity: resolveSeatIdentity,
    isSpeechCollapsible: isSpeechCollapsible,
    buildChatModel: buildChatModel,
    buildArenaModel: buildArenaModel,
    buildApprovalItems: buildApprovalItems,
    handleComposerKeyDown: handleComposerKeyDown,
    renderSegments: renderSegments,
    renderGroupChat: renderGroupChat,
    renderArenaView: renderArenaView,
    renderApprovalInbox: renderApprovalInbox,
  };

  if (typeof globalThis !== 'undefined') globalThis.RoomChat = RoomChat;
})();
