// node --test test/audit.test.mjs
//
// Fixtures (test/fixtures/audit/) are synthetic. Their shapes follow real Codex 0.159 rollouts and
// Claude Code transcripts sampled on the author machine on 2026-10-01; no content was copied.
//   codex-home/sessions/.../rollout-*-…a001.jsonl  parent thread: code-mode exec (JS source),
//       event_msg/item_completed CommandExecution + FileChange, function_call exec_command / shell /
//       apply_patch, patch_apply_end, spawn_agent. Attempt 1 (10:00–10:05Z) only reads;
//       attempt 2 (10:06–10:10Z) writes.
//   …c001.jsonl (sessions/ and an identical archived_sessions/ copy)  child thread: parent_thread_id,
//       subagent_history_start_ordinal=5, ordinals 0–4 are the parent's inherited history (with a
//       copy of the attempt-2 TURN header and of `npm test`, timestamps rewritten into attempt 2).
//       The parent names it in a SubAgentActivity line (agent_thread_id); it names c002 the same way.
//   archived_sessions/…c002.jsonl  grandchild: forked_from_id=c001, local_shell_call with redirect.
//   …e001.jsonl  unrelated thread (other parent): never registered, never opened.
//   …d001.jsonl  a fork of the parent (forked_from_id=a001) that no registered rollout names: not
//       deterministically reachable, so never opened; its coverage is reported as unknown.
//   claude-project/  one Claude Code project dir: the seat session (…b01) with subagents/,
//       subagents/workflows/<wf>/ and tool-results/*.txt (the attempt-2 TURN header exists only
//       there, the transcript carries a persistedOutputPath preview), an old transcript (…b00), an
//       unrelated new one (…b02) and an older decoy that also names the first packet id (…b03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  encodeClaudeProjectDir, claudeHome, readSessionHeader, codexParentIds, findCodexChildThreads, locateFiles,
  isCodexThreadId, rolloutThreadId,
  READ_ONLY_ALLOWLIST, COMMAND_WRAPPERS, WRITE_COMMANDS, GIT_WRITE_SUBCOMMANDS,
  tokenizeCommand, splitCommandChain, isReadOnlyCommand, unwrapShellArgv, isReadOnlyArgv,
  extractCodexExecCommands, parsePatchPaths, classifyWrites, auditPacket, describeObservation,
  auditAttempt, turnWindowFor, cmdAudit,
} from '../lib/audit.mjs';
import { createGuard } from '../lib/guard.mjs';
import { spawnClean } from '../lib/spawn.mjs';
import { testRunsRoot, realPathNative } from '../lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures', 'audit');
const CODEX_FIX = path.join(FIX, 'codex-home');
const CLAUDE_FIX = path.join(FIX, 'claude-project');
const NODE = process.execPath;

const PARENT = '01a0f000-0000-7000-8000-00000000a001';
const CHILD = '01a0f000-0000-7000-8000-00000000c001';
const GRAND = '01a0f000-0000-7000-8000-00000000c002';
const OTHER = '01a0f000-0000-7000-8000-00000000e001';
const DAY = path.join('sessions', '2026', '10', '01');
const F_PARENT = path.join(CODEX_FIX, DAY, `rollout-2026-10-01T18-00-00-${PARENT}.jsonl`);
const F_CHILD = path.join(CODEX_FIX, DAY, `rollout-2026-10-01T18-06-40-${CHILD}.jsonl`);
const F_CHILD_ARCH = path.join(CODEX_FIX, 'archived_sessions', `rollout-2026-10-01T18-06-40-${CHILD}.jsonl`);
const F_GRAND = path.join(CODEX_FIX, 'archived_sessions', `rollout-2026-10-01T18-07-10-${GRAND}.jsonl`);
const F_OTHER = path.join(CODEX_FIX, DAY, `rollout-2026-10-01T18-07-00-${OTHER}.jsonl`);
const FORK = '01a0f000-0000-7000-8000-00000000d001';
const F_FORK = path.join(CODEX_FIX, DAY, `rollout-2026-10-01T18-08-00-${FORK}.jsonl`);

const PACKETS = 'C:/Users/fixture/room-dev/rooms/fx/packets';
const P1 = 'r1-A-a1-1-aa11bb';
const P2 = 'r1-A-a1-2-cc22dd';
const P3 = 'r1-A-a1-3-ee33ff';
const P4 = 'r1-A-a1-4-ff44aa';
const Q1 = 'r1-B-b1-1-1a2b3c';
const Q2 = 'r1-B-b1-2-4d5e6f';
const pk = (id) => `${PACKETS}/${id}.md`;
// The room records packet paths in OS form; the TURN header prints them with forward slashes.
const pkOs = (id) => pk(id).replace(/\//g, '\\');

const S0 = 'c1a0f000-0000-4000-8000-000000000b00';
const S1 = 'c1a0f000-0000-4000-8000-000000000b01';
const S2 = 'c1a0f000-0000-4000-8000-000000000b02';
const S3 = 'c1a0f000-0000-4000-8000-000000000b03';

const W1 = { fromTs: '2026-10-01T10:00:00.000Z', toTs: '2026-10-01T10:05:00.000Z' };
const W2 = { fromTs: '2026-10-01T10:06:00.000Z', toTs: '2026-10-01T10:10:00.000Z' };
const CODEX_FILES = [F_PARENT, F_CHILD, F_CHILD_ARCH, F_GRAND];

// ---------- helpers ----------

// Temporary trees live under testRunsRoot() (never %LOCALAPPDATA%); writes go through a guard.
function tempRun() {
  const root = path.join(testRunsRoot(), `audit-${crypto.randomBytes(6).toString('hex')}`);
  const guard = createGuard({ allowed: [root], logPath: path.join(root, 'write-log.jsonl'), who: 'audit-test' });
  guard.mkdir(root);
  return { root, guard };
}
async function rmRun(root) { await fs.promises.rm(root, { recursive: true, force: true }); }
function copyTree(guard, src, dst) {
  guard.mkdir(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(guard, s, d); else guard.copyFile(s, d);
  }
}
function listFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, acc); else acc.push(p);
  }
  return acc;
}
function statMap(files) {
  return new Map(files.map((f) => { const s = fs.statSync(f); return [f, { mtimeMs: s.mtimeMs, size: s.size }]; }));
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
// Records every open the audit module makes through node:fs (it imports the default export, so
// patching the shared object intercepts its calls) and any write API call at all.
function spyFs() {
  const opens = [];
  const writes = [];
  const orig = {};
  const wrap = (name, onCall) => {
    orig[name] = fs[name];
    fs[name] = function (...args) { onCall(args); return orig[name].apply(this, args); };
  };
  wrap('createReadStream', (a) => opens.push({ api: 'createReadStream', path: path.resolve(String(a[0])), flags: (a[1] && typeof a[1] === 'object' && a[1].flags) || 'r', start: (a[1] && typeof a[1] === 'object' && a[1].start) || 0 }));
  wrap('openSync', (a) => opens.push({ api: 'openSync', path: path.resolve(String(a[0])), flags: a[1] === undefined ? 'r' : String(a[1]) }));
  for (const w of ['writeFileSync', 'appendFileSync', 'createWriteStream', 'writeSync', 'renameSync', 'rmSync', 'unlinkSync', 'truncateSync', 'utimesSync', 'copyFileSync', 'mkdirSync']) {
    wrap(w, (a) => writes.push({ api: w, arg: String(a[0]) }));
  }
  return { opens, writes, restore() { for (const k of Object.keys(orig)) fs[k] = orig[k]; } };
}
const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const norm = (p) => path.resolve(p).toLowerCase();
const FORBIDDEN_WORDING = ['read-only', 'read only', 'no writes occurred', 'guaranteed clean'];

// ---------- tokenizer / chain splitter ----------

test('tokenizeCommand groups quotes, drops them, keeps backslashes and empty quoted tokens', () => {
  assert.deepEqual(tokenizeCommand('rg -n "a b" \'c d\' E:\\x\\y'), ['rg', '-n', 'a b', 'c d', 'E:\\x\\y']);
  assert.deepEqual(tokenizeCommand('echo "" x'), ['echo', '', 'x']);
  assert.deepEqual(tokenizeCommand('  '), []);
  assert.deepEqual(tokenizeCommand(null), []);
});

test('splitCommandChain splits on unquoted && || ; | & and newlines only', () => {
  assert.deepEqual(splitCommandChain('git status && git diff || ls; cat a | rg x & dir\nwc -l').segments,
    ['git status', 'git diff', 'ls', 'cat a', 'rg x', 'dir', 'wc -l']);
  assert.deepEqual(splitCommandChain('rg -n "a|b;c&&d" src').segments, ['rg -n "a|b;c&&d" src']);
  const r = splitCommandChain('git status');
  assert.equal(r.redirect, false);
  assert.equal(r.subexpr, false);
  assert.equal(r.scriptblock, false);
});

test('splitCommandChain reports file redirections and treats fd duplication and null sinks as benign', () => {
  for (const c of ['rg x 2>&1', 'ls > $null', 'ls 2>$null', 'ls >/dev/null', 'ls &> /dev/null', 'dir > NUL', 'echo "a > b"']) {
    assert.equal(splitCommandChain(c).redirect, false, c);
  }
  const r = splitCommandChain('cat a.txt > b.txt; rg x >> "log file.txt" 2>&1');
  assert.equal(r.redirect, true);
  assert.deepEqual(r.redirectTargets.filter((t) => !t.benign).map((t) => t.target), ['b.txt', 'log file.txt']);
  assert.deepEqual(r.segments, ['cat a.txt', 'rg x']);
  assert.equal(splitCommandChain('ls 2> err.txt').redirectTargets[0].target, 'err.txt');
});

test('splitCommandChain flags sub-expressions and script blocks', () => {
  assert.equal(splitCommandChain('echo $(rm x)').subexpr, true);
  assert.equal(splitCommandChain('echo `rm x`').subexpr, true);
  assert.equal(splitCommandChain('echo "$(quoted)"').subexpr, false);
  assert.equal(splitCommandChain('Get-ChildItem | ForEach-Object { Remove-Item $_ }').scriptblock, true);
  assert.equal(splitCommandChain("rg 'a{2}' src").scriptblock, false);
});

// ---------- shell unwrapping ----------

test('unwrapShellArgv unwraps powershell / pwsh / cmd / bash and marks opaque forms', () => {
  assert.deepEqual(unwrapShellArgv(['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', 'git status']), { command: 'git status', opaque: false });
  assert.equal(unwrapShellArgv(['pwsh', '-NoProfile', '-c', 'rg', 'x']).command, 'rg x');
  assert.equal(unwrapShellArgv(['powershell', '-Comm', 'ls']).command, 'ls');
  assert.equal(unwrapShellArgv(['powershell', '-EncodedCommand', 'ZQBjAGgAbwA=']).opaque, true);
  assert.equal(unwrapShellArgv(['powershell', '-enc', 'ZQBjAGgAbwA=']).reason, 'encoded command');
  assert.equal(unwrapShellArgv(['powershell', '-File', 'x.ps1']).reason, 'script file');
  assert.equal(unwrapShellArgv(['cmd.exe', '/c', 'type a.txt']).command, 'type a.txt');
  assert.equal(unwrapShellArgv(['cmd', '/d', '/s', '/c', 'dir']).command, 'dir');
  assert.equal(unwrapShellArgv(['/bin/bash', '-lc', 'cat a > b']).command, 'cat a > b');
  assert.equal(unwrapShellArgv(['bash', 'script.sh']).opaque, true);
  assert.deepEqual(unwrapShellArgv(['git', 'status']), { argv: ['git', 'status'], opaque: false });
  assert.deepEqual(unwrapShellArgv([]), { command: '', opaque: false });
});

// ---------- read vs write vs unknown ----------

test('isReadOnlyCommand: allowlisted reads, including chains and benign redirections', () => {
  for (const c of ['git status', 'git status && git diff --stat', 'git log -1', 'Get-Content -LiteralPath C:/x.md',
    'rg -n "unlink|TODO" src', 'rg foo 2>&1', 'git -C E:/x status', 'ls; dir; Get-ChildItem -Recurse src',
    'type README.md', 'cat a | rg x | wc -l', 'Get-ChildItem | Select-Object Name', '']) {
    const r = isReadOnlyCommand(c);
    assert.equal(r.readOnly, true, c);
    assert.equal(r.write, false, c);
  }
  assert.equal(isReadOnlyCommand('wrap run git status', { wrappers: [['wrap', 'run']] }).class, 'read');
  assert.equal(isReadOnlyCommand('git status && git diff').reason, 'allowlist');
});

test('isReadOnlyCommand: commands outside the allowlist are unknown, never read', () => {
  for (const [c, why] of [
    ['npm test', /not in allowlist: npm/], ['node build.mjs', /not in allowlist: node/], ['git push', /not in allowlist: git/],
    ['git status; npm test', /npm/], ['git -c core.pager=x log', /configuration override/], ['git diff --output=d.txt', /unsafe flag/],
    ['rg --pre ./x foo', /unsafe flag/], ['echo $(whoami)', /not in allowlist|sub-expression/],
    ['Get-ChildItem | ForEach-Object { $_ }', /not in allowlist|script block/],
    ['powershell -EncodedCommand ZQBjAGgAbwA=', /encoded command/],
  ]) {
    const r = isReadOnlyCommand(c);
    assert.equal(r.class, 'unknown', c);
    assert.equal(r.readOnly, false, c);
    assert.equal(r.write, false, c);
    assert.match(r.reason, why, c);
  }
});

test('isReadOnlyCommand: write commands, git mutations and file redirections are writes, also inside chains and wrappers', () => {
  const cases = [
    ['Set-Content -Path E:\\x\\s.txt -Value 1', ['E:\\x\\s.txt']], ['Get-Content a | Set-Content b', ['b']],
    ['type a & del b', ['b']], ['git status && rm -rf build', ['build']], ['cat a.txt > b.txt', ['b.txt']],
    ['Remove-Item old.txt', ['old.txt']], ['git commit -m x', []], ['git -C E:/r add .', []],
    ['sed -i s/a/b/ f.txt', []], ['cmd /c "type a & del b"', ['b']], ['powershell -Command "New-Item -ItemType File x.md"', ['x.md']],
    ['ls 2> err.txt', ['err.txt']],
  ];
  for (const [c, paths] of cases) {
    const r = isReadOnlyCommand(c);
    assert.equal(r.write, true, c);
    assert.equal(r.class, 'write', c);
    assert.equal(r.readOnly, false, c);
    assert.deepEqual(r.paths, paths, c);
  }
  assert.ok(WRITE_COMMANDS.has('set-content') && WRITE_COMMANDS.has('rm'));
  assert.ok(GIT_WRITE_SUBCOMMANDS.has('commit') && !GIT_WRITE_SUBCOMMANDS.has('status'));
});

test("isReadOnlyCommand: the room's own command is excluded (roomOnly), alone or wrapped; room + read is a read", () => {
  for (const c of ['node D:/tools/room-dev/room.mjs wait --seat X',
    'C:\\rooms\\fx\\seats\\A\\room.cmd wait', 'node room.mjs wait; node room.mjs status']) {
    const r = isReadOnlyCommand(c);
    assert.equal(r.roomOnly, true, c);
    assert.equal(r.readOnly, true, c);
  }
  assert.equal(isReadOnlyCommand('wrap run node D:/tools/room-dev/room.mjs submit --file a.md', { wrappers: [['wrap', 'run']] }).roomOnly, true);
  const mixed = isReadOnlyCommand('node room.mjs wait; rg x');
  assert.equal(mixed.class, 'read');
  assert.equal(mixed.roomOnly, false);
  assert.equal(isReadOnlyCommand('node room.mjs wait; npm test').class, 'unknown');
  assert.equal(isReadOnlyCommand('node other.mjs').class, 'unknown');
});

test('isReadOnlyCommand honours a custom allowlist and wrapper list', () => {
  assert.equal(isReadOnlyCommand('npm test', { allowlist: [['npm', 'test']] }).class, 'read');
  assert.equal(isReadOnlyCommand('git status', { allowlist: [['npm', 'test']] }).class, 'unknown');
  assert.equal(isReadOnlyCommand('sudo git status', { wrappers: [['sudo']] }).class, 'read');
  assert.equal(isReadOnlyCommand('wrap run git status', { wrappers: [['wrap', 'run']] }).class, 'read');
  assert.equal(isReadOnlyCommand('wrap run git status', { wrappers: [] }).class, 'unknown');
  assert.ok(READ_ONLY_ALLOWLIST.some((p) => p.join(' ') === 'git diff'));
  assert.deepEqual(COMMAND_WRAPPERS, []);
});

test('isReadOnlyArgv handles recorded argv: shell wrappers, custom wrappers around a shell, room commands, plain argv', () => {
  const ps = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  let r = isReadOnlyArgv([ps, '-Command', "rg -n \"room|seat\" 'E:/x/MEMORY.md'"]);
  assert.equal(r.class, 'read');
  assert.equal(r.command, "rg -n \"room|seat\" 'E:/x/MEMORY.md'");
  r = isReadOnlyArgv([ps, '-Command', 'wrap run node D:/tools/room-dev/room.mjs wait --seat C:/r/seats/A'], { wrappers: [['wrap', 'run']] });
  assert.equal(r.roomOnly, true);
  assert.equal(isReadOnlyArgv(['wrap', 'run', 'powershell', '-Command', 'git status'], { wrappers: [['wrap', 'run']] }).class, 'read');
  assert.equal(isReadOnlyArgv(['wrap', 'run', 'powershell', '-Command', 'Remove-Item x'], { wrappers: [['wrap', 'run']] }).class, 'write');
  assert.equal(isReadOnlyArgv(['cmd', '/c', 'npm test']).class, 'unknown');
  assert.equal(isReadOnlyArgv(['git', 'log', '-1']).class, 'read');
  assert.equal(isReadOnlyArgv(['git', 'log', '-1']).command, 'git log -1');
  assert.equal(isReadOnlyArgv(['powershell', '-File', 'x.ps1']).class, 'unknown');
  assert.equal(isReadOnlyArgv(['powershell', '-File', 'x.ps1']).command, null);
  assert.equal(isReadOnlyArgv('git status').class, 'read'); // a string is a command line
});

// ---------- code-mode exec / apply_patch ----------

test('extractCodexExecCommands finds literal cmd strings and flags what it cannot read', () => {
  const src = [
    'const r = await Promise.allSettled([',
    '  tools.exec_command({cmd:"rg -n \\"unlink|TODO\\" src", max_output_tokens:6000}),',
    "  tools.exec_command({ cmd: 'Get-Content \\'a b.md\\'' }),",
    '  tools.exec_command({cmd:`git status`}),',
    '  tools.exec_command({cmd:`ls ${dir}`}),',
    '  tools.exec_command({cmd: chosen}),',
    '  tools.write_stdin({session_id: 1, chars: "y"}),',
    ']);',
  ].join('\n');
  const x = extractCodexExecCommands(src);
  assert.deepEqual(x.commands, ['rg -n "unlink|TODO" src', "Get-Content 'a b.md'", 'git status']);
  assert.deepEqual(x.opaque, ['ls ${dir}']);
  assert.equal(x.unresolved, 1);
  assert.equal(x.stdinCalls, 1);
  assert.deepEqual(x.writeHints, [], 'words inside string literals are not write hints');
  const w = extractCodexExecCommands('await tools.apply_patch({input: p}); fs.writeFileSync("x", "y");');
  assert.deepEqual(w.writeHints.sort(), ['apply_patch', 'writeFileSync']);
  assert.deepEqual(extractCodexExecCommands(''), { commands: [], opaque: [], unresolved: 0, stdinCalls: 0, writeHints: [] });
});

test('parsePatchPaths reads Add / Update / Delete / Move to, tolerating CRLF', () => {
  const patch = '*** Begin Patch\r\n*** Add File: a.md\r\n+x\r\n*** Update File: E:\\r\\b.md\r\n*** Move to: E:\\r\\c.md\r\n*** Delete File: d.md\r\n*** End Patch\r\n';
  assert.deepEqual(parsePatchPaths(patch), [
    { op: 'add', path: 'a.md' }, { op: 'update', path: 'E:\\r\\b.md' }, { op: 'move', path: 'E:\\r\\c.md' }, { op: 'delete', path: 'd.md' },
  ]);
  assert.deepEqual(parsePatchPaths(undefined), []);
});

// ---------- classifyWrites, per shape ----------

test('classifyWrites on every Codex line shape in the parent fixture', () => {
  const L = readLines(F_PARENT);
  const by = (ord) => classifyWrites('codex', L.find((l) => l.ordinal === ord));
  assert.equal(by(0).kind, 'other'); // session_meta
  assert.equal(by(2).kind, 'other'); // custom exec: room wait (excluded)
  assert.equal(by(2).items[0].source, 'custom_tool_call/exec/room');
  assert.equal(by(3).kind, 'other'); // CommandExecution: room wait via powershell
  assert.equal(by(3).items[0].source, 'CommandExecution/room');
  const r5 = by(5); // custom exec with two literal reads
  assert.equal(r5.kind, 'read');
  assert.deepEqual(r5.items.map((i) => i.command), [`Get-Content -LiteralPath '${pk(P1)}'`, 'rg -n "unlink|TODO" src']);
  assert.equal(by(6).kind, 'read'); // CommandExecution Get-Content
  assert.equal(by(6).items[0].command, `Get-Content -LiteralPath '${pk(P1)}'`);
  assert.equal(by(7).kind, 'read'); // function_call exec_command, chained reads
  assert.equal(by(8).kind, 'read'); // function_call shell, argv
  assert.equal(by(9).kind, 'unknown-exec'); // npm test
  assert.equal(by(10).kind, 'unknown-exec'); // non-literal cmd
  assert.equal(by(10).items[0].reason, 'cmd is not a literal');
  assert.equal(by(11).kind, 'other'); // assistant message
  const p = by(16); // function_call apply_patch
  assert.equal(p.kind, 'write');
  assert.deepEqual(p.items[0].paths, ['E:\\fixture\\reviewer-A\\notes.md']);
  assert.equal(p.items[0].callId, 'call_p1');
  assert.equal(by(17).kind, 'write'); // patch_apply_end
  assert.equal(by(17).items[0].callId, 'call_p1');
  const fc = by(18); // FileChange
  assert.equal(fc.kind, 'write');
  assert.equal(fc.items[0].status, 'completed');
  assert.match(fc.detail, /^FileChange .*a1-2-cc22dd-s01\.md$/);
  assert.equal(by(19).kind, 'other'); // spawn_agent
  assert.equal(by(20).kind, 'other'); // SubAgentActivity
});

test('classifyWrites on child / grandchild shapes and on synthetic Codex lines', () => {
  const C = readLines(F_CHILD);
  assert.equal(classifyWrites('codex', C.find((l) => l.ordinal === 7)).kind, 'write'); // custom_tool_call apply_patch
  assert.deepEqual(classifyWrites('codex', C.find((l) => l.ordinal === 7)).items[0].paths, ['E:\\fixture\\reviewer-A\\child-note.md']);
  const sc = classifyWrites('codex', C.find((l) => l.ordinal === 8)); // shell_command Set-Content
  assert.equal(sc.kind, 'write');
  assert.deepEqual(sc.items[0].paths, ['E:\\fixture\\reviewer-A\\scratch.txt']);
  const G = readLines(F_GRAND);
  const ls = classifyWrites('codex', G[1]); // local_shell_call bash -lc with redirect
  assert.equal(ls.kind, 'write');
  assert.deepEqual(ls.items[0].paths, ['b.txt']);
  assert.equal(classifyWrites('codex', G[2]).kind, 'read'); // exec_command_begin git log
  const ev = (item) => ({ type: 'event_msg', payload: { type: 'item_completed', item } });
  assert.equal(classifyWrites('codex', ev({ type: 'CommandExecution', command: 'git status' })).kind, 'read', 'string command is a command line');
  assert.equal(classifyWrites('codex', ev({ type: 'CommandExecution', command: ['powershell.exe', '-Command', 'npm test'] })).kind, 'unknown-exec');
  const fn = (name, args) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'c' } });
  assert.equal(classifyWrites('codex', fn('write_stdin', { session_id: 1, chars: 'rm -rf /\n' })).kind, 'unknown-exec');
  assert.equal(classifyWrites('codex', fn('write_file', { path: 'a.md' })).kind, 'write');
  assert.equal(classifyWrites('codex', fn('exec_command', { cmd: 'node D:/tools/room-dev/room.mjs wait --seat X' })).kind, 'other');
  const exec = (input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
  assert.equal(classifyWrites('codex', exec('text("hi")')).items[0].reason, 'no exec_command literal found');
  const mixed = classifyWrites('codex', exec('await tools.exec_command({cmd:"git status"}); await tools.apply_patch({input: p});'));
  assert.equal(mixed.kind, 'write');
  assert.deepEqual(mixed.items.map((i) => i.kind), ['read', 'write']);
  assert.equal(classifyWrites('codex', exec('tools.exec_command({cmd:`rm ${x}`})')).items[0].reason, 'template interpolation');
  assert.equal(classifyWrites('codex', { type: 'turn_context', payload: {} }).kind, 'other');
  assert.equal(classifyWrites('codex', null).kind, 'other');
  assert.deepEqual(classifyWrites('codex', 'x').items, []);
});

