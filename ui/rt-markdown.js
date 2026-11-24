/* ui/rt-markdown.js - zero-dependency safe Markdown parser & DOM renderer.
 * Classic ES2020 IIFE exposing globalThis.RoomMarkdown (pure AST functions work in Node vm).
 *
 * Security invariants:
 * - ZERO innerHTML usage anywhere; all text inserted strictly via document.createTextNode.
 * - ZERO raw HTML passthrough (<script>, <img onerror=...>, <iframe> render as inert plain text).
 * - ZERO auto-loading <img> elements: Markdown images ![alt](url) render as inert link/chip text
 *   (no external image fetches or tracking pixels).
 * - Strict URL scheme allowlist: http:, https:, mailto: only (rejects javascript:, data:, vbscript:,
 *   file:, control characters, and malformed URLs).
 */
(function () {
  'use strict';

  var SAFE_SCHEMES = { 'http:': 1, 'https:': 1, 'mailto:': 1 };
  var MAX_BLOCKQUOTE_DEPTH = 16;
  var MAX_MARKDOWN_CHARS = 60000;

  function clampMarkdown(source) {
    var s = typeof source === 'string' ? source : String(source || '');
    if (s.length <= MAX_MARKDOWN_CHARS) return s;
    var cut = MAX_MARKDOWN_CHARS;
    var code = s.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return s.slice(0, cut);
  }

  function sanitizeUrl(raw) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (!trimmed || trimmed.length > 2048) return null;
    // Reject ASCII control chars or embedded whitespace that can confuse parsers.
    if (/[\x00-\x1f\x7f\s]/.test(trimmed)) return null;
    var m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed);
    if (!m) return null;
    var scheme = m[1].toLowerCase() + ':';
    if (!SAFE_SCHEMES[scheme]) return null;
    if (scheme === 'http:' || scheme === 'https:') {
      try {
        var u = new URL(trimmed);
        if (!SAFE_SCHEMES[u.protocol]) return null;
        return u.href;
      } catch (e) {
        return null;
      }
    }
    return trimmed;
  }

  // ---- Inline tokenizer (linear scan, no catastrophic backtracking) ----
  function parseInline(text) {
    var s = typeof text === 'string' ? text : String(text || '');
    var tokens = [];
    var n = s.length;
    var i = 0;

    function pushText(str) {
      if (!str) return;
      var prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') prev.text += str;
      else tokens.push({ type: 'text', text: str });
    }

    while (i < n) {
      var ch = s[i];

      // Hard line break inside paragraph
      if (ch === '\n') {
        tokens.push({ type: 'br' });
        i += 1;
        continue;
      }

      // Backslash escape for Markdown punctuation
      if (ch === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!~|>]/.test(s[i + 1])) {
        pushText(s[i + 1]);
        i += 2;
        continue;
      }

      // Inline code span (`...` or ``...``)
      if (ch === '`') {
        var tickEnd = i + 1;
        while (tickEnd < n && s[tickEnd] === '`') tickEnd += 1;
        var tickLen = tickEnd - i;
        var closeSeq = s.slice(i, tickEnd);
        var closeIdx = s.indexOf(closeSeq, tickEnd);
        // Ensure exact run length match
        while (closeIdx !== -1 && (s[closeIdx + tickLen] === '`' || s[closeIdx - 1] === '`')) {
          closeIdx = s.indexOf(closeSeq, closeIdx + 1);
        }
        if (closeIdx !== -1) {
          var codeText = s.slice(tickEnd, closeIdx);
          if (codeText.length >= 2 && codeText[0] === ' ' && codeText[codeText.length - 1] === ' ' && codeText.trim().length > 0) {
            codeText = codeText.slice(1, -1);
          }
          tokens.push({ type: 'code', text: codeText });
          i = closeIdx + tickLen;
          continue;
        }
        pushText(closeSeq);
        i = tickEnd;
        continue;
      }

      // Image ![alt](url) -> rendered as inert image-link chip (never an <img> element)
      if (ch === '!' && s[i + 1] === '[') {
        var imgCloseBracket = s.indexOf(']', i + 2);
        if (imgCloseBracket !== -1 && s[imgCloseBracket + 1] === '(') {
          var imgCloseParen = s.indexOf(')', imgCloseBracket + 2);
          if (imgCloseParen !== -1 && s.slice(i + 2, imgCloseBracket).indexOf('\n') === -1) {
            var alt = s.slice(i + 2, imgCloseBracket);
            var rawImgUrl = s.slice(imgCloseBracket + 2, imgCloseParen).trim();
            var safeImg = sanitizeUrl(rawImgUrl);
            if (safeImg) {
              tokens.push({ type: 'image-link', alt: alt || safeImg, href: safeImg });
            } else {
              pushText(s.slice(i, imgCloseParen + 1));
            }
            i = imgCloseParen + 1;
            continue;
          }
        }
      }

      // Link [label](url)
      if (ch === '[') {
        var closeBracket = s.indexOf(']', i + 1);
        if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
          var closeParen = s.indexOf(')', closeBracket + 2);
          if (closeParen !== -1 && s.slice(i + 1, closeBracket).indexOf('\n') === -1) {
            var label = s.slice(i + 1, closeBracket);
            var rawUrl = s.slice(closeBracket + 2, closeParen).trim();
            var safeUrl = sanitizeUrl(rawUrl);
            if (safeUrl) {
              tokens.push({ type: 'link', label: label || safeUrl, href: safeUrl });
            } else {
              pushText(label || s.slice(i, closeParen + 1));
            }
            i = closeParen + 1;
            continue;
          }
        }
      }

      // Strong (**text** or __text__)
      if ((ch === '*' && s[i + 1] === '*') || (ch === '_' && s[i + 1] === '_')) {
        var delim2 = ch + ch;
        var close2 = s.indexOf(delim2, i + 2);
        if (close2 !== -1 && close2 > i + 2 && s.slice(i + 2, close2).indexOf('\n') === -1) {
          tokens.push({ type: 'strong', children: parseInline(s.slice(i + 2, close2)) });
          i = close2 + 2;
          continue;
        }
      }

      // Strikethrough (~~text~~)
      if (ch === '~' && s[i + 1] === '~') {
        var closeStrike = s.indexOf('~~', i + 2);
        if (closeStrike !== -1 && closeStrike > i + 2 && s.slice(i + 2, closeStrike).indexOf('\n') === -1) {
          tokens.push({ type: 'strike', children: parseInline(s.slice(i + 2, closeStrike)) });
          i = closeStrike + 2;
          continue;
        }
      }

      // Emphasis (*text*)
      if (ch === '*' && s[i + 1] !== ' ' && s[i + 1] !== '*') {
        var closeEm = s.indexOf('*', i + 1);
        if (closeEm !== -1 && closeEm > i + 1 && s[closeEm - 1] !== ' ' && s.slice(i + 1, closeEm).indexOf('\n') === -1) {
          tokens.push({ type: 'em', children: parseInline(s.slice(i + 1, closeEm)) });
          i = closeEm + 1;
          continue;
        }
      }

      // Autolink https://... or http://...
      if ((ch === 'h' || ch === 'H') && /^https?:\/\/[^\s<>()]+/i.test(s.slice(i))) {
        var lm = /^https?:\/\/[^\s<>()]+/i.exec(s.slice(i));
        var rawAuto = lm[0].replace(/[.,;:!?]+$/, '');
        var safeAuto = sanitizeUrl(rawAuto);
        if (safeAuto) {
          tokens.push({ type: 'link', label: rawAuto, href: safeAuto });
          i += rawAuto.length;
          continue;
        }
      }

      pushText(ch);
      i += 1;
    }

    return tokens;
  }

  function splitTableRow(line) {
    var t = line.trim();
    if (t[0] === '|') t = t.slice(1);
    if (t[t.length - 1] === '|') t = t.slice(0, -1);
    return t.split('|').map(function (c) { return c.trim(); });
  }

  function isTableSeparator(line) {
    var t = line.trim();
    if (t.indexOf('|') === -1 || t.indexOf('-') === -1) return false;
    var cells = splitTableRow(t);
    return cells.length > 0 && cells.every(function (c) { return /^:?-{3,}:?$/.test(c); });
  }

  // ---- Block parser (bounded recursion depth & input length) ----
  function parseBlocks(source, depth) {
    var d = typeof depth === 'number' ? depth : 0;
    var clamped = d === 0 ? clampMarkdown(source) : (typeof source === 'string' ? source : String(source || ''));
    var text = clamped.replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var blocks = [];
    var i = 0;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];

      // Blank line
      if (!line.trim()) { i += 1; continue; }

      // Fenced code block (CommonMark backtick/tilde rules)
      var fm = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fm && (fm[1][0] !== '`' || fm[2].indexOf('`') === -1)) {
        var fCh = fm[1][0];
        var fLen = fm[1].length;
        var lang = fm[2].trim().split(/\s+/)[0] || '';
        var codeLines = [];
        i += 1;
        while (i < n) {
          var cm = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
          if (cm && cm[1][0] === fCh && cm[1].length >= fLen && cm[2].trim() === '') {
            i += 1;
            break;
          }
          codeLines.push(lines[i]);
          i += 1;
        }
        blocks.push({ type: 'code', lang: lang, text: codeLines.join('\n') });
        continue;
      }

      // Horizontal rule
      if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
        blocks.push({ type: 'hr' });
        i += 1;
        continue;
      }

      // ATX Heading (# .. ######)
      var hm = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (hm) {
        blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] });
        i += 1;
        continue;
      }

      // Blockquote (> ...), bounded to MAX_BLOCKQUOTE_DEPTH to prevent stack overflow DoS
      if (d < MAX_BLOCKQUOTE_DEPTH && /^\s{0,3}>\s?/.test(line)) {
        var bqLines = [];
        while (i < n && /^\s{0,3}>\s?/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        blocks.push({ type: 'blockquote', blocks: parseBlocks(bqLines.join('\n'), d + 1) });
        continue;
      }

      // GFM Table (header + separator)
      if (i + 1 < n && line.indexOf('|') !== -1 && isTableSeparator(lines[i + 1])) {
        var headers = splitTableRow(line);
        i += 2;
        var rows = [];
        while (i < n && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        blocks.push({ type: 'table', headers: headers, rows: rows });
        continue;
      }

      // Unordered list
      if (/^\s{0,3}[-*+]\s+/.test(line)) {
        var ulItems = [];
        while (i < n && /^\s{0,3}[-*+]\s+/.test(lines[i])) {
          ulItems.push(lines[i].replace(/^\s{0,3}[-*+]\s+/, ''));
          i += 1;
        }
        blocks.push({ type: 'ul', items: ulItems });
        continue;
      }

      // Ordered list
      if (/^\s{0,3}\d{1,9}[.)]\s+/.test(line)) {
        var olItems = [];
        while (i < n && /^\s{0,3}\d{1,9}[.)]\s+/.test(lines[i])) {
          olItems.push(lines[i].replace(/^\s{0,3}\d{1,9}[.)]\s+/, ''));
          i += 1;
        }
        blocks.push({ type: 'ol', items: olItems });
        continue;
      }

      // Paragraph (accumulate until blank line or block start)
      var paraLines = [line];
      i += 1;
      while (i < n && lines[i].trim()) {
        var nextLine = lines[i];
        if (/^\s{0,3}(`{3,}|~{3,})/.test(nextLine) || /^\s{0,3}#{1,6}\s+/.test(nextLine) ||
            /^\s{0,3}>\s?/.test(nextLine) || /^\s{0,3}[-*+]\s+/.test(nextLine) ||
            /^\s{0,3}\d{1,9}[.)]\s+/.test(nextLine) || /^\s{0,3}(?:[-*_]\s*){3,}$/.test(nextLine)) {
          break;
        }
        if (i + 1 < n && nextLine.indexOf('|') !== -1 && isTableSeparator(lines[i + 1])) break;
        paraLines.push(nextLine);
        i += 1;
      }
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    }

    return blocks;
  }

  // ---- Pure DOM Renderer (zero innerHTML) ----
  function renderInlineNodes(doc, parent, tokens) {
    for (var i = 0; i < tokens.length; i += 1) {
      var tok = tokens[i];
      if (tok.type === 'text') {
        parent.appendChild(doc.createTextNode(tok.text));
      } else if (tok.type === 'br') {
        parent.appendChild(doc.createElement('br'));
      } else if (tok.type === 'code') {
        var code = doc.createElement('code');
        code.className = 'rt-inline-code';
        code.textContent = tok.text;
        parent.appendChild(code);
      } else if (tok.type === 'strong') {
        var st = doc.createElement('strong');
        renderInlineNodes(doc, st, tok.children);
        parent.appendChild(st);
      } else if (tok.type === 'em') {
        var em = doc.createElement('em');
        renderInlineNodes(doc, em, tok.children);
        parent.appendChild(em);
      } else if (tok.type === 'strike') {
        var del = doc.createElement('del');
        renderInlineNodes(doc, del, tok.children);
        parent.appendChild(del);
      } else if (tok.type === 'link') {
        var a = doc.createElement('a');
        a.setAttribute('href', tok.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.textContent = tok.label;
        parent.appendChild(a);
      } else if (tok.type === 'image-link') {
        var chip = doc.createElement('a');
        chip.className = 'rt-img-chip';
        chip.setAttribute('href', tok.href);
        chip.setAttribute('target', '_blank');
        chip.setAttribute('rel', 'noopener noreferrer');
        chip.textContent = '[img: ' + tok.alt + ']';
        parent.appendChild(chip);
      }
    }
  }

  function renderBlockNodes(doc, container, blocks) {
    for (var i = 0; i < blocks.length; i += 1) {
      var b = blocks[i];
      if (b.type === 'paragraph') {
        var p = doc.createElement('p');
        renderInlineNodes(doc, p, parseInline(b.text));
        container.appendChild(p);
      } else if (b.type === 'heading') {
        var tag = 'h' + Math.min(6, Math.max(2, b.level + 1));
        var hEl = doc.createElement(tag);
        hEl.className = 'rt-md-h';
        renderInlineNodes(doc, hEl, parseInline(b.text));
        container.appendChild(hEl);
      } else if (b.type === 'code') {
        var codeWrap = doc.createElement('div');
        codeWrap.className = 'rt-code-block';
        var codeHead = doc.createElement('div');
        codeHead.className = 'rt-code-head';
        var langTag = doc.createElement('span');
        langTag.className = 'rt-code-lang';
        langTag.textContent = b.lang ? b.lang : 'text';
        codeHead.appendChild(langTag);
        codeWrap.appendChild(codeHead);
        var pre = doc.createElement('pre');
        pre.className = 'rt-md-pre';
        var code = doc.createElement('code');
        if (b.lang) code.setAttribute('data-lang', b.lang);
        code.textContent = b.text;
        pre.appendChild(code);
        codeWrap.appendChild(pre);
        container.appendChild(codeWrap);
      } else if (b.type === 'blockquote') {
        var bq = doc.createElement('blockquote');
        bq.className = 'rt-md-quote';
        renderBlockNodes(doc, bq, b.blocks);
        container.appendChild(bq);
      } else if (b.type === 'hr') {
        container.appendChild(doc.createElement('hr'));
      } else if (b.type === 'ul' || b.type === 'ol') {
        var list = doc.createElement(b.type);
        for (var j = 0; j < b.items.length; j += 1) {
          var li = doc.createElement('li');
          renderInlineNodes(doc, li, parseInline(b.items[j]));
          list.appendChild(li);
        }
        container.appendChild(list);
      } else if (b.type === 'table') {
        var wrap = doc.createElement('div');
        wrap.className = 'rt-md-table-wrap';
        var tbl = doc.createElement('table');
        tbl.className = 'rt-md-table';
        var thead = doc.createElement('thead');
        var htr = doc.createElement('tr');
        for (var hi = 0; hi < b.headers.length; hi += 1) {
          var th = doc.createElement('th');
          renderInlineNodes(doc, th, parseInline(b.headers[hi]));
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        tbl.appendChild(thead);
        var tbody = doc.createElement('tbody');
        for (var ri = 0; ri < b.rows.length; ri += 1) {
          var tr = doc.createElement('tr');
          var row = b.rows[ri];
          for (var ci = 0; ci < b.headers.length; ci += 1) {
            var td = doc.createElement('td');
            renderInlineNodes(doc, td, parseInline(row[ci] || ''));
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        wrap.appendChild(tbl);
        container.appendChild(wrap);
      }
    }
  }

  function renderMarkdown(doc, source) {
    var root = doc.createElement('div');
    root.className = 'rt-md';
    var blocks = parseBlocks(source);
    renderBlockNodes(doc, root, blocks);
    return root;
  }

  var RoomMarkdown = {
    sanitizeUrl: sanitizeUrl,
    parseInline: parseInline,
    parseBlocks: parseBlocks,
    renderMarkdown: renderMarkdown,
  };

  if (typeof globalThis !== 'undefined') globalThis.RoomMarkdown = RoomMarkdown;
})();
