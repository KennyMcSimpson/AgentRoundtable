// dist/export.mjs: a synthetic room with a planted fake key in a packet must make the export fail;
// --redact must succeed and the key must be absent from the (decompressed) zip bytes. Also checks that
// the private layer never reaches the archive and that the scanner finds each shape it claims to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testRunsRoot } from '../lib/common.mjs';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanText, redactText, sanitizeEvent, sanitizeRoom, exportRoom } from '../dist/export.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = path.join(ROOT, 'dist', 'export.mjs');
const rand = Math.random().toString(16).slice(2, 8);
const base = path.join(testRunsRoot(), `export-${rand}`);
const roomDir = path.join(base, 'room');

// Fake secrets: shaped like the real thing, never valid. Built by concatenation so that the
// repository's own secret scan does not flag this test file.
const FAKE_KEY = 'sk-' + 'ant-' + 'api03-' + 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
const FAKE_OPENAI = 'sk-' + 'proj-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const FAKE_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const FAKE_BEARER = 'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9.e30.fakefakefakefake';
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKfake\n-----END RSA PRIVATE KEY-----';
const FAKE_GH = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const WIN_PATH = 'C:\\Users\\someone\\project\\file.txt';
const POSIX_PATH = '/home/someone/project/file.txt';

// Minimal zip reader (independent of dist/build.mjs): returns Map name -> decompressed Buffer.
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, 'EOCD present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
  }
  return out;
}

