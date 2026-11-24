/* ui/rt-protocol.js - zero-dependency display-oriented protocol-marker parser for Roundtable.
 * Classic ES2020 IIFE exposing globalThis.RoomProtocol (DOM-free, safe in Node vm).
 *
 * Security & complexity guarantees:
 * - Clamps input to MAX_SPEECH_RENDER_CHARS (60,000 UTF-16 units) without splitting surrogate pairs.
 * - Isolates 5 protected span classes: delimited packet blocks ([ROOM:<tok>:...] and escaped
 *   [ROOM\:<tok>:...]), CommonMark fenced code blocks, nested HTML <blockquote> regions, Markdown
 *   blockquote lines (including list-nested), and inline backtick spans (including multi-line
 *   spans within a paragraph).
 * - Prototype-pollution immune attribute map (Object.create(null) + hasOwnProperty checks).
 * - Linear-time scanning + binary search interval queries + 128-entry LRU cache with deep clones.
 */
(function () {
  'use strict';

  var MAX_SPEECH_RENDER_CHARS = 60000;
  var PARSE_CACHE_MAX = 128;
  var MD_BLOCKQUOTE_RE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*>/;

  function clampSpeechText(rawText) {
    var s = typeof rawText === 'string' ? rawText : String(rawText || '');
    if (s.length <= MAX_SPEECH_RENDER_CHARS) return { text: s, truncated: false };
    var cut = MAX_SPEECH_RENDER_CHARS;
    var code = s.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return { text: s.slice(0, cut), truncated: true };
  }

  function mergeSpans(rawSpans) {
    if (rawSpans.length <= 1) return rawSpans;
    rawSpans.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    var merged = [{ start: rawSpans[0].start, end: rawSpans[0].end }];
    for (var i = 1; i < rawSpans.length; i += 1) {
      var cur = rawSpans[i];
      var last = merged[merged.length - 1];
      if (cur.start <= last.end) {
        if (cur.end > last.end) last.end = cur.end;
      } else {
        merged.push({ start: cur.start, end: cur.end });
      }
    }
    return merged;
  }

  var tailReCache = new Map();
  function getTailRegex(token) {
    var cached = tailReCache.get(token);
    if (!cached) {
      if (tailReCache.size >= 64) tailReCache.clear();
      cached = new RegExp('\\[/ROOM\\\\?:' + token + '\\]', 'g');
      tailReCache.set(token, cached);
    }
    return cached;
  }

  function findDelimitedSpans(text) {
    var spans = [];
    var length = text.length;
    var prefixRe = /\[ROOM\\?:([A-Za-z0-9_-]+):/g;
    var pos = 0;
    var cachedCloseBracket = -2;
    var cachedNextNl = -2;
    var match;

    while ((match = prefixRe.exec(text)) !== null) {
      if (match.index < pos) continue;
      var afterPrefix = match.index + match[0].length;
      if (cachedCloseBracket !== -1 && cachedCloseBracket < afterPrefix) {
        cachedCloseBracket = text.indexOf(']', afterPrefix);
      }
      if (cachedCloseBracket === -1) break;
      if (cachedNextNl !== -1 && cachedNextNl < afterPrefix) {
        cachedNextNl = text.indexOf('\n', afterPrefix);
      }
      if (cachedNextNl !== -1 && cachedCloseBracket > cachedNextNl) {
        prefixRe.lastIndex = cachedNextNl + 1;
        continue;
      }
      var token = match[1];
      var tailRe = getTailRegex(token);
      var scanStart = cachedCloseBracket + 1;
      tailRe.lastIndex = scanStart;
      var tailMatch = tailRe.exec(text);
      if (!tailMatch) {
        spans.push({ start: match.index, end: length });
        break;
      }
      var closeEnd = tailMatch.index + tailMatch[0].length;
      spans.push({ start: match.index, end: closeEnd });
      pos = closeEnd;
      prefixRe.lastIndex = closeEnd;
    }
    return spans;
  }

  function countHtmlBlockquotesLinear(tagText) {
    if (!/blockquote/i.test(tagText)) return { opens: 0, closes: 0 };
    var opens = 0;
    var closes = 0;
    var cachedGt = -2;
    var tagRe = /<(\/?)blockquote\b/gi;
    var m;
    while ((m = tagRe.exec(tagText)) !== null) {
      var afterName = m.index + m[0].length;
      if (cachedGt !== -1 && cachedGt < afterName) {
        cachedGt = tagText.indexOf('>', afterName);
      }
      if (cachedGt === -1) break;
      var isClose = m[1] === '/';
      if (isClose) {
        if (tagText.slice(afterName, cachedGt).trim().length === 0) closes += 1;
      } else {
        opens += 1;
      }
      tagRe.lastIndex = cachedGt + 1;
    }
    return { opens: opens, closes: closes };
  }

  function findProtectedSpans(text) {
    var delimSpans = findDelimitedSpans(text);
    var spans = delimSpans.map(function (s) { return { start: s.start, end: s.end }; });
    var length = text.length;

    var scanText = text;
    if (delimSpans.length > 0) {
      var built = '';
      var cursor = 0;
      for (var d = 0; d < delimSpans.length; d += 1) {
        var ds = delimSpans[d];
        built += text.slice(cursor, ds.start);
        built += text.slice(ds.start, ds.end).replace(/[^\n]/g, ' ');
        cursor = ds.end;
      }
      built += text.slice(cursor);
      scanText = built;
    }

    var tickRuns = [];
    var paraId = 0;
    var fence = null;
    var htmlDepth = 0;
    var htmlStart = -1;
    var lineStart = 0;

    while (lineStart < length) {
      var nl = scanText.indexOf('\n', lineStart);
      var lineEnd = nl === -1 ? length : nl;
      var rawLine = scanText.slice(lineStart, lineEnd);
      var line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      var fm = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence !== null) {
        if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && fm[2].trim() === '') {
          spans.push({ start: fence.start, end: lineEnd });
          fence = null;
        }
        lineStart = nl === -1 ? length : nl + 1;
        continue;
      }

      var tagText = line.indexOf('`') !== -1 ? line.replace(/`[^`\n]*`/g, '') : line;
      var bq = countHtmlBlockquotesLinear(tagText);
      if (htmlDepth > 0 || bq.opens > 0) {
        if (htmlStart === -1) htmlStart = lineStart;
        htmlDepth = Math.max(0, htmlDepth + bq.opens - bq.closes);
        if (htmlDepth === 0) {
          spans.push({ start: htmlStart, end: lineEnd });
          htmlStart = -1;
        }
        lineStart = nl === -1 ? length : nl + 1;
        continue;
      }

      if (fm && (fm[1][0] !== '`' || fm[2].indexOf('`') === -1)) {
        fence = { ch: fm[1][0], len: fm[1].length, start: lineStart };
        paraId += 1;
        lineStart = nl === -1 ? length : nl + 1;
        continue;
      }

      if (MD_BLOCKQUOTE_RE.test(line)) {
        spans.push({ start: lineStart, end: lineEnd });
        paraId += 1;
        lineStart = nl === -1 ? length : nl + 1;
        continue;
      }

      if (line.trim().length === 0) {
        paraId += 1;
        lineStart = nl === -1 ? length : nl + 1;
        continue;
      }

      var p = lineStart;
      while (p < lineEnd) {
        if (scanText[p] === '`') {
          var tickEnd = p + 1;
          while (tickEnd < lineEnd && scanText[tickEnd] === '`') tickEnd += 1;
          tickRuns.push({ start: p, end: tickEnd, paraId: paraId, len: tickEnd - p });
          p = tickEnd;
        } else {
          p += 1;
        }
      }

      lineStart = nl === -1 ? length : nl + 1;
    }

    if (fence !== null) spans.push({ start: fence.start, end: length });
    if (htmlStart !== -1) spans.push({ start: htmlStart, end: length });

    if (tickRuns.length >= 2) {
      var buckets = new Map();
      for (var idx = 0; idx < tickRuns.length; idx += 1) {
        var run = tickRuns[idx];
        var key = run.paraId + ':' + run.len;
        var list = buckets.get(key);
        if (list) list.push(idx);
        else buckets.set(key, [idx]);
      }
      var bucketCursor = new Map();
      var r = 0;
      while (r < tickRuns.length) {
        var openRun = tickRuns[r];
        var oKey = openRun.paraId + ':' + openRun.len;
        var oList = buckets.get(oKey);
        var ptr = bucketCursor.has(oKey) ? bucketCursor.get(oKey) : 0;
        while (ptr < oList.length && oList[ptr] <= r) ptr += 1;
        bucketCursor.set(oKey, ptr);
        if (ptr < oList.length) {
          var closeIdx = oList[ptr];
          var closeRun = tickRuns[closeIdx];
          spans.push({ start: openRun.start, end: closeRun.end });
          bucketCursor.set(oKey, ptr + 1);
          r = closeIdx + 1;
        } else {
          r += 1;
        }
      }
    }

    return mergeSpans(spans);
  }

  function insideProtectedSpan(pos, spans) {
    var lo = 0;
    var hi = spans.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      var span = spans[mid];
      if (pos < span.start) hi = mid - 1;
      else if (pos >= span.end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  function overlapsProtectedSpan(start, end, spans) {
    var lo = 0;
    var hi = spans.length - 1;
    var firstAfterStart = spans.length;
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (spans[mid].end > start) {
        firstAfterStart = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return firstAfterStart < spans.length && spans[firstAfterStart].start < end;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function parseMarkerAttrs(raw) {
    var positional = [];
    // Null-prototype map: immune to __proto__ / constructor / toString keys.
    var kv = Object.create(null);
    var i = 0;
    var n = raw.length;

    while (i < n) {
      while (i < n && /\s/.test(raw[i])) i += 1;
      if (i >= n) break;

      var keyStart = i;
      while (i < n && /[A-Za-z0-9_-]/.test(raw[i])) i += 1;
      var key = raw.slice(keyStart, i);

      if (i < n && raw[i] === '=') {
        if (!key || hasOwn(kv, key)) return null;
        i += 1;
        if (i >= n) return null;

        if (raw[i] === '"') {
          i += 1;
          var out = '';
          var closed = false;
          while (i < n) {
            var c = raw[i];
            if (c === '\\') {
              if (i + 1 >= n) return null;
              var next = raw[i + 1];
              out += next === '"' || next === '\\' ? next : ('\\' + next);
              i += 2;
              continue;
            }
            if (c === '"') {
              closed = true;
              i += 1;
              break;
            }
            out += c;
            i += 1;
          }
          if (!closed) return null;
          kv[key] = out;
          continue;
        }

        if (raw[i] === '[') {
          var depth = 0;
          var inStr = false;
          var esc = false;
          var arrStart = i;
          while (i < n) {
            var ch = raw[i];
            if (inStr) {
              if (esc) esc = false;
              else if (ch === '\\') esc = true;
              else if (ch === '"') inStr = false;
            } else {
              if (ch === '"') inStr = true;
              else if (ch === '[') depth += 1;
              else if (ch === ']') {
                depth -= 1;
                if (depth === 0) {
                  i += 1;
                  break;
                }
              }
            }
            i += 1;
          }
          if (depth !== 0) return null;
          try {
            var parsed = JSON.parse(raw.slice(arrStart, i));
            if (!Array.isArray(parsed)) return null;
            kv[key] = parsed;
          } catch (e) {
            return null;
          }
          continue;
        }

        var valStart = i;
        while (i < n && !/\s/.test(raw[i])) i += 1;
        var val = raw.slice(valStart, i);
        if (!val) return null;
        kv[key] = val;
        continue;
      }

      i = keyStart;
      while (i < n && !/\s/.test(raw[i])) i += 1;
      var word = raw.slice(keyStart, i);
      if (!word || word.indexOf('=') !== -1) return null;
      positional.push(word);
    }

    return { _: positional, kv: kv };
  }

  function parseNonNegativeInt(value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    var num = Number(value);
    return Number.isSafeInteger(num) ? num : null;
  }

  function parseItemTargetSeq(itemId, explicitSeq) {
    if (typeof explicitSeq === 'number' && Number.isInteger(explicitSeq) && explicitSeq >= 0) return explicitSeq;
    if (!itemId) return null;
    var trimmed = String(itemId).trim();
    var mMatch = /^m(\d+)(?:p\d+)?$/.exec(trimmed);
    if (mMatch) return Number(mMatch[1]);
    var pMatch = /^p(\d+)(?:\.\d+)?$/.exec(trimmed);
    if (pMatch) return Number(pMatch[1]);
    return null;
  }

  function looksTranslatedMarker(content) {
    var c = content.trim();
    if (/^room\s*[:：]/i.test(c) && !/^ROOM:/.test(c)) return true;
    if (/^[^\x00-\x7f]+\s*[:：]/.test(c)) return true;
    if (/^ROOM\s*：/.test(c)) return true;
    return false;
  }

  function scanCandidates(text, protectedSpans) {
    var candidates = [];
    var candidateRe = /<<([^<>\n]*)>>|<<\s*(?:room|房间)\s*[:：][^\s<>\n]*/gi;
    var match;

    while ((match = candidateRe.exec(text)) !== null) {
      var start = match.index;
      var raw = match[0];
      var end = start + raw.length;
      if (overlapsProtectedSpan(start, end, protectedSpans)) continue;
      var content = match[1];
      if (content !== undefined) {
        if (content.indexOf('ROOM:') === 0) {
          candidates.push({ start: start, end: end, raw: raw, inner: content });
        } else if (looksTranslatedMarker(content)) {
          candidates.push({ start: start, end: end, raw: raw, inner: null });
        }
      } else {
        candidates.push({ start: start, end: end, raw: raw, inner: null });
      }
    }
    return candidates;
  }

  function trimBlockBody(rawBody) {
    return rawBody.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  }

  function parseAssignBlock(rawBody) {
    var items = [];
    var extraLines = [];
    var lines = rawBody.split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;
      var bulletMatch = /^(?:[-*+]|\d+[.)])\s*([A-Za-z0-9_.-]+)\s*[:：]\s*(.+)$/.exec(trimmed);
      if (bulletMatch) items.push({ seatId: bulletMatch[1], task: bulletMatch[2].trim() });
      else extraLines.push(trimmed);
    }
    return { items: items, extraText: extraLines.join('\n') };
  }

  function readTrailingBody(text, candidates, currentIndex, protectedSpans, lastNonWsIndex) {
    var current = candidates[currentIndex];
    var next = candidates[currentIndex + 1];
    if (next && next.inner === 'ROOM:END') {
      return {
        body: text.slice(current.end, next.start).trim(),
        consumedEnd: next.end,
        nextCandidateIndex: currentIndex + 2,
        explicitBound: true,
        splitWithFollowingBeforeNext: false,
      };
    }

    var sliceEnd = next ? next.start : text.length;
    var rawBetween = text.slice(current.end, sliceEnd);
    var paraRe = /\r?\n[ \t]*\r?\n/g;
    var match;
    while ((match = paraRe.exec(rawBetween)) !== null) {
      var absPos = current.end + match.index;
      if (insideProtectedSpan(absPos, protectedSpans) || insideProtectedSpan(absPos + match[0].length - 1, protectedSpans)) {
        continue;
      }
      var afterBlankRel = match.index + match[0].length;
      var hasFollowingBeforeNext = rawBetween.slice(afterBlankRel).trim().length > 0;
      var hasFollowingContent = absPos + match[0].length <= lastNonWsIndex;
      return {
        body: rawBetween.slice(0, match.index).trim(),
        consumedEnd: absPos,
        nextCandidateIndex: currentIndex + 1,
        explicitBound: hasFollowingContent || Boolean(next),
        splitWithFollowingBeforeNext: hasFollowingBeforeNext,
      };
    }

    return {
      body: rawBetween.trim(),
      consumedEnd: sliceEnd,
      nextCandidateIndex: currentIndex + 1,
      explicitBound: Boolean(next),
      splitWithFollowingBeforeNext: false,
    };
  }

  function cloneSegments(segments) {
    return segments.map(function (seg) {
      if (seg.type === 'assign') {
        return {
          type: 'assign',
          items: seg.items.map(function (it) { return { seatId: it.seatId, task: it.task }; }),
          extraText: seg.extraText,
        };
      }
      if (seg.type === 'disclose') {
        return { type: 'disclose', argv: seg.argv.slice(), reason: seg.reason };
      }
      return Object.assign({}, seg);
    });
  }

  var parseCache = new Map();

  function parseRoundtableSpeechInternal(rawText) {
    if (!rawText) return { segments: [], blankSplitMarkIndices: [], rawMarkSlices: [] };
    var protectedSpans = findProtectedSpans(rawText);
    var candidates = scanCandidates(rawText, protectedSpans);
    if (candidates.length === 0) {
      return {
        segments: rawText.trim() ? [{ type: 'markdown', text: rawText.trim() }] : [],
        blankSplitMarkIndices: [],
        rawMarkSlices: [],
      };
    }

    var lastNonWsIndex = rawText.length - 1;
    while (lastNonWsIndex >= 0 && /\s/.test(rawText[lastNonWsIndex])) lastNonWsIndex -= 1;

    var segments = [];
    var blankSplitMarkIndices = [];
    var rawMarkSlices = [];

    function pushMarkdown(chunk) {
      var cleaned = chunk.replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, '');
      if (!cleaned.trim()) return;
      var prev = segments[segments.length - 1];
      if (prev && prev.type === 'markdown') prev.text = prev.text + '\n\n' + cleaned.trim();
      else segments.push({ type: 'markdown', text: cleaned.trim() });
    }

    var cursor = 0;
    var i = 0;
    var endSearchCursor = 0;
    function nextMatchingEnd(openIndex) {
      if (endSearchCursor <= openIndex) endSearchCursor = openIndex + 1;
      while (endSearchCursor < candidates.length) {
        if (candidates[endSearchCursor].inner === 'ROOM:END') return endSearchCursor;
        endSearchCursor += 1;
      }
      return -1;
    }

    while (i < candidates.length) {
      var cand = candidates[i];
      if (cand.start < cursor) { i += 1; continue; }
      if (cand.start > cursor) pushMarkdown(rawText.slice(cursor, cand.start));

      if (cand.inner === null || cand.inner.indexOf('ROOM:') !== 0) {
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      var km = /^ROOM:([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(cand.inner);
      if (!km || km[1] !== km[1].toUpperCase()) {
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      var kind = km[1];
      var attrStr = km[2] || '';
      var attrs = parseMarkerAttrs(attrStr);
      if (!attrs) {
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'QUOTE') {
        var qSeq = parseNonNegativeInt(hasOwn(attrs.kv, 'seq') ? attrs.kv.seq : undefined);
        var qEndIdx = nextMatchingEnd(i);
        if (qEndIdx !== -1) {
          var qEndCand = candidates[qEndIdx];
          var qBody = trimBlockBody(rawText.slice(cand.end, qEndCand.start));
          if (qSeq !== null && qBody.trim().length > 0) {
            segments.push({ type: 'quote', seq: qSeq, text: qBody.trim() });
          } else if (qBody.trim().length > 0) {
            var qRawTail = rawText.slice(cand.end, qEndCand.start).replace(/^\r?\n/, '').trimEnd();
            segments.push({ type: 'raw-marker', raw: cand.raw, trailingText: qRawTail, closingRaw: qEndCand.raw });
          } else {
            segments.push({ type: 'raw-marker', raw: rawText.slice(cand.start, qEndCand.end) });
          }
          cursor = qEndCand.end;
          i = qEndIdx + 1;
          continue;
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'ASSIGN') {
        var aEndIdx = nextMatchingEnd(i);
        if (aEndIdx !== -1) {
          var aEndCand = candidates[aEndIdx];
          var aBody = trimBlockBody(rawText.slice(cand.end, aEndCand.start));
          if (aBody.trim().length > 0) {
            var parsedAssign = parseAssignBlock(aBody);
            segments.push({ type: 'assign', items: parsedAssign.items, extraText: parsedAssign.extraText });
          } else {
            segments.push({ type: 'raw-marker', raw: rawText.slice(cand.start, aEndCand.end) });
          }
          cursor = aEndCand.end;
          i = aEndIdx + 1;
          continue;
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'PASS') {
        segments.push({ type: 'pass' });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'MARK') {
        var itemId = hasOwn(attrs.kv, 'item') && typeof attrs.kv.item === 'string' ? attrs.kv.item.trim() : '';
        var status = hasOwn(attrs.kv, 'status') && typeof attrs.kv.status === 'string' ? attrs.kv.status : '';
        var attrText = hasOwn(attrs.kv, 'text') && typeof attrs.kv.text === 'string' ? attrs.kv.text.trim() : '';
        if (itemId && (status === 'accepted' || status === 'rejected' || status === 'deferred')) {
          if (attrText) {
            var mNext = candidates[i + 1];
            var mConsumeEnd = Boolean(mNext && mNext.inner === 'ROOM:END' && !rawText.slice(cand.end, mNext.start).trim());
            var mConsumedEnd = mConsumeEnd ? mNext.end : cand.end;
            var mSegIdx = segments.length;
            segments.push({
              type: 'mark',
              itemId: itemId,
              targetSeq: parseItemTargetSeq(itemId),
              status: status,
              reason: attrText,
              explicitBound: true,
            });
            rawMarkSlices.push([mSegIdx, { head: rawText.slice(cand.start, mConsumedEnd).trim(), tail: '' }]);
            cursor = mConsumedEnd;
            i = mConsumeEnd ? i + 2 : i + 1;
            continue;
          }
          var mTrailing = readTrailingBody(rawText, candidates, i, protectedSpans, lastNonWsIndex);
          var mSegIdx2 = segments.length;
          segments.push({
            type: 'mark',
            itemId: itemId,
            targetSeq: parseItemTargetSeq(itemId),
            status: status,
            reason: mTrailing.body,
            explicitBound: mTrailing.explicitBound,
          });
          var mNext2 = candidates[i + 1];
          var hasExplicitEnd = Boolean(mNext2 && mNext2.inner === 'ROOM:END' && mTrailing.consumedEnd === mNext2.end);
          if (hasExplicitEnd && !mTrailing.body) {
            rawMarkSlices.push([mSegIdx2, { head: rawText.slice(cand.start, mNext2.end).trim(), tail: '' }]);
          } else if (hasExplicitEnd) {
            var rawTail1 = rawText.slice(cand.end, mNext2.start).replace(/^\r?\n/, '').trimEnd();
            rawMarkSlices.push([mSegIdx2, { head: cand.raw, tail: rawTail1, foot: mNext2.raw }]);
          } else {
            var rawTail2 = rawText.slice(cand.end, mTrailing.consumedEnd).replace(/^\r?\n/, '').trimEnd();
            rawMarkSlices.push([mSegIdx2, { head: cand.raw, tail: rawTail2 }]);
          }
          if (mTrailing.splitWithFollowingBeforeNext) blankSplitMarkIndices.push(mSegIdx2);
          cursor = mTrailing.consumedEnd;
          i = mTrailing.nextCandidateIndex;
          continue;
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'POINT') {
        var pSeq = parseNonNegativeInt(hasOwn(attrs.kv, 'seq') ? attrs.kv.seq : undefined);
        if (pSeq !== null) {
          var pTrailing = readTrailingBody(rawText, candidates, i, protectedSpans, lastNonWsIndex);
          if (pTrailing.body) {
            segments.push({ type: 'point', seq: pSeq, text: pTrailing.body });
            cursor = pTrailing.consumedEnd;
            i = pTrailing.nextCandidateIndex;
            continue;
          }
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'VERDICT') {
        var rawVerdict = hasOwn(attrs.kv, 'verdict') && typeof attrs.kv.verdict === 'string'
          ? attrs.kv.verdict
          : (attrs._[0] || '');
        var artifact = hasOwn(attrs.kv, 'artifact') && typeof attrs.kv.artifact === 'string' && attrs.kv.artifact.trim()
          ? attrs.kv.artifact
          : null;
        if (rawVerdict === 'pass' || rawVerdict === 'reject' || rawVerdict === 'disclose') {
          var vTrailing = readTrailingBody(rawText, candidates, i, protectedSpans, lastNonWsIndex);
          segments.push({ type: 'verdict', verdict: rawVerdict, artifact: artifact, reason: vTrailing.body });
          cursor = vTrailing.consumedEnd;
          i = vTrailing.nextCandidateIndex;
          continue;
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'DISCLOSE') {
        var rawArgv = hasOwn(attrs.kv, 'argv') ? attrs.kv.argv : null;
        var argv = Array.isArray(rawArgv) && rawArgv.length > 0 && rawArgv.every(function (x) { return typeof x === 'string' && x.length > 0; })
          ? rawArgv
          : null;
        var attrReason = hasOwn(attrs.kv, 'reason') && typeof attrs.kv.reason === 'string' ? attrs.kv.reason.trim() : '';
        if (argv && argv.length > 0) {
          if (attrReason) {
            var dNext = candidates[i + 1];
            var dConsumeEnd = Boolean(dNext && dNext.inner === 'ROOM:END' && !rawText.slice(cand.end, dNext.start).trim());
            segments.push({ type: 'disclose', argv: argv, reason: attrReason });
            cursor = dConsumeEnd ? dNext.end : cand.end;
            i = dConsumeEnd ? i + 2 : i + 1;
            continue;
          }
          var dTrailing = readTrailingBody(rawText, candidates, i, protectedSpans, lastNonWsIndex);
          segments.push({ type: 'disclose', argv: argv, reason: dTrailing.body });
          cursor = dTrailing.consumedEnd;
          i = dTrailing.nextCandidateIndex;
          continue;
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      if (kind === 'MISQUOTED') {
        var msSeq = parseNonNegativeInt(hasOwn(attrs.kv, 'seq') ? attrs.kv.seq : undefined);
        if (msSeq !== null) {
          var msTrailing = readTrailingBody(rawText, candidates, i, protectedSpans, lastNonWsIndex);
          segments.push({ type: 'misquoted', seq: msSeq, reason: msTrailing.body });
          cursor = msTrailing.consumedEnd;
          i = msTrailing.nextCandidateIndex;
          continue;
        }
        segments.push({ type: 'raw-marker', raw: cand.raw });
        cursor = cand.end;
        i += 1;
        continue;
      }

      segments.push({ type: 'raw-marker', raw: cand.raw });
      cursor = cand.end;
      i += 1;
    }

    if (cursor < rawText.length) pushMarkdown(rawText.slice(cursor));
    return { segments: segments, blankSplitMarkIndices: blankSplitMarkIndices, rawMarkSlices: rawMarkSlices };
  }

  function getCachedParse(rawText) {
    if (!rawText) {
      return {
        result: { segments: [], blankSplitMarkIndices: [], rawMarkSlices: [] },
        truncated: false,
      };
    }
    var clamped = clampSpeechText(rawText);
    var hit = parseCache.get(clamped.text);
    if (hit !== undefined) {
      parseCache.delete(clamped.text);
      parseCache.set(clamped.text, hit);
      return { result: hit, truncated: clamped.truncated };
    }
    var computed = parseRoundtableSpeechInternal(clamped.text);
    if (parseCache.size >= PARSE_CACHE_MAX) {
      var oldestKey = parseCache.keys().next().value;
      if (oldestKey !== undefined) parseCache.delete(oldestKey);
    }
    parseCache.set(clamped.text, computed);
    return { result: computed, truncated: clamped.truncated };
  }

  function parseRoundtableSpeech(rawText) {
    return cloneSegments(getCachedParse(rawText).result.segments);
  }

  function parseRoundtableSpeechDetailed(rawText) {
    var cached = getCachedParse(rawText);
    var map = new Map();
    for (var i = 0; i < cached.result.rawMarkSlices.length; i += 1) {
      var pair = cached.result.rawMarkSlices[i];
      map.set(pair[0], Object.assign({}, pair[1]));
    }
    return {
      segments: cloneSegments(cached.result.segments),
      blankSplitMarkIndices: new Set(cached.result.blankSplitMarkIndices),
      rawMarkSlices: map,
      truncated: cached.truncated,
    };
  }

  var RoomProtocol = {
    MAX_SPEECH_RENDER_CHARS: MAX_SPEECH_RENDER_CHARS,
    clampSpeechText: clampSpeechText,
    findDelimitedSpans: findDelimitedSpans,
    findProtectedSpans: findProtectedSpans,
    insideProtectedSpan: insideProtectedSpan,
    overlapsProtectedSpan: overlapsProtectedSpan,
    parseItemTargetSeq: parseItemTargetSeq,
    parseRoundtableSpeech: parseRoundtableSpeech,
    parseRoundtableSpeechDetailed: parseRoundtableSpeechDetailed,
  };

  if (typeof globalThis !== 'undefined') globalThis.RoomProtocol = RoomProtocol;
})();
