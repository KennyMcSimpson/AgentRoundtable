#!/usr/bin/env node
// ui/mock-server.mjs - a stand-in for the room service's HTTP surface (INTERFACES section 8), so the
// browser UI can be developed and tested without a room, agents or a running service.
//
//   node ui/mock-server.mjs [--port 0] [--fixture ui/fixtures/state.json] [--token <hex>]
//     prints:  MOCK_UI http://127.0.0.1:<port>/#<token>
//     stops on Ctrl+C.
//
// Routes (all behind the same loopback Host/Origin check as the real service):
//   GET  /, /index.html, /app.js, /app.css      static files from ui/ (top level only, fixed types)
//   GET  /api/state                             { state, room } from the fixture
//   GET  /api/events?since=N                    { events: [...seq > N], lastSeq }
//   POST /api/admin                             JSON body { token, cmd, ...params } -> echo, nothing runs
//
// It writes nothing to disk, starts no child process and binds only 127.0.0.1. Admin posts are kept in
// memory (`received`, token removed) so tests can check what the page would have sent.
//
// checkHostOrigin() is the reference for lib/http.mjs: Host must be exactly 127.0.0.1:<port> or
// localhost:<port> (DNS-rebinding guard); Origin, when present, must be the same loopback origin;
// Sec-Fetch-Site, when present, must be same-origin or none (a same-site top-level navigation to / or
// /index.html excepted, see pageNavigation); POST must be application/json (a plain
// cross-site form cannot send that without a preflight the server never answers).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomHex, parseArgs, out } from '../lib/common.mjs';

export const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = path.join(UI_DIR, 'fixtures', 'state.json');

// Admin command names INTERFACES defines: the P-1 admin commands (lib/admin.mjs, room.mjs) plus the
// ones INTERFACES sections 1/3/9 name (`admin confirm-task`, `admin say`, `admin interrupt`,
// `admin reconcile`, `admin pi-key`, and the epoch-bumping `reassign` / `reverse`), plus the commands
// the room service implements (lib/service.mjs ADMIN_COMMANDS: approve-disclose, deny-disclose,
// accept-stale, pi-permission, retry). test/ui.test.mjs re-derives this list from docs/INTERFACES.md
// and lib/service.mjs and fails if they drift.
export const ADMIN_COMMANDS = Object.freeze([
  'init', 'add-seat', 'set-audit', 'task', 'start', 'cancel', 'skip', 'retry', 'wake', 'close', 'log', 'show',
  'confirm-task', 'say', 'interrupt', 'reconcile', 'pi-key', 'reassign', 'reverse',
  'approve-disclose', 'deny-disclose', 'accept-stale', 'pi-permission',
]);

const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

const MAX_BODY_BYTES = 64 * 1024;

// Same as lib/http.mjs pageNavigation: a same-site top-level GET/HEAD document navigation to / or
// /index.html (the lobby on another loopback port opens the room UI). The page carries no secret and
// cannot be framed; /api/* and every non-navigation request still need same-origin or none.
const NAVIGABLE_PATHS = Object.freeze(['/', '/index.html']);
export function pageNavigation(headers, { method, path: p } = {}) {
  const h = headers || {};
  if (String(h['sec-fetch-site'] || '').toLowerCase() !== 'same-site') return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (String(h['sec-fetch-mode'] || '').toLowerCase() !== 'navigate') return false;
  const dest = h['sec-fetch-dest'] === undefined ? 'document' : String(h['sec-fetch-dest']).toLowerCase();
  if (dest !== 'document') return false;
  return typeof p === 'string' && NAVIGABLE_PATHS.includes(p);
}

// Pure. headers: Node's lower-cased header object; req {method, path} enables the pageNavigation
// exception. Returns {ok:true} or {ok:false, status, error}.
export function checkHostOrigin(headers, port, req = {}) {
  const h = headers || {};
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = typeof h.host === 'string' ? h.host.trim().toLowerCase() : '';
  if (!hosts.includes(host)) return { ok: false, status: 403, error: 'BAD_HOST' };
  if (h.origin !== undefined) {
    const origin = String(h.origin).trim().toLowerCase();
    if (!hosts.some((x) => origin === `http://${x}`)) return { ok: false, status: 403, error: 'BAD_ORIGIN' };
  }
  if (h['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(h['sec-fetch-site']).toLowerCase())
    && !pageNavigation(h, req)) {
    return { ok: false, status: 403, error: 'BAD_FETCH_SITE' };
  }
  return { ok: true };
}

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function loadFixture(fixturePath = DEFAULT_FIXTURE) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const events = Array.isArray(raw.events) ? raw.events.slice().sort((a, b) => a.seq - b.seq) : [];
  return { state: raw.state || {}, room: raw.room || null, events };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

// Only top-level files of ui/ with a known type; never .mjs (this file), never fixtures/.
function staticFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p === '/' || p === '') p = '/index.html';
  if (!/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) || p.includes('..')) return null;
  const ext = path.extname(p).toLowerCase();
  if (!STATIC_TYPES[ext]) return null;
  const abs = path.join(UI_DIR, p.slice(1));
  if (path.dirname(abs) !== UI_DIR) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return { abs, type: STATIC_TYPES[ext] };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// createMockServer({ port, fixturePath, fixture, token }) -> Promise<{ server, port, url, token, received, close() }>
