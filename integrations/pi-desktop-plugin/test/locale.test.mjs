// The turn toast's language, driven through the fake host (fake-pi-host.mjs cites the upstream
// lines). Upstream answers app.getLocale with "en" while it restores the enabled plugins at boot,
// then applies the stored language and pushes appearance:changed; a later language switch pushes it
// again. The toast must follow the host language, not the one read at load. Each test gets its own
// host, so this file runs in its own process with its own ROOM_DEV_HOME.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../build.mjs';
import { startFakeHost } from './fake-pi-host.mjs';

const RUN_ROOT = path.join(process.env.ROOM_DEV_HOME || path.join(os.homedir(), 'room-dev'), 'test-runs');
const base = path.join(RUN_ROOT, `pi-plugin-locale-${crypto.randomBytes(4).toString('hex')}`);
const savedHome = process.env.ROOM_DEV_HOME;
process.env.ROOM_DEV_HOME = path.join(base, 'home');
const ID = 'io.github.kennymcsimpson.governed-roundtable';
const ZH_TOAST = (seat) => new RegExp(`^圆桌 \\S+：轮到席位 ${seat}。`);
const EN_TOAST = (seat) => new RegExp(`^Roundtable \\S+: seat ${seat}'s turn`);
const S1 = 'session-locale-one';
const S2 = 'session-locale-two';
let pluginDir;
let hosts = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(80); } }
function seatDir(name) { const d = path.join(base, 'seats', name); fs.mkdirSync(d, { recursive: true }); return d; }

before(async () => {
  fs.mkdirSync(base, { recursive: true });
  pluginDir = (await buildPlugin({ out: path.join(base, 'build', ID), source: 'worktree' })).out;
});
after(async () => {
  if (savedHome === undefined) delete process.env.ROOM_DEV_HOME; else process.env.ROOM_DEV_HOME = savedHome;
  await fs.promises.rm(base, { recursive: true, force: true });
});

// One fake host per test; unloaded afterwards whatever happened.
async function withHost(opts, fn) {
  const host = await startFakeHost({ pluginDir, dataDir: path.join(base, `plugin-data-${++hosts}`), ...opts });
  try { return await fn(host); } finally { await host.unload(); }
}
// A room of PI seats created from a PI conversation (S1 takes the first seat); the user sets the
// task and starts the round in the panel.
async function startRound(host, room, seats, { order } = {}) {
  const c = await host.tool('Room', {
    action: 'create', room, preset: 'discussion', joinAs: seats[0],
    seats: seats.map((s, i) => ({ seat: s, role: i ? 'participant' : 'lead', agent: 'pi', cwd: seatDir(`${room}-${s}`) })),
  }, { sessionId: S1 });
  assert.equal(c.status, 'CREATED', JSON.stringify(c));
  assert.equal((await host.panel('roundtable/admin', { room, cmd: 'task', text: '讨论：要不要加 --strict' })).ok, true);
  assert.equal((await host.panel('roundtable/admin', { room, cmd: 'start', ...(order ? { order } : {}) })).ok, true);
}
const toastFor = (host, seat) => until(() => host.toasts.find((t) => t.message.includes(`${seat}。`) || t.message.includes(`seat ${seat}'s turn`)));
const localeReads = (host) => host.calls.filter((c) => c.api === 'app.getLocale').length;