test('classifyWrites on Claude shapes: Write/Edit/MultiEdit write, Bash/PowerShell by command, Read/Grep read, results other', () => {
  const L = readLines(path.join(CLAUDE_FIX, `${S1}.jsonl`));
  const byUuid = (u) => classifyWrites('claude', L.find((l) => l.uuid === u));
  assert.equal(byUuid('u-0001').kind, 'other'); // user prompt
  assert.equal(byUuid('u-0002').kind, 'other'); // Bash room wait (excluded)
  assert.equal(byUuid('u-0003').kind, 'other'); // user tool_result
  assert.equal(byUuid('u-0004').kind, 'read'); // Read packet
  assert.equal(byUuid('u-0006').kind, 'read'); // Bash git status; rg 2>&1
  assert.equal(byUuid('u-0007').kind, 'unknown-exec'); // PowerShell npm test
  assert.equal(byUuid('u-0008').kind, 'read'); // Grep
  assert.equal(byUuid('u-0009').kind, 'other'); // text only
  const w = byUuid('u-0012');
  assert.equal(w.kind, 'write');
  assert.deepEqual(w.items[0].paths, ['E:\\fixture\\demo\\hello.mjs']);
  assert.equal(w.items[0].toolUseId, 'toolu_x1');
  assert.equal(byUuid('u-0014').kind, 'write'); // Edit
  assert.equal(byUuid('u-0015').kind, 'other'); // Agent
  const sub = readLines(path.join(CLAUDE_FIX, S1, 'subagents', 'agent-a0001.jsonl'));
  assert.equal(classifyWrites('claude', sub[1]).kind, 'write'); // Bash Remove-Item
  const multi = { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } },
    { type: 'tool_use', id: 't2', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } },
    { type: 'tool_use', id: 't3', name: 'mcp__x__y', input: {} },
  ] } };
  const m = classifyWrites('claude', multi);
  assert.equal(m.kind, 'write', 'the most severe call on the line wins');
  assert.deepEqual(m.items.map((i) => i.kind), ['read', 'write', 'other']);
  assert.equal(m.detail, 'tool_use/NotebookEdit n.ipynb');
});

