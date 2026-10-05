// The panel (plugin/renderer/panel.js) in a minimal DOM: its language comes from the host's
// appearance (pluginBridge.invoke('app.getAppearance'), as upstream panels read it), not from
// index.html's placeholder lang="en"; navigator.language is the fallback; appearance:changed
// switches it live. The poll keeps the detail current while the user types, without losing the
// typed text, the caret or an IME composition; confirms, the buttons per room state, errors and
// late answers are checked against the same fake. No browser and no dependency: a small fake
// document is enough for the calls the panel makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RENDERER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'renderer');
const PANEL_JS = fs.readFileSync(path.join(RENDERER, 'panel.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

class TextNode { constructor(s) { this.textContent = String(s); this.parentNode = null; } }
class El {
  constructor(tag, id, doc) {
    this.tagName = tag; this.id = id || null; this.doc = doc; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.value = ''; this.disabled = false; this._text = '';
    this.parentNode = null; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; this.scrollTop = 0; this.selections = []; this.focusCalls = 0; this.blurs = 0; this.composing = false;
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); assert.ok(i >= 0, 'removeChild of a non-child'); blurIfInside(this.doc, c); this.children.splice(i, 1); c.parentNode = null; return c; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) { blurIfInside(this.doc, c); c.parentNode = null; } this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  click() { if (!this.disabled) this.fire('click'); }
  fire(type) {
    if (type === 'compositionstart') this.composing = true;
    if (type === 'compositionend') this.composing = false;
    for (const fn of this.listeners[type] || []) fn({ type, target: this });
  }
  matches(sel) { return sel.split(',').map((x) => x.trim()).includes(this.tagName); }
  // As in a browser, focus() does nothing on a node that is not in the document or sits under a
  // hidden ancestor.
  focus() { this.focusCalls++; if (focusable(this)) this.doc.activeElement = this; }
  setSelectionRange(start, end, dir) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = dir || 'none'; this.selections.push([start, end, dir]); }
}
// The roots (#rooms, #detail, ...) stand for the document. Detaching a subtree that holds the focused
// node moves focus away (the browser's focus fixup): activeElement becomes null and the node gets a
// blur, so a test sees a focused control that was detached even if the same node comes back.
function inside(root, node) { for (let n = node; n; n = n.parentNode) if (n === root) return true; return false; }
function blurIfInside(doc, root) {
  const a = doc && doc.activeElement;
  if (!a || !(root instanceof El) || !inside(root, a)) return;
  doc.activeElement = null;
  a.blurs++;
  if (a.composing) doc.lostCompositions++;
  a.fire('blur');
}
function focusable(node) { for (let n = node; n; n = n.parentNode) { if (n.hidden) return false; if (n.root) return true; } return false; }
function walk(node, out = []) { out.push(node); for (const c of node.children || []) if (c instanceof El) walk(c, out); return out; }

const ROOM = { room: 'demo', preset: 'discussion', phase: 'idle', roundId: 0, closed: false, current: null, served: 'here', seats: [{ seat: 'A', role: 'lead', kind: 'pi', waitMode: 'manual', boundTo: null }] };
const CLOSED = { ...ROOM, phase: 'closed', roundId: 1, closed: true, served: 'stopped', seats: [{ seat: 'A', role: 'lead', kind: 'pi', waitMode: 'manual', boundTo: '…abcdef' }] };
const ZH_APPEARANCE = { theme: 'system', base: 'system', locale: 'zh-CN', pluginTheme: null };
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

