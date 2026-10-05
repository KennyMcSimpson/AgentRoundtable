// Pure parts of the contract scripts and the evidence collector: diff functions, path containment,
// the write-log checker on synthetic logs (with planted violations that must be caught: negative
// controls), process-set and ancestry judgement, environment helpers, report rendering.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnClean } from '../lib/spawn.mjs';
import { openRunDir, canonicalPath, passThroughEnv, createReporter } from '../contract/harness.mjs';
import { diffSnapshots, snapshotTargets, listEntries, formatDiff, diffKey, countEntries } from '../contract/memory-diff.mjs';
import { isInsideRoot, classifyAuthor, checkWriteLog, readWriteLog, collectSeats, main as checkWritesMain } from '../contract/check-writes.mjs';
import { parseTasklistCsv, parsePs, parsePsParents, diffProcessSets, roomAncestor, judgeAgentDiff, compareReport, filterServiceCommandLines } from '../contract/pids.mjs';
import { extraEnvKeys, findCanaries, makeCanaries, canaryKeysIn, parseProbeLines, PROBE_SOURCE, CANARY_KEYS } from '../contract/env.mjs';
import { applyBaseline, unexpectedWorkdirEntries, defaultTargets, GROUPS } from '../contract/control-run.mjs';
import { parseTapSummary, parseE2eSummary, parseContractLines, pickRaw, planRowFor, renderReport, quoteArg } from '../evidence/collect.mjs';

const WIN = process.platform === 'win32';
const R = (...p) => path.resolve(path.sep, 'rooms-test', ...p); // absolute, platform-native, never touched

// One run directory under testRunsRoot() per test-file run; each test gets its own sub-directory.
// Removed after the file's tests finish (its names are ASCII, so fs.rmSync is reliable here).
let RUN = null;
after(() => { if (RUN) fs.rmSync(RUN.runDir, { recursive: true, force: true }); });
let nScratch = 0;
function scratch() {
  if (!RUN) RUN = openRunDir({ prefix: 'contract-test' });
  const runDir = path.join(RUN.runDir, `t${++nScratch}`);
  RUN.guard.mkdir(runDir);
  return { runDir, guard: RUN.guard };
}

// ---------------------------------------------------------------- memory-diff

const snap = (targets) => ({ schema_version: 1, targets });
const tgt = (p, entries, exists = true, group = 'memory') => ({ path: p, group, exists, entries });
const ent = (p, sha, size = 1, kind = 'file') => ({ path: p, kind, size, sha256: sha });

test('diffSnapshots: identical snapshots have no differences', () => {
  const a = snap([tgt(R('m'), [ent('a.md', 'x'), ent('b.md', 'y')])]);
  assert.deepEqual(diffSnapshots(a, structuredClone(a)), []);
});

test('diffSnapshots: changed, added and removed entries are each reported', () => {
  const a = snap([tgt(R('m'), [ent('a.md', 'x'), ent('gone.md', 'g')])]);
  const b = snap([tgt(R('m'), [ent('a.md', 'x2'), ent('new.md', 'n')])]);
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.map((x) => `${x.change}:${x.path}`).sort(), ['added:new.md', 'changed:a.md', 'removed:gone.md']);
  assert.match(formatDiff(d.find((x) => x.change === 'changed')), /^changed .*a\.md /);
});

test('diffSnapshots: a size-only or kind-only change is a difference', () => {
  const a = snap([tgt(R('m'), [ent('a', 'x', 1), ent('d', null, 0, 'dir')])]);
  const b = snap([tgt(R('m'), [ent('a', 'x', 2), ent('d', 's', 0, 'symlink')])]);
  assert.equal(diffSnapshots(a, b).length, 2);
});

test('diffSnapshots: a target that appears, disappears or is added counts', () => {
  const a = snap([tgt(R('x'), [], false), tgt(R('y'), [ent('', 'h')])]);
  const b = snap([tgt(R('x'), [ent('', 'h')]), tgt(R('y'), [], false), tgt(R('z'), [])]);
  assert.deepEqual(diffSnapshots(a, b).map((x) => x.change).sort(), ['target_added', 'target_appeared', 'target_disappeared']);
});