// ---------- headers and child threads ----------

test('readSessionHeader reads only the first line; handles long headers, a missing newline and a missing file', async () => {
  const h = readSessionHeader(F_CHILD);
  assert.equal(h.type, 'session_meta');
  assert.equal(h.payload.id, CHILD);
  assert.equal(readSessionHeader(path.join(FIX, 'no-such-file.jsonl')), null);
  const { root, guard } = tempRun();
  try {
    const big = { timestamp: 'x', ordinal: 0, type: 'session_meta', payload: { id: 'big', base_instructions: { text: 'y'.repeat(150_000) } } };
    const f = path.join(root, 'big.jsonl');
    guard.writeFile(f, `${JSON.stringify(big)}\r\n{"next":1}\n`);
    assert.equal(readSessionHeader(f).payload.id, 'big', 'headers longer than one 64 KB chunk are read');
    assert.equal(readSessionHeader(f, 1000), null, 'a header longer than the cap is unreadable, not guessed');
    const g = path.join(root, 'one.jsonl');
    guard.writeFile(g, JSON.stringify({ type: 'session_meta', payload: { id: 'one' } }));
    assert.equal(readSessionHeader(g).payload.id, 'one');
    const bad = path.join(root, 'bad.jsonl');
    guard.writeFile(bad, '{not json\n');
    assert.equal(readSessionHeader(bad), null);
  } finally { await rmRun(root); }
});

test('codexParentIds collects parent_thread_id, forked_from_id and source.subagent.thread_spawn', () => {
  assert.deepEqual(codexParentIds(readSessionHeader(F_CHILD)), [PARENT]);
  assert.deepEqual(codexParentIds(readSessionHeader(F_GRAND)), [CHILD]);
  assert.deepEqual(codexParentIds(readSessionHeader(F_PARENT)), []);
  assert.deepEqual(codexParentIds({ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } }, forked_from_id: 'f' } }).sort(), ['f', 'p']);
  assert.deepEqual(codexParentIds({ type: 'event_msg', payload: { parent_thread_id: 'p' } }), []);
  assert.deepEqual(codexParentIds(null), []);
});

test('isCodexThreadId / rolloutThreadId: canonical uuids only, taken from the anchored tail of the file name', () => {
  assert.equal(isCodexThreadId(PARENT), true);
  assert.equal(isCodexThreadId(PARENT.toUpperCase()), true);
  for (const bad of ['2026', 'a001', '01a0f000', PARENT.slice(0, 35), `x${PARENT}`, `${PARENT}-1`, '', null, 42]) assert.equal(isCodexThreadId(bad), false, String(bad));
  assert.equal(rolloutThreadId(F_PARENT), PARENT);
  assert.equal(rolloutThreadId(`rollout-2026-10-01T18-00-00-${PARENT.toUpperCase()}.jsonl`), PARENT);
  for (const bad of [`rollout-2026-10-01T18-00-00-x${PARENT}.jsonl`, `rollout-2026-10-01T18-00-00-${PARENT}-copy.jsonl`, `rollout-${PARENT}.json`, 'rollout-2026-10-01.jsonl']) {
    assert.equal(rolloutThreadId(bad), null, bad);
  }
});

test('findCodexChildThreads follows SubAgentActivity names (children of children) across sessions/ and archived_sessions/, opening only registered rollouts', async () => {
  const spy = spyFs();
  let r;
  try { r = await findCodexChildThreads(PARENT, null, CODEX_FIX); } finally { spy.restore(); }
  assert.deepEqual(r.threadFiles, [F_PARENT]);
  assert.deepEqual(r.children.map((c) => c.file).sort(), [F_CHILD, F_CHILD_ARCH, F_GRAND].sort());
  const child = r.children.find((c) => c.file === F_CHILD);
  assert.equal(child.id, CHILD);
  assert.equal(child.parent, PARENT);
  assert.equal(child.inheritedPrefix, 5);
  const grand = r.children.find((c) => c.file === F_GRAND);
  assert.equal(grand.parent, CHILD);
  assert.equal(grand.inheritedPrefix, null);
  assert.ok(!r.children.some((c) => c.file === F_OTHER), 'a thread with another parent is not a child');
  assert.ok(!r.children.some((c) => c.file === F_FORK), 'a fork no registered rollout names is not followed');
  assert.ok(!r.children.some((c) => c.file === F_PARENT), 'the thread itself is not its own child');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.rejected, []);
  // opened == registered: nothing outside the thread and its named descendants is touched.
  assert.deepEqual(r.opened.slice().sort(), CODEX_FILES.slice().sort());
  assert.deepEqual([...new Set(spy.opens.map((o) => norm(o.path)))].sort(), CODEX_FILES.map(norm).sort());
  assert.ok(!spy.opens.some((o) => [F_OTHER, F_FORK].map(norm).includes(norm(o.path))), 'the unrelated thread and the unnamed fork stay closed');
  assert.deepEqual(r.persist.childThreads.map((c) => [c.id, c.parent]).sort(), [[CHILD, PARENT], [GRAND, CHILD]]);
  const none = await findCodexChildThreads('01a0f000-0000-7000-8000-0000000000ff', null, CODEX_FIX);
  assert.deepEqual([none.threadFiles, none.children, none.opened], [[], [], []]);
  const upper = await findCodexChildThreads(PARENT.toUpperCase(), null, CODEX_FIX);
  assert.deepEqual(upper.opened.slice().sort(), CODEX_FILES.slice().sort(), 'ids compare case-insensitively');
});

test('findCodexChildThreads: recent unrelated rollouts and unnamed forks are never opened; a named child without a rollout is recorded, not searched for', async () => {
  const { root, guard } = tempRun();
  try {
    const home = path.join(root, 'codex');
    copyTree(guard, CODEX_FIX, home); // fresh mtimes: every rollout is "recent"
    const parent = path.join(home, DAY, path.basename(F_PARENT));
    const ghost = '01a0f000-0000-7000-8000-00000000f001';
    guard.appendFsync(parent, `${JSON.stringify({ timestamp: '2026-10-01T10:09:00.000Z', ordinal: 22, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'call_s9', kind: 'started', agent_thread_id: ghost } } })}\n`);
    const spy = spyFs();
    let r;
    try { r = await findCodexChildThreads(PARENT, Date.now() - 60_000, home); } finally { spy.restore(); }
    const reg = [parent, ...r.children.map((c) => c.file)];
    assert.equal(r.children.length, 3);
    assert.deepEqual(r.missing, [{ id: ghost, parent: PARENT }]);
    assert.deepEqual(new Set(spy.opens.map((o) => norm(o.path))), new Set(reg.map(norm)));
    for (const name of [path.basename(F_OTHER), path.basename(F_FORK)]) assert.ok(!spy.opens.some((o) => o.path.endsWith(name)), `${name} opened`);
  } finally { await rmRun(root); }
});

// ---------- locateFiles ----------

test('locateFiles (codex) registers the thread, its archived copy and descendants, never unrelated rollouts', async () => {
  await withEnv({ CODEX_HOME: CODEX_FIX }, async () => {
    const spy = spyFs();
    let r;
    try { r = await locateFiles({ kind: 'codex', threadId: PARENT }, null, P1); } finally { spy.restore(); }
    assert.deepEqual(r.files.slice().sort(), CODEX_FILES.slice().sort());
    assert.ok(!r.files.includes(F_OTHER) && !r.files.includes(F_FORK));
    assert.match(r.note, /\+3 child thread\(s\)/);
    assert.match(r.note, /forks not named by a registered rollout: unknown/);
    assert.deepEqual(r.candidates, []);
    // For Codex the opened set IS the registered set (#44), measured at the fs layer too.
    assert.deepEqual(new Set(r.opened.map(norm)), new Set(r.files.map(norm)));
    assert.deepEqual(new Set(spy.opens.map((o) => norm(o.path))), new Set(r.files.map(norm)));
    assert.deepEqual(spy.writes, []);
    const none = await locateFiles({ kind: 'codex', threadId: null }, null, P1);
    assert.deepEqual(none.files, []);
    assert.equal(none.note, 'no threadId registered');
  });
  assert.equal((await locateFiles({ kind: 'gemini' })).note, 'unknown audit kind gemini');
});

