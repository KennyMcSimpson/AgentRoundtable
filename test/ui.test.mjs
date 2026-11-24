// ui/: static checks on app.js (token handling, admin command names, zero innerHTML, zero CJK, syntax),
// the pure RoomUI model over the fixture, and the mock server (static files, API, loopback Host/Origin check).
// No browser, no temp files, no child process except `node --check` through lib/spawn.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnClean } from '../lib/spawn.mjs';
import { createMockServer, checkHostOrigin, ADMIN_COMMANDS, loadFixture } from '../ui/mock-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI = path.join(ROOT, 'ui');
const APP_JS = path.join(UI, 'app.js');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const htmlSrc = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const interfacesSrc = fs.readFileSync(path.join(ROOT, 'docs', 'INTERFACES.md'), 'utf8');
const fixture = loadFixture();

// P-1 admin commands (lib/admin.mjs / room.mjs baseline contract).
const P1_ADMIN = ['init', 'add-seat', 'set-audit', 'task', 'start', 'cancel', 'skip', 'wake', 'close', 'log', 'show'];

// Admin command names INTERFACES itself names: every `admin <name>` / `room admin <name>` code span,
// plus the backticked words on the "epoch bump" line of section 3 (interrupt / reassign / reverse).
function interfacesAdminCommands(src) {
  const names = new Set();
  for (const m of src.matchAll(/`(?:room )?admin ([a-z][a-z-]*)/g)) names.add(m[1]);
  const epochLine = src.split('\n').find((l) => l.includes('epoch bump'));
  assert.ok(epochLine, 'INTERFACES section 3 has the epoch bump line');
  for (const m of epochLine.matchAll(/`([a-z][a-z-]*)`/g)) names.add(m[1]);
  return names;
}
// Admin commands the room service itself executes: the ADMIN_COMMANDS literal in lib/service.mjs,
// read as text (not imported) so this file stays free of the service's module graph.
function serviceAdminCommands() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'service.mjs'), 'utf8');
  const m = /export const ADMIN_COMMANDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(m, 'lib/service.mjs exports an ADMIN_COMMANDS array literal');
  return [...m[1].matchAll(/'([a-z][a-z-]*)'/g)].map((x) => x[1]);
}
const SERVICE_ADMIN = serviceAdminCommands();
const CONTRACT_ADMIN = new Set([...P1_ADMIN, ...interfacesAdminCommands(interfacesSrc), ...SERVICE_ADMIN]);

function loadRoomUI() {
  // Same realm as the test (so deepStrictEqual compares prototypes fairly), with its own `globalThis`.
  const sandbox = {};
  const fn = new vm.Script(`(function (globalThis) {\n${appSrc}\n})`, { filename: 'app.js' }).runInThisContext();
  fn(sandbox);
  assert.ok(sandbox.RoomUI, 'app.js exposes RoomUI without a document');
  return sandbox.RoomUI;
}
const RoomUI = loadRoomUI();

// Request helper with full control over Host / Origin (fetch() would not let us forge Host).
function req(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ------------------------------------------------------------------------------------------------
// app.js: syntax and static analysis
// ------------------------------------------------------------------------------------------------
test('node --check ui/app.js passes; zero innerHTML and zero CJK in UI room assets', async () => {
  const r = await spawnClean(process.execPath, ['--check', APP_JS], { timeoutMs: 30_000 });
  assert.equal(r.spawnError, null, r.spawnError || '');
  assert.equal(r.code, 0, `node --check failed:\n${r.stderr}`);
  const codeOnly = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/, 'zero innerHTML in app.js');
  for (const rel of ['index.html', 'app.js', 'app.css', 'rt-chat.css', 'mock-server.mjs', 'fixtures/state.json']) {
    const txt = fs.readFileSync(path.join(UI, rel), 'utf8');
    assert.doesNotMatch(txt, /[\u4e00-\u9fff]/, `${rel} contains no CJK characters`);
  }
});

test('node --check ui/mock-server.mjs passes', async () => {
  const r = await spawnClean(process.execPath, ['--check', path.join(UI, 'mock-server.mjs')], { timeoutMs: 30_000 });
  assert.equal(r.code, 0, `node --check failed:\n${r.stderr}`);
});

test('admin token is read from location.hash, never from the query string or storage', () => {
  const m = /function readTokenFromFragment\(\)\s*\{([\s\S]*?)\n  \}/.exec(appSrc);
  assert.ok(m, 'readTokenFromFragment exists');
  assert.match(m[1], /location\.hash/, 'token comes from location.hash');
  assert.doesNotMatch(appSrc, /location\.search|URLSearchParams|location\.href/, 'no query-string reads');
  assert.doesNotMatch(appSrc, /localStorage|sessionStorage|document\.cookie|indexedDB/, 'token is not persisted anywhere');
  assert.match(appSrc, /setToken\(readTokenFromFragment\(\)\)/, 'boot loads the fragment token');
  assert.match(appSrc, /history\.replaceState\(null,\s*'',\s*location\.pathname\)/, 'fragment token is scrubbed from the address bar');
});

test('boot() scrubs #token via history.replaceState and keeps app.token across empty hashchange', () => {
  const replaceCalls = [];
  const winListeners = {};
  const formListeners = {};
  const loc = { pathname: '/', hash: '#0123456789abcdef0123456789abcdef' };
  const tokenInput = { value: '' };
  const tokenState = { textContent: '', className: '' };
  const dummyEl = () => {
    const children = [];
    return {
      textContent: '', className: '', disabled: false, title: '', value: '', placeholder: '',
      dataset: {},
      get firstChild() { return children[0] || null; },
      addEventListener: () => {},
      append: (...nodes) => { children.push(...nodes); },
      appendChild: (c) => { children.push(c); return c; },
      removeChild: (c) => { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
      replaceWith: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { toggle: () => {} },
      setAttribute: () => {},
      getAttribute: () => '',
    };
  };
  const doc = {
    readyState: 'complete',
    documentElement: { lang: 'en', dataset: {}, setAttribute: () => {} },
    addEventListener: () => {},
    getElementById: (id) => {
      if (id === 'token-form') return { addEventListener: (ev, fn) => { formListeners[ev] = fn; } };
      if (id === 'token-input') return tokenInput;
      if (id === 'hdr-token') return tokenState;
      return dummyEl();
    },
    querySelectorAll: () => [],
    querySelector: () => dummyEl(),
    createElement: () => dummyEl(),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  };
  const sandbox = {
    location: loc,
    history: {
      replaceState: (state, title, url) => {
        replaceCalls.push([state, title, url]);
        loc.hash = '';
      },
    },
    window: {
      matchMedia: () => ({ matches: false }),
      addEventListener: (ev, fn) => { winListeners[ev] = fn; },
    },
    document: doc,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ state: {}, room: {}, events: [] }), text: () => Promise.resolve('{}') }),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  const fn = new vm.Script(`(function (globalThis, window, document, location, history, fetch, setInterval, clearInterval, setTimeout, clearTimeout) {\n${appSrc}\n})`, { filename: 'app.js' }).runInThisContext();
  fn(sandbox, sandbox.window, sandbox.document, sandbox.location, sandbox.history, sandbox.fetch, sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.clearTimeout);

  assert.equal(replaceCalls.length, 1, 'boot scrubbed the initial #token');
  assert.deepEqual(replaceCalls[0], [null, '', '/']);
  assert.equal(loc.hash, '');
  assert.match(tokenState.textContent, /^Loaded$/, 'token loaded into memory');

  // Empty hashchange (e.g. triggered after clearing fragment) must NOT wipe the in-memory token.
  winListeners.hashchange();
  assert.match(tokenState.textContent, /^Loaded$/, 'empty hashchange keeps app.token');

  // A new non-empty #token updates app.token and scrubs the fragment again.
  loc.hash = '#fedcba9876543210fedcba9876543210';
  winListeners.hashchange();
  assert.equal(replaceCalls.length, 2, 'new #token scrubbed again');
  assert.equal(loc.hash, '');
  assert.match(tokenState.textContent, /^Loaded$/);

  // Submitting token-form updates app.token and ensures any fragment is scrubbed.
  loc.hash = '#stale';
  tokenInput.value = 'aaaa1111bbbb2222cccc3333dddd4444';
  formListeners.submit({ preventDefault: () => {} });
  assert.equal(replaceCalls.length, 3);
  assert.equal(loc.hash, '');
  assert.equal(tokenInput.value, '');
  assert.match(tokenState.textContent, /^Loaded$/);
});

test('admin token is sent only inside the POST /api/admin body', () => {
  const uses = [...appSrc.matchAll(/app\.token/g)].map((m) => {
    const lineStart = appSrc.lastIndexOf('\n', m.index) + 1;
    const lineEnd = appSrc.indexOf('\n', m.index);
    return { idx: m.index, line: appSrc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd) };
  });
  assert.ok(uses.length > 0);
  for (const { idx, line } of uses) {
    const after = appSrc.slice(idx + 'app.token'.length, idx + 'app.token'.length + 12);
    const before = appSrc.slice(Math.max(0, idx - 20), idx);
    const isTruthiness = /^\s*(\?|\)|;|,|\s*\|\|)/.test(after) || /!!?$/.test(before);
    const isAssign = /^\s*=\s*t\b/.test(after);
    const isBodyPut = /body\.token\s*=\s*$/.test(before);
    assert.ok(isTruthiness || isAssign || isBodyPut, `unexpected use of app.token: ${line.trim()}`);
  }
  const puts = [...appSrc.matchAll(/(\w+)\.token\s*=\s*app\.token/g)];
  assert.equal(puts.length, 1, 'exactly one place copies the token');
  assert.equal(puts[0][1], 'body', 'and it copies it into the request body');
  // That body is JSON-serialized into a POST to /api/admin, with a JSON content type and no token header.
  const tail = appSrc.slice(puts[0].index, puts[0].index + 400);
  assert.match(tail, /fetchJson\('\/api\/admin',\s*\{\s*method:\s*'POST',\s*headers:\s*\{\s*'content-type':\s*'application\/json'\s*\},\s*body:\s*JSON\.stringify\(body\)\s*\}/);
  // Every fetch target is a fixed /api/ path; the only dynamic part is the numeric since= cursor.
  const calls = [...appSrc.matchAll(/fetchJson\(([^\s,)]+)/g)].map((m) => m[1]).filter((t) => t !== 'url');
  assert.deepEqual(calls.sort(), ["'/api/admin'", "'/api/events?since='", "'/api/state'"]);
  assert.match(appSrc, /fetchJson\('\/api\/events\?since=' \+ encodeURIComponent\(String\(since\)\)\)/, 'since= carries only the numeric cursor');
  assert.doesNotMatch(appSrc, /[Hh]eaders\s*[:=][^}]*token/, 'no header carries the token');
  assert.doesNotMatch(appSrc, /\bfetch\([^)]*token/, 'no fetch URL carries the token');
  // The confirm dialog shows the command body before the token is added.
  const confirmIdx = appSrc.indexOf('window.confirm(a.confirm');
  assert.ok(confirmIdx > 0 && confirmIdx < puts[0].index, 'confirm text is built before the token joins the body');
  // The evidence export does not include the word token or any credential.
  const exp = /function exportEvidence\(\)\s*\{([\s\S]*?)\n  \}/.exec(appSrc);
  assert.ok(exp && !/token/i.test(exp[1]), 'export payload carries no token');
});

test('every admin command name used in app.js is one INTERFACES defines', () => {
  // Static: every `cmd: '<name>'` literal in the source.
  const literal = [...appSrc.matchAll(/\bcmd:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(literal.length >= 10, 'found the ACTIONS table');
  for (const name of literal) assert.ok(CONTRACT_ADMIN.has(name), `app.js sends cmd=${name}, which INTERFACES does not define`);
  // Dynamic: the loaded ACTIONS table.
  const live = Object.values(RoomUI.ACTIONS).map((a) => a.cmd).filter(Boolean);
  for (const name of live) assert.ok(CONTRACT_ADMIN.has(name), `ACTIONS cmd=${name} not in INTERFACES`);
  // The UI posts only to the room service's /api/admin, so every enabled action must be one it executes.
  for (const name of live) assert.ok(SERVICE_ADMIN.includes(name), `ACTIONS cmd=${name} is not executed by lib/service.mjs`);
  assert.deepEqual([...new Set(live)].sort(), [...new Set(literal)].sort(), 'static and runtime views agree');
  // Actions with no contract command are disabled with an English reason, never sent.
  for (const [key, a] of Object.entries(RoomUI.ACTIONS)) {
    if (a.cmd) continue;
    assert.ok(typeof a.reason === 'string' && a.reason.length > 10 && !/[\u4e00-\u9fff]/.test(a.reason), `${key} has an English reason`);
    assert.throws(() => RoomUI.buildCommand(key, {}), (e) => e.message === a.reason);
  }
  // The mock server accepts every command INTERFACES names and every command the UI sends, and nothing
  // outside the contract-or-service set.
  for (const name of [...P1_ADMIN, ...interfacesAdminCommands(interfacesSrc), ...live]) assert.ok(ADMIN_COMMANDS.includes(name), `mock-server accepts ${name}`);
  for (const name of ADMIN_COMMANDS) assert.ok(CONTRACT_ADMIN.has(name), `mock-server accepts ${name}, which neither INTERFACES nor lib/service.mjs defines`);
});

test('buildCommand produces the admin-queue shapes lib/admin.mjs uses', () => {
  assert.deepEqual(RoomUI.buildCommand('start', { order: 'A, B,A' }), { cmd: 'start', order: ['A', 'B', 'A'] });
  assert.deepEqual(RoomUI.buildCommand('task', { text: 't' }), { cmd: 'task', text: 't' });
  assert.deepEqual(RoomUI.buildCommand('wake', { seatId: 'A' }), { cmd: 'wake', seatId: 'A' });
  assert.deepEqual(RoomUI.buildCommand('say', { text: 'hi' }), { cmd: 'say', text: 'hi' });
  assert.deepEqual(RoomUI.buildCommand('reconcile', { attemptId: 'att-b2', action: 'void' }), { cmd: 'reconcile', attemptId: 'att-b2', action: 'void' });
  assert.deepEqual(RoomUI.buildCommand('cancel', {}), { cmd: 'cancel' });
  assert.throws(() => RoomUI.buildCommand('start', { order: '' }), /Missing parameter order/);
  assert.throws(() => RoomUI.buildCommand('reconcile', { attemptId: 'x' }), /Missing parameter action/);
  for (const k of Object.keys(RoomUI.ACTIONS)) {
    const a = RoomUI.ACTIONS[k];
    if (!a.cmd) continue;
    try { assert.ok(!('token' in RoomUI.buildCommand(k, { text: 'x', order: 'A', seatId: 'A', toSeatId: 'B', attemptId: 'a', action: 'replay', id: 'dsc-1', reason: 'r', manifestSha: 'abc' })), `${k} body has no token before send`); } catch (e) { assert.fail(`${k}: ${e.message}`); }
  }
});

test('index.html: every data-action is a known action, every tab has its view', () => {
  const actions = [...htmlSrc.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(actions.length > 5);
  for (const a of actions) assert.ok(a === 'export-evidence' || RoomUI.ACTIONS[a], `index.html data-action=${a} has no ACTIONS entry`);
  const tabs = [...htmlSrc.matchAll(/<button data-view="([^"]+)"/g)].map((m) => m[1]);
  const views = [...htmlSrc.matchAll(/<section id="view-([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, views, 'one section per tab, same order');
  assert.deepEqual(tabs, ['stream', 'seats', 'packets', 'task', 'items', 'verdicts', 'receipts', 'usage', 'recovery', 'merge', 'contract']);
  for (const v of tabs) assert.match(appSrc, new RegExp(`VIEWS\\.${v} = function`), `app.js renders view ${v}`);
  assert.match(htmlSrc, /<meta name="referrer" content="no-referrer">/, 'fragment token never leaks via Referer');
  // Regression (found in a browser render): td({class}, ...) must treat the leading object as attributes.
  if (/td\(\{ class:/.test(appSrc)) assert.match(appSrc, /function td\(\) \{\s*\n\s*var args = Array\.prototype\.slice\.call\(arguments\);\s*\n\s*var attrs = args\.length && isObj\(args\[0\]\) && !args\[0\]\.nodeType/, 'td() takes a leading attribute object');
  assert.doesNotMatch(htmlSrc, /<script>(?!<\/script>)|\son[a-z]+="/, 'no inline script or inline handlers (CSP script-src self)');
  assert.doesNotMatch(htmlSrc, /<style>|\sstyle=/, 'no inline style in index.html');
});

// ------------------------------------------------------------------------------------------------
// RoomUI over the fixture: every view has data, and missing fields say Unknown
// ------------------------------------------------------------------------------------------------
test('fixture events fold into every view model', () => {
  const d = RoomUI.derive(fixture.events);
  const { state, room } = fixture;
  assert.equal(d.lastSeq, 68);
  assert.equal(d.epoch, 1);
  // needs_reconcile
  const rec = RoomUI.attemptsNeedingReconcile(d, state);
  assert.deepEqual(rec.map((r) => r.attemptId), ['att-b2']);
  // stale artifact + stale verdict
  const artB = d.artifacts['b3f0c2d4e6a8091b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d'];
  assert.equal(artB.recomputed.stale, true);
  assert.equal(artB.verdicts[0].annotation, 'stale');
  assert.equal(artB.verdicts[0].verdict, 'disclose');
  // tainted seat
  const seats = RoomUI.seatList(state, room, d);
  assert.deepEqual(seats.map((s) => s.seatId), ['A', 'B', 'C', 'D', 'P']);
  const obsC = RoomUI.auditObservation(seats.find((s) => s.seatId === 'C'), d);
  assert.equal(obsC.tone, 'bad');
  assert.match(obsC.text, /^tainted/);
  assert.equal(RoomUI.auditObservation(seats.find((s) => s.seatId === 'D'), d).text, 'Unaudited');
  // Executor B wrote in a work attempt: reported as observed writes, not as "no writes observed", not tainted.
  const obsB = RoomUI.auditObservation(seats.find((s) => s.seatId === 'B'), d);
  assert.match(obsB.text, /^Observed 1 write/);
  assert.doesNotMatch(obsB.text, /No writes observed/i);
  assert.doesNotMatch(appSrc, /read-only|zero writes|\bno writes\b(?! observed)/i, 'never claims read-only or guaranteed zero writes, only not observed');
  // unanswered items
  const st = Object.fromEntries(Object.values(d.items).map((it) => [it.itemId, RoomUI.itemStatus(it, d)]));
  assert.deepEqual(st, { i1: 'accepted', i2: 'unanswered', i3: 'unanswered' });
  assert.equal(RoomUI.itemMisquoted({ aboutSeq: 35 }, d), true);
  assert.equal(RoomUI.latestSummary(d).version, 2);
  assert.equal(RoomUI.latestSummary(d).supersedes, 1);
  assert.equal(d.supersededNotices.length, 1);
  // pending disclosure
  assert.equal(d.disclosures['dsc-1'].status, 'requested');
  assert.equal(d.disclosures['dsc-2'].status, 'executed');
  assert.equal(d.disclosures['dsc-2'].exec.exitCode, 0);
  // usage paused, embedded seat unknown, hosted seat known
  const sum = RoomUI.usageSummary(state, room, d);
  assert.equal(sum.paused, true);
  assert.equal(sum.knownTokens, 158000);
  assert.equal(sum.maxTokens, 150000);
  assert.equal(sum.unknownReports, 1);
  const uB = RoomUI.seatUsage(state, d, 'B');
  assert.equal(uB.input, null, 'embedded seat usage stays unknown, not 0');
  assert.equal(RoomUI.seatUsage(state, d, 'P').input, 120000);
  assert.equal(RoomUI.seatUsage(state, d, 'A'), null);
  // receipts: sent / header_only / present / unknown all appear
  const receipts = new Set(RoomUI.receiptRows(d).map((p) => p.receipt));
  for (const r of ['sent', 'header_only', 'present', 'unknown']) assert.ok(receipts.has(r), `receipt ${r} present`);
  // quotes read the quoted seq, not the event seq
  assert.deepEqual(d.quotes.map((q) => [q.seq, q.verified]), [[25, true], [23, false]]);
  // merge conflicts from state
  assert.equal(RoomUI.mergeConflicts(state, d).length, 1);
  // failures, wakes, round reopen, task draft
  assert.equal(d.failures[0].class, 'rate_limited');
  assert.equal(RoomUI.wakesTotal(d, 'C'), 1);
  assert.equal(d.reopened[0].epoch, 1);
  assert.equal(d.taskConfirmed.by, 'admin');
});

test('missing fields render as Unknown, never as a guess', () => {
  const d = RoomUI.emptyDerived();
  assert.equal(RoomUI.u(undefined), 'Unknown');
  assert.equal(RoomUI.u(null), 'Unknown');
  assert.equal(RoomUI.u(''), 'Unknown');
  assert.equal(RoomUI.u(0), '0');
  assert.equal(RoomUI.fmtTs(undefined), 'Unknown');
  assert.equal(RoomUI.fmtBytes(undefined), 'Unknown');
  assert.equal(RoomUI.fmtArgv(undefined), 'Unknown');
  assert.equal(RoomUI.shortSha(undefined), 'Unknown');
  assert.equal(RoomUI.seatAgent({ seatId: 'X' }), 'Unknown');
  assert.equal(RoomUI.seatForm({ seatId: 'X' }), 'Unknown');
  assert.equal(RoomUI.auditSource({ seatId: 'X' }), 'Unknown');
  assert.equal(RoomUI.auditSource({ seatId: 'X', audit: null }), 'Unregistered');
  assert.equal(RoomUI.projectedTurns({}), null);
  const empty = RoomUI.usageSummary({}, null, d);
  assert.equal(empty.paused, null, 'paused unknown without data');
  assert.equal(empty.knownTokens, null, 'no known usage is null, not 0');
  assert.equal(empty.maxTokens, undefined, 'cap unknown');
  assert.equal(RoomUI.usageSummary({}, { budget: { maxTokens: null } }, d).paused, false, 'no cap -> never paused');
  // Usage report with missing numbers stays unknown.
  const d2 = RoomUI.derive([{ seq: 1, type: 'usage_reported', seatId: 'B', attemptId: 'a', source: 'declared' }]);
  assert.equal(RoomUI.seatUsage({}, d2, 'B').input, null);
  assert.equal(RoomUI.usageSummary({}, null, d2).knownTokens, null);
  // Item after a summary that neither marks nor lists it: unknown, not unanswered.
  const d3 = RoomUI.derive([
    { seq: 1, ts: '2026-10-01T00:00:01Z', type: 'point_added', itemId: 'i9', seatId: 'C', aboutSeq: 1, text: 'x' },
    { seq: 2, ts: '2026-10-01T00:00:02Z', type: 'summary_published', version: 1, seatId: 'A', unanswered: [] },
  ]);
  assert.equal(RoomUI.itemStatus(d3.items.i9, d3), 'unknown');
  // Quote without a verification result.
  const d4 = RoomUI.derive([{ seq: 1, type: 'quote_submitted', seatId: 'C', attemptId: 'a', quotedSeq: 1, text: 'x' }]);
  assert.equal(d4.quotes[0].verified, null);
  // Unknown event types and junk are ignored.
  assert.doesNotThrow(() => RoomUI.derive([null, 1, 'x', { type: 'no_such_event', seq: 3 }, { seq: 4 }]));
  // Views use Unknown / u() for the fields INTERFACES leaves optional.
  assert.doesNotMatch(appSrc, /v\.annotation \|\| 'none'|confirmed\.by \|\| 'admin'/, 'no defaulted annotation / confirmer');
});

// CF-4: the service emits user_message_queued {msgSeq} (lib/service.mjs); `seq` is the event envelope.
test('user_message_queued shows the message seq (msgSeq), not the event envelope seq', () => {
  const d = RoomUI.derive([{ seq: 120, ts: 't', type: 'user_message_queued', msgSeq: 37, text: 'Please redo the summary' }]);
  assert.equal(d.userMessages[0].seq, 37, 'message seq is msgSeq');
  assert.equal(d.userMessages[0].eventSeq, 120, 'event seq kept separately');
  const entry = d.stream.find((e) => e.kind === 'user');
  assert.equal(entry.msgSeq, 37);
  assert.equal(entry.seq, 120, 'stream entry seq stays the event seq (ordering, markers)');
  // Without msgSeq the message seq is unknown, never the envelope seq.
  const d2 = RoomUI.derive([{ seq: 121, type: 'user_message_queued', text: 'x' }]);
  assert.equal(d2.userMessages[0].seq, null);
  // The stream view labels the user message with msgSeq and shows the event number apart from it.
  assert.match(appSrc, /badge\('User Message', 'user'\), badge\('seq ' \+ u\(e\.msgSeq\)\)/, 'user message badge reads msgSeq');
  // Fixture events carry the field name the service emits.
  for (const ev of fixture.events.filter((e) => e.type === 'user_message_queued')) assert.ok(Number.isInteger(ev.msgSeq), 'fixture user_message_queued has msgSeq');
});

// GOV-14: disclosure decisions and stale acceptance are live actions with the CLI's parameter shapes.
test('approve-disclose / deny-disclose / accept-stale are enabled and send what the service expects', () => {
  for (const k of ['approve-disclose', 'deny-disclose', 'accept-stale']) {
    const a = RoomUI.ACTIONS[k];
    assert.equal(a.cmd, k, `${k} is enabled`);
    assert.ok(SERVICE_ADMIN.includes(k), `${k} is executed by lib/service.mjs`);
    assert.ok(typeof a.confirm === 'string' && a.confirm.length > 10 && !/[\u4e00-\u9fff]/.test(a.confirm), `${k} asks for confirmation in English`);
  }
  assert.deepEqual(RoomUI.buildCommand('approve-disclose', { id: 'dsc-1' }), { cmd: 'approve-disclose', id: 'dsc-1' });
  assert.deepEqual(RoomUI.buildCommand('deny-disclose', { id: 'dsc-1', reason: ' Too broad ' }), { cmd: 'deny-disclose', id: 'dsc-1', reason: 'Too broad' });
  assert.deepEqual(RoomUI.buildCommand('accept-stale', { manifestSha: 'abc' }), { cmd: 'accept-stale', manifestSha: 'abc' });
  // Same rule as `room admin deny-disclose <id> --reason`: an empty reason is refused before sending.
  assert.throws(() => RoomUI.buildCommand('deny-disclose', { id: 'dsc-1', reason: '   ' }), /Missing parameter reason/);
  assert.throws(() => RoomUI.buildCommand('deny-disclose', { id: 'dsc-1' }), /Missing parameter reason/);
  assert.throws(() => RoomUI.buildCommand('approve-disclose', {}), /Missing parameter id/);
  assert.throws(() => RoomUI.buildCommand('accept-stale', {}), /Missing parameter manifestSha/);
});

// Service-side review fixes surfaced in the UI: GOV-3 (only the resolved reviewer binds; verified),
// GOV-7 (awaitingDecision -> retry / skip / reassign; absent markers), CF-3 (no_artifact),
// NI-6 (a refused wake pushed nothing and is not counted).
test('fold: authorized / tainted verdicts, summary verified + absent + noArtifact, refused wakes, work_no_artifact', () => {
  const sha = 'a'.repeat(64);
  const d = RoomUI.derive([
    { seq: 1, type: 'round_started', roundId: 1, order: ['A', 'B', 'C'], epoch: 0 },
    { seq: 2, type: 'verdict_recorded', seatId: 'C', attemptId: 'x1', artifactSha: sha, verdict: 'pass', annotation: 'none', annotations: ['none'], authorized: false, tainted: false, producer: 'B' },
    { seq: 3, type: 'verdict_recorded', seatId: 'A', attemptId: 'x2', artifactSha: sha, verdict: 'pass', annotation: 'accepted_stale', annotations: ['accepted_stale', 'tainted'], authorized: true, tainted: true, producer: 'B' },
    { seq: 4, type: 'wake_pushed', seatId: 'A', attemptId: 'x2', command_ok: false, refused: 'THREAD_BUSY', detail: 'THREAD_BUSY: thread has an active turn; manual wake required' },
    { seq: 5, type: 'wake_pushed', seatId: 'A', attemptId: 'x2', command_ok: true, detail: 'ok' },
    { seq: 6, type: 'work_no_artifact', seatId: 'B', attemptId: 'w1', roundId: 1, reason: 'empty', manifestSha: sha },
    { seq: 7, type: 'attempt_expired', seatId: 'C', attemptId: 'x3', hold: true },
    { seq: 8, type: 'summary_published', version: 1, seatId: 'A', attemptId: 'x4', unanswered: [], supersedes: null, verdicts: [], excluded: [{ artifactSha: sha, verdict: 'pass', seatId: 'C', annotation: 'not_reviewer', authorized: false }],
      verified: [{ artifactSha: sha, producer: 'B', verified: false, reason: 'TAINTED', by: 'A' }], absent: [{ seatId: 'C', phase: 'meet', by: 'admin', attemptId: 'x3' }], noArtifact: [{ seatId: 'B', attemptId: 'w1', reason: 'empty', manifestSha: sha }] },
  ]);
  assert.deepEqual(d.verdicts.map((v) => [v.seatId, v.authorized, v.tainted]), [['C', false, false], ['A', true, true]]);
  assert.deepEqual(d.verdicts[1].annotations, ['accepted_stale', 'tainted'], 'the taint is kept beside accepted_stale');
  assert.equal(RoomUI.wakesThisRound(d, 'A'), 1, 'the refused wake is not counted');
  assert.equal(RoomUI.wakesTotal(d, 'A'), 1);
  assert.equal(RoomUI.wakeRefusalsFor(d, 'A')[0].refused, 'THREAD_BUSY');
  assert.ok(d.stream.some((e) => /manual wake required/.test(e.text || '')));
  assert.equal(d.noArtifact.length, 1);
  assert.ok(d.stream.some((e) => /no_artifact/.test(e.text || '')));
  assert.ok(d.stream.some((e) => /awaiting user decision/.test(e.text || '')), 'a held expiry says the room waits for the user');
  const v = RoomUI.verifiedFor(d, sha);
  assert.deepEqual([v.verified, v.reason], [false, 'TAINTED']);
  assert.equal(RoomUI.verifiedFor(d, 'b'.repeat(64)), null);
  const sm = RoomUI.latestSummary(d);
  assert.deepEqual(sm.absent.map((x) => x.seatId), ['C']);
  assert.deepEqual(sm.noArtifact.map((x) => x.seatId), ['B']);
  // The view text for a non-reviewer verdict and the Verified badge come from these fields.
  assert.match(appSrc, /Non-reviewer opinion \(excluded\)/);
  assert.match(appSrc, /v\.authorized === true/);
  assert.match(appSrc, /'Verified'/);
  // awaitingDecision -> retry (same seat), skip, reassign.
  assert.equal(RoomUI.awaitingDecision({}), null);
  assert.equal(RoomUI.awaitingDecision({ awaitingDecision: { seatId: 'C', attemptId: 'x3', phase: 'meet' } }).seatId, 'C');
  assert.deepEqual(RoomUI.buildCommand('retry', { seatId: 'C' }), { cmd: 'retry', seatId: 'C' });
  assert.deepEqual(RoomUI.buildCommand('retry', {}), { cmd: 'retry' });
  assert.ok(SERVICE_ADMIN.includes('retry'));
  assert.match(appSrc, /actionButton\('retry'/);
});

test('INTERFACES section 4 event names used by the fold all exist in the contract', () => {
  const contractEvents = new Set();
  const sec4 = interfacesSrc.slice(interfacesSrc.indexOf('## 4.'), interfacesSrc.indexOf('## 5.'));
  for (const m of sec4.matchAll(/(?:^|\s)([a-z]+(?:_[a-z]+)*) \{/gm)) contractEvents.add(m[1]);
  const existing = /Existing:\s*`([^`]+)`/.exec(sec4);
  assert.ok(existing, 'section 4 lists the existing events');
  for (const t of existing[1].split(/\s+/)) contractEvents.add(t);
  assert.ok(contractEvents.size >= 40, `parsed ${contractEvents.size} event names`);
  const folded = [...appSrc.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  assert.ok(folded.length > 40);
  for (const t of folded) assert.ok(contractEvents.has(t), `app.js folds ${t}, which INTERFACES section 4 does not define`);
  for (const ev of fixture.events) assert.ok(contractEvents.has(ev.type), `fixture event ${ev.type} is in INTERFACES section 4`);
});

// ------------------------------------------------------------------------------------------------
// Mock server
// ------------------------------------------------------------------------------------------------
let mock;
before(async () => { mock = await createMockServer(); });
after(async () => { if (mock) await mock.close(); });

test('mock server binds 127.0.0.1 on an ephemeral port', () => {
  const addr = mock.server.address();
  assert.equal(addr.address, '127.0.0.1');
  assert.ok(addr.port > 0);
  assert.match(mock.token, /^[0-9a-f]{32}$/);
});

test('GET / and the assets', async () => {
  const root = await req(mock.port, { pathname: '/' });
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /^text\/html/);
  assert.match(root.text, /<script src="app\.js"><\/script>/);
  assert.match(root.text, /href="app\.css"/);
  assert.match(root.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(root.headers['referrer-policy'], 'no-referrer');
  const js = await req(mock.port, { pathname: '/app.js' });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal(js.text, appSrc);
  const css = await req(mock.port, { pathname: '/app.css' });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  for (const p of ['/mock-server.mjs', '/fixtures/state.json', '/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/nope.js']) {
    const r = await req(mock.port, { pathname: p });
    assert.equal(r.status, 404, `${p} is not served`);
  }
});

test('GET /api/state and /api/events?since=', async () => {
  const st = await req(mock.port, { pathname: '/api/state' });
  assert.equal(st.status, 200);
  assert.equal(st.json.state.phase, 'meet');
  assert.equal(st.json.room.id, 'demo');
  const all = await req(mock.port, { pathname: '/api/events?since=0' });
  assert.equal(all.json.events.length, fixture.events.length);
  const tail = await req(mock.port, { pathname: '/api/events?since=60' });
  assert.deepEqual(tail.json.events.map((e) => e.seq), [61, 62, 63, 64, 65, 66, 67, 68]);
  assert.equal(tail.json.lastSeq, 68);
  assert.equal((await req(mock.port, { pathname: '/api/events?since=-1' })).status, 400);
  assert.equal((await req(mock.port, { pathname: '/api/events?since=abc' })).status, 400);
  // The page's own unwrap/fold understands what the mock serves.
  const un = RoomUI.unwrapState(st.json);
  assert.equal(un.room.id, 'demo');
  assert.equal(RoomUI.unwrapEvents(tail.json).length, 8);
});

test('POST /api/admin: token only in the body, contract commands only, echo without the token', async () => {
  const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${mock.port}` };
  const ok = await req(mock.port, { method: 'POST', pathname: '/api/admin', headers, body: { token: mock.token, cmd: 'say', text: 'hello' } });
  assert.equal(ok.status, 200);
  assert.deepEqual({ ok: ok.json.ok, cmd: ok.json.cmd, params: ok.json.params }, { ok: true, cmd: 'say', params: { text: 'hello' } });
  assert.ok(!JSON.stringify(ok.json).includes(mock.token), 'echo does not reflect the token');
  assert.ok(!JSON.stringify(mock.received).includes(mock.token), 'recorded posts drop the token');
  const inUrl = await req(mock.port, { method: 'POST', pathname: `/api/admin?token=${mock.token}`, headers, body: { token: mock.token, cmd: 'say', text: 'x' } });
  assert.equal(inUrl.status, 400);
  assert.equal(inUrl.json.error, 'TOKEN_IN_URL');
  const noTok = await req(mock.port, { method: 'POST', pathname: '/api/admin', headers: { ...headers, authorization: `Bearer ${mock.token}` }, body: { cmd: 'say', text: 'x' } });
  assert.equal(noTok.status, 401, 'a header token is not accepted');
  const bad = await req(mock.port, { method: 'POST', pathname: '/api/admin', headers, body: { token: 'f'.repeat(32), cmd: 'say', text: 'x' } });
  assert.equal(bad.status, 401);
  const unk = await req(mock.port, { method: 'POST', pathname: '/api/admin', headers, body: { token: mock.token, cmd: 'merge-apply', id: 'dsc-1' } });
  assert.equal(unk.status, 400);
  assert.equal(unk.json.error, 'UNKNOWN_CMD');
  const form = await req(mock.port, { method: 'POST', pathname: '/api/admin', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${mock.token}&cmd=close` });
  assert.equal(form.status, 415, 'simple cross-site form posts are refused');
  const get = await req(mock.port, { pathname: '/api/admin' });
  assert.equal(get.status, 405);
  // Every enabled UI action round-trips through the mock.
  for (const [key, a] of Object.entries(RoomUI.ACTIONS)) {
    if (!a.cmd) continue;
    const body = RoomUI.buildCommand(key, { text: 'x', order: 'A,B', seatId: 'A', toSeatId: 'B', attemptId: 'att-b2', action: 'replay', id: 'dsc-1', reason: 'reason', manifestSha: 'abc' });
    body.token = mock.token;
    const r = await req(mock.port, { method: 'POST', pathname: '/api/admin', headers, body });
    assert.equal(r.status, 200, `${key} -> ${a.cmd}: ${r.text}`);
  }
});

test('Host / Origin check (DNS rebinding and cross-site requests)', async () => {
  const p = mock.port;
  const cases = [
    [{ host: `evil.example:${p}` }, 403, 'BAD_HOST'],
    [{ host: `127.0.0.1:${p + 1}` }, 403, 'BAD_HOST'],
    [{ host: '127.0.0.1' }, 403, 'BAD_HOST'],
    [{ host: `localhost:${p}` }, 200, null],
    [{ host: `127.0.0.1:${p}`, origin: 'http://evil.example' }, 403, 'BAD_ORIGIN'],
    [{ host: `127.0.0.1:${p}`, origin: 'null' }, 403, 'BAD_ORIGIN'],
    [{ host: `127.0.0.1:${p}`, origin: `https://127.0.0.1:${p}` }, 403, 'BAD_ORIGIN'],
    [{ host: `127.0.0.1:${p}`, origin: `http://localhost:${p}` }, 200, null],
    [{ host: `127.0.0.1:${p}`, 'sec-fetch-site': 'cross-site' }, 403, 'BAD_FETCH_SITE'],
    [{ host: `127.0.0.1:${p}`, 'sec-fetch-site': 'same-origin' }, 200, null],
  ];
  for (const [headers, status, error] of cases) {
    const r = await req(p, { pathname: '/api/state', headers });
    assert.equal(r.status, status, JSON.stringify(headers));
    if (error) {
      assert.equal(r.json.error, error);
      assert.ok(!r.text.includes('demo'), 'refused requests get no room data');
    }
  }
  // The gate covers static files and admin posts too.
  assert.equal((await req(p, { pathname: '/', headers: { host: `evil.example:${p}` } })).status, 403);
  const post = await req(p, { method: 'POST', pathname: '/api/admin', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: { token: mock.token, cmd: 'close' } });
  assert.equal(post.status, 403);
  // Pure function, same answers.
  assert.equal(checkHostOrigin({ host: `127.0.0.1:${p}` }, p).ok, true);
  assert.equal(checkHostOrigin({}, p).error, 'BAD_HOST');
  assert.equal(checkHostOrigin({ host: `LOCALHOST:${p}` }, p).ok, true);
  // F1, kept in step with lib/http.mjs: a same-site top-level navigation opens the page only.
  const nav = { host: `127.0.0.1:${p}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const page = await req(p, { pathname: '/', headers: nav });
  assert.equal(page.status, 200, 'GET / from the lobby link');
  assert.match(page.text, /app\.js/);
  assert.equal((await req(p, { pathname: '/api/state', headers: nav })).status, 403, 'same-site to the API refused');
  assert.equal((await req(p, { pathname: '/app.js', headers: { ...nav, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } })).status, 403);
  const httpMod = await import('../lib/http.mjs');
  for (const [h, r] of [[nav, { method: 'GET', path: '/' }], [nav, { method: 'GET', path: '/api/state' }], [{ ...nav, 'sec-fetch-dest': 'iframe' }, { method: 'GET', path: '/' }], [nav, { method: 'POST', path: '/' }]]) {
    assert.deepEqual(checkHostOrigin(h, p, r), httpMod.checkHostOrigin(h, p, r), `mock and service gates agree: ${JSON.stringify(r)}`);
  }
});