test('applyBaseline: diffs explained by the quiet window are excluded, the rest judged', () => {
  const room = [{ target: R('m'), path: 'a', change: 'changed' }, { target: R('m'), path: 'b', change: 'added' }];
  const quiet = [{ target: R('m'), path: 'a', change: 'changed' }];
  const { judged, excluded } = applyBaseline(room, quiet);
  assert.deepEqual(judged.map((d) => d.path), ['b']);
  assert.deepEqual(excluded.map((d) => d.path), ['a']);
  assert.equal(diffKey(room[0]), diffKey(quiet[0]));
});

test('snapshotTargets on disk: same-content rewrite is no diff, same-size content change is', () => {
  const { runDir, guard } = scratch();
  const dir = path.join(runDir, 'mem');
  guard.mkdir(path.join(dir, 'sub'));
  guard.writeFile(path.join(dir, 'a.md'), 'alpha');
  guard.writeFile(path.join(dir, 'sub', 'b.md'), 'beta');
  const missing = path.join(runDir, 'absent.json');
  const s1 = snapshotTargets([{ path: dir, group: 'memory' }, missing]);
  assert.equal(countEntries(s1), 3); // a.md, sub, sub/b.md
  assert.equal(s1.targets[1].exists, false);
  guard.writeFile(path.join(dir, 'a.md'), 'alpha'); // new mtime, same bytes
  assert.deepEqual(diffSnapshots(s1, snapshotTargets([{ path: dir, group: 'memory' }, missing])), []);
  guard.writeFile(path.join(dir, 'a.md'), 'ALPHA'); // same size, different bytes
  const d = diffSnapshots(s1, snapshotTargets([{ path: dir, group: 'memory' }, missing]));
  assert.deepEqual(d.map((x) => `${x.change}:${x.path}`), ['changed:a.md']);
  const single = listEntries(path.join(dir, 'a.md'));
  assert.equal(single.entries.length, 1);
  assert.equal(single.entries[0].path, '');
});

// ---------------------------------------------------------------- path containment

test('isInsideRoot: equal and child are inside; sibling with shared prefix and parent are not', () => {
  assert.equal(isInsideRoot(R('room'), R('room')), true);
  assert.equal(isInsideRoot(R('room', 'events.jsonl'), R('room')), true);
  assert.equal(isInsideRoot(R('room2', 'x'), R('room')), false);
  assert.equal(isInsideRoot(R('roomx'), R('room')), false);
  assert.equal(isInsideRoot(R(), R('room')), false);
  assert.equal(isInsideRoot(R('room', '..', 'other'), R('room')), false);
});

test('isInsideRoot: case folding only on Windows', () => {
  assert.equal(isInsideRoot(R('ROOM', 'a'), R('room')), WIN);
});

test('canonicalPath: existing prefix is real-pathed, missing tail is kept', () => {
  const { runDir } = scratch();
  const real = fs.realpathSync.native(runDir).replace(/^\\\\\?\\/, '');
  assert.equal(canonicalPath(runDir), real);
  assert.equal(canonicalPath(path.join(runDir, 'not', 'yet.txt')), path.join(real, 'not', 'yet.txt'));
});

// ---------------------------------------------------------------- write-log checker

const roomDir = R('room');
const outboxes = { A: R('cwdA', '.room-outbox', 'A'), B: R('cwdB', '.room-outbox', 'B') };
const seatCwds = { A: R('cwdA'), B: R('cwdB') };
const w = (who, p, op = 'write') => ({ ts: 't', who, op, path: p, pid: 1 });

test('classifyAuthor', () => {
  assert.deepEqual(classifyAuthor('service'), { kind: 'service', seatId: null });
  assert.deepEqual(classifyAuthor('seat:A'), { kind: 'seat', seatId: 'A' });
  assert.deepEqual(classifyAuthor('seat:'), classifyAuthor('nobody'));
  assert.equal(classifyAuthor('seat:A/../B').kind, 'unknown');
  assert.equal(classifyAuthor(undefined).kind, 'unknown');
});

test('checkWriteLog: a clean room log has no violations', () => {
  const entries = [w('admin', path.join(roomDir, 'room.json')), w('service', path.join(roomDir, 'events.jsonl'), 'append'), w('service', path.join(roomDir, 'snapshots', 'A', 'x', 'f.txt'))];
  const r = checkWriteLog({ entries, roomDir, outboxes, seatCwds, source: 'room' });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.counts, { admin: 1, service: 2 });
  assert.equal(r.inSeatCwd, 0);
});