// Runs panel.js against a fake document and bridge. appearance: the host's answer to
// app.getAppearance, or an Error to make that channel fail. The returned data can be changed during
// a test: rooms and serviceRunning shape roundtable/rooms, details[room] is merged into that room's
// roundtable/room answer, and override(channel, payload) answers a call itself whenever it returns
// anything but undefined (a value or a promise).
function runPanel({ appearance, language = 'en-US', rooms = [ROOM], details = {}, override = null }) {
  const ids = ['title', 'service', 'refresh', 'root', 'error', 'rooms', 'detail'];
  const html = { lang: 'en' };
  const listeners = {};
  const docListeners = {};
  const invoked = [];
  const calls = [];
  const data = { rooms, serviceRunning: true, details, override };
  const document = {
    documentElement: html, hidden: false, activeElement: null, lostCompositions: 0,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => new El(tag, null, document),
    createTextNode: (s) => new TextNode(s),
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
  };
  const byId = Object.fromEntries(ids.map((id) => [id, new El(id === 'title' ? 'h1' : 'div', id, document)]));
  for (const n of Object.values(byId)) n.root = true;
  byId.error.hidden = true;
  byId.detail.hidden = true;
  const detailOf = (room) => {
    const r = data.rooms.find((x) => x.room === room);
    if (!r) return { ok: false, error: 'NO_SUCH_ROOM' };
    return { ok: true, ...r, roomDir: `R/${room}`, task: null, attempt: null, holding: {}, awaitingDecision: null, messages: 0, disclosures: [], stale: [], recent: [], roundActive: false, ...(data.details[room] || {}) };
  };
  const bridge = {
    invoke(channel, payload) {
      invoked.push(channel);
      calls.push([channel, payload]);
      if (channel === 'app.getAppearance') return appearance instanceof Error ? Promise.reject(appearance) : Promise.resolve(appearance);
      const own = data.override ? data.override(channel, payload) : undefined;
      if (own !== undefined) return Promise.resolve(own);
      if (channel === 'roundtable/rooms') return Promise.resolve({ ok: true, serviceRunning: data.serviceRunning, roomsRoot: 'R', rooms: data.rooms });
      if (channel === 'roundtable/room') return Promise.resolve(detailOf(payload.room));
      return Promise.resolve({ ok: true, payload });
    },
    on(channel, fn) { (listeners[channel] ||= []).push(fn); },
  };
  // Timers run by hand: runLoop() runs the pending poll (the function named loop), runTimers()
  // every other timer (a confirm's disarm).
  const timers = [];
  let nextTimer = 0;
  const ctx = {
    document, navigator: { language }, console,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  ctx.window = ctx;
  ctx.pluginBridge = bridge;
  vm.runInNewContext(PANEL_JS, ctx, { filename: 'panel.js' });
  const buttons = () => ids.flatMap((id) => walk(byId[id])).filter((n) => n.tagName === 'button');
  const take = (pred) => { const due = timers.filter(pred); for (const t of due) timers.splice(timers.indexOf(t), 1); for (const t of due) t.fn(); return due.length; };
  return {
    html, byId, invoked, calls, listeners, docListeners, document, data, timers,
    button: (text) => buttons().find((b) => b.textContent === text) || null,
    buttonTexts: () => buttons().map((b) => b.textContent),
    click: (text) => { const b = buttons().find((x) => x.textContent === text); assert.ok(b, `button ${text}`); b.click(); },
    inDetail: (tag) => walk(byId.detail).filter((n) => n.tagName === tag),
    connected: (node) => { for (let n = node; n; n = n.parentNode) if (n === byId.rooms || n === byId.detail) return true; return false; },
    runLoop: () => take((t) => t.fn.name === 'loop'),
    runTimers: () => take((t) => t.fn.name !== 'loop'),
    // Payloads come from the panel's vm realm: copied into this one so deepEqual compares values.
    sent: (channel) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] === channel))),
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const typeInto = (node, value) => { node.value = value; node.fire('input'); };
// Opens the detail of the room in a zh-CN panel and returns it settled.
async function openZh(opts = {}) {
  const p = runPanel({ appearance: ZH_APPEARANCE, ...opts });
  await settle();
  p.click('详情');
  await settle();
  return p;
}
// The detail's controls in the order the panel draws them: task textarea, order, say.
function controls(p) {
  const [task] = p.inDetail('textarea');
  const [order, say] = p.inDetail('input');
  return { task, order, say };
}

test('index.html lang is only a placeholder; the panel asks the host for its appearance', () => {
  assert.match(INDEX_HTML, /<script src="\.\/panel\.js"><\/script>/);
  assert.match(PANEL_JS, /app\.getAppearance/);
  assert.doesNotMatch(PANEL_JS, /document\.documentElement\.lang \|\|/, 'the language is not read from the html placeholder');
});

test('host locale zh-CN: the panel renders in Chinese (开始一轮)', async () => {
  const p = runPanel({ appearance: ZH_APPEARANCE, language: 'en-US' });
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

test('typing does not freeze the panel: the poll updates the detail around the focused textarea', async () => {
  const p = await openZh();
  const { task } = controls(p);
  typeInto(task, '任务草稿');
  task.focus();
  task.setSelectionRange(2, 4);
  task.selections.length = 0;
  p.data.rooms = [{ ...ROOM, phase: 'meet', roundId: 1, current: 'A' }];
  p.data.details.demo = { recent: [{ seq: 7, type: 'round_started', seatId: null }], roundActive: true };
  assert.equal(p.runLoop(), 1);
  await settle();
  assert.match(p.byId.detail.textContent, /#7 round_started/, 'the detail follows the room while the textarea has focus');
  assert.match(p.byId.detail.textContent, /阶段: 开会/);
  assert.equal(controls(p).task, task, 'the same textarea node');
  assert.ok(p.connected(task));
  assert.equal(task.value, '任务草稿');
  assert.deepEqual([task.selectionStart, task.selectionEnd], [2, 4]);
  assert.deepEqual(task.selections, [], 'the caret was not set again');
  assert.equal(p.document.activeElement, task);
  assert.equal(task.blurs, 0, 'never detached, so never blurred');
  assert.equal(p.timers.filter((t) => t.fn.name === 'loop').length, 1, 'the next poll is scheduled');
});

test('drafts left unfocused survive polls: task, order, user message and deny reason', async () => {
  const disclosure = { id: 'd1', seatId: 'A', argv: ['npm', 'test'], reason: '跑测试', allowed: true, manifestSha: null };
  const p = await openZh({ details: { demo: { disclosures: [disclosure] } } });
  const { task, order, say } = controls(p);
  const deny = p.inDetail('input')[2];
  assert.equal(deny.getAttribute('placeholder'), '拒绝理由（必填）');
  typeInto(task, '任务');
  typeInto(order, 'A,A');
  typeInto(say, '用户消息');
  typeInto(deny, '不需要');
  p.document.activeElement = null;
  p.data.details.demo = { disclosures: [disclosure], recent: [{ seq: 3, type: 'task_set', seatId: null }] };
  p.runLoop();
  await settle();
  p.data.details.demo = { disclosures: [disclosure], recent: [{ seq: 4, type: 'message_added', seatId: null }] };
  p.runLoop();
  await settle();
  assert.match(p.byId.detail.textContent, /#4 message_added/);
  const now = { ...controls(p), deny: p.inDetail('input')[2] };
  assert.deepEqual([now.task.value, now.order.value, now.say.value, now.deny.value], ['任务', 'A,A', '用户消息', '不需要']);
  assert.ok([task, order, say, deny].every((n) => p.connected(n)), 'the same controls stay in place');
});

test('an IME composition is not interrupted by a poll', async () => {
  const p = await openZh();
  const { say } = controls(p);
  say.focus();
  say.focusCalls = 0;
  say.fire('compositionstart');
  p.data.details.demo = { recent: [{ seq: 5, type: 'round_started', seatId: null }] };
  p.runLoop();
  await settle();
  assert.match(p.byId.detail.textContent, /#5 round_started/);
  assert.equal(controls(p).say, say, 'the same input node');
  assert.ok(p.connected(say));
  assert.equal(p.document.activeElement, say, 'still focused');
  assert.equal(say.blurs, 0, 'never detached, so the composition was not cancelled');
  assert.equal(p.document.lostCompositions, 0);
  assert.equal(say.focusCalls, 0, 'not re-focused');
  assert.deepEqual(say.selections, [], 'no setSelectionRange');
});

test('a shell rebuild under a composition waits for compositionend, then restores the draft and the caret', async () => {
  const p = await openZh();
  const { say } = controls(p);
  say.focus();
  say.fire('compositionstart');
  say.value = '你好';
  say.selectionStart = 1; say.selectionEnd = 2;
  p.listeners['appearance:changed'][0]({ locale: 'en' });
  await settle();
  assert.equal(controls(p).say, say, 'no rebuild during the composition');
  say.fire('compositionend');
  const now = controls(p).say;
  assert.notEqual(now, say, 'rebuilt in English once the composition ended');
  assert.ok(p.buttonTexts().includes('Start round'));
  assert.equal(now.value, '你好');
  assert.equal(p.document.activeElement, now);
  assert.deepEqual(now.selections, [[1, 2, 'none']]);
});

test('a composition in a control that went away does not hold rebuilds back', async () => {
  const disclosure = { id: 'd1', seatId: 'A', argv: ['npm', 'test'], reason: '跑测试', allowed: true, manifestSha: null };
  const p = await openZh({ details: { demo: { disclosures: [disclosure] } } });
  const deny = p.inDetail('input')[2];
  deny.focus();
  deny.fire('compositionstart');
  p.data.details.demo = { disclosures: [] };
  p.runLoop();
  await settle();
  assert.ok(!p.connected(deny), 'the disclosure and its reason input are gone');
  p.listeners['appearance:changed'][0]({ locale: 'en' });
  await settle();
  assert.ok(p.buttonTexts().includes('Start round'), p.buttonTexts().join(' | '));
});

test('the two-click confirm survives a poll', async () => {
  const p = await openZh();
  p.click('散会');
  p.data.details.demo = { recent: [{ seq: 6, type: 'message_added', seatId: null }] };
  p.runLoop();
  await settle();
  assert.match(p.byId.detail.textContent, /#6 message_added/);
  p.click('再点一次确认');
  await settle();
  assert.deepEqual(p.sent('roundtable/admin'), [['roundtable/admin', { room: 'demo', cmd: 'close' }]]);
});

test('a stale disarm timer does not cancel a newer arm', async () => {
  const p = await openZh();
  p.click('散会');
  const [first] = p.timers.filter((t) => t.fn.name !== 'loop');
  assert.ok(first, 'the arm has a disarm timer');
  p.click('再点一次确认');
  p.click('散会');
  first.fn();
  p.timers.splice(p.timers.indexOf(first), 1);
  assert.ok(p.button('再点一次确认'), 'the newer arm is still armed');
  await settle();
  assert.ok(p.button('再点一次确认'), 'still armed after the action\'s refresh');
  p.runTimers();
  assert.ok(p.button('散会'), 'its own timer disarms it');
  assert.equal(p.button('再点一次确认'), null);
});

test('a closed room: no serve, stop or open buttons, and a localized status line', async () => {
  const zh = runPanel({ appearance: ZH_APPEARANCE, rooms: [CLOSED] });
  await settle();
  const texts = zh.buttonTexts();
  for (const t of ['在此服务', '停止服务', '在浏览器打开房间界面']) assert.ok(!texts.includes(t), `${t} in ${texts.join(' | ')}`);
  assert.ok(texts.includes('详情') && texts.includes('解除绑定'), texts.join(' | '));
  const status = walk(zh.byId.rooms).find((n) => n.className === 'muted' && /^阶段/.test(n.textContent)).textContent;
  assert.match(status, /已散会/);
  assert.match(status, /轮次 1/);
  assert.doesNotMatch(status, /closed|round/, status);
  const en = runPanel({ appearance: { locale: 'en' }, rooms: [CLOSED] });
  await settle();
  assert.ok(!en.buttonTexts().includes('Serve here'), en.buttonTexts().join(' | '));
});

test('a closed room\'s detail is read-only', async () => {
  const p = await openZh({ rooms: [CLOSED], details: { demo: { task: '讨论 parser', recent: [{ seq: 9, type: 'room_closed', seatId: null }] } } });
  const text = p.byId.detail.textContent;
  assert.equal(p.byId.detail.hidden, false);
  assert.match(text, /已散会/);
  assert.match(text, /讨论 parser/);
  assert.match(text, /#9 room_closed/);
  assert.doesNotMatch(text, /未服务/);
  assert.deepEqual([...p.inDetail('textarea'), ...p.inDetail('input')], []);
  const texts = p.buttonTexts();
  for (const t of ['设定任务', '开始一轮', '发送', '散会']) assert.ok(!texts.includes(t), `${t} in ${texts.join(' | ')}`);
});

test('serve, stop and open buttons follow the serving state', async () => {
  const cases = [
    { served: 'here', running: true, has: ['停止服务', '在浏览器打开房间界面'], not: ['在此服务'] },
    { served: 'stopped', running: true, has: ['在此服务'], not: ['停止服务', '在浏览器打开房间界面'], serve: 'enabled' },
    { served: 'stopped', running: false, has: ['在此服务'], not: ['停止服务', '在浏览器打开房间界面'], serve: 'disabled' },
    { served: 'elsewhere', running: true, has: [], not: ['在此服务', '停止服务', '在浏览器打开房间界面'] },
  ];
  for (const c of cases) {
    const label = `${c.served}, service ${c.running ? 'up' : 'down'}`;
    const p = runPanel({ appearance: ZH_APPEARANCE, rooms: [{ ...ROOM, served: c.served }] });
    p.data.serviceRunning = c.running;
    await settle();
    const texts = p.buttonTexts();
    for (const t of c.has) assert.ok(texts.includes(t), `${label}: ${t} missing from ${texts.join(' | ')}`);
    for (const t of c.not) assert.ok(!texts.includes(t), `${label}: ${t} in ${texts.join(' | ')}`);
    if (c.serve) assert.equal(p.button('在此服务').disabled, c.serve === 'disabled', label);
    if (c.serve === 'enabled') {
      p.click('在此服务');
      await settle();
      assert.deepEqual(p.sent('roundtable/serve'), [['roundtable/serve', { room: 'demo' }]]);
    }
  }
});

test('Release on a closed room asks twice', async () => {
  const p = runPanel({ appearance: ZH_APPEARANCE, rooms: [CLOSED] });
  await settle();
  const release = p.button('解除绑定');
  p.click('解除绑定');
  await settle();
  assert.deepEqual(p.sent('roundtable/unbind'), []);
  p.click('再点一次确认');
  await settle();
  assert.deepEqual(p.sent('roundtable/unbind'), [['roundtable/unbind', { room: 'demo', seat: 'A' }]]);
  assert.match(release.getAttribute('title') || '', /散会包/, 'the button says what releasing a closed room costs');
});

test('Start round is disabled while a round runs', async () => {
  const p = await openZh({ rooms: [{ ...ROOM, phase: 'meet', roundId: 1 }], details: { demo: { roundActive: true } } });
  assert.equal(p.button('开始一轮').disabled, true);
  p.data.rooms = [{ ...ROOM, phase: 'done', roundId: 1 }];
  p.data.details.demo = { roundActive: false };
  p.runLoop();
  await settle();
  assert.equal(p.button('开始一轮').disabled, false);
});

test('Set task keeps the draft when it fails and clears it when it succeeds', async () => {
  let answer = { ok: false, error: 'BAD_ARGS', message: 'text' };
  const p = await openZh({ override: (ch, pl) => (ch === 'roundtable/admin' && pl.cmd === 'task' ? answer : undefined) });
  typeInto(controls(p).task, '新任务');
  p.click('设定任务');
  await settle();
  assert.equal(controls(p).task.value, '新任务');
  assert.equal(p.byId.error.hidden, false);
  assert.match(p.byId.error.textContent, /BAD_ARGS/);
  answer = { ok: true };
  p.click('设定任务');
  await settle();
  assert.equal(controls(p).task.value, '');
  assert.equal(p.byId.error.hidden, true);
  assert.deepEqual(p.sent('roundtable/admin').map((c) => c[1].text), ['新任务', '新任务']);
});

test('an empty task, message or deny reason says so instead of doing nothing', async () => {
  const p = await openZh({ details: { demo: { disclosures: [{ id: 'd1', seatId: 'A', argv: ['x'], reason: 'r', allowed: false, manifestSha: null }] } } });
  assert.match(p.byId.detail.textContent, /（不在白名单）/);
  for (const [button, msg] of [['设定任务', /任务/], ['发送', /消息/], ['拒绝', /拒绝理由/]]) {
    p.click(button);
    assert.equal(p.byId.error.hidden, false, button);
    assert.match(p.byId.error.textContent, msg);
  }
  assert.deepEqual(p.sent('roundtable/admin'), []);
});

test('Hide wins over a late detail answer', async () => {
  const late = deferred();
  let first = true;
  const p = runPanel({ appearance: ZH_APPEARANCE, override: (ch) => { if (ch === 'roundtable/room' && first) { first = false; return late.p; } return undefined; } });
  await settle();
  p.click('详情');
  await settle();
  p.click('收起');
  await settle();
  late.resolve({ ok: true, ...ROOM, task: null, awaitingDecision: null, disclosures: [], stale: [], recent: [], roundActive: false });
  await settle();
  assert.equal(p.byId.detail.hidden, true);
  assert.equal(p.byId.detail.textContent, '');
  assert.ok(p.button('详情'));
});

test('a late rooms answer is dropped: a newer refresh wins', async () => {
  let late = null;
  const p = runPanel({ appearance: ZH_APPEARANCE, override: (ch) => { if (ch === 'roundtable/rooms' && late && !late.taken) { late.taken = true; return late.p; } return undefined; } });
  await settle();
  late = deferred();
  p.runLoop();
  await settle();
  p.data.rooms = [{ ...ROOM, room: 'newer' }];
  p.byId.refresh.click();
  await settle();
  assert.match(p.byId.rooms.textContent, /newer/);
  late.resolve({ ok: true, serviceRunning: true, roomsRoot: 'R', rooms: [{ ...ROOM, room: 'older' }] });
  await settle();
  assert.match(p.byId.rooms.textContent, /newer/, 'the newer answer stays');
  assert.doesNotMatch(p.byId.rooms.textContent, /older/);
});

test('a room that closes drops its drafts and armed confirms; an armed Release survives', async () => {
  const bound = { ...ROOM, seats: CLOSED.seats };
  let hold = null;
  const p = await openZh({ rooms: [bound], override: (ch) => (ch === 'roundtable/room' && hold ? hold.p : undefined) });
  typeInto(controls(p).task, '任务草稿');
  p.click('散会');
  // The poll that sees the room closed: the cards first (Release now asks twice), the detail held back.
  hold = deferred();
  p.data.rooms = [CLOSED];
  p.runLoop();
  await settle();
  p.click('解除绑定');
  const pending = hold;
  hold = null;
  pending.resolve({ ok: true, ...CLOSED, roomDir: 'R/demo', task: null, attempt: null, holding: {}, awaitingDecision: null, messages: 0, disclosures: [], stale: [], recent: [], roundActive: false });
  await settle();
  assert.deepEqual([...p.inDetail('textarea'), ...p.inDetail('input')], [], 'the closed detail is read-only');
  // The cards are drawn again from state: Release is still armed.
  p.data.rooms = [{ ...CLOSED, roundId: 2 }];
  p.runLoop();
  await settle();
  assert.equal(p.button('解除绑定'), null);
  assert.ok(p.button('再点一次确认'), p.buttonTexts().join(' | '));
  // Only a probe: drawn as served here again, the room's detail has neither the draft nor the armed close.
  p.data.rooms = [bound];
  p.runLoop();
  await settle();
  assert.equal(controls(p).task.value, '');
  assert.ok(p.button('散会'), p.buttonTexts().join(' | '));
});

test('known refusals are shown in the panel language, others with their own message', async () => {
  const p = await openZh({ override: (ch, pl) => (ch === 'roundtable/admin' && pl.cmd === 'task' ? { ok: false, error: 'ROOM_CLOSED', message: 'room demo is closed; a closed room is not served again', served: 'closed' } : undefined) });
  typeInto(controls(p).task, '新任务');
  p.click('设定任务');
  await settle();
  assert.equal(p.byId.error.hidden, false);
  assert.match(p.byId.error.textContent, /^ROOM_CLOSED: 房间已散会/);
  assert.doesNotMatch(p.byId.error.textContent, /is closed/);
  const en = runPanel({ appearance: { locale: 'en' }, override: (ch) => (ch === 'roundtable/stop' ? { ok: false, error: 'BUSY', message: 'try later' } : undefined) });
  await settle();
  en.click('Stop serving');
  await settle();
  assert.equal(en.byId.error.textContent, 'BUSY: try later');
});

test('a stopped room\'s hint names Serve here only while the service runs', async () => {
  const p = runPanel({ appearance: ZH_APPEARANCE, rooms: [{ ...ROOM, served: 'stopped' }] });
  p.data.serviceRunning = false;
  await settle();
  p.click('详情');
  await settle();
  assert.equal(p.button('在此服务').disabled, true);
  assert.match(p.byId.detail.textContent, /这个房间现在没有服务。/);
  assert.doesNotMatch(p.byId.detail.textContent, /点「在此服务」/);
  p.data.serviceRunning = true;
  p.runLoop();
  await settle();
  assert.equal(p.button('在此服务').disabled, false);
  assert.match(p.byId.detail.textContent, /点「在此服务」后就能在这里管理它/);
});

test('a failed poll\'s error clears on the next good one; an action\'s error is kept', async () => {
  let failRooms = true;
  const p = runPanel({
    appearance: ZH_APPEARANCE,
    override: (ch, pl) => {
      if (ch === 'roundtable/rooms' && failRooms) { failRooms = false; return Promise.reject(new Error('NOT_READY: the plugin is still loading')); }
      if (ch === 'roundtable/admin' && pl.cmd === 'close') return { ok: false, error: 'ROOM_CLOSED', message: 'room demo is closed' };
      return undefined;
    },
  });
  await settle();
  assert.equal(p.byId.error.hidden, false);
  assert.match(p.byId.error.textContent, /NOT_READY/);
  p.runLoop();
  await settle();
  assert.equal(p.byId.error.hidden, true, 'the next good poll clears it');
  p.click('详情');
  await settle();
  p.click('散会');
  p.click('再点一次确认');
  await settle();
  assert.equal(p.byId.error.hidden, false, 'kept through the action\'s own refresh');
  assert.match(p.byId.error.textContent, /ROOM_CLOSED/);
  p.runLoop();
  await settle();
  assert.match(p.byId.error.textContent, /ROOM_CLOSED/, 'and through the next poll');
});

test('polls never stack, and the panel refreshes when it becomes visible again', async () => {
  let slow = null;
  const p = runPanel({ appearance: ZH_APPEARANCE, override: (ch) => (ch === 'roundtable/rooms' && slow ? slow.p : undefined) });
  await settle();
  slow = deferred();
  p.runLoop();
  await settle();
  assert.equal(p.timers.filter((t) => t.fn.name === 'loop').length, 0, 'no poll is scheduled while one is in flight');
  const pending = slow;
  slow = null;
  pending.resolve({ ok: true, serviceRunning: true, roomsRoot: 'R', rooms: [ROOM] });
  await settle();
  assert.equal(p.timers.filter((t) => t.fn.name === 'loop').length, 1, 'scheduled once it finished');
  p.document.hidden = true;
  const before = p.sent('roundtable/rooms').length;
  p.runLoop();
  await settle();
  assert.equal(p.sent('roundtable/rooms').length, before, 'no poll while hidden');
  p.document.hidden = false;
  for (const fn of p.docListeners.visibilitychange || []) fn({ type: 'visibilitychange' });
  await settle();
  assert.equal(p.sent('roundtable/rooms').length, before + 1, 'refreshed on becoming visible');
});
