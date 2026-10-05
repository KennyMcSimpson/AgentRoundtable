// lib/lobby.mjs + ui/lobby.js: the lobby started on port 0 against a temp rooms root. Rooms and seats
// are created through lib/api.mjs (the CLI code path); refusals leave nothing behind; a room opened
// from the lobby answers on its own loopback UI with its admin token; stop and close remove
// service.lock. The lobby token never travels in a URL query string.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { testRunsRoot, randomHex, ROOM_FILES as F } from '../lib/common.mjs';
import { startLobby, suggestedSeatCwd, seatFolderProblem, samePath } from '../lib/lobby.mjs';
import { spawnClean } from '../lib/spawn.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const roots = [];
const lobbies = [];
after(async () => {
  for (const l of lobbies) await l.close();
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true });
});

function base() {
  const b = path.join(testRunsRoot(), `lobby-${randomHex(5)}`);
  fs.mkdirSync(b, { recursive: true });
  roots.push(b);
  return b;
}

// Request helper with full control over Host / Origin.
function req(port, { method = 'GET', pathname = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { host: host || `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
    }, (res) => {
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
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } }

test('lobby: gate, create, refusals without leftovers, list, open, task + start, stop, close', async () => {
  const b = base();
  const roomsRoot = path.join(b, 'rooms');
  const logs = [];
  const lobby = await startLobby({ port: 0, roomsRoot, log: (l) => logs.push(l) });
  lobbies.push(lobby);
  const { port, token } = lobby;
  assert.match(lobby.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/#[0-9a-f]{48}$`), 'token only in the fragment');
  assert.ok(!lobby.url.includes('?'), 'no query string in the lobby URL');

  // Static page with the same security headers as the room UI.
  const page = await req(port, { pathname: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /lobby\.js/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  for (const f of ['/lobby.js', '/lobby.css']) assert.equal((await req(port, { pathname: f })).status, 200, f);
  assert.equal((await req(port, { pathname: '/app.js' })).status, 404, 'only the lobby files are served');
  assert.equal((await req(port, { pathname: '/../lib/lobby.mjs' })).status, 404);

  // Gate: wrong Host, cross Origin, missing / wrong token, token in the query string.
  const cwdA = path.join(b, 'seats', 'A');
  fs.mkdirSync(cwdA, { recursive: true });
  const cwdB = path.join(b, 'seats', 'new', 'B');
  const createBody = { id: 'r1', preset: 'implement-review', seats: [
    { seatId: 'A', role: 'lead', agent: 'codex-desktop', cwd: cwdA, createCwd: false },
    { seatId: 'B', role: 'executor', agent: 'claude-code', cwd: cwdB, createCwd: true },
  ] };
  assert.equal((await req(port, { pathname: '/lobby/api/rooms', host: `evil.example:${port}` })).status, 403, 'wrong Host on GET');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/create', host: `evil.example:${port}`, body: { token, ...createBody } })).status, 403, 'wrong Host on POST');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/create', headers: { origin: 'http://evil.example' }, body: { token, ...createBody } })).status, 403, 'cross Origin');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/create', headers: { 'sec-fetch-site': 'cross-site' }, body: { token, ...createBody } })).status, 403, 'cross-site fetch');
  const noTok = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: createBody });
  assert.equal(noTok.status, 401);
  assert.equal(noTok.json.error, 'BAD_TOKEN');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token: 'f'.repeat(48), ...createBody } })).status, 401, 'wrong token');
  assert.equal((await req(port, { method: 'POST', pathname: `/lobby/api/create?token=${token}`, body: createBody })).status, 400, 'token in a query string refused');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/create', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token, ...createBody }) })).status, 415);
  // Over the cap the server answers 413 and drops the connection (lib/http.mjs readBody), so the
  // client sees either the 413 or the reset, depending on timing.
  const big = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, pad: 'x'.repeat(70 * 1024) } }).then((r) => r.status, (e) => e.code);
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(big), `body cap: ${big}`);
  for (const name of ['open', 'stop', 'task', 'start']) assert.equal((await req(port, { method: 'POST', pathname: `/lobby/api/${name}`, body: { id: 'r1' } })).status, 401, `${name} without token`);
  assert.ok(!fs.existsSync(path.join(roomsRoot, 'r1')), 'nothing created by refused requests');
  assert.ok(!fs.existsSync(cwdB), 'no seat folder created by refused requests');

  // Seat defaults: %USERPROFILE%\room-seats\<room>-<seat>.
  const def = await req(port, { pathname: '/lobby/api/seat-defaults?id=r1&seat=A' });
  assert.equal(def.status, 200);
  assert.equal(def.json.cwd, suggestedSeatCwd('r1', 'A'));
  assert.match(def.json.cwd, /room-seats[\\/]r1-A$/);
  assert.equal((await req(port, { pathname: '/lobby/api/seat-defaults?id=r1&seat=..%2Fx' })).status, 400);

  // Create a two-seat room: one folder made by the user, one created by the lobby.
  const made = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, ...createBody } });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.json.ok, true);
  const roomDir = path.join(roomsRoot, 'r1');
  assert.ok(fs.existsSync(path.join(roomDir, F.room)));
  assert.ok(fs.statSync(cwdB).isDirectory() && fs.readdirSync(cwdB).length === 0, 'createCwd made an empty folder');
  assert.equal(made.json.seats.length, 2);
  for (const s of made.json.seats) {
    assert.ok(fs.existsSync(s.joinPath), `JOIN.md of ${s.seatId}`);
    assert.equal(s.joinPath, path.join(roomDir, 'seats', s.seatId, 'JOIN.md'));
    assert.equal(s.sentence, `读 ${s.joinPath}，按它入席。`);
  }
  const [sa, sb] = made.json.seats;
  assert.equal(sa.wakeThread, 'room-r1-A', 'codex seat gets the default thread name, unique per room');
  assert.match(sa.hint, /Codex Desktop/);
  assert.match(sa.hint, /workspace-write/);
  assert.match(sa.hint, /room-r1-A/);
  assert.ok(sa.hint.includes(path.resolve(cwdA)), 'hint names the project folder');
  assert.match(sb.hint, /Claude Code/);
  assert.match(sb.hint, /Bash\(node .+room\.mjs:\*\)/, 'hint names the one allow rule');
  assert.equal(sb.createdCwd, true);
  const room = JSON.parse(fs.readFileSync(path.join(roomDir, F.room), 'utf8'));
  assert.deepEqual(room.seats.map((s) => [s.seatId, s.role, s.agent]), [['A', 'lead', 'codex-desktop'], ['B', 'executor', 'claude-code']]);
  assert.equal(room.seats[0].wake.thread, 'room-r1-A');
  assert.equal(room.preset, 'implement-review');
  // Written by admin (the CLI code path), recorded in the room's write-log.
  assert.match(fs.readFileSync(path.join(roomDir, F.writeLog), 'utf8'), /"who":"admin"/);

  // Refusals leave nothing behind.
  const dup = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, ...createBody, seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: cwdA }] } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'ROOM_EXISTS');
  assert.match(dup.json.message, /已经存在/);
  assert.ok(fs.existsSync(path.join(roomDir, F.room)), 'the existing room is untouched');
  const missing = path.join(b, 'seats', 'missing');
  const miss = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r2', preset: 'discussion', seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: missing, createCwd: false }] } });
  assert.equal(miss.status, 400);
  assert.equal(miss.json.error, 'CWD_MISSING');
  assert.match(miss.json.message, /不存在/);
  assert.ok(!fs.existsSync(path.join(roomsRoot, 'r2')) && !fs.existsSync(missing), 'nothing left after a missing folder');
  // A refusal that only add-seat can see (two leads): the room and the folder it made are removed.
  const fresh = path.join(b, 'seats', 'fresh', 'X');
  const two = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r3', preset: 'discussion', seats: [
    { seatId: 'X', role: 'lead', agent: 'generic', cwd: fresh, createCwd: true },
    { seatId: 'Y', role: 'lead', agent: 'generic', cwd: cwdA },
  ] } });
  assert.equal(two.status, 400, two.text);
  assert.equal(two.json.error, 'SEAT_REFUSED');
  assert.match(two.json.message, /席位 Y 没建成/);
  assert.ok(!fs.existsSync(path.join(roomsRoot, 'r3')), 'half-created room removed');
  assert.ok(!fs.existsSync(path.join(b, 'seats', 'fresh')), 'folders the request created removed');
  const exists = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r4', seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: cwdA, createCwd: true }] } });
  assert.equal(exists.json.error, 'CWD_EXISTS', 'createCwd only makes a new folder');
  const rel = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r4', seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: 'relative\\x', createCwd: true }] } });
  assert.equal(rel.json.error, 'CWD_NOT_ABSOLUTE');
  assert.ok(!fs.existsSync(path.join(roomsRoot, 'r4')));
  assert.deepEqual(fs.readdirSync(roomsRoot), ['r1'], 'only the created room is under the rooms root');

  // LOBBY-SEC-1: an EMPTY folder the user already had survives a refused create; only the folder the
  // request made is removed.
  const keep = path.join(b, 'seats', 'keep-empty');
  fs.mkdirSync(keep, { recursive: true });
  const refusedInKeep = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r5', preset: 'discussion', seats: [
    { seatId: 'X', role: 'lead', agent: 'generic', cwd: path.join(keep, 'X'), createCwd: true },
    { seatId: 'Y', role: 'lead', agent: 'generic', cwd: cwdA },
  ] } });
  assert.equal(refusedInKeep.json.error, 'SEAT_REFUSED', refusedInKeep.text);
  assert.ok(!fs.existsSync(path.join(keep, 'X')), 'the folder the request made is removed');
  assert.ok(fs.existsSync(keep), 'the empty folder that existed before the request survives');
  assert.ok(fs.existsSync(path.join(b, 'seats')), 'and so does its parent');
  assert.ok(!fs.existsSync(path.join(roomsRoot, 'r5')));
  // A deeper new chain under the pre-existing empty folder: every new level goes, the old one stays.
  const refusedDeep = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r5', preset: 'discussion', seats: [
    { seatId: 'X', role: 'lead', agent: 'generic', cwd: path.join(keep, 'n1', 'n2', 'X'), createCwd: true },
    { seatId: 'Y', role: 'lead', agent: 'generic', cwd: cwdA },
  ] } });
  assert.equal(refusedDeep.json.error, 'SEAT_REFUSED');
  assert.ok(!fs.existsSync(path.join(keep, 'n1')), 'new parents removed');
  assert.deepEqual(fs.readdirSync(keep), [], 'pre-existing empty folder kept, still empty');

  // LOBBY-SEC-2 / SEC-3: names Windows programs would open differently, or cannot create, are
  // refused before anything is made (no 500, nothing left behind).
  if (process.platform === 'win32') {
    for (const [bad, what] of [[path.join(b, 'seats', 'p1', 'p2', 'x<y'), 'illegal character'], [path.join(b, 'seats', 'p1', 'AppData.', 'x'), 'trailing dot'], [path.join(b, 'seats', 'p1', 'AppData ', 'x'), 'trailing space'], [path.join(b, 'seats', 'p1', 'con', 'x'), 'device name']]) {
      for (const createCwd of [true, false]) {
        const r = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r6', preset: 'discussion', seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: bad, createCwd }] } });
        assert.equal(r.status, 400, `${what}: ${r.text}`);
        assert.equal(r.json.error, 'CWD_BAD_NAME', what);
        assert.match(r.json.message, /工作文件夹不能用/);
      }
    }
    assert.ok(!fs.existsSync(path.join(b, 'seats', 'p1')), 'no parent folder left behind by a bad name');
    // A recursive mkdir that makes the parents and then fails on the leaf (a name longer than a
    // Windows name may be): a refusal, and the parents it made are removed again.
    const tooLong = path.join(b, 'seats', 'q1', 'q2', 'x'.repeat(300));
    const fail = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'r6', preset: 'discussion', seats: [{ seatId: 'A', role: 'lead', agent: 'generic', cwd: tooLong, createCwd: true }] } });
    assert.equal(fail.status, 400, fail.text);
    assert.equal(fail.json.error, 'CWD_CREATE_FAILED');
    assert.ok(!fs.existsSync(path.join(b, 'seats', 'q1')), 'parents made before the failure are removed');
    assert.ok(!fs.existsSync(path.join(roomsRoot, 'r6')));
  }
  assert.deepEqual(fs.readdirSync(roomsRoot), ['r1'], 'still only the created room');

  // F3: the page asks whether a typed folder exists (read-only), to untick 替我新建.
  const fe = await req(port, { pathname: `/lobby/api/folder?path=${encodeURIComponent(cwdA)}` });
  assert.deepEqual([fe.status, fe.json.exists, fe.json.isDir], [200, true, true]);
  const fm = await req(port, { pathname: `/lobby/api/folder?path=${encodeURIComponent(path.join(b, 'nope'))}` });
  assert.deepEqual([fm.json.exists, fm.json.isDir], [false, false]);
  assert.ok(!fs.existsSync(path.join(b, 'nope')), 'the check creates nothing');
  assert.equal((await req(port, { pathname: '/lobby/api/folder?path=relative' })).status, 400);
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/folder', body: { token } })).status, 405);

  // List.
  const list = await req(port, { pathname: '/lobby/api/rooms' });
  assert.equal(list.status, 200);
  assert.equal(list.json.rooms.length, 1);
  const r1 = list.json.rooms[0];
  assert.equal(r1.id, 'r1');
  assert.equal(r1.preset, 'implement-review');
  assert.equal(r1.phase, 'idle');
  assert.equal(r1.roundId, 0);
  assert.equal(r1.serviceRunning, false);
  assert.equal(r1.openedHere, false);
  assert.deepEqual(r1.seats.map((s) => [s.seatId, s.role, s.agent, s.waitMode, s.wakeThread]), [['A', 'lead', 'codex-desktop', 'turn_over', 'room-r1-A'], ['B', 'executor', 'claude-code', 'background', null]]);
  assert.ok(!list.text.includes(token), 'the list never carries the lobby token');

  // Another service in this process already holds the lock: open is refused in Chinese.
  const lockPath = path.join(roomDir, F.lock);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, image: 'node', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  const held = await req(port, { method: 'POST', pathname: '/lobby/api/open', body: { token, id: 'r1' } });
  assert.equal(held.status, 409);
  assert.equal(held.json.error, 'SERVICE_RUNNING');
  assert.match(held.json.message, /已经/);
  fs.rmSync(lockPath);

  // task before open: refused, nothing queued.
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/task', body: { token, id: 'r1', text: 'x' } })).json.error, 'NOT_OPEN');

  // Open: the room UI answers; the fragment carries the room's admin token.
  const opened = await req(port, { method: 'POST', pathname: '/lobby/api/open', body: { token, id: 'r1' } });
  assert.equal(opened.status, 200, opened.text);
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#([0-9a-f]+)$/.exec(opened.json.url);
  assert.ok(m, `room url ${opened.json.url}`);
  const roomPort = Number(m[1]);
  const adminToken = fs.readFileSync(path.join(roomDir, F.adminToken), 'utf8').trim();
  assert.equal(m[2], adminToken, 'fragment is the room admin token');
  assert.notEqual(roomPort, port);
  // F1: the browser follows the lobby's link to the room UI on another loopback port as a same-site
  // top-level navigation. The page loads; the API and every non-navigation request stay closed.
  const nav = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const uiPage = await req(roomPort, { pathname: '/', headers: nav });
  assert.equal(uiPage.status, 200, `room UI opens from the lobby link: ${uiPage.text.slice(0, 120)}`);
  assert.match(uiPage.headers['content-type'], /text\/html/);
  assert.match(uiPage.text, /app\.js/);
  assert.equal(uiPage.headers['x-frame-options'], 'DENY', 'still not frameable');
  assert.equal((await req(roomPort, { pathname: '/index.html', headers: nav })).status, 200);
  assert.equal((await req(roomPort, { pathname: '/api/state', headers: nav })).status, 403, 'same-site navigation to the API refused');
  assert.equal((await req(roomPort, { pathname: '/api/state', headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).status, 403, 'same-site fetch of the API refused');
  assert.equal((await req(roomPort, { pathname: '/app.js', headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } })).status, 403, 'same-site script load refused');
  assert.equal((await req(roomPort, { pathname: '/', headers: { ...nav, 'sec-fetch-dest': 'iframe' } })).status, 403, 'same-site frame load refused');
  assert.equal((await req(roomPort, { pathname: '/', headers: { ...nav, 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site navigation refused');
  assert.equal((await req(roomPort, { method: 'POST', pathname: '/api/admin', headers: nav, body: { token: m[2], cmd: 'say', text: 'x' } })).status, 403, 'same-site POST refused');
  const st = await req(roomPort, { pathname: '/api/state' });
  assert.equal(st.status, 200);
  assert.equal(st.json.room.id, 'r1');
  const adm = await req(roomPort, { method: 'POST', pathname: '/api/admin', body: { token: m[2], cmd: 'say', text: '你好' } });
  assert.equal(adm.status, 200, adm.text);
  assert.notEqual(adm.json.ok, false, 'the room accepts its admin token from the fragment');
  assert.ok(fs.existsSync(lockPath), 'service.lock while open');
  const again = await req(port, { method: 'POST', pathname: '/lobby/api/open', body: { token, id: 'r1' } });
  assert.equal(again.json.url, opened.json.url, 'opening twice returns the same room');
  assert.equal(again.json.already, true);
  const list2 = (await req(port, { pathname: '/lobby/api/rooms' })).json.rooms[0];
  assert.equal(list2.openedHere, true);
  assert.equal(list2.serviceRunning, true);
  assert.equal(list2.url, `http://127.0.0.1:${roomPort}/`, 'GET list carries the room url without its admin token');

  // Task + start move the room to work (implement-review with an executor).
  const tk = await req(port, { method: 'POST', pathname: '/lobby/api/task', body: { token, id: 'r1', text: '写 hello.mjs' } });
  assert.equal(tk.status, 200, tk.text);
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/start', body: { token, id: 'r1', order: ['Z'] } })).json.error, 'BAD_ORDER');
  const sr = await req(port, { method: 'POST', pathname: '/lobby/api/start', body: { token, id: 'r1', order: ['A', 'B'] } });
  assert.equal(sr.status, 200, sr.text);
  assert.equal(sr.json.ok, true);
  const phase = await until(async () => { const s = await req(roomPort, { pathname: '/api/state' }); return ['work', 'meet'].includes(s.json.state.phase) ? s.json.state.phase : null; });
  assert.ok(phase, 'room moved to work/meet');
  assert.equal((await req(roomPort, { pathname: '/api/state' })).json.state.task.text, '写 hello.mjs');
  const list3 = (await req(port, { pathname: '/lobby/api/rooms' })).json.rooms[0];
  assert.ok(['work', 'meet'].includes(list3.phase));
  assert.equal(list3.roundId, 1);
  const again2 = await req(port, { method: 'POST', pathname: '/lobby/api/start', body: { token, id: 'r1' } });
  assert.equal(again2.status, 409, 'a second start while the round runs is refused');
  assert.match(again2.json.message, /开始被房间拒绝/);

  // Stop: service.lock gone, the room UI no longer answers.
  const stopped = await req(port, { method: 'POST', pathname: '/lobby/api/stop', body: { token, id: 'r1' } });
  assert.equal(stopped.status, 200, stopped.text);
  assert.ok(!fs.existsSync(lockPath), 'no service.lock after stop');
  await assert.rejects(req(roomPort, { pathname: '/api/state' }));
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/stop', body: { token, id: 'r1' } })).json.error, 'NOT_OPEN');

  // Open again, then close the lobby: every room it opened stops.
  const reopened = await req(port, { method: 'POST', pathname: '/lobby/api/open', body: { token, id: 'r1' } });
  assert.equal(reopened.status, 200, reopened.text);
  assert.ok(fs.existsSync(lockPath));
  await lobby.close();
  assert.ok(!fs.existsSync(lockPath), 'no service.lock after close');
  await assert.rejects(req(port, { pathname: '/' }), 'lobby port closed');
  assert.ok(!logs.some((l) => l.includes(token)), 'the lobby never logs its token');
});

// LOBBY-SEC-5: a room whose room.json id differs from its directory name is listed and acted on by
// the directory name. F4: a built-in Pi seat can be created from the lobby. SEC-3 on the CLI path.
test('lobby: rooms are keyed by directory name; built-in Pi seats; add-seat refuses Windows-renamed folders', async () => {
  const b = base();
  const roomsRoot = path.join(b, 'rooms');
  const { createRoom, addSeat } = await import('../lib/api.mjs');
  const seatDir = path.join(b, 'seats', 'A');
  fs.mkdirSync(seatDir, { recursive: true });
  const init = await createRoom({ dir: path.join(roomsRoot, 'foo'), id: 'bar' });
  assert.equal(init.code, 0, init.lines.join('\n'));
  assert.equal((await addSeat({ dir: path.join(roomsRoot, 'foo'), seat: 'A', role: 'lead', cwd: seatDir })).code, 0);
  if (process.platform === 'win32') {
    for (const c of ['AppData.', 'AppData ']) {
      const r = await addSeat({ dir: path.join(roomsRoot, 'foo'), seat: 'B', role: 'participant', cwd: `${b}\\${c}\\x` });
      assert.notEqual(r.code, 0, `add-seat refuses ${JSON.stringify(c)}`);
      assert.match(r.error || r.lines.join(' '), /句点或空格结尾/);
    }
  }
  const lobby = await startLobby({ port: 0, roomsRoot });
  lobbies.push(lobby);
  const { port, token } = lobby;
  const list = (await req(port, { pathname: '/lobby/api/rooms' })).json.rooms;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].roomId, list[0].idMismatch], ['foo', 'bar', true], 'id is the directory name');
  assert.deepEqual(list[0].seats.map((s) => s.seatId), ['A']);
  const opened = await req(port, { method: 'POST', pathname: '/lobby/api/open', body: { token, id: list[0].id } });
  assert.equal(opened.status, 200, opened.text);
  const after = (await req(port, { pathname: '/lobby/api/rooms' })).json.rooms[0];
  assert.equal(after.openedHere, true, 'openedHere found under the directory name');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/open', body: { token, id: 'bar' } })).json.error, 'NO_ROOM', 'room.json id is not an address');
  assert.equal((await req(port, { method: 'POST', pathname: '/lobby/api/stop', body: { token, id: 'foo' } })).status, 200);

  // F4: meta offers the built-in Pi tiers; create accepts hosted: 'pi:<tier>' without an agent.
  const meta = (await req(port, { pathname: '/lobby/api/meta' })).json;
  assert.deepEqual(meta.hostedTiers.map((t) => t.id), ['discussion', 'exec', 'reviewer']);
  assert.match(meta.presets.find((p) => p.id === 'simplified').desc, /房间内置 Pi/);
  const piDir = path.join(b, 'seats', 'P');
  const made = await req(port, { method: 'POST', pathname: '/lobby/api/create', body: { token, id: 'simple', preset: 'simplified', seats: [
    { seatId: 'A', role: 'lead', agent: 'claude-code', cwd: seatDir },
    { seatId: 'P', role: 'participant', hosted: 'pi:discussion', cwd: piDir, createCwd: true },
  ] } });
  assert.equal(made.status, 200, made.text);
  const p = made.json.seats.find((s) => s.seatId === 'P');
  assert.equal(p.sentence, null, 'no sentence for a seat the room runs itself');
  assert.match(p.hint, /内置 Pi/);
  const room = JSON.parse(fs.readFileSync(path.join(roomsRoot, 'simple', F.room), 'utf8'));
  assert.deepEqual(room.seats.find((s) => s.seatId === 'P').hosted, { kind: 'pi', tier: 'discussion' });
  await lobby.close();
});

test('lobby: a busy port falls back to a free one', async () => {
  const b = base();
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  try {
    const lobby = await startLobby({ port: busy, roomsRoot: path.join(b, 'rooms') });
    lobbies.push(lobby);
    assert.notEqual(lobby.port, busy);
    assert.equal((await req(lobby.port, { pathname: '/' })).status, 200);
    await lobby.close();
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('seatFolderProblem refuses AppData, agent homes and folders around the room', () => {
  const b = base();
  const roomsRoot = path.join(b, 'outer', 'rooms');
  const roomDir = path.join(roomsRoot, 'r');
  const env = { LOCALAPPDATA: path.join(b, 'AppData', 'Local'), APPDATA: path.join(b, 'AppData', 'Roaming'), CODEX_HOME: path.join(b, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(b, 'claude-home') };
  const ok = seatFolderProblem(path.join(b, 'seats', 'A'), { roomDir, roomsRoot, env });
  assert.equal(ok, null);
  assert.match(seatFolderProblem(path.join(env.LOCALAPPDATA, 'x'), { roomDir, roomsRoot, env }), /AppData/);
  assert.match(seatFolderProblem(path.join(env.CODEX_HOME, 'x'), { roomDir, roomsRoot, env }), /CODEX_HOME/);
  assert.match(seatFolderProblem(path.join(env.CLAUDE_CONFIG_DIR, 'x'), { roomDir, roomsRoot, env }), /CLAUDE_CONFIG_DIR/);
  assert.match(seatFolderProblem(path.join(roomsRoot, 'seat'), { roomDir, roomsRoot, env }), /互相包含/);
  assert.match(seatFolderProblem(path.join(b, 'outer'), { roomDir, roomsRoot, env }), /互相包含/);
  assert.match(seatFolderProblem('relative', { roomDir, roomsRoot, env }), /绝对路径/);
  // LOBBY-SEC-3: a trailing dot or space slips past a literal AppData comparison, but Windows programs
  // strip it and land inside AppData. Refused under a fake home whose AppData env vars are not set.
  const home = path.join(b, 'home');
  const bare = { CODEX_HOME: env.CODEX_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR };
  assert.match(seatFolderProblem(path.join(home, 'AppData', 'x'), { roomDir, roomsRoot, env: bare, home }), /AppData/, 'the plain name is refused');
  if (process.platform === 'win32') {
    for (const c of ['AppData.', 'AppData ', 'AppData. .']) {
      const msg = seatFolderProblem(`${home}\\${c}\\Local\\x`, { roomDir, roomsRoot, env: bare, home });
      assert.match(String(msg), /句点或空格结尾/, JSON.stringify(c));
    }
    assert.match(String(seatFolderProblem(`${home}\\a<b`, { roomDir, roomsRoot, env: bare, home })), /不允许/);
    assert.match(String(seatFolderProblem(`${home}\\NUL.txt\\x`, { roomDir, roomsRoot, env: bare, home })), /设备名/);
    assert.equal(seatFolderProblem(`${home}\\a.b\\x`, { roomDir, roomsRoot, env: bare, home }), null, 'a dot inside a name is fine');
    // samePath: a \\?\ prefix and case do not make two Windows paths different.
    assert.equal(samePath(`\\\\?\\${path.join(b, 'X')}`, path.join(b, 'x')), true);
    assert.equal(samePath('\\\\?\\UNC\\srv\\share\\x', '\\\\srv\\share\\x'), true);
    assert.equal(samePath(path.join(b, 'x'), path.join(b, 'y')), false);
  }
  // A repository that contains the room: the folder inside it is refused.
  const repo = path.join(b, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.match(seatFolderProblem(path.join(repo, 'seat'), { roomDir: path.join(repo, 'rooms', 'r'), roomsRoot: path.join(repo, 'rooms'), env }), /git 仓库/);
});

test('room.mjs lobby: prints the URL once (token only in its fragment) and serves the page', async () => {
  const b = base();
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'room.mjs'), 'lobby', '--port', '0'], { env: { ...process.env, ROOM_DEV_HOME: b }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  try {
    // The URL and the rooms-root line are separate writes; wait for both.
    const line = await until(async () => (/^房间目录：/m.test(out) ? /^圆桌启动器：(http:\/\/127\.0\.0\.1:(\d+)\/#([0-9a-f]{48}))\r?$/m.exec(out) : null), 15000);
    assert.ok(line, `URL line printed\n${out}`);
    const [, url, p, tok] = line;
    assert.ok(!url.includes('?'));
    assert.equal(out.split(tok).length - 1, 1, 'the token is printed exactly once');
    assert.match(out, new RegExp(`房间目录：${path.join(b, 'rooms').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.equal((await req(Number(p), { pathname: '/' })).status, 200);
    assert.equal((await req(Number(p), { method: 'POST', pathname: '/lobby/api/open', body: { token: tok, id: 'none' } })).json.error, 'NO_ROOM');
  } finally {
    child.kill();
    await new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', r); });
  }
});

test('the double-click path is the desktop app, not a cmd file', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '启动圆桌.cmd')), '启动圆桌.cmd is gone');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'main.mjs');
  const main = fs.readFileSync(path.join(ROOT, 'app', 'main.mjs'), 'utf8');
  assert.match(main, /utilityProcess\.fork\(spec\.modulePath, spec\.args, spec\.options\)/, 'the app forks room.mjs lobby');
});

// ui/lobby.js: the token is read from the fragment once, removed with replaceState, and sent only in
// POST bodies. Static analysis of the source (no browser).
test('ui/lobby.js never puts the lobby token in a URL', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'lobby.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const chk = await spawnClean(process.execPath, ['--check', path.join(ROOT, 'ui', 'lobby.js')], { timeoutMs: 20_000 });
  assert.equal(chk.code, 0, chk.stderr);
  assert.ok(!/[?&]token=/.test(code), 'no ?token= / &token= anywhere');
  assert.ok(!/URLSearchParams|searchParams/.test(code), 'no query-string builder');
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(code), 'token kept in memory only');
  assert.equal((code.match(/\bfetch\(/g) || []).length, 2, 'fetch only inside getJson and postJson');
  // Every string that starts a URL with a query string: none of those expressions mentions the token.
  const queryLines = code.split('\n').filter((l) => /['"][^'"]*\?[A-Za-z_]+=/.test(l));
  assert.ok(queryLines.length >= 1, 'the seat-defaults query is found (the check is live)');
  for (const l of queryLines) assert.ok(!/token/i.test(l), `query string built without the token: ${l.trim()}`);
  // getJson is never handed the token; postJson puts it in the JSON body.
  for (const call of code.match(/getJson\([^)]*\)/g) || []) assert.ok(!/token/i.test(call), call);
  assert.match(code, /function postJson\(path, body\) \{\s*var payload = Object\.assign\(\{\}, body \|\| \{\}, \{ token: app\.token \}\);/);
  assert.match(code, /body: JSON\.stringify\(payload\)/);
  assert.match(code, /function getJson\(path\) \{\s*return fetch\(path, \{ method: 'GET'/);
  // The fragment is read once and removed from the address bar.
  assert.equal((code.match(/location\.hash/g) || []).length, 2, 'location.hash read in one place');
  assert.match(code, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.equal((code.match(/takeTokenFromFragment\(\)/g) || []).length, 2, 'defined once, called once');
  // LOBBY-SEC-5: a room id is never concatenated into a CSS selector.
  assert.ok(!/querySelector(All)?\([^)]*\+/.test(code), 'no selector built from data');
  // F3 / F4: a typed folder is checked read-only; a built-in Pi seat is sent as hosted 'pi:<tier>'.
  assert.match(code, /getJson\('\/lobby\/api\/folder\?path=' \+ encodeURIComponent\(v\)\)/);
  assert.match(code, /create\.checked = !res\.json\.exists;/);
  assert.match(code, /s\.hosted = 'pi:' \+ tier\.value; return s;/);
  assert.match(code, /preset === 'simplified'/);
  // Inline scripts / handlers would break the CSP the lobby sends.
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'lobby.html'), 'utf8');
  assert.ok(!/<script>(?!<\/script>)|\son[a-z]+=/.test(html), 'no inline script or handler in lobby.html');
  assert.ok(!/<style>|\sstyle=/.test(html), 'no inline style in lobby.html');
});