test('locateFiles (codex) matches the registered id exactly: a short or partial id registers and opens nothing', async () => {
  const { root, guard } = tempRun();
  try {
    const home = path.join(root, 'codex');
    copyTree(guard, CODEX_FIX, home);
    // Decoys whose names contain the parent id without ending in "-<id>.jsonl".
    const decoyA = path.join(home, DAY, `rollout-2026-10-01T18-09-00-x${PARENT}.jsonl`);
    const decoyB = path.join(home, DAY, `rollout-2026-10-01T18-09-10-${PARENT}-copy.jsonl`);
    for (const d of [decoyA, decoyB]) guard.copyFile(F_PARENT, d);
    await withEnv({ CODEX_HOME: home }, async () => {
      for (const id of ['2026', 'rollout', 'a001', '01a0f000', PARENT.slice(0, 20), `x${PARENT}`]) {
        const spy = spyFs();
        let r;
        try { r = await locateFiles({ kind: 'codex', threadId: id }, null, P1); } finally { spy.restore(); }
        assert.deepEqual(r.files, [], id);
        assert.deepEqual(r.opened, [], id);
        assert.deepEqual(spy.opens, [], id);
        assert.match(r.note, /not a canonical thread uuid; nothing opened/, id);
      }
      const r = await locateFiles({ kind: 'codex', threadId: PARENT.toUpperCase() }, null, P1);
      const names = r.files.map((f) => path.basename(f)).sort();
      assert.deepEqual(names, CODEX_FILES.map((f) => path.basename(f)).sort());
      assert.ok(!r.opened.some((f) => f === decoyA || f === decoyB));
    });
    // A file named for the thread whose header says it is another thread is not registered.
    const liar = path.join(home, 'archived_sessions', `rollout-2026-10-01T18-09-20-${PARENT}.jsonl`);
    guard.copyFile(F_OTHER, liar);
    await withEnv({ CODEX_HOME: home }, async () => {
      const r = await locateFiles({ kind: 'codex', threadId: PARENT }, null, P1);
      assert.ok(!r.files.includes(liar));
      assert.deepEqual(r.rejected.map((x) => [x.file, x.headerId]), [[liar, OTHER]]);
      assert.match(r.note, /1 rollout\(s\) whose header id differs/);
    });
  } finally { await rmRun(root); }
});

test('locateFiles (codex) with persisted discovery state reads registered rollouts only from where it stopped and picks up a newly named child', async () => {
  const { root, guard } = tempRun();
  try {
    const home = path.join(root, 'codex');
    copyTree(guard, CODEX_FIX, home);
    const parent = path.join(home, DAY, path.basename(F_PARENT));
    await withEnv({ CODEX_HOME: home }, async () => {
      const audit = { kind: 'codex', threadId: PARENT };
      const r1 = await locateFiles(audit, null, P1);
      assert.equal(r1.files.length, 4);
      assert.equal(r1.persist.discoveryCursors[parent].offset, fs.statSync(parent).size);
      Object.assign(audit, r1.persist);
      let spy = spyFs();
      let r2;
      try { r2 = await locateFiles(audit, null, P1); } finally { spy.restore(); }
      assert.deepEqual(spy.opens, [], 'nothing appended: nothing opened');
      assert.deepEqual(r2.files.slice().sort(), r1.files.slice().sort());
      assert.equal(r2.children.find((c) => c.id === CHILD).inheritedPrefix, 5, 'the inherited prefix survives without re-reading the header');
      Object.assign(audit, r2.persist);
      // A new child thread appears and the parent names it.
      const NEW = '01a0f000-0000-7000-8000-00000000c003';
      const newFile = path.join(home, DAY, `rollout-2026-10-01T18-09-40-${NEW}.jsonl`);
      guard.writeFile(newFile, `${JSON.stringify({ timestamp: '2026-10-01T10:09:40.000Z', ordinal: 0, type: 'session_meta', payload: { id: NEW, parent_thread_id: PARENT } })}\n`);
      const before = fs.statSync(parent).size;
      guard.appendFsync(parent, `${JSON.stringify({ timestamp: '2026-10-01T10:09:39.000Z', ordinal: 22, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'call_s2', kind: 'started', agent_thread_id: NEW } } })}\n`);
      spy = spyFs();
      let r3;
      try { r3 = await locateFiles(audit, null, P1); } finally { spy.restore(); }
      assert.deepEqual(spy.opens.filter((o) => o.api === 'createReadStream').map((o) => [norm(o.path), o.start]).sort(),
        [[norm(parent), before], [norm(newFile), 0]].sort(), 'parent resumed at its old end; the new child read once');
      assert.ok(r3.files.includes(newFile));
      assert.equal(r3.children.find((c) => c.file === newFile).parent, PARENT);
      assert.deepEqual(new Set(spy.opens.map((o) => norm(o.path))), new Set([parent, newFile].map(norm)));
    });
  } finally { await rmRun(root); }
});

async function claudeProject(guard, root) {
  const home = path.join(root, 'claude');
  const cwd = path.join(root, 'seat-cwd');
  const dir = path.join(home, 'projects', encodeClaudeProjectDir(cwd));
  copyTree(guard, CLAUDE_FIX, dir);
  const base = Date.parse('2026-10-01T10:00:00Z') / 1000;
  const at = (name, dt) => fs.utimesSync(path.join(dir, `${name}.jsonl`), base + dt, base + dt); // test setup only
  at(S0, -3600); at(S3, 10); at(S1, 20); at(S2, 30);
  return { home, cwd, dir, since: base * 1000, f: (name) => path.join(dir, `${name}.jsonl`) };
}

test('locateFiles (claude) opens only candidates, newest first, until the first packet id is found (#44 registration)', async () => {
  const { root, guard } = tempRun();
  try {
    const p = await claudeProject(guard, root);
    await withEnv({ CLAUDE_CONFIG_DIR: p.home }, async () => {
      assert.equal(claudeHome(), p.home);
      const spy = spyFs();
      let r;
      try { r = await locateFiles({ kind: 'claude', cwd: p.cwd }, p.since, Q1); } finally { spy.restore(); }
      assert.equal(r.sessionId, S1);
      assert.deepEqual(r.candidates.map((x) => path.basename(x)), [`${S2}.jsonl`, `${S1}.jsonl`, `${S3}.jsonl`], 'older-than-since transcripts are not candidates');
      const sub = path.join(p.dir, S1);
      assert.deepEqual(r.files, [
        p.f(S1),
        path.join(sub, 'subagents', 'agent-a0001.jsonl'),
        path.join(sub, 'subagents', 'workflows', 'wf_0001', 'agent-a0002.jsonl'),
        path.join(sub, 'tool-results', 'bwait0002.txt'),
      ]);
      const contentOpens = spy.opens.map((o) => o.path);
      assert.deepEqual(contentOpens, [p.f(S2), p.f(S1)], 'stops at the first hit; the older decoy and the pre-seat transcript stay closed');
      assert.ok(spy.opens.every((o) => o.flags === 'r'));
      assert.deepEqual(spy.writes, []);
      const allowed = new Set([...r.files, ...r.candidates].map(norm));
      for (const f of [...r.opened, ...contentOpens]) assert.ok(allowed.has(norm(f)), `opened ${f} outside registered ∪ candidates`);
      assert.ok(!r.opened.includes(p.f(S0)) && !r.opened.includes(p.f(S3)));
    });
  } finally { await rmRun(root); }
});

test('locateFiles (claude): the transcript found by packet id is handed back for registration, after which no candidate is probed again', async () => {
  const { root, guard } = tempRun();
  try {
    const p = await claudeProject(guard, root);
    await withEnv({ CLAUDE_CONFIG_DIR: p.home }, async () => {
      const audit = { kind: 'claude', cwd: p.cwd };
      const r1 = await locateFiles(audit, p.since, Q1);
      assert.deepEqual(r1.persist, { sessionId: S1 });
      Object.assign(audit, r1.persist);
      const spy = spyFs();
      let r2;
      try { r2 = await locateFiles(audit, p.since, Q1); } finally { spy.restore(); }
      assert.deepEqual(r2.candidates, []);
      assert.equal(r2.persist, undefined, 'already registered');
      assert.deepEqual(spy.opens, [], 'locating a registered session opens no transcript');
      assert.deepEqual(r2.files, r1.files);
    });
  } finally { await rmRun(root); }
});

test('locateFiles (claude): a registered sessionId opens nothing else; no packet id opens nothing; baseline excludes unchanged transcripts', async () => {
  const { root, guard } = tempRun();
  try {
    const p = await claudeProject(guard, root);
    await withEnv({ CLAUDE_CONFIG_DIR: p.home }, async () => {
      let spy = spyFs();
      let r;
      try { r = await locateFiles({ kind: 'claude', cwd: p.cwd, sessionId: S1 }, p.since, Q1); } finally { spy.restore(); }
      assert.equal(r.files[0], p.f(S1));
      assert.deepEqual(r.candidates, []);
      assert.deepEqual(spy.opens, []);

      spy = spyFs();
      try { r = await locateFiles({ kind: 'claude', cwd: p.cwd }, p.since, undefined); } finally { spy.restore(); }
      assert.deepEqual(r.files, []);
      assert.deepEqual(r.opened, []);
      assert.deepEqual(spy.opens, []);
      assert.match(r.note, /no packet issued yet/);

      const st = fs.statSync(p.f(S2));
      spy = spyFs();
      try {
        r = await locateFiles({ kind: 'claude', cwd: p.cwd, knownTranscripts: [{ name: `${S2}.jsonl`, size: st.size, mtimeMs: st.mtimeMs }] }, p.since, Q1);
      } finally { spy.restore(); }
      assert.deepEqual(spy.opens.map((o) => o.path), [p.f(S1)], 'a transcript unchanged since seat creation is not a candidate');

      spy = spyFs();
      try { r = await locateFiles({ kind: 'claude', cwd: p.cwd }, p.since, 'r9-B-never-issued'); } finally { spy.restore(); }
      assert.deepEqual(r.files, []);
      assert.deepEqual(spy.opens.map((o) => o.path), [p.f(S2), p.f(S1), p.f(S3)]);
      assert.match(r.note, /3 candidates checked/);
    });
    const missing = await withEnv({ CLAUDE_CONFIG_DIR: path.join(root, 'nowhere') }, () => locateFiles({ kind: 'claude', cwd: p.cwd }, p.since, Q1));
    assert.match(missing.note, /claude project dir not found/);
  } finally { await rmRun(root); }
});

