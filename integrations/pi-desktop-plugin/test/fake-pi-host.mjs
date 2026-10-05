// A fake PI-Desktop plugin host for tests. It runs a built plugin folder the way the real host does
// and hands it a `pi` object with the upstream SDK's shapes, without building PI-Desktop.
//
// Mirrored from upstream PI-Desktop at commit 10e824ee12f828907fd123e42dc44b3e59c0af75 (paths are
// relative to that repository):
//   apps/desktop/electron/main/plugin-host-process.mjs
//     162-450  buildApi(): the pi.* surface. The subset below keeps the same names and argument
//              shapes; agent.registerTool (277-298) forwards only {name, description, risk, schema}
//              to the broker, so planSafeActions never reaches it.
//     475-499  loadPluginModule / handleInit: globalThis.pi = buildApi() BEFORE require(main.js),
//              then onLoad().
//     503-511  panel.invoke -> onPanelInvoke(channel, payload).
//     531-557  tool.execute -> execute(args, {sessionId, turnId, mode, modelKey, thinkingLevel,
//              signal, log}).
//     559-580  service.start({log}) (idempotent per process) / service.stop().
//     605-620  lifecycle.unload -> onUnload(); the broker stops services first (plugin-runtime.ts 1888-1895, 2005-2010).
//   apps/desktop/electron/main/plugin-runtime.ts
//     1856-1860 startServices runs after onLoad; 3650-3700 only with background.service, each start
//              bounded by SERVICE_START_TIMEOUT_MS = PLUGIN_HOOK_TIMEOUT_MS = 5_000 (560, 647).
//     2558-2646 agent.registerTool (agent.tool.register); Plan/Goal mode refuses a tool whose
//              planSafeActions is empty (2586-2605); 110 s tool timeout (572).
//     4089-4174 agent.complete: agent.complete permission, modelKey providerId/modelId, system
//              <= 32 KiB, messages <= 200k chars, 8 calls per plugin per rolling 60 s
//              (RATE_LIMITED, 699-702, 4052-4061), 90 s TIMEOUT; session context only during a tool.
//     4253-4265 assertPermission -> PERMISSION_DENIED "missing permission: <perm>".
//     4879-4927 ui.openPanel needs ui.panel and manifest.ui.panel; showToast needs nothing;
//              ui.notify needs notify.
//     5549-5562 shell.openExternal needs shell.openExternal and an http(s)/mailto URL
//              (safe-open-external.ts 16-41).
//     2075-2245 panel channels the host answers itself (ui.*, fs.*, plugin.getSettings, ...);
//              anything else goes to the plugin's onPanelInvoke (30 s, 576).
//   apps/desktop/electron/main/plugin-host-process.mjs, tool-invocation scoping (AsyncLocalStorage):
//     50       invocationContext = new AsyncLocalStorage().
//     54-69    call(): a pi.* call whose async context is a tool invocation that is no longer active
//              is rejected with PLUGIN_TOOL_ABORTED (71-73) before it reaches the broker.
//     531-557  tool.execute runs execute() inside invocationContext.run(invocation, ...); in finally
//              the invocation is removed and every call still pending from it is rejected (85-91,
//              556). Timers, servers and promises created during execute() inherit that context, so
//              once the call returns, every pi.* call made from them is rejected.
//     660      every other parent call (panel.invoke, command.run, service.start / stop, unload)
//              runs under invocationContext.run(undefined, ...).
//   apps/desktop/electron/main/services/session-collaboration.ts 107-114: send/spawn refuse
//     without an active tool invocation; desktop.invoke itself needs desktop.control (4955).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

export const UPSTREAM_COMMIT = '10e824ee12f828907fd123e42dc44b3e59c0af75';
const SERVICE_START_TIMEOUT_MS = 5_000;
const PLUGIN_TOOL_TIMEOUT_MS = 110_000;
const PLUGIN_PANEL_TIMEOUT_MS = 30_000;
const MAX_COMPLETES_PER_WINDOW = 8;
const COMPLETE_RATE_WINDOW_MS = 60_000;
const MAX_COMPLETE_SYSTEM_CHARS = 32 * 1024;
const MAX_COMPLETE_MESSAGE_CHARS = 200_000;
const HOST_PANEL_CHANNELS = new Set(['app.getAppearance', 'ui.showToast', 'ui.notify', 'ui.closePanel', 'plugin.getSettings', 'workspace.get', 'fs.readText', 'fs.stat', 'fs.list', 'clipboard.readText', 'clipboard.writeText', 'shell.openExternal', 'net.fetch']);

function apiError(code, message) { return Object.assign(new Error(message), { code }); }
function withTimeout(promise, ms, code) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(apiError(code, `timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}
function allowedExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname && /^https?:\/\//i.test(raw.trim())) return u.href;
    if (u.protocol === 'mailto:' && u.pathname) return u.href;
  } catch { /* invalid */ }
  return null;
}

// startFakeHost({pluginDir, dataDir, grant?, locale?, complete?}) -> host
//   grant:    permissions the user granted (default: everything the manifest asks for)
//   complete: async (input) => {text, modelKey, usage?} standing in for the host's model call
export async function startFakeHost({ pluginDir, dataDir, grant, locale = 'en-US', complete } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
  const permissions = new Set(grant || manifest.permissions || []);
  const calls = [];             // every pi.* call the plugin made: {api, args}
  const tools = new Map();      // name -> {descriptor (as forwarded), execute}
  const commands = new Map();   // id -> {descriptor, run}
  const services = new Map();   // id -> {start, stop, running}
  const toasts = [];
  const external = [];
  const completeLog = [];
  const serviceLog = [];        // lines the service wrote through its start ctx.log
  let completeWindow = null;
  let panelOpen = 0;

  const aborted = [];            // pi.* calls refused because their tool invocation had finished: {api}
  const invocationContext = new AsyncLocalStorage();
  const invocations = new Map(); // invocation id -> {id, pending: Set<{reject}>}
  let nextInvocation = 0;

  const need = (perm) => { if (!permissions.has(perm)) throw apiError('PERMISSION_DENIED', `missing permission: ${perm}`); };
  const record = (api, args) => { calls.push({ api, args }); };
  // call() (plugin-host-process.mjs 54-69): refused when the async context is a finished invocation;
  // a call still pending when its invocation finishes is rejected at that moment (85-91).
  const host = (api, args, fn) => {
    record(api, args);
    const inv = invocationContext.getStore();
    if (inv && invocations.get(inv.id) !== inv) {
      aborted.push({ api });
      return Promise.reject(apiError('PLUGIN_TOOL_ABORTED', 'Plugin tool invocation finished'));
    }
    const result = Promise.resolve().then(fn);
    if (!inv) return result;
    return new Promise((resolve, reject) => {
      const entry = { reject: (e) => { aborted.push({ api }); reject(e); } };
      inv.pending.add(entry);
      result.then((v) => { inv.pending.delete(entry); resolve(v); }, (e) => { inv.pending.delete(entry); reject(e); });
    });
  };
  // Parent calls other than tool.execute run outside any invocation (plugin-host-process.mjs 660).
  const outside = (fn) => invocationContext.run(undefined, fn);

  const pi = {
    app: {
      getVersion: () => host('app.getVersion', [], async () => '0.16.1'),
      getLocale: () => host('app.getLocale', [], async () => locale),
      getAppearance: () => host('app.getAppearance', [], async () => ({ theme: 'system', base: 'system', locale, pluginTheme: null })),
    },
    plugin: {
      getId: () => manifest.id,
      getManifest: () => manifest,
      getSettings: () => host('plugin.getSettings', [], async () => ({})),
      getDataPath: () => host('plugin.getDataPath', [], async () => { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; }),
    },
    commands: {
      register: async (command) => {
        if (!command || typeof command.id !== 'string' || !command.id) throw new Error('command.id is required');
        if (typeof command.run !== 'function') throw new Error('command.run must be a function');
        await host('commands.register', [{ id: command.id, title: command.title, keywords: command.keywords, category: command.category }], async () => {
          commands.set(command.id, { descriptor: { id: command.id, title: command.title }, run: command.run });
        });
      },
      unregister: async (id) => { commands.delete(id); await host('commands.unregister', [id], async () => {}); },
    },
    ui: {
      openPanel: (options) => host('ui.openPanel', [options], async () => {
        need('ui.panel');
        if (!manifest.ui || !manifest.ui.panel) throw apiError('NOT_FOUND', 'plugin does not declare ui.panel');
        if (!fs.existsSync(path.join(pluginDir, manifest.ui.panel))) throw apiError('NOT_FOUND', `panel html missing: ${manifest.ui.panel}`);
        panelOpen++;
      }),
      closePanel: () => host('ui.closePanel', [], async () => {}),
      showToast: (message, level) => host('ui.showToast', [message, level], async () => { toasts.push({ message: String(message), level }); }),
      notify: (input) => host('ui.notify', [input], async () => { need('notify'); }),
    },
    desktop: {
      listOperations: () => host('desktop.listOperations', [], async () => { need('desktop.control'); return []; }),
      invoke: (input) => host('desktop.invoke', [input], async () => { need('desktop.control'); throw apiError('PERMISSION_DENIED', 'Sending requires an active, host-authenticated Agent tool invocation'); }),
    },
    agent: {
      registerTool: async (tool) => {
        if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('tool.name is required');
        if (typeof tool.execute !== 'function') throw new Error('tool.execute must be a function');
        // What the child forwards (plugin-host-process.mjs 285-292): no planSafeActions.
        const descriptor = { name: tool.name, description: tool.description, risk: tool.risk, schema: tool.schema };
        await host('agent.registerTool', [descriptor], async () => {
          need('agent.tool.register');
          tools.set(tool.name, { descriptor, execute: tool.execute });
        });
      },
      unregisterTool: async (name) => { tools.delete(name); await host('agent.unregisterTool', [name], async () => {}); },
      complete: (input) => host('agent.complete', [input], async () => {
        need('agent.complete');
        const modelKey = String((input && input.modelKey) || '').trim();
        if (!modelKey || !modelKey.includes('/')) throw apiError('INVALID_ARGUMENT', 'modelKey must be providerId/modelId');
        const system = typeof input.system === 'string' ? input.system : '';
        if (system.length > MAX_COMPLETE_SYSTEM_CHARS) throw apiError('INVALID_ARGUMENT', 'system prompt exceeds 32 KiB');
        const messages = Array.isArray(input.messages) ? input.messages : [];
        if (messages.reduce((n, m) => n + String((m && m.content) || '').length, 0) > MAX_COMPLETE_MESSAGE_CHARS) throw apiError('INVALID_ARGUMENT', 'messages exceed 200k characters');
        const now = Date.now();
        if (!completeWindow || now - completeWindow.start >= COMPLETE_RATE_WINDOW_MS) completeWindow = { start: now, count: 1 };
        else if (++completeWindow.count > MAX_COMPLETES_PER_WINDOW) throw apiError('RATE_LIMITED', 'plugin completion rate exceeded');
        if (input.includeSessionContext === true) { need('session.read'); throw apiError('INVALID_ARGUMENT', 'session context is only available during tool execution'); }
        completeLog.push(input);
        if (typeof complete !== 'function') throw apiError('UNSUPPORTED', 'host api not available: agent.complete');
        return complete(input);
      }),
    },
    services: {
      register: (service) => {
        if (!service || typeof service.id !== 'string' || !service.id) throw new Error('service.id is required');
        if (typeof service.start !== 'function') throw new Error('service.start must be a function');
        services.set(service.id, { start: service.start, stop: typeof service.stop === 'function' ? service.stop : undefined, running: false });
      },
      unregister: async (id) => { const e = services.get(id); services.delete(id); if (e && e.running && e.stop) await e.stop(); },
    },
    shell: {
      openExternal: (url) => host('shell.openExternal', [url], async () => {
        need('shell.openExternal');
        const ok = allowedExternalUrl(url);
        if (!ok) throw apiError('INVALID_ARGUMENT', 'only http(s)/mailto URLs allowed');
        external.push(ok);
      }),
    },
    events: { on: () => {}, off: () => {} },
  };

  // handleInit: the host sets globalThis.pi, then requires main.js and runs onLoad.
  const prevPi = globalThis.pi;
  globalThis.pi = pi;
  const require = createRequire(import.meta.url);
  const entry = path.join(pluginDir, manifest.main);
  delete require.cache[require.resolve(entry)];
  const mod = require(entry);
  if (mod && typeof mod.onLoad === 'function') await outside(() => mod.onLoad());

  function startServices() { return outside(startServicesNow); }
  async function startServicesNow() {
    const declared = (manifest.contributes && manifest.contributes.services) || [];
    if (!declared.length || !permissions.has('background.service')) return { started: [], skipped: declared.map((s) => s.id) };
    const started = [];
    for (const s of declared) {
      const e = services.get(s.id);
      if (!e) throw apiError('NOT_FOUND', `service not registered: ${s.id}`);
      if (e.running) continue;
      const t0 = Date.now();
      await withTimeout(Promise.resolve(e.start({ log: (line) => { serviceLog.push(String(line)); } })), SERVICE_START_TIMEOUT_MS, 'TIMEOUT');
      e.running = true;
      started.push({ id: s.id, ms: Date.now() - t0 });
    }
    return { started, skipped: [] };
  }
  function stopServices() { return outside(stopServicesNow); }
  async function stopServicesNow() {
    for (const e of services.values()) {
      if (!e.running) continue;
      e.running = false;
      if (e.stop) await e.stop();
    }
  }
  const serviceStart = await startServices();

  let turn = 0;
  return {
    pi, manifest, calls, tools, commands, services, toasts, external, completeLog, serviceLog, permissions, serviceStart, aborted,
    get panelOpen() { return panelOpen; },
    startServices, stopServices,
    // One Agent tool call from conversation `sessionId` (plugin-runtime.ts 2583-2640).
    async tool(name, args, { sessionId, mode = 'agent', modelKey = 'test/agent-model' } = {}) {
      const t = tools.get(name);
      if (!t) throw apiError('TOOL_NOT_FOUND', `tool not registered: ${name}`);
      if (mode === 'plan' || mode === 'goal') throw apiError('PERMISSION_DENIED', `plugin tool ${name} is not available in ${mode} mode`);
      const controller = new AbortController();
      const ctx = { sessionId: sessionId === undefined ? undefined : String(sessionId ?? ''), turnId: `turn-${++turn}`, mode, modelKey, thinkingLevel: undefined, signal: controller.signal, log: () => {} };
      // plugin-host-process.mjs 531-557: execute runs inside the invocation's async context; when it
      // returns, the invocation is gone and the calls still pending from it are rejected.
      const inv = { id: `inv-${++nextInvocation}`, pending: new Set() };
      invocations.set(inv.id, inv);
      try {
        return await withTimeout(invocationContext.run(inv, () => Promise.resolve().then(() => t.execute(args, ctx))), PLUGIN_TOOL_TIMEOUT_MS, 'TIMEOUT');
      } finally {
        invocations.delete(inv.id);
        const err = apiError('PLUGIN_TOOL_ABORTED', 'Plugin tool invocation finished');
        for (const p of inv.pending) p.reject(err);
        inv.pending.clear();
      }
    },
    async panel(channel, payload) {
      if (HOST_PANEL_CHANNELS.has(channel)) throw new Error(`fake host: ${channel} is answered by the host, not the plugin`);
      if (typeof mod.onPanelInvoke !== 'function') throw apiError('UNSUPPORTED', 'plugin does not expose panel operations');
      return withTimeout(outside(() => Promise.resolve().then(() => mod.onPanelInvoke(channel, payload ?? {}))), PLUGIN_PANEL_TIMEOUT_MS, 'TIMEOUT');
    },
    async command(id) {
      const c = commands.get(id);
      if (!c) throw apiError('NOT_FOUND', `command not registered: ${id}`);
      await outside(() => c.run());
    },
    // Disable / quit: services stop first, then onUnload (plugin-runtime.ts 1888-1895 and 3730-3760, child 605-620).
    async unload() {
      await stopServices();
      if (mod && typeof mod.onUnload === 'function') await outside(() => mod.onUnload());
      globalThis.pi = prevPi;
    },
  };
}
