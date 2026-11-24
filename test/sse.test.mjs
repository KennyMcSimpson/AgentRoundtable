// SSE streaming tests for lib/http.mjs (/api/stream) and service.subscribe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { testRunsRoot, randomHex } from '../lib/common.mjs';
import { createRoom, addSeat, openRoom } from '../lib/api.mjs';
import { startHttp } from '../lib/http.mjs';

const roots = [];
const handles = [];
after(async () => {
  for (const h of handles) await h.close().catch(() => {});
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true });
});

async function makeRoom() {
  const b = path.join(testRunsRoot(), `sse-${randomHex(5)}`);
  const roomDir = path.join(b, 'room');
  const seatA = path.join(b, 'seatA');
  fs.mkdirSync(seatA, { recursive: true });
  roots.push(b);
  assert.equal((await createRoom({ dir: roomDir, id: 'sse1', preset: 'discussion' })).code, 0);
  assert.equal((await addSeat({ dir: roomDir, seat: 'A', role: 'lead', cwd: seatA })).code, 0);
  const h = await openRoom({ roomDir, port: 0 });
  handles.push(h);
  return { b, roomDir, h, port: new URL(h.url).port };
}

function reqJson(port, { method = 'GET', pathname = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { host: host || `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function openSse(port, pathname = '/api/stream', headers = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    let buf = '';
    const flushWaiters = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const hit = events.find(w.pred);
        if (hit) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(hit);
        }
      }
    };
    const r = http.request({
      host: '127.0.0.1', port, method: 'GET', path: pathname,
      headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...headers },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw.trim() || raw.startsWith(':')) continue;
          const ev = { event: 'message', id: null, data: '' };
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('data:')) ev.data += (ev.data ? '\n' : '') + line.slice(5).trim();
          }
          try { ev.json = JSON.parse(ev.data); } catch { ev.json = null; }
          events.push(ev);
          flushWaiters();
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        waitFor(pred, timeoutMs = 4000) {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i >= 0) waiters.splice(i, 1);
              rej2(new Error(`SSE waitFor timeout (${events.length} events: ${events.map((e) => e.event).join(',')})`));
            }, timeoutMs);
            const w = { pred, resolve: res2, timer };
            waiters.push(w);
          });
        },
        close() {
          r.destroy();
          res.destroy();
        },
      });
    });
    r.on('error', reject);
    r.end();
  });
}

test('SSE /api/stream: gate, snapshot, live push, Last-Event-ID resume, no secrets', async () => {
  const { h, port } = await makeRoom();

  // Gate & query checks
  assert.equal((await reqJson(port, { pathname: '/api/stream', host: `evil.example:${port}` })).status, 403);
  assert.equal((await reqJson(port, { pathname: '/api/stream', headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await reqJson(port, { pathname: '/api/stream', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await reqJson(port, { pathname: `/api/stream?token=${h.adminToken}` })).status, 400);
  assert.equal((await reqJson(port, { pathname: '/api/stream?since=abc' })).status, 400);
  assert.equal((await reqJson(port, { method: 'POST', pathname: '/api/stream', body: {} })).status, 405);

  const client = await openSse(port, '/api/stream');
  try {
    assert.equal(client.status, 200);
    assert.match(client.headers['content-type'], /text\/event-stream/);
    const snap = await client.waitFor((e) => e.event === 'snapshot');
    assert.equal(snap.json.room.id, 'sse1');
    assert.ok(!snap.data.includes(h.adminToken), 'snapshot never leaks admin token');
    assert.ok(!snap.data.includes('"token"'), 'snapshot never leaks seat tokens');

    // Trigger a live admin message and observe immediate room_event + state frame
    const say1 = await reqJson(port, { method: 'POST', pathname: '/api/admin', body: { token: h.adminToken, cmd: 'say', text: 'hello sse 1' } });
    assert.equal(say1.status, 200);
    const ev1 = await client.waitFor((e) => e.event === 'room_event' && e.json && e.json.type === 'user_message_queued' && e.json.text === 'hello sse 1');
    assert.ok(ev1.id && Number(ev1.id) > 0);
    const st1 = await client.waitFor((e) => e.event === 'state' && e.json && e.json.lastSeq >= Number(ev1.id));
    assert.equal(st1.json.room.id, 'sse1');

    // Send a second message, then reconnect with Last-Event-ID = ev1.id
    const say2 = await reqJson(port, { method: 'POST', pathname: '/api/admin', body: { token: h.adminToken, cmd: 'say', text: 'hello sse 2' } });
    assert.equal(say2.status, 200);
    const ev2 = await client.waitFor((e) => e.event === 'room_event' && e.json && e.json.text === 'hello sse 2');
    assert.ok(Number(ev2.id) > Number(ev1.id));

    const resumed = await openSse(port, '/api/stream', { 'last-event-id': String(ev1.id) });
    try {
      const catchup = await resumed.waitFor((e) => e.event === 'room_event' && e.json && e.json.text === 'hello sse 2');
      assert.equal(Number(catchup.id), Number(ev2.id));
      const roomEvs = resumed.events.filter((e) => e.event === 'room_event');
      assert.ok(!roomEvs.some((e) => e.json && e.json.text === 'hello sse 1'), 'Last-Event-ID skips already seen events');
    } finally {
      resumed.close();
    }
  } finally {
    client.close();
  }
});

test('SSE /api/stream enforces maxSseClients cap and closes cleanly', async () => {
  const { h } = await makeRoom();
  const extraHttp = await startHttp({ service: h.service, port: 0, maxSseClients: 2 });
  handles.push(extraHttp);
  const p = extraHttp.port;

  const c1 = await openSse(p, '/api/stream');
  const c2 = await openSse(p, '/api/stream');
  try {
    await c1.waitFor((e) => e.event === 'snapshot');
    await c2.waitFor((e) => e.event === 'snapshot');
    const c3 = await reqJson(p, { pathname: '/api/stream' });
    assert.equal(c3.status, 503);
    assert.equal(c3.json.error, 'TOO_MANY_STREAMS');
  } finally {
    c1.close();
    c2.close();
  }
  // Closing server with an active client completes promptly without hanging.
  await new Promise((r) => setTimeout(r, 80));
  const c4 = await openSse(p, '/api/stream');
  assert.equal(c4.status, 200);
  await c4.waitFor((e) => e.event === 'snapshot');
  await extraHttp.close();
  c4.close();
});