test('checkWriteLog NEGATIVE CONTROL: a planted service write into agent config is caught', () => {
  const planted = w('service', path.join(os.homedir(), '.claude', 'settings.json'));
  const entries = [w('service', path.join(roomDir, 'state.json')), planted];
  const r = checkWriteLog({ entries, roomDir, outboxes, seatCwds, source: 'room' });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].reason, 'outside_room_dir');
  assert.equal(r.violations[0].path, planted.path);
});

test('checkWriteLog NEGATIVE CONTROL: a room-side write into a seat working directory is caught (#43)', () => {
  const r = checkWriteLog({ entries: [w('service', path.join(seatCwds.B, 'hello.txt'))], roomDir, outboxes, seatCwds, source: 'room' });
  assert.equal(r.inSeatCwd, 1);
  assert.equal(r.violations[0].reason, 'inside_seat_cwd:B');
  // also when the write lands in the seat's own outbox: the service never writes outboxes
  const r2 = checkWriteLog({ entries: [w('service', path.join(outboxes.A, 'x.json'))], roomDir, outboxes, seatCwds, source: 'room' });
  assert.equal(r2.violations[0].reason, 'inside_seat_cwd:A');
});

test('checkWriteLog NEGATIVE CONTROL: a sibling directory sharing the room prefix is outside', () => {
  const r = checkWriteLog({ entries: [w('service', R('room-evil', 'x'))], roomDir, outboxes, seatCwds, source: 'room' });
  assert.equal(r.violations[0].reason, 'outside_room_dir');
});

test('checkWriteLog: seat writes must be in its own outbox and in its own log', () => {
  const ok = checkWriteLog({ entries: [w('seat:A', path.join(outboxes.A, 'joined.json'))], roomDir, outboxes, source: 'seat:A' });
  assert.deepEqual(ok.violations, []);
  const outside = checkWriteLog({ entries: [w('seat:A', path.join(seatCwds.A, 'speech.md'))], roomDir, outboxes, source: 'seat:A' });
  assert.equal(outside.violations[0].reason, 'outside_outbox');
  const intoOther = checkWriteLog({ entries: [w('seat:A', path.join(outboxes.B, 'x.json'))], roomDir, outboxes, source: 'seat:A' });
  assert.equal(intoOther.violations[0].reason, 'outside_outbox');
  const wrongLog = checkWriteLog({ entries: [w('seat:A', path.join(outboxes.A, 'x.json'))], roomDir, outboxes, source: 'seat:B' });
  assert.equal(wrongLog.violations[0].reason, 'seat_author_in_seat:B_log');
  const inRoomLog = checkWriteLog({ entries: [w('seat:A', path.join(outboxes.A, 'x.json'))], roomDir, outboxes, source: 'room' });
  assert.equal(inRoomLog.violations[0].reason, 'seat_author_in_room_log');
  const serviceInSeatLog = checkWriteLog({ entries: [w('service', path.join(roomDir, 'x'))], roomDir, outboxes, source: 'seat:A' });
  assert.equal(serviceInSeatLog.violations[0].reason, 'room_author_in_seat:A_log');
  const unknownSeat = checkWriteLog({ entries: [w('seat:Z', R('cwdZ', 'x'))], roomDir, outboxes, source: 'seat:Z' });
  assert.equal(unknownSeat.violations[0].reason, 'unknown_seat');
});

test('checkWriteLog: unknown authors and malformed rows are violations, not skipped', () => {
  const r = checkWriteLog({ entries: [w('mallory', path.join(roomDir, 'x')), { malformed: '{oops' }, { who: 'service', op: 'write' }], roomDir, outboxes, source: 'room' });
  assert.deepEqual(r.violations.map((v) => v.reason), ['unknown_author', 'malformed_entry', 'malformed_entry']);
});

test('checkWriteLog: canon() is applied to roots and entries alike', () => {
  const canon = (p) => p.replace(`${path.sep}alias${path.sep}`, `${path.sep}rooms-test${path.sep}`);
  const aliased = path.resolve(path.sep, 'alias', 'room', 'events.jsonl');
  const r = checkWriteLog({ entries: [w('service', aliased)], roomDir, outboxes, source: 'room', canon });
  assert.deepEqual(r.violations, []);
});