test('the toast text: Chinese and English, for a PI seat and for an external seat', async () => {
  const { turnToast, isZhLocale } = await import(pathToFileURL(path.join(pluginDir, 'core.mjs')).href);
  assert.match(turnToast('r1', 'A', true, true), /^圆桌 r1：轮到席位 A。请让坐在这个席位的 PI 对话继续/);
  assert.match(turnToast('r1', 'X', false, true), /^圆桌 r1：轮到席位 X。请提醒这个席位的 agent 运行 wait 取包。$/);
  assert.match(turnToast('r1', 'A', true, false), /^Roundtable r1: seat A's turn\. Ask the PI conversation in that seat to continue \(Room tool, action wait\)\.$/);
  assert.match(turnToast('r1', 'X', false, false), /Remind that agent to run its wait command\.$/);
  for (const v of ['zh-CN', 'zh', 'ZH-tw', 'zh-Hans']) assert.equal(isZhLocale(v), true, v);
  for (const v of ['en', 'en-US', 'ja', '', null, undefined, 42]) assert.equal(isZhLocale(v), false, String(v));
});

test('boot order: restored at boot under en, settings then apply zh-CN, so turn toasts are Chinese', async () => {
  await withHost({ bootLocale: 'en', locale: 'zh-CN' }, async (host) => {
    await startRound(host, 'boot', ['A'], { order: 'A' });
    const t = await toastFor(host, 'A');
    assert.ok(t, 'a toast for A');
    assert.match(t.message, ZH_TOAST('A'));
    assert.doesNotMatch(t.message, /seat A's turn/);
  });
});

test('a later language switch is followed live', async () => {
  await withHost({ locale: 'zh-CN' }, async (host) => {
    await startRound(host, 'switch', ['A', 'B'], { order: 'A,B' });
    assert.equal((await host.tool('Room', { action: 'join', room: 'switch', seat: 'B' }, { sessionId: S2 })).status, 'JOINED');
    const tA = await toastFor(host, 'A');
    assert.ok(tA, 'a toast for A');
    assert.match(tA.message, ZH_TOAST('A'));
    await host.setLocale('en');
    const wA = await until(async () => { const r = await host.tool('Room', { action: 'wait', room: 'switch' }, { sessionId: S1 }); return r.status === 'TURN' ? r : null; });
    assert.ok(wA, 'A gets its turn');
    assert.equal((await host.tool('Room', { action: 'submit', room: 'switch', attempt: wA.attempt, text: '开题' }, { sessionId: S1 })).status, 'ACCEPTED');
    const tB = await toastFor(host, 'B');
    assert.ok(tB, 'a toast for B');
    assert.match(tB.message, /Roundtable \S+: seat B's turn/);
  });
});

test('without the event, the toast re-reads app.getLocale', async () => {
  await withHost({ locale: 'en-US' }, async (host) => {
    const atLoad = localeReads(host);
    await host.setLocale('zh-CN', { broadcast: false });
    await startRound(host, 'reread', ['A']);
    const t = await toastFor(host, 'A');
    assert.ok(t, 'a toast for A');
    assert.match(t.message, ZH_TOAST('A'));
    assert.equal(localeReads(host), atLoad + 1, 'one getLocale read for the one toast');
  });
});

test('subscription hygiene: one listener while loaded, none after unload; nothing ran in a finished tool call', async () => {
  const host = await startFakeHost({ pluginDir, dataDir: path.join(base, `plugin-data-${++hosts}`), locale: 'en-US' });
  try {
    assert.equal(host.listenerCount('appearance:changed'), 1);
    // The room is created (and served) from inside a tool call; the re-read and the toast run detached.
    await startRound(host, 'hygiene', ['A']);
    assert.ok(await toastFor(host, 'A'), 'a toast for A');
    await host.setLocale('zh-CN');
    assert.deepEqual(host.eventErrors, []);
    assert.deepEqual(host.aborted.filter((a) => a.api === 'app.getLocale' || a.api === 'ui.showToast'), []);
  } finally {
    await host.unload();
  }
  assert.equal(host.listenerCount('appearance:changed'), 0, 'onUnload unsubscribed');
});

test('subscription hygiene: a failed onLoad leaves no listener and no tool behind', async () => {
  // Driven directly (main.js would keep no plugin to unload), with a host stub that keeps the process.
  const { createRoundtablePlugin } = await import(pathToFileURL(path.join(pluginDir, 'core.mjs')).href);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
  const denied = () => Object.assign(new Error('missing permission'), { code: 'PERMISSION_DENIED' });
  const cases = [
    { name: 'registerTool refused', registerTool: () => Promise.reject(denied()) },
    { name: 'no Room tool in the manifest', manifest: { ...manifest, contributes: { ...manifest.contributes, agentTools: [] } } },
    { name: 'commands.register refused', register: () => Promise.reject(denied()) },
  ];
  for (const c of cases) {
    const listeners = new Set();
    const tools = new Set();
    const pi = {
      plugin: { getManifest: () => c.manifest || manifest, getDataPath: async () => path.join(base, `failed-load-${++hosts}`) },
      events: { on: (ev, fn) => listeners.add(fn), off: (ev, fn) => listeners.delete(fn) },
      app: { getLocale: async () => 'zh-CN' },
      services: { register: () => {} },
      agent: { registerTool: c.registerTool || (async (t) => { tools.add(t.name); }), unregisterTool: async (n) => { tools.delete(n); } },
      commands: { register: c.register || (async () => {}), unregister: async () => {} },
    };
    await assert.rejects(createRoundtablePlugin(pi).onLoad(), (e) => !!e, c.name);
    assert.equal(listeners.size, 0, `${c.name}: the appearance listener is removed`);
    assert.equal(tools.size, 0, `${c.name}: no tool stays registered`);
  }
});

test('malformed appearance payloads change nothing; a failing getLocale keeps the last good language', async () => {
  await withHost({ locale: 'en-US' }, async (host) => {
    await host.setLocale('zh-CN');   // a good event: Chinese from now on
    for (const args of [[null], [{}], [{ locale: 42 }], [[]], [{ locale: '' }], [{ locale: '   ' }], [], ['en']]) await host.emit('appearance:changed', args);
    assert.deepEqual(host.eventErrors, [], 'the listener never threw');
    host.failGetLocale(true);
    await startRound(host, 'malformed', ['A']);
    const t = await toastFor(host, 'A');
    assert.ok(t, 'a toast for A although getLocale failed');
    assert.match(t.message, ZH_TOAST('A'));
    host.failGetLocale(false);
  });
});

test('fake host fidelity: events reach listeners outside any invocation; bootLocale is what onLoad saw', async () => {
  await withHost({ bootLocale: 'en', locale: 'zh-CN' }, async (host) => {
    const first = host.calls.find((c) => c.api === 'app.getLocale');
    assert.ok(first, 'onLoad read the locale');
    assert.equal(first.result, 'en', 'restored at boot: the host answered en');
    assert.equal(await host.pi.app.getLocale(), 'zh-CN', 'the stored setting is applied after the boot');
    assert.deepEqual((await host.pi.app.getAppearance()).locale, 'zh-CN');
    // A handler registered during a tool call still runs outside it when an event arrives later
    // (the parent's frames are dispatched from the port, plugin-host-process.mjs 635-638).
    const before = host.aborted.length;
    let seen = null;
    const handler = (a) => { host.pi.app.getLocale().then((v) => { seen = { payload: a.locale, read: v }; }, (e) => { seen = { error: e.code }; }); };
    host.tools.set('Probe', { descriptor: { name: 'Probe' }, execute: async () => { host.pi.events.on('appearance:changed', handler); return { ok: true }; } });
    try {
      await host.tool('Probe', {}, { sessionId: S1 });
      await host.setLocale('en-GB');
      assert.ok(await until(() => seen), 'the handler ran');
      assert.deepEqual(seen, { payload: 'en-GB', read: 'en-GB' });
      assert.equal(host.aborted.length, before, 'no call from the handler was refused');
    } finally {
      host.pi.events.off('appearance:changed', handler);
      host.tools.delete('Probe');
    }
    assert.deepEqual(host.eventErrors, []);
  });
});
