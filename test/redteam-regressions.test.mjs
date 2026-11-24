// Regression tests locking in every High/Medium/Low defect caught during v0.2.0 red-team review.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isReadOnlyCommand } from '../lib/audit.mjs';
import { seatCommandPrefix, seatRoomCmd } from '../lib/join.mjs';
import { probeLockHolder } from '../lib/service.mjs';
import { createDaemonStore, REGISTRY_FILE } from '../lib/daemon-store.mjs';
import { startLobby } from '../lib/lobby.mjs';
import { cmdWait } from '../lib/seat.mjs';
import { createRoom, addSeat } from '../lib/api.mjs';
import { malformedFollowUp, REASON_TEXT } from '../lib/structured.mjs';
import { testRunsRoot, randomHex, ROOM_FILES as F } from '../lib/common.mjs';
import { isPublicPath } from '../dist/public-scan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI = path.join(ROOT, 'ui');
const roots = [];
const lobbies = [];

after(async () => {
  for (const l of lobbies) await l.close().catch(() => {});
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true });
});

function tempDir(tag) {
  const b = path.join(testRunsRoot(), `rt-reg-${tag}-${randomHex(4)}`);
  fs.mkdirSync(b, { recursive: true });
  roots.push(b);
  return b;
}

function req(port, { method = 'GET', pathname = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function makeMiniDoc() {
  function makeNode(tag) {
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className: '',
      attrs: {},
      children: [],
      _text: '',
      classList: { toggle() {} },
      addEventListener() {},
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] || ''; },
      appendChild(c) {
        if (c && c.nodeType === 11) { for (const x of c.children) this.children.push(x); return c; }
        this.children.push(c);
        return c;
      },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
      get firstChild() { return this.children[0] || null; },
    };
  }
  return {
    createElement: (tag) => makeNode(tag),
    createTextNode: (t) => ({ nodeType: 3, tagName: '#TEXT', textContent: String(t), children: [], attrs: {} }),
    createDocumentFragment: () => ({ nodeType: 11, children: [], appendChild(c) { this.children.push(c); return c; } }),
  };
}

// ---- H1: POSIX room.sh allowlisted in audit & selected by platform in join.mjs ----
test('H1: audit classifies room.sh and sh/bash room.sh as room (never tainted); join uses room.sh on POSIX', () => {
  assert.equal(isReadOnlyCommand('/tmp/seat/room.sh verdict pass --seat /tmp/seat').class, 'room');
  assert.equal(isReadOnlyCommand('sh /tmp/seat/room.sh submit --seat /tmp/seat').class, 'room');
  assert.equal(isReadOnlyCommand('bash "/tmp/my seat/room.sh" wait --seat /tmp/seat').class, 'room');
  const appSeat = { runtime: { kind: 'app', exe: '/opt/roundtable/app' } };
  assert.match(seatCommandPrefix({ seat: appSeat, seatDir: '/tmp/seat', roomMjs: '/app/room.mjs', platform: 'darwin' }), /room\.sh$/);
  assert.match(seatRoomCmd({ seat: appSeat, seatDir: '/tmp/seat', fallback: 'node /app/room.mjs', platform: 'linux' }), /room\.sh$/);
  assert.match(seatCommandPrefix({ seat: appSeat, seatDir: 'C:\\seat', roomMjs: 'C:\\room.mjs', platform: 'win32' }), /room\.cmd$/);
});