// ---------- packet delivery (§7.2, #48) ----------

test('auditPacket (codex): present_in_native / header_only / mentioned / unknown; inherited prefix ignored', async () => {
  const p1 = await auditPacket({ kind: 'codex', files: CODEX_FILES, packetId: P1, packetPath: pkOs(P1) });
  assert.equal(p1.status, 'present_in_native');
  assert.ok(p1.hits.some((h) => h.side === 'result' && h.mentionsWait));
  assert.ok(p1.hits.some((h) => h.side === 'call' && h.mentionsPath && !h.mentionsWait));
  assert.ok(p1.hits.some((h) => h.side === 'event' && h.call === true), 'CommandExecution: command half counts as the read call');
  assert.ok(p1.hits.some((h) => h.side === 'event' && h.result === true), 'CommandExecution: output half counts as the header');
  const p2 = await auditPacket({ kind: 'codex', files: CODEX_FILES, packetId: P2, packetPath: pkOs(P2) });
  assert.equal(p2.status, 'header_only');
  assert.ok(p2.hits.every((h) => h.file === F_PARENT), 'the copy of the header in the child prefix is not a hit');
  assert.equal((await auditPacket({ kind: 'codex', files: [F_CHILD], packetId: P2, packetPath: pkOs(P2) })).status, 'unknown');
  assert.equal((await auditPacket({ kind: 'codex', files: CODEX_FILES, packetId: P3, packetPath: pkOs(P3) })).status, 'unknown');
  assert.equal((await auditPacket({ kind: 'codex', files: CODEX_FILES, packetId: P4, packetPath: pkOs(P4) })).status, 'mentioned');
  const gone = await auditPacket({ kind: 'codex', files: [path.join(FIX, 'missing.jsonl')], packetId: P1, packetPath: pk(P1) });
  assert.equal(gone.status, 'unknown');
  assert.equal(gone.errors.length, 1);
});

test('auditPacket (claude): tool_result header + Read call -> present; header only in tool-results/*.txt -> header_only', async () => {
  const sub = path.join(CLAUDE_FIX, S1);
  const files = [path.join(CLAUDE_FIX, `${S1}.jsonl`), path.join(sub, 'subagents', 'agent-a0001.jsonl'), path.join(sub, 'tool-results', 'bwait0002.txt')];
  assert.equal((await auditPacket({ kind: 'claude', files, packetId: Q1, packetPath: pkOs(Q1) })).status, 'present_in_native');
  const q2 = await auditPacket({ kind: 'claude', files, packetId: Q2, packetPath: pkOs(Q2) });
  assert.equal(q2.status, 'header_only');
  assert.deepEqual(q2.hits.map((h) => [path.basename(h.file), h.side]), [['bwait0002.txt', 'result']]);
  assert.equal((await auditPacket({ kind: 'claude', files: files.slice(0, 2), packetId: Q2, packetPath: pkOs(Q2) })).status, 'unknown',
    'without the persisted output the preview alone does not carry the header');
});

// ---------- attempt observation (§5.3, §8.3, #9) ----------

test('auditAttempt (codex) attempt 1: unknown commands outside allowlist mark tainted, delivery present_in_native', async () => {
  const r = await auditAttempt({ seat: { seatId: 'A', audit: { kind: 'codex' } }, attemptId: 'a1-1-aa11bb', files: CODEX_FILES, packetId: P1, packetPath: pkOs(P1), turnWindow: W1 });
  assert.equal(r.type, 'audit_observed');
  assert.equal(r.seatId, 'A');
  assert.equal(r.status, 'present_in_native');
  assert.deepEqual(r.writes, []);
  assert.equal(r.tainted, true);
  assert.equal(r.annotation, 'tainted');
  assert.deepEqual(r.unknownCommands.map((u) => u.reason).sort(), ['cmd is not a literal', 'not in allowlist: npm']);
  assert.deepEqual(r.reads.map((x) => x.command).sort(), [
    `Get-Content -LiteralPath '${pk(P1)}'`, 'Get-ChildItem -Recurse src', 'git status && git diff --stat', 'rg -n "unlink|TODO" src',
  ].sort());
  assert.ok(r.others['custom_tool_call/exec/room'] >= 1 && r.others['CommandExecution/room'] >= 1, 'room commands are excluded, not reads');
  assert.match(r.note, /No writes observed/);
  assert.match(r.note, /tainted/);
  assert.deepEqual(r.window, W1);

  // Clean read-only window (no writes, no unknown commands) -> not tainted, annotation none.
  const cleanWin = { fromTs: '2026-10-01T10:00:00.000Z', toTs: '2026-10-01T10:00:26.000Z' };
  const clean = await auditAttempt({ seat: { seatId: 'A', audit: { kind: 'codex' } }, attemptId: 'a1-0-clean', files: [F_PARENT], packetId: P1, packetPath: pkOs(P1), turnWindow: cleanWin });
  assert.deepEqual(clean.writes, []);
  assert.deepEqual(clean.unknownCommands, []);
  assert.equal(clean.tainted, false);
  assert.equal(clean.annotation, 'none');
});

test('auditAttempt (codex) attempt 2: writes across parent, child and grandchild -> tainted; copies and inherited prefix counted once / never', async () => {
  const r = await auditAttempt({ kind: 'codex', attemptId: 'a1-2-cc22dd', files: CODEX_FILES, packetId: P2, packetPath: pkOs(P2), turnWindow: W2 });
  assert.equal(r.status, 'header_only');
  assert.equal(r.tainted, true);
  assert.equal(r.annotation, 'tainted');
  assert.deepEqual(r.writes.map((w) => [w.source, w.path]), [
    ['function_call/apply_patch', 'E:\\fixture\\reviewer-A\\notes.md'],
    ['FileChange', 'E:\\fixture\\reviewer-A\\.room-outbox\\A\\a1-2-cc22dd-s01.md'],
    ['custom_tool_call/apply_patch', 'E:\\fixture\\reviewer-A\\child-note.md'],
    ['function_call/shell_command', 'E:\\fixture\\reviewer-A\\scratch.txt'],
    ['local_shell_call', 'b.txt'],
  ], 'patch_apply_end shares call_p1; the archived copy of the child adds nothing');
  assert.ok(!r.writes.some((w) => w.file === F_CHILD_ARCH));
  assert.deepEqual(r.unknownCommands, [], 'the inherited copy of `npm test` (timestamp inside the window) is skipped');
  assert.deepEqual(r.reads.map((x) => x.command).sort(), ['git log -1', 'rg -n TODO src']);
  const child = r.files.find((f) => f.file === F_CHILD);
  assert.equal(child.inheritedPrefix, 5);
  assert.equal(child.skippedInherited, 5);
  const parent = r.files.find((f) => f.file === F_PARENT);
  assert.equal(parent.skippedOutsideWindow, 13);
  assert.match(r.note, /Observed 5 write operation\(s\)/);
  assert.match(r.note, /tainted/);
});

test('auditAttempt without a window sees both attempts; a custom allowlist turns an unknown into a read', async () => {
  const all = await auditAttempt({ kind: 'codex', files: CODEX_FILES });
  assert.equal(all.writes.length, 5);
  assert.equal(all.unknownCommands.length, 2);
  assert.equal(all.status, 'unknown');
  assert.equal(all.window, null);
  const custom = await auditAttempt({ kind: 'codex', files: [F_PARENT], turnWindow: W1, allowlist: [...READ_ONLY_ALLOWLIST, ['npm', 'test']] });
  assert.deepEqual(custom.unknownCommands.map((u) => u.reason), ['cmd is not a literal']);
});

