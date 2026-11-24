// Multi-room daemon, persistent registry, live room auto-resume, and lobby SSE tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { testRunsRoot, randomHex, ROOM_FILES as F } from '../lib/common.mjs';
import { createDaemonStore, readDaemonStatus, REGISTRY_FILE, DAEMON_META_FILE } from '../lib/daemon-store.mjs';
import { startLobby } from '../lib/lobby.mjs';
import { spawnClean } from '../lib/spawn.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const roots = [];
const lobbies = [];
after(async () => {
  for (const l of lobbies) await l.close().catch(() => {});
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true });
});

function base() {
  const b = path.join(testRunsRoot(), `daemon-${randomHex(5)}`);
  fs.mkdirSync(b, { recursive: true });
  roots.push(b);
  return b;
}

function req(port, { method = 'GET', pathname = '/', headers = {}, body, host } = {}) {
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

function openSse(port, pathname = '/lobby/api/stream') {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    let buf = '';
    const flush = () => {
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
      headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw.trim() || raw.startsWith(':')) continue;
          const ev = { event: 'message', data: '' };
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data += (ev.data ? '\n' : '') + line.slice(5).trim();
          }
          try { ev.json = JSON.parse(ev.data); } catch { ev.json = null; }
          events.push(ev);
          flush();
        }
      });
      resolve({
        status: res.statusCode,
        events,
        waitFor(pred, ms = 4000) {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i >= 0) waiters.splice(i, 1);
              rej2(new Error(`lobby SSE waitFor timeout (${events.length} events)`));
            }, ms);
            const w = { pred, resolve: res2, timer };
            waiters.push(w);
          });
        },
        close() { r.destroy(); res.destroy(); },
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(50); } }

test('daemon-store: atomic persist, corrupt backup recovery, meta status', async () => {
  const b = base();
  const roomsRoot = path.join(b, 'rooms');
  const s1 = createDaemonStore(roomsRoot);
  assert.equal(s1.load().ok, true);
  await s1.upsertRoom('alpha', { roomDir: path.join(roomsRoot, 'alpha'), defaultOrder: ['A', 'B'] });
  await s1.drain();
  assert.ok(fs.existsSync(path.join(roomsRoot, REGISTRY_FILE)));

  const s2 = createDaemonStore(roomsRoot);
  assert.equal(s2.load().ok, true);
  assert.deepEqual(s2.getRoom('alpha').defaultOrder, ['A', 'B']);

  // Corrupt JSON triggers backup + clean reset
  fs.writeFileSync(path.join(roomsRoot, REGISTRY_FILE), '{corrupt!!!', 'utf8');
  const s3 = createDaemonStore(roomsRoot);
  const loaded = s3.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recovered, true);
  assert.ok(loaded.backupPath && fs.existsSync(loaded.backupPath));
  assert.equal(fs.readFileSync(loaded.backupPath, 'utf8'), '{corrupt!!!');
  await s3.drain();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(roomsRoot, REGISTRY_FILE), 'utf8')).rooms, {});

  // Daemon meta status
  assert.equal(readDaemonStatus(roomsRoot).running, false);
  s3.writeMeta({ pid: process.pid, port: 43210, mode: 'daemon' });
  const stLive = readDaemonStatus(roomsRoot);
  assert.equal(stLive.running, true);
  assert.equal(stLive.meta.port, 43210);
  const stDead = readDaemonStatus(roomsRoot, { isAlive: () => false });
  assert.equal(stDead.running, false);
  s3.clearMeta(process.pid);
  assert.ok(!fs.existsSync(path.join(roomsRoot, DAEMON_META_FILE)));
});