// ---- H2 & M4: cmdWait survives fs.watch error & transient EBUSY without hanging or crashing ----
test('H2 + M4: cmdWait survives watcher error and transient EBUSY without hanging or crashing', async () => {
  const b = tempDir('wait');
  const roomDir = path.join(b, 'room');
  const cwdA = path.join(b, 'cwdA');
  fs.mkdirSync(cwdA, { recursive: true });
  assert.equal((await createRoom({ dir: roomDir, id: 'w1', preset: 'discussion' })).code, 0);
  assert.equal((await addSeat({ dir: roomDir, seat: 'A', role: 'lead', wait: 'background', cwd: cwdA })).code, 0);
  const seatDir = path.join(roomDir, 'seats', 'A');
  // Seed state.json + events.jsonl so cmdWait enters the wait loop and exercises readEvents() + watcher
  fs.writeFileSync(path.join(roomDir, F.state), JSON.stringify({ phase: 'idle', roundId: 0, epoch: 0, closed: false, seats: { A: { status: 'joined' } } }));
  fs.writeFileSync(path.join(roomDir, F.events), `${JSON.stringify({ seq: 1, type: 'seat_joined', seatId: 'A', ts: new Date().toISOString() })}\n`);

  const origWatch = fs.watch;
  const origOpen = fs.openSync;
  let injectedEbusy = false;
  fs.watch = () => {
    const em = new EventEmitter();
    em.close = () => {};
    setTimeout(() => em.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' })), 40);
    return em;
  };
  fs.openSync = function (p, ...rest) {
    if (!injectedEbusy && String(p).endsWith(F.events)) {
      injectedEbusy = true;
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    }
    return origOpen.call(fs, p, ...rest);
  };
  try {
    const lines = [];
    const t0 = Date.now();
    const code = await cmdWait({ seat: seatDir, timeout: '0.25' }, { pollMs: 50, out: (l) => lines.push(l) });
    const elapsed = Date.now() - t0;
    assert.equal(code, 0);
    assert.ok(elapsed >= 200 && elapsed < 3000, `expected timeout ~250ms, got ${elapsed}ms`);
    assert.match(lines[0], /^NOT_YOUR_TURN\b/);
  } finally {
    fs.watch = origWatch;
    fs.openSync = origOpen;
  }
});

// ---- H3: Deeply nested blockquotes never overflow stack ----
test('H3: RoomMarkdown.parseBlocks handles 15,000 nested > without RangeError', () => {
  const src = fs.readFileSync(path.join(UI, 'rt-markdown.js'), 'utf8');
  const sandbox = { URL };
  new vm.Script(`(function (globalThis, URL) {\n${src}\n})`, { filename: 'rt-markdown.js' }).runInThisContext()(sandbox, URL);
  const blocks = sandbox.RoomMarkdown.parseBlocks('>'.repeat(15000));
  assert.ok(Array.isArray(blocks) && blocks.length >= 1);
});

// ---- H4 + L1 + M5: SSE + poll dedup, seatList 'toString', verdicts unknownCommands display ----
test('H4 + L1 + M5: app.js dedups SSE+poll, preserves seat named toString, handles room_closed, renders unknownCommands.command', async () => {
  const appSrc = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  // Static check: room_closed listener and poll uses ingestEvent
  assert.match(appSrc, /es\.addEventListener\('room_closed'/);
  assert.match(appSrc, /list\.forEach\(function \(e\) \{ ingestEvent\(e\); \}\)/);
  assert.match(appSrc, /u\(c\.command\)/);

  // L1: seatList with seatId 'toString'
  const pureBox = {};
  new vm.Script(`(function (globalThis) {\n${appSrc}\n})`, { filename: 'app.js' }).runInThisContext()(pureBox);
  const seats = pureBox.RoomUI.seatList({ seats: { A: { status: 'joined' }, toString: { status: 'joined' } } }, null, pureBox.RoomUI.emptyDerived());
  assert.deepEqual(seats.map((s) => s.seatId).sort(), ['A', 'toString']);

  // H4 runtime simulation: SSE delivers seq=1 before concurrent poll resolves with [seq=1]
  let resolveEventsFetch;
  const eventsFetchPromise = new Promise((r) => { resolveEventsFetch = r; });
  const esListeners = {};
  class FakeEventSource {
    constructor() { FakeEventSource.instance = this; }
    addEventListener(ev, fn) { esListeners[ev] = fn; }
    close() { this.closed = true; }
  }
  const streamItems = [];
  const dummyEl = (id) => ({
    id: id || '', textContent: '', className: '', _html: '', disabled: false, title: '', value: '', placeholder: '',
    set innerHTML(v) { this._html = v; if (id === 'stream' && v === '') streamItems.length = 0; },
    get innerHTML() { return this._html; },
    addEventListener() {}, append() {}, appendChild(c) { if (id === 'stream') streamItems.push(c); },
    removeChild() {}, replaceWith() {}, querySelector: () => dummyEl(), querySelectorAll: () => [],
    classList: { toggle() {} }, getAttribute: () => '',
  });
  const doc = {
    readyState: 'complete',
    documentElement: { lang: 'zh-CN' },
    title: '',
    addEventListener() {},
    getElementById: (id) => dummyEl(id),
    querySelector: () => dummyEl(),
    querySelectorAll: () => [],
    createElement: (tag) => ({ nodeType: 1, tagName: tag, className: '', textContent: '', append() {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {} } }),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  };
  const ev1 = { seq: 1, ts: '2026-11-24T00:00:01Z', type: 'user_message_queued', msgSeq: 2, text: 'UNIQUE_HELLO' };
  const sandbox = {
    location: { pathname: '/', hash: '' },
    history: { replaceState() {} },
    window: { addEventListener() {} },
    document: doc,
    EventSource: FakeEventSource,
    fetch: (url) => {
      if (url === '/api/state') return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ state: { phase: 'idle', lastSeq: 1 }, room: { id: 'r1' } })) });
      return eventsFetchPromise;
    },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  };
  new vm.Script(`(function (globalThis, window, document, location, history, fetch, EventSource, setInterval, clearInterval, setTimeout, clearTimeout) {\n${appSrc}\n})`, { filename: 'app.js' })
    .runInThisContext()(sandbox, sandbox.window, sandbox.document, sandbox.location, sandbox.history, sandbox.fetch, sandbox.EventSource, sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.clearTimeout);

  // SSE delivers snapshot + ev1 BEFORE poll()'s /api/events resolves
  esListeners.snapshot({ data: JSON.stringify({ state: { phase: 'idle', lastSeq: 1 }, room: { id: 'r1' }, lastSeq: 1 }) });
  esListeners.room_event({ data: JSON.stringify(ev1) });
  resolveEventsFetch({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ events: [ev1], lastSeq: 1 })) });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Render ran with streamItems populated cleanly — last render has exactly 1 user_message item (never 2!)
  assert.equal(streamItems.length, 1, 'SSE + concurrent poll did not duplicate seq 1');
  // room_closed closes EventSource cleanly
  esListeners.room_closed({ data: JSON.stringify({ state: { phase: 'closed', closed: true } }) });
  assert.equal(FakeEventSource.instance.closed, true);
});

// ---- H5: POSIX probeLockHolder with macOS path spaces & Linux 15-byte comm truncation ----
test('H5: probeLockHolder handles macOS path spaces and Linux 15-byte comm truncation', async () => {
  const lock = { pid: process.pid, image: 'node', procStartedAt: '2026-11-24T03:00:00Z', heartbeatAt: new Date().toISOString() };
  const macRes = await probeLockHolder(lock, {
    platform: 'darwin',
    isAlive: () => true,
    spawn: async (_cmd, args) => {
      assert.ok(args.includes('lstart=,comm='));
      return { code: 0, stdout: 'Tue Nov 24 03:00:00 2026 /Users/John Smith/.nvm/versions/node/v24.11.1/bin/node\n', stderr: '' };
    },
  });
  assert.equal(macRes, 'alive');

  const linuxLock = { ...lock, image: 'my-embedded-host-bin' };
  const linuxRes = await probeLockHolder(linuxLock, {
    platform: 'linux',
    isAlive: () => true,
    spawn: async () => ({ code: 0, stdout: 'Tue Nov 24 03:00:00 2026 my-embedded-hos\n', stderr: '' }),
  });
  assert.equal(linuxRes, 'alive');
});

// ---- H6: Summary-turn verdict & unattached verdict render visibly in Group Chat ----
test('H6: renderGroupChat renders summary-turn verdicts and unattached verdicts visibly', () => {
  const sandbox = { URL, Map, Set };
  for (const f of ['rt-i18n.js', 'rt-protocol.js', 'rt-markdown.js', 'rt-chat.js', 'app.js']) {
    const code = fs.readFileSync(path.join(UI, f), 'utf8');
    new vm.Script(`(function (globalThis, URL) {\n${code}\n})`, { filename: f }).runInThisContext()(sandbox, URL);
  }
  const sha = 'a'.repeat(64);
  const derived = sandbox.RoomUI.derive([
    { seq: 1, ts: '2026-11-24T00:00:01Z', type: 'round_started', roundId: 1, order: ['A', 'B'], epoch: 0 },
    { seq: 2, ts: '2026-11-24T00:00:02Z', type: 'submission_accepted', msgSeq: 2, seatId: 'B', role: 'executor', attemptId: 'att-b', text: 'Built feature.' },
    { seq: 3, ts: '2026-11-24T00:00:03Z', type: 'verdict_recorded', seatId: 'A', attemptId: 'att-sum', artifactSha: sha, verdict: 'reject', annotation: 'tainted', annotations: ['tainted'], authorized: true, tainted: true, producer: 'B' },
    { seq: 4, ts: '2026-11-24T00:00:04Z', type: 'submission_accepted', msgSeq: 3, seatId: 'A', role: 'lead', attemptId: 'att-sum', text: 'Summary prose.' },
    { seq: 5, ts: '2026-11-24T00:00:05Z', type: 'summary_published', version: 1, seatId: 'A', attemptId: 'att-sum', unanswered: [], supersedes: null, verdicts: [], excluded: [], verified: [], absent: [], noArtifact: [] },
  ]);
  const model = sandbox.RoomChat.buildChatModel({
    state: { roundId: 1, phase: 'done' },
    room: { id: 'demo', seats: [{ seatId: 'A', role: 'lead' }, { seatId: 'B', role: 'executor' }] },
    derived,
  });
  const doc = makeMiniDoc();
  const container = doc.createElement('div');
  sandbox.RoomChat.renderGroupChat(doc, container, model, { lang: 'en' });
  const text = container.textContent;
  assert.match(text, /Official verdict: reject/);
  assert.match(text, /tainted/);
});