test('auditAttempt (claude): attempt 1 tainted by unknown command, attempt 2 tainted by writes across main/subagent/workflow', async () => {
  const sub = path.join(CLAUDE_FIX, S1);
  const files = [path.join(CLAUDE_FIX, `${S1}.jsonl`), path.join(sub, 'subagents', 'agent-a0001.jsonl'),
    path.join(sub, 'subagents', 'workflows', 'wf_0001', 'agent-a0002.jsonl'), path.join(sub, 'tool-results', 'bwait0002.txt')];
  const seat = { seatId: 'B', audit: { kind: 'claude' } };
  const a1 = await auditAttempt({ seat, attemptId: 'b1-1-1a2b3c', files, packetId: Q1, packetPath: pkOs(Q1), turnWindow: W1 });
  assert.equal(a1.status, 'present_in_native');
  assert.equal(a1.tainted, true);
  assert.equal(a1.annotation, 'tainted');
  assert.deepEqual(a1.unknownCommands.map((u) => u.command), ['npm test']);
  assert.deepEqual(a1.reads.map((x) => x.source).sort(), ['tool_use/Bash', 'tool_use/Grep', 'tool_use/Read']);
  const a2 = await auditAttempt({ seat, attemptId: 'b1-2-4d5e6f', files, packetId: Q2, packetPath: pkOs(Q2), turnWindow: W2 });
  assert.equal(a2.status, 'header_only');
  assert.equal(a2.tainted, true);
  assert.deepEqual(a2.writes.map((w) => [w.source, w.path]), [
    ['tool_use/Write', 'E:\\fixture\\demo\\hello.mjs'],
    ['tool_use/Edit', 'E:\\fixture\\demo\\hello.mjs'],
    ['tool_use/Bash', 'E:\\fixture\\demo\\old.txt'],
    ['tool_use/MultiEdit', 'E:\\fixture\\demo\\b.mjs'],
  ]);
  assert.deepEqual(a2.reads.map((x) => x.path), ['E:\\fixture\\demo\\hello.mjs']);
});

test('auditAttempt reports audit_failed when no registered jsonl has the expected shape, and is never tainted then', async () => {
  const claudeFile = path.join(CLAUDE_FIX, `${S1}.jsonl`);
  const asCodex = await auditAttempt({ kind: 'codex', files: [claudeFile] });
  assert.equal(asCodex.annotation, 'audit_failed');
  assert.equal(asCodex.tainted, false);
  assert.match(asCodex.note, /audit_failed/);
  const asClaude = await auditAttempt({ kind: 'claude', files: [F_PARENT] });
  assert.equal(asClaude.annotation, 'audit_failed');
  const txtOnly = await auditAttempt({ kind: 'claude', files: [path.join(CLAUDE_FIX, S1, 'tool-results', 'bwait0002.txt')] });
  assert.equal(txtOnly.annotation, 'none', 'text files carry no shape to check');
  const missing = await auditAttempt({ kind: 'codex', files: [path.join(FIX, 'missing.jsonl')] });
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.annotation, 'audit_failed');
});