test('daemon mode: lang=en room, start with task protection, registry outside roomDir, auto-resume, lobby SSE & health', async () => {
  const b = base();
  const roomsRoot = path.join(b, 'rooms');
  const seatA = path.join(b, 'seats', 'A');
  const seatB = path.join(b, 'seats', 'B');
  fs.mkdirSync(seatA, { recursive: true });
  fs.mkdirSync(seatB, { recursive: true });

  const d1 = await startLobby({ port: 0, roomsRoot, mode: 'daemon', resume: true, persistRegistry: true });
  lobbies.push(d1);
  assert.equal(d1.mode, 'daemon');
  assert.ok(fs.existsSync(path.join(roomsRoot, DAEMON_META_FILE)));

  // Health endpoint (zero token)
  const health = await req(d1.port, { pathname: '/lobby/api/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.mode, 'daemon');
  assert.equal(health.json.pid, process.pid);
  assert.ok(!health.text.includes(d1.token));

  // Lobby SSE gate + initial rooms frame
  assert.equal((await req(d1.port, { pathname: `/lobby/api/stream?token=${d1.token}` })).status, 400);
  assert.equal((await req(d1.port, { pathname: '/lobby/api/stream', host: `evil.example:${d1.port}` })).status, 403);
  const sse = await openSse(d1.port, '/lobby/api/stream');
  try {
    const initEv = await sse.waitFor((e) => e.event === 'rooms');
    assert.deepEqual(initEv.json.rooms, []);
    assert.ok(!initEv.data.includes(d1.token));

    // Create two rooms: live1 (en, will be started) and idle1 (zh-CN, stays idle)
    const c1 = await req(d1.port, { method: 'POST', pathname: '/lobby/api/create', body: {
      token: d1.token, id: 'live1', preset: 'discussion', lang: 'en',
      seats: [
        { seatId: 'A', role: 'lead', agent: 'claude-code', cwd: seatA },
        { seatId: 'B', role: 'participant', agent: 'codex-cli', cwd: seatB },
      ],
    } });
    assert.equal(c1.status, 200, c1.text);
    assert.equal(c1.json.lang, 'en');
    assert.match(c1.json.seats[0].sentence, /^Read .+JOIN\.md and join the room following it\.$/);
    assert.match(c1.json.seats[0].hint, /Claude Code/);

    const c2 = await req(d1.port, { method: 'POST', pathname: '/lobby/api/create', body: {
      token: d1.token, id: 'idle1', preset: 'discussion',
      seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: seatA }],
    } });
    assert.equal(c2.status, 200, c2.text);

    // SSE receives room list update
    const afterCreate = await sse.waitFor((e) => e.event === 'rooms' && e.json && e.json.rooms.some((r) => r.id === 'live1'));
    assert.ok(afterCreate.json.rooms.find((r) => r.id === 'live1').lang === 'en');
    assert.ok(!afterCreate.data.includes(d1.token));

    // Open live1 and start with atomic task + order
    const op = await req(d1.port, { method: 'POST', pathname: '/lobby/api/open', body: { token: d1.token, id: 'live1' } });
    assert.equal(op.status, 200, op.text);
    const roomPort = Number(new URL(op.json.url).port);

    const stStart = await req(d1.port, { method: 'POST', pathname: '/lobby/api/start', body: {
      token: d1.token, id: 'live1', task: 'Original task', order: ['A', 'B'],
    } });
    assert.equal(stStart.status, 200, stStart.text);
    const phase = await until(async () => {
      const s = await req(roomPort, { pathname: '/api/state' });
      return s.json && s.json.state.phase === 'meet' ? s.json.state.phase : null;
    });
    assert.equal(phase, 'meet');

    // Mid-round start with new task MUST fail with 409 ROUND_IN_PROGRESS and NOT overwrite the task!
    const overwrite = await req(d1.port, { method: 'POST', pathname: '/lobby/api/start', body: {
      token: d1.token, id: 'live1', task: 'SHOULD NOT OVERWRITE',
    } });
    assert.equal(overwrite.status, 409);
    assert.equal(overwrite.json.error, 'ROUND_IN_PROGRESS');
    const stAfter = await req(roomPort, { pathname: '/api/state' });
    assert.equal(stAfter.json.state.task.text, 'Original task');

    // Verify registry stored defaultOrder in <roomsRoot>, NOT inside <roomDir>
    const reg = JSON.parse(fs.readFileSync(path.join(roomsRoot, REGISTRY_FILE), 'utf8'));
    assert.deepEqual(reg.rooms.live1.defaultOrder, ['A', 'B']);
    assert.ok(!fs.existsSync(path.join(roomsRoot, 'live1', REGISTRY_FILE)));
    assert.ok(!fs.existsSync(path.join(roomsRoot, 'live1', DAEMON_META_FILE)));
  } finally {
    sse.close();
  }

  // Stop daemon 1: meta cleared, room lock released
  await d1.close();
  assert.ok(!fs.existsSync(path.join(roomsRoot, DAEMON_META_FILE)));
  assert.ok(!fs.existsSync(path.join(roomsRoot, 'live1', F.lock)));

  // Start daemon 2 on same roomsRoot: live1 auto-resumes, idle1 stays closed
  const d2 = await startLobby({ port: 0, roomsRoot, mode: 'daemon', resume: true, persistRegistry: true });
  lobbies.push(d2);
  assert.deepEqual(d2.resumed, ['live1']);
  const rooms2 = (await req(d2.port, { pathname: '/lobby/api/rooms' })).json.rooms;
  const rLive = rooms2.find((r) => r.id === 'live1');
  const rIdle = rooms2.find((r) => r.id === 'idle1');
  assert.equal(rLive.openedHere, true);
  assert.equal(rLive.serviceRunning, true);
  assert.deepEqual(rLive.defaultOrder, ['A', 'B']);
  assert.equal(rIdle.openedHere, false);
  await d2.close();
});

test('room.mjs daemon + daemon status CLI', async () => {
  const b = base();
  const roomsRoot = path.join(b, 'rooms');
  const before = await spawnClean(process.execPath, [path.join(ROOT, 'room.mjs'), 'daemon', 'status', '--rooms-root', roomsRoot], { timeoutMs: 10_000 });
  assert.equal(before.code, 1);
  assert.match(before.stdout, /DAEMON_STOPPED/);

  const child = spawn(process.execPath, [path.join(ROOT, 'room.mjs'), 'daemon', '--port', '0', '--rooms-root', roomsRoot], {
    env: { ...process.env, ROOM_DEV_HOME: b },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  try {
    const ready = await until(async () => (/常驻守护模式：/.test(out) ? /^圆桌启动器：(http:\/\/127\.0\.0\.1:(\d+)\/#([0-9a-f]{48}))\r?$/m.exec(out) : null), 15_000);
    assert.ok(ready, `daemon stdout:\n${out}`);
    const running = await spawnClean(process.execPath, [path.join(ROOT, 'room.mjs'), 'daemon', 'status', '--rooms-root', roomsRoot], { timeoutMs: 10_000 });
    assert.equal(running.code, 0, running.stdout + running.stderr);
    assert.match(running.stdout, new RegExp(`DAEMON_RUNNING pid=${child.pid} port=${ready[2]}`));
  } finally {
    child.kill();
    await new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', r); });
  }
});