export function createMockServer({ port = 0, fixturePath = DEFAULT_FIXTURE, fixture, token } = {}) {
  const data = fixture || loadFixture(fixturePath);
  const adminToken = token || randomHex(16);
  const received = [];
  const sseClients = new Set();
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    const gate = checkHostOrigin(req.headers, boundPort, { method: req.method, path: String(req.url || '').split('?')[0] });
    if (!gate.ok) { send(res, gate.status, { ok: false, error: gate.error }); return; }
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${boundPort}`); } catch { send(res, 400, { ok: false, error: 'BAD_URL' }); return; }

    if (url.pathname === '/api/state') {
      if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      send(res, 200, { state: data.state, room: data.room });
      return;
    }
    if (url.pathname === '/api/events') {
      if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      const raw = url.searchParams.get('since');
      const since = raw === null || raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(since) || since < 0) { send(res, 400, { ok: false, error: 'BAD_SINCE' }); return; }
      const events = data.events.filter((e) => typeof e.seq === 'number' && e.seq > since);
      send(res, 200, { events, lastSeq: data.events.length ? data.events[data.events.length - 1].seq : 0 });
      return;
    }
    if (url.pathname === '/api/stream') {
      if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      for (const k of url.searchParams.keys()) {
        if (k !== 'since') { send(res, 400, { ok: false, error: 'BAD_QUERY' }); return; }
      }
      const parseNonNeg = (v) => {
        if (v === null || v === undefined || v === '') return 0;
        if (!/^\d+$/.test(String(v).trim())) return null;
        const n = Number(String(v).trim());
        return Number.isSafeInteger(n) && n >= 0 ? n : null;
      };
      const qSince = parseNonNeg(url.searchParams.get('since'));
      const hSince = parseNonNeg(req.headers['last-event-id']);
      if (qSince === null || hSince === null) { send(res, 400, { ok: false, error: 'BAD_SINCE' }); return; }
      if (sseClients.size >= 32) { send(res, 503, { ok: false, error: 'TOO_MANY_STREAMS' }); return; }
      const since = Math.max(qSince, hSince);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      const lastSeq = data.events.length ? data.events[data.events.length - 1].seq : 0;
      res.write(`event: snapshot\ndata: ${JSON.stringify({ state: data.state, room: data.room, lastSeq })}\n\n`);
      for (const ev of data.events) {
        if (typeof ev.seq === 'number' && ev.seq > since) res.write(`id: ${ev.seq}\nevent: room_event\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      let closed = false;
      const ping = setInterval(() => { if (!closed && !res.writableEnded) try { res.write(': ping\n\n'); } catch { cleanup(); } }, 20_000);
      if (ping.unref) ping.unref();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        sseClients.delete(cleanup);
        if (!res.writableEnded) try { res.end(); } catch {}
      };
      sseClients.add(cleanup);
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }
    if (url.pathname === '/api/admin') {
      if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      if (url.search) { send(res, 400, { ok: false, error: 'TOKEN_IN_URL', message: 'Admin token must be sent in the POST JSON body, never in the URL query string' }); return; }
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') { send(res, 415, { ok: false, error: 'CONTENT_TYPE' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { send(res, e && e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: e && e.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_JSON' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { ok: false, error: 'BAD_JSON' }); return; }
      if (!tokenEquals(body.token, adminToken)) { send(res, 401, { ok: false, error: 'BAD_TOKEN' }); return; }
      if (!ADMIN_COMMANDS.includes(body.cmd)) { send(res, 400, { ok: false, error: 'UNKNOWN_CMD', cmd: typeof body.cmd === 'string' ? body.cmd : null }); return; }
      const { token: _drop, cmd, ...params } = body;
      const rec = { n: received.length + 1, cmd, params, ts: new Date().toISOString() };
      received.push(rec);
      send(res, 200, { ok: true, mock: true, queued: `mock-${rec.n}.json`, cmd, params });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
    const f = staticFile(url.pathname);
    if (!f) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
    send(res, 200, fs.readFileSync(f.abs), f.type);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      boundPort = server.address().port;
      resolve({
        server,
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}/`,
        token: adminToken,
        received,
        close: () => new Promise((r) => { for (const c of [...sseClients]) c(); server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

function isMain() {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port === undefined ? 0 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { process.stderr.write('ERROR --port must be an integer between 0 and 65535\n'); process.exit(9); }
  const m = await createMockServer({ port, fixturePath: args.fixture ? path.resolve(String(args.fixture)) : DEFAULT_FIXTURE, token: typeof args.token === 'string' ? args.token : undefined });
  out(`MOCK_UI ${m.url}#${m.token}`);
  out('Mock server for the Room UI: data comes from the fixture; actions echo only and do not execute. Press Ctrl+C to exit.');
  const stop = () => { m.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
