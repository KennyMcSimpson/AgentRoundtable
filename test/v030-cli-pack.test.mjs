// v0.3.0 CLI, lean packaging, async stdin submit (real subprocess + size cap), and storefront hygiene checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanText } from '../dist/public-scan.mjs';
import { cmdInit, cmdAddSeat } from '../lib/admin.mjs';
import { createRoomService } from '../lib/service.mjs';
import { cmdSubmit, readStdinBounded } from '../lib/seat.mjs';
import { testRunsRoot, randomHex, readJsonl } from '../lib/common.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOM_MJS = path.join(ROOT, 'room.mjs');
const base = path.join(testRunsRoot(), `v030-test-${randomHex(4)}`);
after(() => fs.rmSync(base, { recursive: true, force: true }));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

test('room.mjs --version reports package.json version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const r = spawnSync(process.execPath, [ROOM_MJS, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `agent-roundtable ${pkg.version}`);
});

test('room.mjs demo serves the 5-agent Studio fixture on loopback and rejects unknown/dead/smuggled flags', async () => {
  const bad1 = spawnSync(process.execPath, [ROOM_MJS, 'demo', '--unknown-flag'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(bad1.status, 9);
  assert.match(bad1.stderr, /unknown option --unknown-flag/);

  const badOpen = spawnSync(process.execPath, [ROOM_MJS, 'demo', '--open'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(badOpen.status, 9, 'dead --open flag must be rejected cleanly');

  const bad2 = spawnSync(process.execPath, [ROOM_MJS, 'demo', '--no-open', 'extra'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(bad2.status, 9);
  assert.match(bad2.stderr, /--no-open takes no value/);

  const badPort = spawnSync(process.execPath, [ROOM_MJS, 'demo', '--port', '   '], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(badPort.status, 9);
  assert.match(badPort.stderr, /--port must be an integer/);

  const badFixtureDir = spawnSync(process.execPath, [ROOM_MJS, 'demo', '--fixture', path.join(ROOT, 'ui')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(badFixtureDir.status, 9);
  assert.match(badFixtureDir.stderr, /fixture file not found/);

  const child = spawn(process.execPath, [ROOM_MJS, 'demo', '--port', '0', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, CI: '1' },
  });
  let out = '';
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`demo startup timeout; stdout=${out}`)), 10_000);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
        const m = /http:\/\/127\.0\.0\.1:(\d+)\/#([0-9a-f]+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`demo exited early (${code}): ${out}`)); });
    });
    const html = await httpGet(`${url}/`);
    assert.equal(html.status, 200);
    assert.match(html.text, /AgentRoundtable/);
    const state = await httpGet(`${url}/api/state`);
    assert.equal(state.status, 200);
    const parsed = JSON.parse(state.text);
    assert.ok(Array.isArray(parsed.room.seats) && parsed.room.seats.length === 5);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', () => r()));
  }
});

test('readStdinBounded enforces max byte cap and real subprocess `room.mjs submit --file -` pipes chunked stdin verbatim', async () => {
  const huge = Readable.from([Buffer.alloc(60, 0x61), Buffer.alloc(60, 0x62)]);
  await assert.rejects(() => readStdinBounded(huge, 100), /exceeds 100 bytes limit/);

  const roomDir = path.join(base, 'stdin-room');
  const seatCwd = path.join(base, 'stdin-seat');
  fs.mkdirSync(seatCwd, { recursive: true });
  const quiet = { out: () => {} };
  cmdInit({ dir: roomDir, id: 'stdin-demo', preset: 'discussion' }, quiet);
  cmdAddSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'generic', cwd: seatCwd }, quiet);

  const svc = createRoomService({
    roomDir,
    log: () => {},
    adjudicationsPath: path.join(base, 'adj.jsonl'),
    gitExe: null,
    savedPiKeyPath: path.join(base, 'no-key.dpapi'),
  });
  await svc.admin({ cmd: 'start', order: ['A'] });
  await svc.tick();
  const issued = readJsonl(path.join(roomDir, 'events.jsonl')).find((e) => e.type === 'packet_issued');
  assert.ok(issued && issued.attemptId);

  const emptyRes = spawnSync(
    process.execPath,
    [ROOM_MJS, 'submit', '--seat', path.join(roomDir, 'seats', 'A'), '--attempt', issued.attemptId, '--file', '-'],
    { input: '', encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  assert.equal(emptyRes.status, 9);
  assert.match(emptyRes.stderr, /stdin body is empty/);

  const trickySpeech = 'Reviewed `$(rm -rf /)` and `"quoted"` code.\nLine 2 with $HOME and `backticks`.\n';
  const tickTimer = setInterval(() => { svc.tick().catch(() => {}); }, 25);
  let subOut = '';
  let subErr = '';
  let subCode = -1;
  try {
    const child = spawn(
      process.execPath,
      [ROOM_MJS, 'submit', '--seat', path.join(roomDir, 'seats', 'A'), '--attempt', issued.attemptId, '--file', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stdout.on('data', (d) => { subOut += d.toString('utf8'); });
    child.stderr.on('data', (d) => { subErr += d.toString('utf8'); });
    const half = Math.floor(trickySpeech.length / 2);
    child.stdin.write(trickySpeech.slice(0, half));
    await new Promise((r) => setTimeout(r, 30));
    child.stdin.end(trickySpeech.slice(half));
    subCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  } finally {
    clearInterval(tickTimer);
    await svc.close();
  }

  assert.equal(subCode, 0, `stdout=${subOut}\nstderr=${subErr}`);
  assert.match(subOut, /^ACCEPTED /);
  const acc = readJsonl(path.join(roomDir, 'events.jsonl')).find((e) => e.type === 'submission_accepted');
  assert.ok(acc && acc.text === trickySpeech, 'exact chunked stdin speech bytes preserved verbatim');

  await assert.rejects(
    () => cmdSubmit(
      { seat: path.join(roomDir, 'seats', 'A'), attempt: issued.attemptId, file: '-' },
      { out: () => {}, maxStdinBytes: 16, readStdinBytes: () => Buffer.alloc(32, 0x78) },
    ),
    /exceeds 16 bytes limit/,
  );
});

test('lean npm files whitelist, llms.txt, SKILL.md, and SVGs are clean English and public-scan safe', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length >= 6, 'package.json declares files whitelist');
  assert.ok(!pkg.files.includes('docs/'), 'npm tarball must exclude heavy docs/assets PNG screenshots');
  assert.ok(pkg.files.includes('docs/*.md'), 'npm tarball includes lightweight markdown docs only');
  for (const entry of pkg.files) {
    const baseEntry = entry.includes('*') ? entry.split('*')[0].replace(/\/$/, '') : entry;
    assert.ok(fs.existsSync(path.join(ROOT, baseEntry)), `package.json files entry exists: ${entry}`);
  }
  const textFiles = [
    'llms.txt',
    'skills/agent-roundtable/SKILL.md',
    'docs/assets/hero-dark.svg',
    'docs/assets/hero-light.svg',
    'docs/assets/governance-flow-dark.svg',
    'docs/assets/governance-flow-light.svg',
    'README.md',
    'CHANGELOG.md',
  ];
  for (const rel of textFiles) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${rel} has no UTF-8 BOM`);
    const txt = buf.toString('utf8');
    assert.doesNotMatch(txt, /[\u4e00-\u9fff]/, `${rel} contains zero CJK characters`);
    assert.deepEqual(scanText(txt), [], `${rel} passes public-scan rules`);
    if (rel.endsWith('.svg')) {
      assert.match(txt, /^<svg\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(txt, /<\/svg>\s*$/);
    }
  }
});