test('auditAttempt with cursors reads only bytes appended since the previous audit; inherited prefix, half lines and shrinking are handled', async () => {
  const { root, guard } = tempRun();
  try {
    const dir = path.join(root, 'logs');
    guard.mkdir(dir);
    const par = path.join(dir, path.basename(F_PARENT));
    const kid = path.join(dir, path.basename(F_CHILD));
    guard.copyFile(F_PARENT, par);
    guard.copyFile(F_CHILD, kid);
    const files = [par, kid];
    const a1 = await auditAttempt({ kind: 'codex', files });
    assert.equal(a1.writes.length, 4);
    assert.equal(a1.cursors[par].offset, fs.statSync(par).size);
    assert.equal(a1.cursors[par].lines, 22);
    assert.equal(a1.cursors[kid].skipBefore, 5);

    // Nothing appended: nothing opened, and the earlier shape check still holds (not audit_failed).
    let spy = spyFs();
    let a2;
    try { a2 = await auditAttempt({ kind: 'codex', files, cursors: a1.cursors }); } finally { spy.restore(); }
    assert.deepEqual(spy.opens, []);
    assert.deepEqual(a2.writes, []);
    assert.equal(a2.annotation, 'none');
    assert.ok(a2.files.every((f) => f.unchanged));

    // Appended: a write in the parent, an inherited-ordinal copy and a real write in the child,
    // and a half-written last line in the parent.
    const line = (o) => `${JSON.stringify(o)}\n`;
    const patch = (ord, ts, file, id) => ({ timestamp: ts, ordinal: ord, type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch\n` }), call_id: id } });
    const parEnd = fs.statSync(par).size;
    const kidEnd = fs.statSync(kid).size;
    const half = line(patch(23, '2026-10-01T10:09:30.000Z', 'E:\\fixture\\late.md', 'call_n2'));
    guard.appendFsync(par, line(patch(22, '2026-10-01T10:09:00.000Z', 'E:\\fixture\\new.md', 'call_n1')) + half.slice(0, 40));
    guard.appendFsync(kid, line(patch(3, '2026-10-01T10:09:05.000Z', 'E:\\fixture\\inherited.md', 'call_i1')) + line(patch(11, '2026-10-01T10:09:10.000Z', 'E:\\fixture\\kid.md', 'call_k1')));
    spy = spyFs();
    let a3;
    try { a3 = await auditAttempt({ kind: 'codex', files, cursors: a2.cursors }); } finally { spy.restore(); }
    assert.deepEqual(spy.opens.map((o) => [norm(o.path), o.start]).sort(), [[norm(par), parEnd], [norm(kid), kidEnd]].sort());
    assert.deepEqual(a3.writes.map((w) => [w.path, w.line]), [['E:\\fixture\\new.md', 23], ['E:\\fixture\\kid.md', 13]], 'only new lines, numbered absolutely');
    assert.equal(a3.files.find((f) => f.file === kid).skippedInherited, 1, 'the inherited prefix boundary is kept across resumes');
    assert.equal(a3.files.find((f) => f.file === par).lines, 2, 'the complete new line plus the half line');
    const afterFirst = parEnd + Buffer.byteLength(line(patch(22, '2026-10-01T10:09:00.000Z', 'E:\\fixture\\new.md', 'call_n1')));
    assert.equal(a3.cursors[par].offset, afterFirst, 'the cursor stops before the half-written line');

    // The half line is completed: it is read again, whole.
    guard.appendFsync(par, half.slice(40));
    const a4 = await auditAttempt({ kind: 'codex', files: [par], cursors: a3.cursors });
    assert.deepEqual(a4.writes.map((w) => [w.path, w.line]), [['E:\\fixture\\late.md', 24]]);

    // The file shrank (rewritten): the cursor is discarded and reading starts at byte 0.
    guard.writeFile(par, fs.readFileSync(F_PARENT, 'utf8').split('\n').slice(0, 3).join('\n') + '\n');
    spy = spyFs();
    let a5;
    try { a5 = await auditAttempt({ kind: 'codex', files: [par], cursors: a4.cursors }); } finally { spy.restore(); }
    assert.deepEqual(spy.opens.map((o) => o.start), [0]);
    assert.equal(a5.files[0].cursorReset, true);
    assert.equal(a5.cursors[par].lines, 3);
  } finally { await rmRun(root); }
});

// ---------- read-only access (#44) ----------

test('auditing the fixtures leaves every fixture file byte- and mtime-identical and opens nothing for writing', async () => {
  const all = listFiles(FIX);
  const before = statMap(all);
  const spy = spyFs();
  try {
    await withEnv({ CODEX_HOME: CODEX_FIX }, async () => {
      const loc = await locateFiles({ kind: 'codex', threadId: PARENT }, null, P1);
      await auditAttempt({ kind: 'codex', files: loc.files, packetId: P2, packetPath: pkOs(P2), turnWindow: W2 });
      await auditPacket({ kind: 'codex', files: loc.files, packetId: P1, packetPath: pkOs(P1) });
    });
  } finally { spy.restore(); }
  assert.deepEqual(spy.writes, []);
  assert.ok(spy.opens.length > 0);
  for (const o of spy.opens) assert.equal(o.flags, 'r', `${o.api} ${o.path}`);
  assert.deepEqual(statMap(all), before);
});

test('an agent that keeps appending to its rollout sees zero write errors while the audit reads it (#44)', async (t) => {
  const { root, guard } = tempRun();
  try {
    const home = path.join(root, 'codex');
    copyTree(guard, CODEX_FIX, home);
    const live = path.join(home, DAY, path.basename(F_PARENT));
    const liveChild = path.join(home, DAY, path.basename(F_CHILD));
    const frozen = listFiles(home).filter((f) => f !== live && f !== liveChild);
    const frozenBefore = statMap(frozen);
    const guardUrl = pathToFileURL(path.join(ROOT, 'lib', 'guard.mjs')).href;
    // The simulated agent appends (open-append-fsync-close, as an agent's logger would) through a guard.
    const script = `
      const [guardUrl, dir, a, b, ms] = process.argv.slice(1);
      const { createGuard } = await import(guardUrl);
      const g = createGuard({ allowed: [dir], logPath: dir + '/appender-write-log.jsonl', who: 'agent-sim' });
      let n = 0, errors = 0, ord = 1000;
      const end = Date.now() + Number(ms);
      while (Date.now() < end) {
        const line = JSON.stringify({ timestamp: '2026-10-01T10:07:00.000Z', ordinal: ord++, type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n live' + n }), call_id: 'live' + n } }) + '\\n';
        for (const f of [a, b]) { try { g.appendFsync(f, line); n++; } catch (e) { errors++; process.stderr.write(String(e && e.code || e) + '\\n'); } }
        await new Promise((r) => setTimeout(r, 1));
      }
      process.stdout.write(JSON.stringify({ n, errors }));
    `;
    let childDone = false;
    const childP = spawnClean(NODE, ['--input-type=module', '-e', script, guardUrl, root, live, liveChild, '1500'], { timeoutMs: 30_000 })
      .finally(() => { childDone = true; });
    const startSize = fs.statSync(live).size;
    const t0 = Date.now();
    while (!childDone && fs.statSync(live).size === startSize && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 10));
    const spy = spyFs();
    let rounds = 0;
    const auditErrors = [];
    try {
      await withEnv({ CODEX_HOME: home }, async () => {
        while (!childDone) {
          const loc = await locateFiles({ kind: 'codex', threadId: PARENT }, null, P1);
          const r = await auditAttempt({ kind: 'codex', files: loc.files, packetId: P2, packetPath: pkOs(P2), turnWindow: W2 });
          auditErrors.push(...r.errors);
          const registered = new Set(loc.files.map(norm));
          assert.equal(loc.files.length, 4);
          assert.deepEqual(new Set(loc.opened.map(norm)), registered, 'opened == registered');
          for (const o of spy.opens) assert.ok(registered.has(norm(o.path)), `opened ${o.path} outside the registered set`);
          rounds++;
        }
      });
    } finally { spy.restore(); }
    const child = await childP;
    assert.equal(child.code, 0, child.stderr);
    const stats = JSON.parse(child.stdout);
    t.diagnostic(`appends=${stats.n} append_errors=${stats.errors} audit_rounds=${rounds} opens=${spy.opens.length}`);
    assert.equal(stats.errors, 0, 'the appender never failed while the audit had the file open');
    assert.ok(stats.n > 0, 'the appender appended');
    assert.ok(rounds >= 1, 'the audit ran while the appender was running');
    assert.deepEqual(auditErrors, []);
    assert.deepEqual(spy.writes, []);
    assert.ok(spy.opens.every((o) => o.flags === 'r'));
    assert.deepEqual(statMap(frozen), frozenBefore, 'files nobody appended to are untouched');
    assert.equal(realPathNative(live).toLowerCase(), path.resolve(live).toLowerCase(), 'the temp tree is not virtualised');
  } finally { await rmRun(root); }
});

// ---------- wording, windows, CLI ----------

test('describeObservation never claims read-only or guaranteed no writes, in any branch', () => {
  const base = { files: [{}, {}], writes: [], unknownCommands: [{}], reads: [{}, {}], annotation: 'none' };
  const texts = [
    describeObservation(base),
    describeObservation({ ...base, writes: [{ path: 'a.md' }, { path: 'a.md' }, {}], annotation: 'tainted' }),
    describeObservation({ ...base, annotation: 'audit_failed' }),
  ];
  for (const t of texts) for (const w of FORBIDDEN_WORDING) assert.ok(!t.toLowerCase().includes(w), `${w} in ${t}`);
  assert.match(texts[0], /No writes observed/);
  assert.match(texts[0], /Not observed does not mean none occurred/);
  assert.match(texts[0], /recorded as unknown, not clean/);
  assert.match(texts[0], /tainted/);
  assert.match(texts[1], /Observed 3 write operation\(s\) within the turn window \(a\.md\)/);
  assert.match(texts[2], /audit_failed/);
});

test('every note produced from the fixtures avoids the forbidden wording', async () => {
  const notes = [];
  for (const w of [W1, W2, undefined]) notes.push((await auditAttempt({ kind: 'codex', files: CODEX_FILES, turnWindow: w })).note);
  notes.push((await auditAttempt({ kind: 'codex', files: [path.join(CLAUDE_FIX, `${S1}.jsonl`)] })).note);
  for (const n of notes) for (const w of FORBIDDEN_WORDING) assert.ok(!n.toLowerCase().includes(w), `${w} in ${n}`);
});

test('turnWindowFor: packet_issued to the first terminal event of the same attempt, else now', () => {
  const ev = [
    { seq: 1, ts: '2026-10-01T10:00:00.000Z', type: 'packet_issued', attemptId: 'a1', packetId: 'p1' },
    { seq: 2, ts: '2026-10-01T10:01:00.000Z', type: 'submission_accepted', attemptId: 'other' },
    { seq: 3, ts: '2026-10-01T10:02:00.000Z', type: 'submission_rejected', attemptId: 'a1' },
    { seq: 4, ts: '2026-10-01T10:05:00.000Z', type: 'submission_accepted', attemptId: 'a1' },
    { seq: 5, ts: '2026-10-01T10:06:00.000Z', type: 'packet_issued', attemptId: 'a2' },
    { seq: 6, ts: '2026-10-01T10:07:00.000Z', type: 'attempt_expired', attemptId: 'a2' },
    { seq: 7, ts: '2026-10-01T10:08:00.000Z', type: 'packet_issued', attemptId: 'a3' },
  ];
  assert.deepEqual(turnWindowFor(ev, 'a1'), { fromTs: '2026-10-01T10:00:00.000Z', toTs: '2026-10-01T10:05:00.000Z' });
  assert.deepEqual(turnWindowFor(ev, 'a2'), { fromTs: '2026-10-01T10:06:00.000Z', toTs: '2026-10-01T10:07:00.000Z' });
  assert.deepEqual(turnWindowFor(ev, 'a3', () => 'NOW'), { fromTs: '2026-10-01T10:08:00.000Z', toTs: 'NOW' });
  assert.equal(turnWindowFor(ev, 'nope'), null);
});

test('encodeClaudeProjectDir replaces every non-alphanumeric character; claudeHome follows CLAUDE_CONFIG_DIR', async () => {
  const enc = encodeClaudeProjectDir(path.join(path.parse(process.cwd()).root, 'Codex', 'a b.c'));
  assert.match(enc, /Codex-a-b-c$/);
  assert.ok(/^[A-Za-z0-9-]+$/.test(enc));
  if (process.platform === 'win32') assert.equal(encodeClaudeProjectDir('D:\\Work'), 'D--Work');
  await withEnv({ CLAUDE_CONFIG_DIR: path.join(FIX, 'cfg') }, () => assert.equal(claudeHome(), path.join(FIX, 'cfg')));
});

test('cmdAudit prints delivery and observation per packet for a registered seat (run as a child process)', async () => {
  const { root, guard } = tempRun();
  try {
    const roomDir = path.join(root, 'room');
    const seatDir = path.join(roomDir, 'seats', 'A');
    guard.mkdir(seatDir);
    guard.writeFile(path.join(seatDir, 'seat.json'), JSON.stringify({
      seatId: 'A', roomDir, createdAt: '2026-10-01T09:59:00.000Z', audit: { kind: 'codex', threadId: PARENT, cwd: 'E:\\fixture\\reviewer-A' },
    }));
    const events = [
      { seq: 1, ts: W1.fromTs, type: 'packet_issued', seatId: 'A', attemptId: 'a1-1-aa11bb', packetId: P1, path: pkOs(P1) },
      { seq: 2, ts: W1.toTs, type: 'submission_accepted', seatId: 'A', attemptId: 'a1-1-aa11bb' },
      { seq: 3, ts: W2.fromTs, type: 'packet_issued', seatId: 'A', attemptId: 'a1-2-cc22dd', packetId: P2, path: pkOs(P2) },
      { seq: 4, ts: W2.toTs, type: 'submission_accepted', seatId: 'A', attemptId: 'a1-2-cc22dd' },
    ];
    guard.writeFile(path.join(roomDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const auditUrl = pathToFileURL(path.join(ROOT, 'lib', 'audit.mjs')).href;
    const run = (seat) => spawnClean(NODE, ['--input-type=module', '-e',
      'const [u, s] = process.argv.slice(1); const m = await import(u); await m.cmdAudit({ seat: s, verbose: true });', auditUrl, seat],
    { env: { CODEX_HOME: CODEX_FIX }, timeoutMs: 30_000 });
    const r = await run(seatDir);
    assert.equal(r.code, 0, r.stderr);
    const outText = r.stdout;
    assert.match(outText, /^AUDIT seat=A kind=codex codex thread 01a0f000-0000-7000-8000-00000000a001 \+3 child thread\(s\)/m);
    assert.match(outText, /^registered_files=4 /m);
    assert.match(outText, new RegExp(`^PACKET ${P1} -> present_in_native`, 'm'));
    assert.match(outText, new RegExp(`^PACKET ${P2} -> header_only`, 'm'));
    assert.match(outText, /^OBSERVED attempt=a1-1-aa11bb status=present_in_native writes=0 unknown=2 reads=4 tainted=true annotation=tainted$/m);
    assert.match(outText, /^OBSERVED attempt=a1-2-cc22dd status=header_only writes=5 unknown=0 reads=2 tainted=true annotation=tainted$/m);
    assert.match(outText, /inherited_skipped=5/);
    for (const w of FORBIDDEN_WORDING) assert.ok(!outText.toLowerCase().includes(w));

    const bare = path.join(roomDir, 'seats', 'C');
    guard.mkdir(bare);
    guard.writeFile(path.join(bare, 'seat.json'), JSON.stringify({ seatId: 'C', roomDir, createdAt: W1.fromTs, audit: null }));
    const u = await run(bare);
    assert.equal(u.code, 0);
    assert.match(u.stdout, /^UNAUDITED seat C/);
  } finally { await rmRun(root); }
});

test('cmdAudit is exported for room.mjs', () => { assert.equal(typeof cmdAudit, 'function'); });