test('readWriteLog: torn final line tolerated, malformed middle line flagged', () => {
  const { runDir, guard } = scratch();
  const f = path.join(runDir, 'wl.jsonl');
  guard.writeFile(f, `${JSON.stringify(w('service', 'a'))}\n{broken\n${JSON.stringify(w('service', 'b'))}\n{"torn":`);
  const rows = readWriteLog(f);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].malformed, '{broken');
  assert.deepEqual(readWriteLog(path.join(runDir, 'none.jsonl')), []);
});

function syntheticRoom(guard, base, roomEntries, seatEntries = {}) {
  const rd = path.join(base, 'room');
  const seats = Object.keys(seatEntries).map((id) => ({ seatId: id, cwd: path.join(base, `cwd${id}`), outbox: path.join(base, `cwd${id}`, '.room-outbox', id) }));
  guard.mkdir(rd);
  guard.writeFile(path.join(rd, 'room.json'), JSON.stringify({ schema_version: 2, id: 't', seats }));
  guard.writeFile(path.join(rd, 'write-log.jsonl'), roomEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  for (const s of seats) {
    guard.mkdir(s.outbox);
    guard.writeFile(path.join(s.outbox, 'write-log.jsonl'), seatEntries[s.seatId](s).map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return { rd, seats };
}

test('check-writes CLI: clean synthetic room exits 0 with PASS lines and RAW paths', () => {
  const { runDir, guard } = scratch();
  const rd = path.join(runDir, 'room');
  const { seats } = syntheticRoom(guard, runDir, [w('admin', path.join(rd, 'room.json')), w('service', path.join(rd, 'state.json'))], { A: (s) => [w('seat:A', path.join(s.outbox, 'joined.json'))] });
  const lines = [];
  const code = checkWritesMain([rd], { out: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /^PASS write-log\(room\): 2 条写入/.test(l)));
  assert.ok(lines.some((l) => /^PASS write-log\(seat A\)/.test(l)));
  assert.ok(lines.some((l) => l === `RAW ${path.join(seats[0].outbox, 'write-log.jsonl')}`));
  assert.ok(lines.every((l) => !l.startsWith('FAIL')));
  assert.ok(lines.filter((l) => l.startsWith('PASS')).every((l) => /未观测到/.test(l)));
});

test('check-writes CLI NEGATIVE CONTROL: planted out-of-bounds writes make it exit 1', () => {
  const { runDir, guard } = scratch();
  const rd = path.join(runDir, 'room');
  syntheticRoom(guard, runDir, [w('service', path.join(rd, 'state.json')), w('service', path.join(runDir, 'cwdA', 'stolen.txt'))], { A: (s) => [w('seat:A', path.join(runDir, 'elsewhere.txt'))] });
  const lines = [];
  const code = checkWritesMain([rd], { out: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => /^FAIL write-log\(room\)/.test(l)));
  assert.ok(lines.some((l) => /^FAIL write-log\(workdir\)/.test(l)));
  assert.ok(lines.some((l) => /^FAIL write-log\(seat A\)/.test(l)));
  assert.ok(lines.some((l) => /outside_outbox .*elsewhere\.txt/.test(l)));
});

test('check-writes CLI: an empty room log is a FAIL (nothing observed is not a pass)', () => {
  const { runDir, guard } = scratch();
  const { rd } = syntheticRoom(guard, runDir, []);
  guard.writeFile(path.join(rd, 'write-log.jsonl'), '');
  const lines = [];
  assert.equal(checkWritesMain([rd], { out: (l) => lines.push(l) }), 1);
  assert.ok(lines.some((l) => /^FAIL write-log\(room\): .*为空/.test(l)));
});

test('collectSeats reads outbox and cwd from room.json and adds explicit outboxes', () => {
  const { runDir, guard } = scratch();
  const { rd } = syntheticRoom(guard, runDir, [], { A: () => [] });
  const extra = path.join(runDir, 'x', '.room-outbox', 'Q');
  const { outboxes: ob, cwds } = collectSeats(rd, [extra]);
  assert.deepEqual(Object.keys(ob).sort(), ['A', 'Q']);
  assert.equal(cwds.A, path.join(runDir, 'cwdA'));
});

// ---------------------------------------------------------------- pids

test('parseTasklistCsv handles quotes and skips junk', () => {
  const rows = parseTasklistCsv('"claude.exe","123","Console","1","10,000 K"\r\nINFO: nothing\r\n"we""ird.exe","9","Console","1","1 K"\r\n"bad","x"');
  assert.deepEqual(rows, [{ pid: 123, name: 'claude.exe' }, { pid: 9, name: 'we"ird.exe' }]);
});

test('parsePs and parsePsParents', () => {
  assert.deepEqual(parsePs('  1 init\n 42 node\n'), [{ pid: 1, name: 'init' }, { pid: 42, name: 'node' }]);
  assert.deepEqual(parsePsParents('  42     1 node\n'), [{ pid: 42, ppid: 1, name: 'node' }]);
});

const ps = (list) => ({ processes: list.map(([pid, name]) => ({ pid, name })) });

test('diffProcessSets separates agent processes from node processes', () => {
  const d = diffProcessSets(ps([[1, 'claude.exe'], [2, 'node.exe']]), ps([[2, 'node.exe'], [3, 'codex.exe'], [4, 'node.exe']]));
  assert.deepEqual(d.agentAdded.map((p) => p.pid), [3]);
  assert.deepEqual(d.agentRemoved.map((p) => p.pid), [1]);
  assert.deepEqual(d.added.map((p) => p.pid).sort(), [3, 4]);
});

test('roomAncestor walks the parent chain and tolerates cycles', () => {
  const parents = [{ pid: 30, ppid: 20 }, { pid: 20, ppid: 10 }, { pid: 10, ppid: 1 }, { pid: 7, ppid: 8 }, { pid: 8, ppid: 7 }];
  assert.deepEqual(roomAncestor(30, parents, [10]), { found: true, ancestor: 10 });
  assert.deepEqual(roomAncestor(30, parents, [99]), { found: true, ancestor: null });
  assert.deepEqual(roomAncestor(7, parents, [99]), { found: true, ancestor: null });
  assert.deepEqual(roomAncestor(55, parents, [10]), { found: false, ancestor: null });
  // dead parent: its pid is still compared through the child's ppid
  assert.deepEqual(roomAncestor(30, [{ pid: 30, ppid: 500 }], [500]), { found: true, ancestor: 500 });
});

test('judgeAgentDiff NEGATIVE CONTROL: an agent started under a room process fails', () => {
  const diff = { agentAdded: [{ pid: 30, name: 'codex.exe' }], agentRemoved: [] };
  const parents = [{ pid: 30, ppid: 20 }, { pid: 20, ppid: 10 }];
  assert.equal(judgeAgentDiff(diff, parents, [10]).ok, false);
  assert.deepEqual(judgeAgentDiff(diff, parents, [10]).attributed.map((p) => p.ancestor), [10]);
  assert.equal(judgeAgentDiff(diff, parents, [99]).ok, true);
  assert.equal(judgeAgentDiff(diff, null, [99]).ok, false); // no parent table: cannot attribute
  assert.equal(judgeAgentDiff({ agentAdded: [], agentRemoved: [{ pid: 5, name: 'claude.exe' }] }, parents, [99]).ok, false);
});

test('compareReport: unchanged set passes; foreign start passes with wording; room-started fails', async () => {
  const before = ps([[1, 'claude.exe']]);
  let rep = await compareReport({ before, after: ps([[1, 'claude.exe']]) });
  assert.equal(rep.ok, true);
  assert.match(rep.lines[0], /^PASS pids\(agents\): .*未观测到/);
  const after = { ...ps([[1, 'claude.exe'], [2, 'claude.exe']]), parents: [{ pid: 2, ppid: 1, name: 'claude.exe' }] };
  rep = await compareReport({ before, after, roomPids: [700] });
  assert.equal(rep.ok, true);
  assert.match(rep.lines[0], /^PASS pids\(agents\): agent 进程集合有 1 个新增/);
  rep = await compareReport({ before, after, roomPids: [1] });
  assert.equal(rep.ok, false);
  assert.ok(rep.lines.some((l) => /^FAIL pids\(agents\)/.test(l)));
  assert.ok(rep.lines.some((l) => /claude\.exe\(2\)<-1/.test(l)));
});

test('filterServiceCommandLines matches room.mjs serve for one room only', () => {
  const rd = R('room');
  const rows = [
    { pid: 1, cmd: `node "D:/tools/room-dev/room.mjs" serve --dir ${rd} --tick 120` },
    { pid: 2, cmd: `node D:/tools/room-dev/room.mjs serve --dir ${R('other')}` },
    { pid: 3, cmd: `node D:/tools/room-dev/room.mjs wait --seat ${rd}` },
  ];
  assert.deepEqual(filterServiceCommandLines(rows, rd).map((p) => p.pid), [1]);
  assert.deepEqual(filterServiceCommandLines(rows).map((p) => p.pid), [1, 2]);
});

// W9: PowerShell 5.1 writes redirected output in the OEM code page (CP936 here); without the UTF-8
// switch a Chinese room path in a command line decodes to U+FFFD and the service is never found.
test('findRoomServiceProcesses finds a live `room.mjs serve` whose room path is Chinese', { skip: !WIN && 'Windows only' }, async () => {
  const { runDir, guard } = scratch();
  const fakeApp = path.join(runDir, '应用');
  const roomDir = path.join(runDir, '房间 中文');
  guard.mkdir(fakeApp);
  guard.mkdir(roomDir);
  const ready = path.join(roomDir, 'ready');
  const stop = path.join(roomDir, 'stop');
  // A stand-in for the room service: same file name and argv shape, does nothing but wait for `stop`.
  guard.writeFile(path.join(fakeApp, 'room.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const dir = process.argv[process.argv.indexOf("--dir") + 1];',
    "fs.writeFileSync(path.join(dir, 'ready'), String(process.pid));",
    "const t = setInterval(() => { if (fs.existsSync(path.join(dir, 'stop'))) { clearInterval(t); process.exit(0); } }, 100);",
    'setTimeout(() => process.exit(3), 60000);',
    '',
  ].join('\n'));
  const child = spawnClean(process.execPath, [path.join(fakeApp, 'room.mjs'), 'serve', '--dir', roomDir], { timeoutMs: 90000 });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    const { findRoomServiceProcesses } = await import('../contract/pids.mjs');
    const found = await findRoomServiceProcesses({ roomDir });
    assert.deepEqual(found.map((p) => p.pid), [pid], `service for the Chinese room found; got ${JSON.stringify(found)}`);
    assert.ok(found[0].cmd.includes('房间 中文'), `command line decoded as UTF-8: ${found[0].cmd}`);
  } finally {
    guard.writeFile(stop, '1');
    const r = await child;
    assert.equal(r.code, 0, `stand-in exited on stop (timedOut=${r.timedOut})`);
  }
});

// ---------------------------------------------------------------- env

test('extraEnvKeys: whitelist, explicit keys, platform case folding, hidden =C: keys', () => {
  const env = { PATH: 'p', Path2: 'x', OPENAI_API_KEY: 'k', '=C:': 'C:\\', systemroot: 'r', ROOM_X: '1' };
  assert.deepEqual(extraEnvKeys(env, ['PATH', 'SystemRoot'], ['ROOM_X'], 'win32'), ['OPENAI_API_KEY', 'Path2']);
  assert.deepEqual(extraEnvKeys(env, ['PATH', 'SystemRoot'], ['ROOM_X'], 'linux'), ['OPENAI_API_KEY', 'Path2', 'systemroot']);
});

test('findCanaries NEGATIVE CONTROL: a planted canary value is found, its absence is not', () => {
  const c = makeCanaries(['OPENAI_API_KEY', 'GITHUB_TOKEN']);
  assert.notEqual(c.OPENAI_API_KEY, makeCanaries(['OPENAI_API_KEY']).OPENAI_API_KEY);
  assert.deepEqual(findCanaries(`packet body ... ${c.GITHUB_TOKEN} ...`, c), ['GITHUB_TOKEN']);
  assert.deepEqual(findCanaries('nothing secret here OPENAI_API_KEY', c), []);
});

test('canaryKeysIn and parseProbeLines', () => {
  assert.deepEqual(canaryKeysIn(['PATH', 'openai_api_key', 'GITHUB_TOKEN'], CANARY_KEYS, 'win32'), ['GITHUB_TOKEN', 'openai_api_key']);
  assert.deepEqual(canaryKeysIn(['openai_api_key'], CANARY_KEYS, 'linux'), []);
  const rows = parseProbeLines('noise\nROOM_ENV_PROBE {"phase":"exit","keys":["A"]}\nROOM_ENV_PROBE {bad\n');
  assert.deepEqual(rows, [{ phase: 'exit', keys: ['A'] }]);
});

test('exit probe reports key names at start and after process.exit, never values', async () => {
  const { runDir, guard } = scratch();
  const probe = path.join(runDir, 'probe.mjs');
  guard.writeFile(probe, PROBE_SOURCE);
  const r = await spawnClean(process.execPath, ['-e', 'delete process.env.ROOM_GONE; process.exit(0)'], {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(probe).href}`, ROOM_GONE: 'v-secret-value', ROOM_STAY: 'v2' }, timeoutMs: 30000,
  });
  const rows = parseProbeLines(r.stderr);
  const start = rows.find((x) => x.phase === 'start');
  const exit = rows.find((x) => x.phase === 'exit');
  assert.ok(start && exit, r.stderr);
  assert.ok(start.keys.includes('ROOM_GONE'));
  assert.ok(!exit.keys.includes('ROOM_GONE'));
  assert.ok(exit.keys.includes('ROOM_STAY'));
  assert.ok(!r.stderr.includes('v-secret-value'));
});

// ---------------------------------------------------------------- control-run

test('unexpectedWorkdirEntries NEGATIVE CONTROL: a planted file in a seat cwd is reported', () => {
  const rel = ['.room-outbox', '.room-outbox/B', '.room-outbox/B/write-log.jsonl', 'hello.txt', 'planted.txt', 'sub', 'sub/x'];
  assert.deepEqual(unexpectedWorkdirEntries(rel, ['hello.txt']), ['planted.txt', 'sub', 'sub/x']);
  assert.deepEqual(unexpectedWorkdirEntries(['.room-outbox', 'hello.txt'], ['hello.txt']), []);
});

test('defaultTargets: agent homes from env, groups from the contract, per-project memory expanded', () => {
  const { runDir, guard } = scratch();
  const home = path.join(runDir, 'home');
  guard.mkdir(path.join(home, '.claude', 'projects', 'p1', 'memory'));
  guard.mkdir(path.join(home, '.claude', 'projects', 'p2'));
  const t = defaultTargets({}, home);
  assert.ok(t.every((x) => GROUPS.includes(x.group)));
  for (const g of GROUPS) assert.ok(t.some((x) => x.group === g), g);
  assert.ok(t.some((x) => x.path === path.join(home, '.claude.json')));
  assert.ok(t.some((x) => x.path === path.join(home, '.codex', 'config.toml')));
  assert.ok(t.some((x) => x.path === path.join(home, '.claude', 'projects', 'p1', 'memory') && x.group === 'memory'));
  assert.ok(!t.some((x) => x.path.includes(`${path.sep}p2`)));
  assert.ok(!t.some((x) => /sessions/.test(x.path)), 'session storage is not compared');
  const t2 = defaultTargets({ CLAUDE_CONFIG_DIR: path.join(runDir, 'cc'), CODEX_HOME: path.join(runDir, 'cx') }, home);
  assert.ok(!t2.some((x) => x.path === path.join(home, '.claude.json')));
  assert.ok(t2.some((x) => x.path === path.join(runDir, 'cx', 'AGENTS.md')));
  assert.ok(t2.some((x) => x.path === path.join(runDir, 'cc', 'settings.json')));
});

// ---------------------------------------------------------------- harness

test('passThroughEnv copies only defined pass-through keys; reporter tracks FAIL', () => {
  assert.deepEqual(passThroughEnv({ X: '1' }, { HOME: '/h', OPENAI_API_KEY: 'k', CODEX_HOME: undefined }), { HOME: '/h', X: '1' });
  const lines = [];
  const rep = createReporter((l) => lines.push(l));
  rep.pass('a: ok');
  assert.equal(rep.failed, false);
  rep.fail('b: bad');
  assert.equal(rep.failed, true);
  assert.deepEqual(lines, ['PASS a: ok', 'FAIL b: bad']);
});

// ---------------------------------------------------------------- collect

test('parseTapSummary reads totals and failing names', () => {
  const tap = 'TAP version 13\n# Subtest: a\nok 1 - a\n    not ok 2 - inner thing # TODO\nnot ok 3 - outer\n1..3\n# tests 3\n# suites 0\n# pass 1\n# fail 2\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const t = parseTapSummary(tap);
  assert.deepEqual([t.tests, t.pass, t.fail, t.skipped], [3, 1, 2, 0]);
  assert.deepEqual(t.failures, [{ depth: 1, name: 'inner thing' }, { depth: 0, name: 'outer' }]);
  assert.equal(parseTapSummary('garbage').pass, null);
});

test('parseE2eSummary', () => {
  assert.deepEqual(parseE2eSummary('PASS a\nFAIL b -- x\n\n46/47 passed; room=C:/x'), { pass: 46, total: 47, failures: ['b -- x'], passLines: 1, crash: null });
  const crashed = parseE2eSummary('PASS a\nPASS b\nFAIL c\n--- stderr ---\nTypeError: Cannot read properties of null\n    at main');
  assert.equal(crashed.pass, null);
  assert.equal(crashed.passLines, 2);
  assert.deepEqual(crashed.failures, ['c']);
  assert.match(crashed.crash, /^TypeError: Cannot read/);
});

test('parseContractLines groups details and RAW paths; pickRaw and planRowFor route them', () => {
  const sep = path.sep;
  const roomLog = ['', 'r', 'room', 'write-log.jsonl'].join(sep);
  const seatLog = ['', 'r', 'cwdA', '.room-outbox', 'A', 'write-log.jsonl'].join(sep);
  const text = [
    'PASS location(room): 在 realpath 比对下未观测到…',
    'FAIL write-log(room): 3 条写入，观测到 1 条越界',
    '  outside_room_dir who=service op=write path=/x',
    `RAW ${roomLog}`,
    'PASS write-log(seat A): 在 write-log 方法下未观测到…',
    `RAW ${seatLog}`,
    'INFO noise: x',
  ].join('\n');
  const p = parseContractLines(text);
  assert.deepEqual(p.checks.map((c) => `${c.kind} ${c.check}`), ['PASS location(room)', 'FAIL write-log(room)', 'PASS write-log(seat A)']);
  assert.deepEqual(p.checks[1].details, ['outside_room_dir who=service op=write path=/x']);
  assert.deepEqual(p.raws, [roomLog, seatLog]);
  assert.deepEqual(pickRaw('write-log(seat A)', p.raws), [seatLog]);
  assert.deepEqual(pickRaw('write-log(room)', p.raws), [roomLog]);
  assert.deepEqual(pickRaw('env(outputs)', ['/r/env-children.log', '/r/env-room']), ['/r/env-children.log']);
  const wd = ['/r/control-run-commands.log', '/r/cwdA/.room-outbox/A', '/r/cwdB/.room-outbox/B'];
  assert.deepEqual(pickRaw('control-run(workdir B)', wd), ['/r/control-run-commands.log', '/r/cwdB/.room-outbox/B']);
  assert.deepEqual(pickRaw('unknown(thing)', ['/a', '/b', '/c', '/d']), ['/a', '/b', '/c']);
  assert.equal(planRowFor('write-log(seat A)'), '#40');
  assert.equal(planRowFor('write-log(workdir)'), '#43');
  assert.equal(planRowFor('control-run(memory)'), '#45b');
  assert.equal(planRowFor('control-run(config)'), '#40b');
  assert.equal(planRowFor('pids(agents)'), '#41');
  assert.equal(planRowFor('env(spawnClean)'), '#42');
});

test('renderReport: table with raw paths, escaped pipes, commands and failure details', () => {
  const md = renderReport({
    takenAt: '2026-10-01T00:00:00Z', runDir: '/r', nodeVersion: 'v22', platform: 'linux-x64',
    rows: [
      { check: 'write-log(room)', plan: '#40', kind: 'PASS', text: '在 write-log 方法下未观测到房间目录之外的写入', raws: ['/r/room/write-log.jsonl'] },
      { check: 'env(seat-exit)', plan: '#42', kind: 'FAIL', text: 'a | b', details: ['detail one'], raws: ['/r/env.log'] },
    ],
    stages: [{ name: 'check-writes', argv: ['/usr/bin/node', 'contract/check-writes.mjs', '/r/my room'], cwd: '/repo', code: 0, durationMs: 1200, log: '/r/check-writes.log', raws: ['/r/room/write-log.jsonl'] }],
  });
  assert.match(md, /\| 检查 \| 方案条目 \| 结果 \| 原始记录 \|/);
  assert.match(md, /\| write-log\(room\) \| #40 \| \*\*PASS\*\* 在 write-log 方法下未观测到/);
  assert.match(md, /a \\\| b/);
  assert.match(md, /## 失败明细[\s\S]*detail one/);
  assert.match(md, /\/usr\/bin\/node contract\/check-writes\.mjs "\/r\/my room"/);
  assert.match(md, /合计：PASS 1　FAIL 1　SKIP 0/);
  assert.equal(quoteArg('test/**/*.test.mjs'), '"test/**/*.test.mjs"');
});
