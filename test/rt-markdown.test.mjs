// Unit & XSS negative-control tests for ui/rt-markdown.js (zero-dependency IIFE in Node vm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnClean } from '../lib/spawn.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_PATH = path.join(ROOT, 'ui', 'rt-markdown.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

function loadMarkdown() {
  const sandbox = { URL };
  new vm.Script(`(function (globalThis, URL) {\n${src}\n})`, { filename: 'rt-markdown.js' }).runInThisContext()(sandbox, URL);
  assert.ok(sandbox.RoomMarkdown, 'exposes globalThis.RoomMarkdown');
  return sandbox.RoomMarkdown;
}
const M = loadMarkdown();

function makeMiniDoc() {
  function makeNode(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: '',
      attrs: {},
      children: [],
      _text: '',
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.children.push(c); return c; },
    };
  }
  return {
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, tagName: '#TEXT', textContent: String(text), children: [], attrs: {} }),
  };
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

test('node --check ui/rt-markdown.js and zero innerHTML invariant', async () => {
  const r = await spawnClean(process.execPath, ['--check', SRC_PATH], { timeoutMs: 20_000 });
  assert.equal(r.code, 0, r.stderr);
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/, 'zero innerHTML');
});

test('sanitizeUrl allows only http, https, mailto and rejects javascript/data/vbscript/control chars', () => {
  assert.equal(M.sanitizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(M.sanitizeUrl('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(M.sanitizeUrl('mailto:dev@example.com'), 'mailto:dev@example.com');
  for (const bad of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/win.ini',
    'https://example.com/\nfoo',
    'relative/path',
    '',
  ]) {
    assert.equal(M.sanitizeUrl(bad), null, `refuses ${bad}`);
  }
});

test('renders headings, code blocks, lists, quotes, tables, inline links safely', () => {
  const md = [
    '# Title',
    '',
    'Hello **bold** and *em* and ~~del~~ and `code` and [link](https://example.com).',
    '',
    '> quoted line',
    '',
    '- item 1',
    '- item 2',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
  ].join('\n');

  const doc = makeMiniDoc();
  const root = M.renderMarkdown(doc, md);
  const tags = [];
  walk(root, (n) => { if (n.tagName !== '#TEXT') tags.push(n.tagName); });
  assert.ok(tags.includes('H2'));
  assert.ok(tags.includes('STRONG'));
  assert.ok(tags.includes('EM'));
  assert.ok(tags.includes('DEL'));
  assert.ok(tags.includes('CODE'));
  assert.ok(tags.includes('A'));
  assert.ok(tags.includes('BLOCKQUOTE'));
  assert.ok(tags.includes('UL'));
  assert.ok(tags.includes('TABLE'));
  assert.ok(tags.includes('PRE'));
});

test('XSS negative controls: raw HTML, script tags, javascript links, and markdown images NEVER create script/img/dangerous hrefs', () => {
  const xss = [
    '<script>window.__xss=1</script>',
    '<img src=x onerror="alert(1)">',
    '<svg onload=alert(1)>',
    '[click me](javascript:alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '![pixel](https://tracker.example/pixel.png)',
    '![evil](javascript:alert(1))',
  ].join('\n\n');

  const doc = makeMiniDoc();
  const root = M.renderMarkdown(doc, xss);
  const forbiddenTags = new Set(['SCRIPT', 'IMG', 'SVG', 'IFRAME', 'OBJECT', 'EMBED']);
  const foundLinks = [];
  walk(root, (n) => {
    assert.ok(!forbiddenTags.has(n.tagName), `forbidden tag ${n.tagName}`);
    if (n.tagName === 'A') foundLinks.push(n.attrs.href);
  });
  // Only the safe https image-link chip becomes an <a> (inert text chip, no <img>), zero javascript:/data: links!
  assert.deepEqual(foundLinks, ['https://tracker.example/pixel.png']);
  assert.match(root.textContent, /<script>window\.__xss=1<\/script>/);
  assert.match(root.textContent, /\[img: pixel\]/);
});