function makeRoom({ plant = true } = {}) {
  fs.rmSync(roomDir, { recursive: true, force: true });
  for (const d of ['packets', 'manifests', 'artifacts/B', 'private/att-1', 'seats/A', 'replies/A', 'admin-queue/done', 'snapshots/B/abc']) fs.mkdirSync(path.join(roomDir, d), { recursive: true });
  const seatCwd = plant ? WIN_PATH.slice(0, WIN_PATH.lastIndexOf('\\')) : 'relative-cwd';
  const room = {
    schema_version: 2, id: 'exp', createdAt: '2026-10-01T00:00:00.000Z', wallClockSec: 2700,
    seats: [
      { seatId: 'A', name: 'A', role: 'reviewer', waitMode: 'turn_over', cwd: seatCwd, outbox: `${seatCwd}\\.room-outbox\\A`, roomDir: 'C:\\Users\\someone\\AppData\\Local\\room-dev\\rooms\\exp', createdAt: '2026-10-01T00:00:00.000Z', token: 'seat-token-should-not-leak', joinSha256: 'abc', wake: { enabled: false }, audit: { kind: 'codex', threadId: 'thread-1', cwd: seatCwd } },
    ],
  };
  fs.writeFileSync(path.join(roomDir, 'room.json'), JSON.stringify(room, null, 1));
  fs.writeFileSync(path.join(roomDir, 'admin.token'), 'admin-token-should-not-leak');
  const events = [
    { seq: 1, ts: 't', type: 'seat_joined', seatId: 'A' },
    { seq: 2, ts: 't', type: 'task_set', text: '把 hello.txt 写成 hello room', sha256: 'deadbeef' },
    { seq: 3, ts: 't', type: 'packet_issued', seatId: 'A', attemptId: 'att-1', packetId: 'pk-1', path: 'C:\\Users\\someone\\AppData\\Local\\room-dev\\rooms\\exp\\packets\\pk-1.md', sha256: 'x', bytes: 10 },
    { seq: 4, ts: 't', type: 'submission_accepted', seatId: 'A', attemptId: 'att-1', file: '/home/someone/.room-outbox/A/s1.md', text: '我做完了', proof: 'proof-should-not-leak', nested: { token: 'nested-token', keep: 'yes' } },
    { seq: 5, ts: 't', type: 'artifacts_recomputed', seatId: 'B', manifestSha: 'abc', changed: [{ path: 'src/hello.mjs', from: 'a', to: 'b' }], stale: true },
  ];
  fs.writeFileSync(path.join(roomDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n{"torn":`);
  const packet = plant
    ? `[ROOM:abcd:seat=room authority=room seq=0 hash=0000000000000000]\n前言\n[/ROOM:abcd]\n[ROOM:abcd:seat=A authority=none seq=1 hash=1111111111111111]\n我把密钥贴在这里了：${FAKE_KEY}\n[/ROOM:abcd]\n`
    : `[ROOM:abcd:seat=room authority=room seq=0 hash=0000000000000000]\n前言\n[/ROOM:abcd]\n干净的包正文。\n`;
  fs.writeFileSync(path.join(roomDir, 'packets', 'pk-1.md'), packet);
  fs.writeFileSync(path.join(roomDir, 'manifests', 'pk-1.json'), JSON.stringify({ packetId: 'pk-1', seatId: 'A', attemptId: 'att-1', sha256: 'x', bytes: packet.length }));
  fs.writeFileSync(path.join(roomDir, 'artifacts', 'B', 'abc.json'), JSON.stringify({ manifestSha: 'abc', files: [{ path: 'src/hello.mjs', sha256: 'f' }] }));
  fs.writeFileSync(path.join(roomDir, 'private', 'att-1', 'raw.txt'), `raw bytes with ${FAKE_OPENAI}`);
  fs.writeFileSync(path.join(roomDir, 'seats', 'A', 'token'), 'seat-token-should-not-leak');
  fs.writeFileSync(path.join(roomDir, 'seats', 'A', 'JOIN.md'), `# JOIN\n${WIN_PATH}\n`);
  fs.writeFileSync(path.join(roomDir, 'replies', 'A', 's1.json'), '{"status":"ACCEPTED"}');
  fs.writeFileSync(path.join(roomDir, 'write-log.jsonl'), `{"op":"write","path":"${WIN_PATH.replace(/\\/g, '\\\\')}"}\n`);
  fs.writeFileSync(path.join(roomDir, 'state.json'), '{"attempt":{"path":"C:\\\\Users\\\\x"}}');
  fs.writeFileSync(path.join(roomDir, 'service.lock'), '{"pid":1}');
  fs.writeFileSync(path.join(roomDir, 'snapshots', 'B', 'abc', 'hello.mjs'), 'console.log(1)');
  return room;
}

const run = (argv) => spawnSync(process.execPath, [EXPORT, ...argv], { encoding: 'utf8' });

test.before(() => fs.mkdirSync(base, { recursive: true }));

test('scanner finds every claimed shape and redaction removes them all', () => {
  const samples = {
    'anthropic-key': FAKE_KEY, 'openai-key': FAKE_OPENAI, 'aws-key': FAKE_AWS, bearer: FAKE_BEARER, pem: FAKE_PEM,
    'github-token': FAKE_GH, 'win-path': WIN_PATH, 'posix-home': POSIX_PATH,
    'key-assignment': 'ANTHROPIC_API_KEY=' + 'abcdefghijklmnop',
  };
  for (const [kind, sample] of Object.entries(samples)) {
    const hits = scanText(`前后文 ${sample} 前后文`);
    assert.ok(hits.some((h) => h.kind === kind), `${kind} detected in ${sample}; got ${JSON.stringify(hits)}`);
    const r = redactText(`前后文 ${sample} 前后文`);
    assert.ok(!r.text.includes(sample), `${kind} removed`);
    assert.match(r.text, /<REDACTED:[a-z-]+>/);
    assert.equal(scanText(r.text).length, 0, `${kind}: nothing left after redaction`);
  }
  assert.equal(scanText('普通文字 seq=3 ratio 3:4 room.json packets/pk-1.md src/hello.mjs').length, 0, 'no false positives on plain text');
  assert.equal(scanText('escaped json "C:\\\\Users\\\\x\\\\y"').filter((h) => h.kind === 'win-path').length, 1, 'JSON-escaped windows path detected');
});

// W7: a profile name with a space, UNC paths and MSYS drive mounts must be detected (so an export
// without --redact is blocked) and removed whole by --redact (so the re-scan has nothing to miss).
test('paths with spaces, UNC paths and MSYS mounts are detected and fully redacted', () => {
  const B = '\\';
  const smith = ['C:', 'Users', 'John Smith', 'room-dev', 'rooms', 'p2', 'packets', 'a.md'].join(B);
  const smithHome = ['C:', 'Users', 'John Smith'].join(B);
  const unc = B + B + ['fileserver', 'share', '张三', 'x'].join(B);
  const cases = [
    { text: `见 ${smith} 前后`, gone: ['Smith', 'room-dev', 'a.md'] },
    { text: JSON.stringify({ cwd: smith }), gone: ['Smith', 'room-dev'], json: true },
    { text: JSON.stringify({ cwd: smithHome }), gone: ['Smith'], json: true },
    { text: `共享 ${unc}`, gone: ['fileserver', '张三'] },
    { text: JSON.stringify({ p: unc }), gone: ['fileserver', '张三'], json: true },
    { text: '/c/Users/Avery/secret', gone: ['Avery', 'secret'] },
    { text: '日志 /mnt/c/Users/Avery Two/x.md', gone: ['Avery', 'Two'] },
    { text: '/home/John Smith/notes.md', gone: ['Smith', 'notes'] },
    { text: `运行 ${['C:', 'Program Files (x86)', 'Tool Kit', 'a.exe'].join(B)}`, gone: ['x86', 'Tool Kit', 'a.exe'] },
  ];
  for (const c of cases) {
    assert.ok(scanText(c.text).length > 0, `detected (export without --redact is blocked): ${c.text}`);
    const r = redactText(c.text);
    for (const g of c.gone) assert.ok(!r.text.includes(g), `"${g}" removed from ${JSON.stringify(c.text)}; got ${JSON.stringify(r.text)}`);
    assert.equal(scanText(r.text).length, 0, `nothing left after redaction: ${r.text}`);
    if (c.json) assert.doesNotThrow(() => JSON.parse(r.text), `redacted JSON still parses: ${r.text}`);
  }
  // A JSON-escaped quote right after a path keeps its backslash, so the line stays valid JSON.
  const quoted = JSON.stringify({ t: `see "${['C:', 'Users', 'x'].join(B)}" ok` });
  assert.doesNotThrow(() => JSON.parse(redactText(quoted).text), 'escape of \\" is not eaten');
  // Escaped text that merely starts with two backslashes and no host is not a UNC path.
  assert.equal(scanText('regex "\\\\d+\\\\s" and "\\\\n\\\\t" packets/pk-1.md a/b/c and/or http://x.y/a/b').length, 0, 'no UNC/MSYS false positives');
});

test('an export of a room whose cwd has a space in the user name is blocked, and --redact removes it whole', async () => {
  makeRoom({ plant: false });
  const spaced = ['C:', 'Users', 'John Smith', 'proj'].join('\\');
  const unc = '\\\\' + ['fileserver', 'share', '张三', 'notes.md'].join('\\');
  fs.writeFileSync(path.join(roomDir, 'packets', 'pk-2.md'), `工作目录 ${spaced}\n共享 ${unc}\n镜像 /c/Users/Avery/secret\n`);
  const blocked = await exportRoom({ roomDir, out: path.join(base, 'spaced-blocked.zip'), redact: false });
  assert.equal(blocked.ok, false, 'blocked without --redact');
  assert.deepEqual([...new Set(blocked.hits.map((h) => h.kind))].sort(), ['msys-path', 'unc-path', 'win-path']);
  const outZip = path.join(base, 'spaced-redacted.zip');
  const r = await exportRoom({ roomDir, out: outZip, redact: true });
  assert.equal(r.ok, true);
  const body = readZipEntries(fs.readFileSync(outZip)).get('packets/pk-2.md').toString('utf8');
  for (const g of ['Smith', 'fileserver', '张三', 'Avery', 'secret']) assert.ok(!body.includes(g), `${g} absent from exported packet: ${body}`);
});

test('sanitizers drop tokens, proofs and machine-local paths but keep public fields', () => {
  const ev = sanitizeEvent({ type: 'x', path: 'p', file: 'f', privatePath: 'pp', proof: 'pr', text: 'keep', changed: [{ path: 'src/a', from: 1, to: 2 }], deep: { token: 't', cwd: 'c', ok: 1 } });
  assert.deepEqual(ev, { type: 'x', text: 'keep', changed: [{ path: 'src/a', from: 1, to: 2 }], deep: { ok: 1 } });
  const room = sanitizeRoom(makeRoom());
  assert.equal(room.seats[0].token, undefined);
  assert.equal(room.seats[0].cwd, undefined);
  assert.equal(room.seats[0].outbox, undefined);
  assert.equal(room.seats[0].roomDir, undefined);
  assert.deepEqual(room.seats[0].audit, { kind: 'codex' });
  assert.equal(room.seats[0].role, 'reviewer');
  assert.equal(room.id, 'exp');
});

test('export FAILS (exit 2) when a packet carries a planted fake key', () => {
  makeRoom({ plant: true });
  const outZip = path.join(base, 'blocked.zip');
  const r = run([roomDir, outZip]);
  assert.equal(r.status, 2, `exit 2\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^HIT entry=packets\/pk-1\.md kind=anthropic-key count=1$/m);
  assert.match(r.stdout, /^EXPORT_BLOCKED hits=\d+ entries=\d+$/m);
  assert.ok(!fs.existsSync(outZip), 'no zip written when blocked');
});

test('export --redact succeeds and the key is absent from the decompressed zip bytes', () => {
  makeRoom({ plant: true });
  const outZip = path.join(base, 'redacted.zip');
  const r = run([roomDir, outZip, '--redact']);
  assert.equal(r.status, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^REDACTED entry=packets\/pk-1\.md kind=anthropic-key count=1$/m);
  assert.match(r.stdout, /^EXPORTED zip=\S+ entries=\d+ bytes=\d+ sha256=[0-9a-f]{64} redacted=\d+$/m);
  const buf = fs.readFileSync(outZip);
  assert.ok(!buf.includes(FAKE_KEY), 'raw zip bytes do not contain the key');
  const entries = readZipEntries(buf);
  const all = Buffer.concat([...entries.values()]);
  for (const secret of [FAKE_KEY, FAKE_OPENAI, 'should-not-leak', 'nested-token', 'proof-', 'C:\\Users', '/home/', 'thread-1']) {
    assert.ok(!all.includes(secret), `decompressed entries do not contain ${secret}`);
  }
  assert.ok(entries.get('packets/pk-1.md').toString('utf8').includes('<REDACTED:anthropic-key>'), 'packet carries the marker');
  for (const name of entries.keys()) {
    assert.ok(!/^(private|seats|replies|admin-queue|snapshots)\//.test(name) && !['admin.token', 'write-log.jsonl', 'state.json', 'service.lock'].includes(name), `private entry ${name} excluded`);
  }
  for (const expected of ['room.json', 'events.jsonl', 'packets/pk-1.md', 'manifests/pk-1.json', 'artifacts/B/abc.json', 'EXPORT.json']) assert.ok(entries.has(expected), `${expected} present`);
  const events = entries.get('events.jsonl').toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 5, 'torn tail dropped, five events kept');
  assert.equal(events[2].path, undefined);
  assert.equal(events[3].file, undefined);
  assert.equal(events[3].proof, undefined);
  assert.deepEqual(events[3].nested, { keep: 'yes' });
  assert.equal(events[4].changed[0].path, 'src/hello.mjs', 'relative artifact paths survive');
  const record = JSON.parse(entries.get('EXPORT.json').toString('utf8'));
  assert.equal(record.roomId, 'exp');
  assert.equal(record.redact, true);
  assert.ok(record.redactions.some((x) => x.entry === 'packets/pk-1.md' && x.kind === 'anthropic-key'));
  assert.ok(record.excluded.includes('private'));
});

test('a clean room exports without --redact (private layer alone never trips the scan)', async () => {
  makeRoom({ plant: false });
  const outZip = path.join(base, 'clean.zip');
  const logs = [];
  const r = await exportRoom({ roomDir, out: outZip, redact: false, log: (l) => logs.push(l) });
  assert.equal(r.ok, true, logs.join('\n'));
  assert.equal(r.redactions.length, 0);
  const entries = readZipEntries(fs.readFileSync(outZip));
  assert.equal(entries.size, r.entries);
  assert.ok(!Buffer.concat([...entries.values()]).includes('should-not-leak'));
});

test('usage errors exit 9', () => {
  assert.equal(run([]).status, 9);
  assert.equal(run([roomDir, path.join(base, 'x.zip'), '--bogus']).status, 9);
  const notRoom = run([base, path.join(base, 'x.zip')]);
  assert.equal(notRoom.status, 9);
  assert.match(notRoom.stderr, /room\.json/);
});

test.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });
