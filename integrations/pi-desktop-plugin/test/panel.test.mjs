// The panel (plugin/renderer/panel.js) in a minimal DOM: its language comes from the host's
// appearance (pluginBridge.invoke('app.getAppearance'), as upstream panels read it), not from
// index.html's placeholder lang="en"; navigator.language is the fallback; appearance:changed
// switches it live. No browser and no dependency: a small fake document is enough for the calls the
// panel makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RENDERER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'renderer');
const PANEL_JS = fs.readFileSync(path.join(RENDERER, 'panel.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

class TextNode { constructor(s) { this.textContent = String(s); } }
class El {
  constructor(tag, id) { this.tagName = tag; this.id = id || null; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.value = ''; this.disabled = false; this._text = ''; }
  appendChild(c) { this.children.push(c); return c; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ type: 'click' }); }
  matches() { return false; }
}
function walk(node, out = []) { out.push(node); for (const c of node.children || []) if (c instanceof El) walk(c, out); return out; }

const ROOM = { room: 'demo', preset: 'discussion', phase: 'idle', roundId: 0, closed: false, current: null, served: 'here', seats: [{ seat: 'A', role: 'lead', kind: 'pi', waitMode: 'manual', boundTo: null }] };

// Runs panel.js against a fake document and bridge. appearance: the host's answer to
// app.getAppearance, or an Error to make that channel fail.
function runPanel({ appearance, language = 'en-US' }) {
  const ids = ['title', 'service', 'refresh', 'root', 'error', 'rooms', 'detail'];
  const byId = Object.fromEntries(ids.map((id) => [id, new El(id === 'title' ? 'h1' : 'div', id)]));
  const html = { lang: 'en' };
  const listeners = {};
  const invoked = [];
  const document = {
    documentElement: html, hidden: false, activeElement: null,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => new El(tag),
    createTextNode: (s) => new TextNode(s),
  };
  const bridge = {
    invoke(channel, payload) {
      invoked.push(channel);
      if (channel === 'app.getAppearance') return appearance instanceof Error ? Promise.reject(appearance) : Promise.resolve(appearance);
      if (channel === 'roundtable/rooms') return Promise.resolve({ ok: true, serviceRunning: true, roomsRoot: 'R', rooms: [ROOM] });
      if (channel === 'roundtable/room') return Promise.resolve({ ok: true, ...ROOM, roomDir: 'R/demo', task: null, attempt: null, holding: {}, awaitingDecision: null, messages: 0, disclosures: [], stale: [], recent: [] });
      return Promise.resolve({ ok: true, payload });
    },
    on(channel, fn) { (listeners[channel] ||= []).push(fn); },
  };
  const timers = [];
  const ctx = { document, navigator: { language }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, console };
  ctx.window = ctx;
  ctx.pluginBridge = bridge;
  vm.runInNewContext(PANEL_JS, ctx, { filename: 'panel.js' });
  const buttons = () => ids.flatMap((id) => walk(byId[id])).filter((n) => n.tagName === 'button');
  return {
    html, byId, invoked, listeners,
    buttonTexts: () => buttons().map((b) => b.textContent),
    click: (text) => { const b = buttons().find((x) => x.textContent === text); assert.ok(b, `button ${text}`); b.click(); },
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test('index.html lang is only a placeholder; the panel asks the host for its appearance', () => {
  assert.match(INDEX_HTML, /<script src="\.\/panel\.js"><\/script>/);
  assert.match(PANEL_JS, /app\.getAppearance/);
  assert.doesNotMatch(PANEL_JS, /document\.documentElement\.lang \|\|/, 'the language is not read from the html placeholder');
});

test('host locale zh-CN: the panel renders in Chinese (开始一轮)', async () => {
  const p = runPanel({ appearance: { theme: 'system', base: 'system', locale: 'zh-CN', pluginTheme: null }, language: 'en-US' });
  await settle();
  assert.equal(p.invoked[0], 'app.getAppearance', 'the appearance is read before the first render');
  assert.equal(p.html.lang, 'zh-CN');
  assert.equal(p.byId.title.textContent, '圆桌');
  assert.equal(p.byId.refresh.textContent, '刷新');
  p.click('详情');
  await settle();
  assert.ok(p.buttonTexts().includes('开始一轮'), p.buttonTexts().join(' | '));
});

test('host locale en wins over a Chinese navigator.language; appearance:changed switches to Chinese live', async () => {
  const p = runPanel({ appearance: { locale: 'en' }, language: 'zh-CN' });
  await settle();
  assert.equal(p.html.lang, 'en');
  p.click('Details');
  await settle();
  assert.ok(p.buttonTexts().includes('Start round'));
  assert.equal(p.listeners['appearance:changed'].length, 1);
  p.listeners['appearance:changed'][0]({ locale: 'zh-CN' });
  await settle();
  assert.equal(p.html.lang, 'zh-CN');
  assert.ok(p.buttonTexts().includes('开始一轮'), p.buttonTexts().join(' | '));
});

test('no appearance from the host: navigator.language decides', async () => {
  const zh = runPanel({ appearance: new Error('UNSUPPORTED'), language: 'zh-TW' });
  await settle();
  assert.equal(zh.html.lang, 'zh-CN');
  assert.equal(zh.byId.title.textContent, '圆桌');
  const en = runPanel({ appearance: new Error('UNSUPPORTED'), language: 'en-GB' });
  await settle();
  assert.equal(en.html.lang, 'en');
  assert.equal(en.byId.title.textContent, 'Governed Roundtable');
});