// ---- M1 + M3 + L2 + L4: daemon-store safety, mid-round /task block, invalid room.lang, English malformedFollowUp ----
test('M3: daemon-store rejects __proto__ ID and retains dirty flag when flush fails', async () => {
  const b = tempDir('store');
  const s = createDaemonStore(b);
  assert.equal(s.load().ok, true);
  await s.upsertRoom('__proto__', { roomDir: path.join(b, '__proto__') });
  assert.equal(({}).roomDir, undefined);
  assert.equal(s.getRoom('__proto__'), null);

  // Simulate transient failure: make target path a directory so rename fails, then remove it and drain()
  const blocker = path.join(b, REGISTRY_FILE);
  fs.mkdirSync(blocker, { recursive: true });
  await s.upsertRoom('r1', { roomDir: path.join(b, 'r1'), defaultOrder: ['A'] });
  assert.ok(fs.statSync(blocker).isDirectory());
  fs.rmdirSync(blocker);
  await s.drain();
  assert.ok(fs.statSync(blocker).isFile(), 'drain() flushed pending dirty state after transient error');
  assert.deepEqual(JSON.parse(fs.readFileSync(blocker, 'utf8')).rooms.r1.defaultOrder, ['A']);
});

test('M1 + L2: lobby blocks mid-round POST /lobby/api/task and normalizes invalid room.lang', async () => {
  const b = tempDir('lobby-m1');
  const roomsRoot = path.join(b, 'rooms');
  const cwdA = path.join(b, 'cwdA');
  fs.mkdirSync(cwdA, { recursive: true });
  const lobby = await startLobby({ port: 0, roomsRoot });
  lobbies.push(lobby);
  const c = await req(lobby.port, { method: 'POST', pathname: '/lobby/api/create', body: {
    token: lobby.token, id: 'r1', preset: 'discussion',
    seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: cwdA }],
  } });
  assert.equal(c.status, 200);
  // Plant unsupported room.lang -> listRooms must normalize to 'zh-CN', never null
  const roomFile = path.join(roomsRoot, 'r1', F.room);
  const roomObj = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
  roomObj.lang = 'fr';
  fs.writeFileSync(roomFile, JSON.stringify(roomObj, null, 2));
  const list = await req(lobby.port, { pathname: '/lobby/api/rooms' });
  assert.equal(list.json.rooms[0].lang, 'zh-CN');

  const op = await req(lobby.port, { method: 'POST', pathname: '/lobby/api/open', body: { token: lobby.token, id: 'r1' } });
  assert.equal(op.status, 200);
  const st = await req(lobby.port, { method: 'POST', pathname: '/lobby/api/start', body: { token: lobby.token, id: 'r1', task: 'Locked task' } });
  assert.equal(st.status, 200);
  const ov = await req(lobby.port, { method: 'POST', pathname: '/lobby/api/task', body: { token: lobby.token, id: 'r1', text: 'SHOULD_FAIL' } });
  assert.equal(ov.status, 409);
  assert.equal(ov.json.error, 'ROUND_IN_PROGRESS');
  await lobby.close();
});

test('L4: English malformedFollowUp translates standard REASON_TEXT codes to English', () => {
  const enText = malformedFollowUp({
    reasons: [{ code: 'verdict_missing', text: REASON_TEXT.verdict_missing }],
    attemptId: 'att-1',
    lang: 'en',
  });
  assert.match(enText, /verdict_missing: This turn requires a verdict/);
  assert.doesNotMatch(enText, /[\u4e00-\u9fff]/, 'English malformed follow-up contains no Chinese text');
});

// ---- M6: Public markdown files have zero dead relative links to excluded directories ----
test('M6: public Markdown files contain zero broken relative links', () => {
  const mdFiles = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!isPublicPath(r)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, r);
      else if (e.name.endsWith('.md') && !r.startsWith('test/fixtures/') && !r.startsWith('lib/templates/')) mdFiles.push({ rel: r, full });
    }
  };
  walk(ROOT, '');
  const broken = [];
  for (const f of mdFiles) {
    const content = fs.readFileSync(f.full, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1].trim().split('#')[0];
      if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(f.full), target);
      const relResolved = path.relative(ROOT, resolved).replace(/\\/g, '/');
      if (!fs.existsSync(resolved) || !isPublicPath(relResolved)) {
        broken.push(`${f.rel} -> ${m[1]}`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken public markdown links: ${broken.join(', ')}`);
});
