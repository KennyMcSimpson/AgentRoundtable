// node --test test/workspace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  declareArtifacts, recompute, snapshot, runInSnapshot, snapshotEnv, snapshotHome, checkCommand, snapshotArgProblem, SNAPSHOT_GIT_CONFIG,
  collectFiles, globToRegExp, compileExcludes, canonicalJson, manifestSha256, hashFile, toRel,
  WorkspaceError, MANIFEST_SCHEMA, DEFAULT_SIZE_CAP_BYTES, DEFAULT_EXCLUDED_DIRS, SNAPSHOT_META_DIR,
} from '../lib/workspace.mjs';
import { spawnClean, findOnPath } from '../lib/spawn.mjs';
import { createGuard } from '../lib/guard.mjs';
import { readJsonl, isInside, testRunsRoot, realPathNative } from '../lib/common.mjs';

const WIN = process.platform === 'win32';
const NODE = process.execPath;
const GIT = findOnPath('git');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Never under %LOCALAPPDATA%: from inside an MSIX-packaged app those writes are redirected into
// AppData\Local\Packages\<pkg>\LocalCache\..., and child processes (git) report the redirected path.
function tempRoot() {
  const dir = path.join(testRunsRoot(), crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
// Measured on Node v24.11.1 / Windows 11: fs.rmSync({recursive:true}) on a path that itself contains
// non-ASCII characters returns without error and removes nothing. fs.promises.rm does remove it, so
// tests that delete a Chinese-named directory use this and assert it is gone.
async function rmTree(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false, `failed to remove ${dir}`);
}
function write(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// A seat working directory with Chinese characters and spaces in its path, a fake .git, an outbox
// and node_modules (all of which must be excluded by default).
function makeSeatDir(root) {
  const cwd = path.join(root, '席位 工作目录 A');
  write(cwd, 'src/app.mjs', 'export const a = 1;\n');
  write(cwd, 'src/中文 文件.txt', '你好，世界\n');
  write(cwd, 'README.md', '# demo\n');
  write(cwd, 'build/out.log', 'log\n');
  write(cwd, '.git/index', 'fake-index');
  write(cwd, '.git/HEAD', 'ref: refs/heads/main\n');
  write(cwd, '.room-outbox/A/joined.json', '{}');
  write(cwd, 'node_modules/x/index.js', 'x');
  write(cwd, 'src/node_modules/y.js', 'y');
  return cwd;
}

// Records every call; never actually runs anything.
function fakeSpawn(reply = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const fn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const r = typeof reply === 'function' ? reply(file, args, opts) : reply;
    const stdout = Buffer.from(r.stdout || '', 'utf8');
    const stderr = Buffer.from(r.stderr || '', 'utf8');
    return { file, args, cwd: opts.cwd, pid: 1, code: r.code ?? 0, signal: null, stdout: stdout.toString(), stderr: stderr.toString(), raw: { stdout, stderr }, stdoutBytes: stdout.length, stderrBytes: stderr.length, truncated: false, timedOut: false, spawnError: r.spawnError || null, startedAt: new Date().toISOString(), durationMs: 1 };
  };
  fn.calls = calls;
  return fn;
}

// ---------- pure helpers ----------

test('globToRegExp: segment patterns match at any depth, anchored ones at the root, trailing slash is dir-only', () => {
  const m = (pat, p) => globToRegExp(pat).test(p);
  assert.equal(m('*.log', 'a/b.log'), true);
  assert.equal(m('*.log', 'b.log'), true);
  assert.equal(m('*.log', 'a/b.logx'), false);
  assert.equal(m('build/', 'build/'), true);
  assert.equal(m('build/', 'build'), false);
  assert.equal(m('build', 'x/build/out'), true);
  assert.equal(m('src/gen/**', 'src/gen/x.js'), true);
  assert.equal(m('src/gen/**', 'other/src/gen/x.js'), false);
  assert.equal(m('**/*.tmp', 'a/b/c.tmp'), true);
  assert.equal(m('**/*.tmp', 'c.tmp'), true);
  assert.equal(m('a?c', 'abc'), true);
  assert.equal(m('a?c', 'a/c'), false);
  assert.equal(m('.\\build\\', 'build/x'), true);
  assert.equal(m('file.(1)', 'file.(1)'), true);
  assert.equal(m('file.(1)', 'fileX(1)'), false);
  assert.throws(() => globToRegExp(''), WorkspaceError);
  assert.throws(() => globToRegExp('/'), WorkspaceError);
  assert.equal(compileExcludes(['*.log']).length, 1);
  assert.deepEqual(compileExcludes(undefined), []);
});

test('canonicalJson sorts keys recursively; manifestSha256 ignores sha256 and copyTorn', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } }), '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
  const m1 = { schema: MANIFEST_SCHEMA, baseline: 'none', files: [{ path: 'a', sha256: 'x', bytes: 1 }], bytes: 1, copyTorn: false, sha256: 'ignored' };
  const m2 = { sha256: 'other', copyTorn: true, bytes: 1, files: [{ bytes: 1, sha256: 'x', path: 'a' }], baseline: 'none', schema: MANIFEST_SCHEMA };
  assert.equal(manifestSha256(m1), manifestSha256(m2));
  assert.notEqual(manifestSha256(m1), manifestSha256({ ...m1, bytes: 2 }));
  assert.match(manifestSha256(m1), /^[0-9a-f]{64}$/);
});

test('hashFile streams sha256 and counts bytes; toRel uses forward slashes', async () => {
  const root = tempRoot();
  try {
    const abs = write(root, 'd/中文.txt', '你好');
    const r = await hashFile(abs);
    assert.equal(r.sha256, sha('你好'));
    assert.equal(r.bytes, Buffer.byteLength('你好'));
    assert.equal(toRel(root, abs), 'd/中文.txt');
    await assert.rejects(hashFile(path.join(root, 'nope')), (e) => e.code === 'ENOENT');
  } finally { rmrf(root); }
});

test('collectFiles walks read-only, sorts, applies default and custom excludes, never leaves cwd', () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const r = collectFiles({ cwd, paths: ['.'], exclude: ['*.log'] });
    assert.deepEqual(r.files.map((f) => f.path), ['README.md', 'src/app.mjs', 'src/中文 文件.txt']);
    const ex = Object.fromEntries(r.excluded.map((e) => [e.path, e.reason]));
    assert.equal(ex['.git/'], 'default');
    assert.equal(ex['.room-outbox/'], 'default');
    assert.equal(ex['node_modules/'], 'default');
    assert.equal(ex['src/node_modules/'], 'default');
    assert.equal(ex['build/out.log'], 'exclude');
    assert.deepEqual(DEFAULT_EXCLUDED_DIRS, ['.room-outbox', '.git', 'node_modules']);
    // a single file and a sub directory, overlapping declarations collapse
    const r2 = collectFiles({ cwd, paths: ['src', 'src/app.mjs', 'README.md'] });
    assert.deepEqual(r2.files.map((f) => f.path), ['README.md', 'src/app.mjs', 'src/中文 文件.txt']);
    assert.throws(() => collectFiles({ cwd, paths: ['..'] }), (e) => e.code === 'PATH_OUTSIDE_CWD');
    assert.throws(() => collectFiles({ cwd, paths: ['missing-dir'] }), (e) => e.code === 'PATH_MISSING');
    const r3 = collectFiles({ cwd, paths: ['missing-dir'], missingOk: true });
    assert.deepEqual(r3.files, []);
    assert.deepEqual(r3.missing, ['missing-dir']);
  } finally { rmrf(root); }
});

test('collectFiles does not follow symlinks (recorded as excluded)', async (t) => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'cwd');
    write(cwd, 'real.txt', 'r');
    write(root, 'outside/secret.txt', 's');
    try { fs.symlinkSync(path.join(root, 'outside'), path.join(cwd, 'link'), 'junction'); } catch (e) { t.skip(`cannot create symlink here: ${e.code}`); return; }
    const r = collectFiles({ cwd, paths: ['.'] });
    assert.deepEqual(r.files.map((f) => f.path), ['real.txt']);
    assert.ok(r.excluded.some((e) => e.path === 'link' && e.reason === 'symlink'));
  } finally { rmrf(root); }
});

// W5: a junction in an intermediate component of a declared path. Before the fix the lexical check
// passed and j/secret.txt was hashed and copied from outside the cwd.
test('collectFiles/snapshot never read through a junction in an intermediate component (W5, non-ASCII cwd)', async (t) => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, '席位 cwd 中文');
    write(cwd, 'ok.txt', 'inside');
    write(root, 'outside/secret.txt', 'outside-the-cwd');
    try { fs.symlinkSync(path.join(root, 'outside'), path.join(cwd, 'j'), 'junction'); } catch (e) { t.skip(`cannot create junction here: ${e.code}`); return; }
    const r = collectFiles({ cwd, paths: ['j/secret.txt', 'ok.txt'] });
    assert.deepEqual(r.files.map((f) => f.path), ['ok.txt']);
    assert.ok(r.excluded.some((e) => e.path === 'j/secret.txt' && e.reason === 'symlink'), JSON.stringify(r.excluded));
    const m = await declareArtifacts({ cwd, paths: ['j/secret.txt', 'ok.txt', 'j'] });
    assert.deepEqual(m.files.map((f) => f.path), ['ok.txt']);
    const dest = path.join(root, 'snap');
    const s = await snapshot(m, cwd, dest, { spawn: fakeSpawn(), gitExe: null });
    assert.equal(fs.existsSync(path.join(dest, 'j')), false);
    assert.deepEqual(s.refused, []);

    // TOCTOU: d/secret.txt is a real file at declaration time, then d is swapped for a junction to
    // a directory holding identical bytes. snapshot must refuse it, not copy the outside file.
    write(cwd, 'd/secret.txt', 'outside-the-cwd');
    const m2 = await declareArtifacts({ cwd, paths: ['d/secret.txt', 'ok.txt'] });
    assert.deepEqual(m2.files.map((f) => f.path), ['d/secret.txt', 'ok.txt']);
    await rmTree(path.join(cwd, 'd'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(cwd, 'd'), 'junction');
    const dest2 = path.join(root, 'snap2');
    const s2 = await snapshot(m2, cwd, dest2, { spawn: fakeSpawn(), gitExe: null });
    assert.deepEqual(s2.refused, [{ path: 'd/secret.txt', reason: 'symlink' }]);
    assert.equal(fs.existsSync(path.join(dest2, 'd', 'secret.txt')), false, 'the outside file was not copied');
    assert.deepEqual(s2.copied.map((c) => c.path), ['ok.txt']);
    assert.equal(s2.stale, true);
    assert.ok(s2.changed.some((c) => c.path === 'd/secret.txt' && c.to === null));
    // recompute inherits the check: the swapped path is gone from the walk -> stale
    const rc = await recompute(m2, cwd);
    assert.deepEqual(rc.changed.map((c) => [c.path, c.to]), [['d/secret.txt', null]]);
  } finally { await rmTree(root); }
});

// NI-1: a worktree/submodule `.git` is a FILE ("gitdir: ..."); excluded like the directory.
test('collectFiles excludes a .git pointer FILE at any depth, and .git inside a declared path', () => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'wt');
    write(cwd, 'a.txt', 'a');
    write(cwd, '.git', 'gitdir: C:/somewhere/.git/worktrees/wt\n');
    write(cwd, 'sub/.git', 'gitdir: ../.git/modules/sub\n');
    write(cwd, 'sub/b.txt', 'b');
    write(cwd, `${SNAPSHOT_META_DIR}/home/.gitconfig`, '[core]\n');
    const r = collectFiles({ cwd, paths: ['.'] });
    assert.deepEqual(r.files.map((f) => f.path), ['a.txt', 'sub/b.txt']);
    const ex = Object.fromEntries(r.excluded.map((e) => [e.path, e.reason]));
    assert.equal(ex['.git'], 'default');
    assert.equal(ex['sub/.git'], 'default');
    assert.equal(ex[`${SNAPSHOT_META_DIR}/`], 'reserved');
    const r2 = collectFiles({ cwd, paths: ['.git', 'sub/.git'] });
    assert.deepEqual(r2.files, []);
    write(root, 'repo/.git/config', '[core]\n');
    const r3 = collectFiles({ cwd: path.join(root, 'repo'), paths: ['.git/config', '.git'] });
    assert.deepEqual(r3.files, []);
    assert.ok(r3.excluded.some((e) => e.path === '.git/' && e.reason === 'default'));
  } finally { rmrf(root); }
});

test('snapshot refuses manifest entries under .git or the metadata dir, and removes a .git pointer before git init', async () => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'seat');
    write(cwd, 'a.txt', 'a');
    write(cwd, '.git', 'gitdir: C:/real/.git/worktrees/x\n');
    write(cwd, `${SNAPSHOT_META_DIR}/home/.gitconfig`, '[core]\n\tfsmonitor = evil\n');
    const m = await declareArtifacts({ cwd, paths: ['a.txt'] });
    // a foreign/hand-made manifest that lists what collectFiles would never list
    const forged = { ...m, files: [...m.files, { path: '.git', sha256: sha('gitdir: C:/real/.git/worktrees/x\n'), bytes: 1 }, { path: `${SNAPSHOT_META_DIR}/home/.gitconfig`, sha256: 'x', bytes: 1 }] };
    const dest = path.join(root, 'snap');
    write(dest, '.git', 'gitdir: C:/real/.git/worktrees/x\n'); // left over from an earlier run
    const spawn = fakeSpawn({ code: 0 });
    const s = await snapshot(forged, cwd, dest, { spawn, gitExe: path.join(root, 'git.exe'), overwrite: true });
    assert.deepEqual(s.refused.map((x) => [x.path, x.reason]), [['.git', 'reserved'], [`${SNAPSHOT_META_DIR}/home/.gitconfig`, 'reserved']]);
    assert.equal(s.git.removedPointer, true);
    assert.equal(fs.existsSync(path.join(dest, '.git')), false, 'pointer removed before git init ran');
    assert.equal(fs.existsSync(path.join(snapshotHome(dest), '.gitconfig')), false);
    assert.equal(spawn.calls.length, 1);
  } finally { rmrf(root); }
});

// W6: a .cmd/.bat shim cannot run without a shell; say so instead of a bare ENOENT.
test('checkCommand / runInSnapshot report a .cmd shim and an unknown command explicitly (W6)', { skip: !WIN }, async () => {
  const root = tempRoot();
  try {
    const bin = path.join(root, 'bin 目录');
    write(bin, 'fooshim.cmd', '@echo hi\r\n');
    write(bin, 'barshim.bat', '@echo hi\r\n');
    const c1 = checkCommand('fooshim', { env: { PATH: bin } });
    assert.equal(c1.ok, false);
    assert.equal(c1.code, 'BATCH_SHIM_UNSUPPORTED');
    assert.match(c1.message, /\.cmd\/\.bat/);
    assert.equal(checkCommand('barshim', { env: { PATH: bin } }).code, 'BATCH_SHIM_UNSUPPORTED');
    assert.equal(checkCommand(path.join(bin, 'fooshim.cmd')).code, 'BATCH_SHIM_UNSUPPORTED');
    assert.equal(checkCommand('fooshim.cmd', { env: { PATH: bin } }).code, 'BATCH_SHIM_UNSUPPORTED');
    assert.equal(checkCommand('no-such-program-7f3a', { env: { PATH: bin } }).code, 'COMMAND_NOT_FOUND');
    const node = checkCommand('node');
    assert.equal(node.ok, true);
    assert.equal(path.extname(node.file).toLowerCase(), '.exe');

    const dir = path.join(root, 'snap');
    fs.mkdirSync(dir, { recursive: true });
    const spawn = fakeSpawn();
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: ['fooshim', 'x'], extraEnv: { PATH: bin }, spawn }), (e) => e instanceof WorkspaceError && e.code === 'BATCH_SHIM_UNSUPPORTED');
    assert.equal(spawn.calls.length, 0, 'nothing spawned');
    if (findOnPath('npm', { exts: ['.cmd'] })) {
      await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: ['npm', '--version'] }), (e) => e.code === 'BATCH_SHIM_UNSUPPORTED');
    }
  } finally { rmrf(root); }
});

// NI-11 second layer: whatever approved the command, runInSnapshot refuses arguments that point
// outside the copy, and git options that write elsewhere or switch repository / program.
test('snapshotArgProblem / runInSnapshot refuse arguments pointing outside the snapshot (NI-11 second layer)', async () => {
  const bad = [
    ['git', 'diff', '--output=C:/Users/x/out.txt'],
    ['git', 'diff', '--outp=out.txt'], // git takes unambiguous abbreviations
    ['git', 'diff', '--no-index', 'a', 'b'],
    ['git', 'diff', '--git-dir=x'],
    ['git', '-c', 'core.pager=evil', 'diff'],
    ['git', '-C', 'elsewhere', 'diff'],
    ['git', '--exec-path=x', 'diff'],
    ['git', 'diff', '--', '../secret.txt'],
    ['git', 'diff', '\\\\server\\share\\x'],
    ['git', 'diff', '/etc/passwd'],
    ['git', 'diff', 'D:\\elsewhere'],
    ['node', 'C:\\Users\\x\\evil.mjs'],
    ['node', 'sub/../../x.mjs'],
    ['git', 'format-patch', '-o../out'],
    ['git', 'diff', 'a\0b'],
  ];
  for (const argv of bad) assert.ok(snapshotArgProblem(argv), `refused: ${JSON.stringify(argv)}`);
  const good = [
    ['git', 'diff'], ['git', 'diff', '--stat'], ['git', 'diff', '--name-only', 'src/app.mjs'], ['git', 'status', '--short'],
    ['node', '--test'], ['node', '--test', 'test/x.test.mjs'], ['node', 'cli.mjs', '--help'], ['git', 'log', '--format=%H %s'],
  ];
  for (const argv of good) assert.equal(snapshotArgProblem(argv), null, `allowed: ${JSON.stringify(argv)}`);
  const root = tempRoot();
  try {
    const dir = path.join(root, 'snap');
    fs.mkdirSync(dir, { recursive: true });
    const spawn = fakeSpawn();
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: ['git', 'diff', '--output=../leak.txt'], spawn }), (e) => e instanceof WorkspaceError && e.code === 'ARG_NOT_ALLOWED' && /参数不被允许/.test(e.message));
    assert.equal(spawn.calls.length, 0, 'nothing spawned');
  } finally { rmrf(root); }
});

// ---------- declareArtifacts ----------

test('declareArtifacts (#31 non-git dir, Chinese + spaces): manifest shape, hashes, excludes, identity', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['.'], exclude: ['build/'], seatId: 'A', now: () => '2026-10-01T00:00:00.000Z' });
    assert.equal(m.schema, MANIFEST_SCHEMA);
    assert.equal(m.seatId, 'A');
    assert.equal(m.baseline, 'none');
    assert.deepEqual(m.declaredPaths, ['.']);
    assert.deepEqual(m.excludePatterns, ['build/']);
    assert.deepEqual(m.files.map((f) => f.path), ['README.md', 'src/app.mjs', 'src/中文 文件.txt']);
    assert.equal(m.files[1].sha256, sha('export const a = 1;\n'));
    assert.equal(m.files[2].sha256, sha('你好，世界\n'));
    assert.equal(m.files[2].bytes, Buffer.byteLength('你好，世界\n'));
    assert.equal(m.bytes, m.files.reduce((n, f) => n + f.bytes, 0));
    assert.equal(m.fileCount, 3);
    assert.deepEqual(m.deleted, []);
    assert.equal(m.declaredAt, '2026-10-01T00:00:00.000Z');
    assert.equal(m.copyTorn, false);
    assert.equal(m.oversize, false);
    assert.equal(m.sizeCapBytes, DEFAULT_SIZE_CAP_BYTES);
    assert.equal(m.sha256, manifestSha256(m));
    assert.ok(m.excluded.some((e) => e.path === '.git/' && e.reason === 'default'));
    assert.ok(m.excluded.some((e) => e.path === '.room-outbox/' && e.reason === 'default'));
    assert.ok(m.excluded.some((e) => e.path === 'build/' && e.reason === 'exclude'));
    assert.ok(m.files.every((f) => !f.path.includes('\\') && !path.isAbsolute(f.path)));
    // the fake .git was only read: index untouched, no lock file
    assert.equal(fs.readFileSync(path.join(cwd, '.git', 'index'), 'utf8'), 'fake-index');
    assert.equal(fs.existsSync(path.join(cwd, '.git', 'index.lock')), false);
    // deterministic: same tree, same declaredAt -> same sha
    const again = await declareArtifacts({ cwd, paths: ['.'], exclude: ['build/'], seatId: 'A', now: () => '2026-10-01T00:00:00.000Z' });
    assert.equal(again.sha256, m.sha256);
    // whole baseline records the field
    const whole = await declareArtifacts({ cwd, paths: ['src'], baseline: 'whole' });
    assert.equal(whole.baseline, 'whole');
    assert.deepEqual(whole.declaredPaths, ['src']);
    assert.equal(whole.fileCount, 2);
    assert.equal('seatId' in whole, false);
  } finally { rmrf(root); }
});

test('declareArtifacts rejects bad input', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    await assert.rejects(declareArtifacts({ cwd, paths: [] }), (e) => e.code === 'NO_PATHS');
    await assert.rejects(declareArtifacts({ cwd }), (e) => e.code === 'NO_PATHS');
    await assert.rejects(declareArtifacts({ cwd, paths: [''] }), (e) => e.code === 'BAD_PATH');
    await assert.rejects(declareArtifacts({ paths: ['.'] }), (e) => e.code === 'NO_CWD');
    await assert.rejects(declareArtifacts({ cwd: path.join(root, 'nope'), paths: ['.'] }), (e) => e.code === 'CWD_MISSING');
    await assert.rejects(declareArtifacts({ cwd: path.join(cwd, 'README.md'), paths: ['.'] }), (e) => e.code === 'CWD_NOT_DIR');
    await assert.rejects(declareArtifacts({ cwd, paths: ['..'] }), (e) => e.code === 'PATH_OUTSIDE_CWD');
    await assert.rejects(declareArtifacts({ cwd, paths: ['absent'] }), (e) => e.code === 'PATH_MISSING');
    await assert.rejects(declareArtifacts({ cwd, paths: ['.'], baseline: 'bogus' }), (e) => e.code === 'BAD_BASELINE');
    await assert.rejects(declareArtifacts({ cwd, paths: ['.'], sizeCapBytes: -1 }), (e) => e.code === 'BAD_SIZE_CAP');
    await assert.rejects(declareArtifacts({ cwd, paths: ['.'], exclude: [''] }), (e) => e.code === 'BAD_GLOB');
  } finally { rmrf(root); }
});

test('declareArtifacts flags oversize (hash only, no copy) and snapshot refuses it', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['src'], sizeCapBytes: 5 });
    assert.equal(m.oversize, true);
    assert.equal(m.files.length, 2);
    await assert.rejects(snapshot(m, cwd, path.join(root, 'snap'), { spawn: fakeSpawn(), gitExe: null }), (e) => e.code === 'OVERSIZE');
  } finally { rmrf(root); }
});

test('declareArtifacts with a manifest baseline: added / modified / unchanged / deleted', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const base = await declareArtifacts({ cwd, paths: ['.'], exclude: ['build/'] });
    write(cwd, 'src/app.mjs', 'export const a = 2;\n');
    write(cwd, 'src/new.mjs', 'new\n');
    fs.unlinkSync(path.join(cwd, 'README.md'));
    const m = await declareArtifacts({ cwd, paths: ['.'], exclude: ['build/'], baseline: base });
    assert.equal(m.baseline, base.sha256);
    const st = Object.fromEntries(m.files.map((f) => [f.path, f.status]));
    assert.deepEqual(st, { 'src/app.mjs': 'modified', 'src/new.mjs': 'added', 'src/中文 文件.txt': 'unchanged' });
    assert.deepEqual(m.deleted, ['README.md']);
    assert.deepEqual(m.summary, { added: 1, modified: 1, unchanged: 1, deleted: 1 });
    assert.equal(m.sha256, manifestSha256(m));
    assert.notEqual(m.sha256, base.sha256);
  } finally { rmrf(root); }
});

// ---------- recompute ----------

test('recompute (#16a): unchanged tree is not stale; edits, additions and deletions are listed', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['src', 'README.md'] });
    const same = await recompute(m, cwd);
    assert.equal(same.stale, false);
    assert.deepEqual(same.changed, []);
    assert.equal(same.manifestSha, m.sha256);
    assert.match(same.recomputedAt, /^\d{4}-/);

    write(cwd, 'src/app.mjs', 'changed\n');
    write(cwd, 'src/extra.txt', 'extra\n');
    fs.unlinkSync(path.join(cwd, 'README.md'));
    const r = await recompute(m, cwd);
    assert.equal(r.stale, true);
    assert.deepEqual(r.changed, [
      { path: 'README.md', from: sha('# demo\n'), to: null },
      { path: 'src/app.mjs', from: sha('export const a = 1;\n'), to: sha('changed\n') },
      { path: 'src/extra.txt', from: null, to: sha('extra\n') },
    ]);
    // the manifest object itself is untouched by recompute
    assert.equal(m.sha256, manifestSha256(m));
    // a declared directory that vanished: everything deleted, no throw
    await rmTree(path.join(cwd, 'src'));
    const gone = await recompute(m, cwd);
    assert.equal(gone.stale, true);
    assert.ok(gone.changed.every((c) => c.to === null));
    assert.deepEqual(gone.changed.map((c) => c.path), ['README.md', 'src/app.mjs', 'src/中文 文件.txt']);
    await assert.rejects(recompute({}, cwd), (e) => e.code === 'BAD_MANIFEST');
  } finally { rmrf(root); }
});

test('recompute honours the manifest excludes (an excluded file changing is not stale)', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['.'], exclude: ['build/'] });
    write(cwd, 'build/out.log', 'changed log\n');
    write(cwd, 'build/other.log', 'x\n');
    write(cwd, '.room-outbox/A/last-attempt.json', '{}');
    const r = await recompute(m, cwd);
    assert.equal(r.stale, false);
  } finally { rmrf(root); }
});

// ---------- snapshot ----------

test('snapshot copies with pre/post hashes, isolates git, writes only inside destDir (#43, #50)', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['.'], exclude: ['build/'], seatId: 'A' });
    const dest = path.join(root, '快照 目录', m.sha256);
    const spawn = fakeSpawn({ code: 0 });
    const gitExe = path.join(root, 'fake-git.exe');
    const r = await snapshot(m, cwd, dest, { spawn, gitExe });
    assert.equal(r.destDir, dest);
    assert.equal(r.copyTorn, false);
    assert.deepEqual(r.torn, []);
    assert.deepEqual(r.missing, []);
    assert.equal(r.stale, false);
    assert.deepEqual(r.copied.map((c) => c.path), m.files.map((f) => f.path));
    for (const f of m.files) {
      const copy = path.join(dest, ...f.path.split('/'));
      assert.equal((await hashFile(copy)).sha256, f.sha256);
    }
    assert.equal(fs.existsSync(path.join(dest, '.git', 'index')), false, 'the seat .git must not be copied');
    assert.equal(fs.existsSync(path.join(dest, 'build')), false);
    // git init ran exactly once, inside the copy, never with the seat directory as cwd
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].file, gitExe);
    assert.deepEqual(spawn.calls[0].args, ['init', '-q']);
    assert.equal(spawn.calls[0].opts.cwd, dest);
    assert.equal(spawn.calls[0].opts.env.HOME, snapshotHome(dest));
    assert.equal(spawn.calls[0].opts.env.GIT_DIR, path.join(dest, '.git'));
    assert.equal(spawn.calls[0].opts.env.GIT_CEILING_DIRECTORIES, path.dirname(dest).replace(/\\/g, '/'));
    assert.ok(spawn.calls.every((c) => !isInside(c.opts.cwd, cwd)));
    assert.equal(r.git.method, 'git-init');
    assert.equal(r.git.ok, true);
    // metadata and write-log
    assert.equal(r.manifest.copyTorn, false);
    assert.equal(r.manifest.sha256, m.sha256);
    const rec = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
    assert.equal(rec.manifest.sha256, m.sha256);
    assert.equal(rec.destDir, dest);
    const log = readJsonl(path.join(dest, SNAPSHOT_META_DIR, 'write-log.jsonl'));
    assert.ok(log.length >= m.files.length + 2);
    assert.ok(log.every((e) => isInside(e.path, dest)), 'every logged write is inside destDir');
    assert.ok(log.every((e) => !isInside(e.path, cwd)), 'no logged write touches the seat directory');
    assert.ok(log.every((e) => e.who === 'workspace'));
    // the seat directory is byte-for-byte what it was
    const after = await recompute(m, cwd);
    assert.equal(after.stale, false);
    assert.equal(fs.existsSync(path.join(cwd, '.git', 'index.lock')), false);
  } finally { rmrf(root); }
});

test('snapshot without git writes a GIT_CEILING_DIRECTORIES note instead', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['src'] });
    const dest = path.join(root, 'snap');
    const spawn = fakeSpawn();
    const r = await snapshot(m, cwd, dest, { spawn, gitExe: null });
    assert.equal(spawn.calls.length, 0);
    assert.equal(r.git.method, 'ceiling-note');
    assert.equal(r.git.ok, false);
    const note = fs.readFileSync(path.join(dest, SNAPSHOT_META_DIR, 'GIT_CEILING_DIRECTORIES.txt'), 'utf8');
    assert.ok(note.includes(`GIT_CEILING_DIRECTORIES=${path.dirname(dest).replace(/\\/g, '/')}`));
    // git init failing also falls back to the note
    const dest2 = path.join(root, 'snap2');
    const r2 = await snapshot(m, cwd, dest2, { spawn: fakeSpawn({ code: 128, stderr: 'fatal: nope' }), gitExe: 'git' });
    assert.equal(r2.git.method, 'git-init');
    assert.equal(r2.git.ok, false);
    assert.ok(fs.existsSync(path.join(dest2, SNAPSHOT_META_DIR, 'GIT_CEILING_DIRECTORIES.txt')));
    assert.match(r2.git.detail, /fatal: nope/);
  } finally { rmrf(root); }
});

test('snapshot detects a source changed or removed after declaration (stale) and a torn copy', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['src', 'README.md'] });
    write(cwd, 'src/app.mjs', 'edited after freeze\n');
    fs.unlinkSync(path.join(cwd, 'README.md'));
    const r = await snapshot(m, cwd, path.join(root, 'snap'), { spawn: fakeSpawn(), gitExe: null });
    assert.equal(r.stale, true);
    assert.deepEqual(r.missing, ['README.md']);
    assert.deepEqual(r.changed.map((c) => c.path), ['README.md', 'src/app.mjs']);
    assert.equal(r.changed[0].to, null);
    assert.equal(r.changed[1].to, sha('edited after freeze\n'));
    assert.equal(r.copyTorn, false);
    assert.deepEqual(r.copied.map((c) => c.path), ['src/app.mjs', 'src/中文 文件.txt']);

    // Torn copy: a guard whose copyFile writes something else than the source.
    const dest2 = path.join(root, 'snap-torn');
    const real = createGuard({ allowed: [dest2], logPath: path.join(dest2, SNAPSHOT_META_DIR, 'write-log.jsonl'), who: 'workspace' });
    const tornGuard = { ...real, copyFile(src, dst) { real.copyFile(src, dst); if (dst.endsWith('app.mjs')) real.writeFile(dst, 'torn!'); } };
    const r2 = await snapshot(m, cwd, dest2, { spawn: fakeSpawn(), gitExe: null, guard: tornGuard });
    assert.equal(r2.copyTorn, true);
    assert.deepEqual(r2.torn.map((t) => t.path), ['src/app.mjs']);
    assert.equal(r2.manifest.copyTorn, true);
    assert.equal(r2.manifest.sha256, m.sha256, 'copyTorn does not change the manifest identity');
  } finally { rmrf(root); }
});

test('snapshot refuses a destination overlapping the seat directory or a non-empty one', async () => {
  const root = tempRoot();
  try {
    const cwd = makeSeatDir(root);
    const m = await declareArtifacts({ cwd, paths: ['src'] });
    await assert.rejects(snapshot(m, cwd, path.join(cwd, 'snap'), { spawn: fakeSpawn(), gitExe: null }), (e) => e.code === 'DEST_OVERLAPS_CWD');
    await assert.rejects(snapshot(m, cwd, root, { spawn: fakeSpawn(), gitExe: null }), (e) => e.code === 'DEST_OVERLAPS_CWD');
    const dest = path.join(root, 'busy');
    write(dest, 'x.txt', 'x');
    await assert.rejects(snapshot(m, cwd, dest, { spawn: fakeSpawn(), gitExe: null }), (e) => e.code === 'DEST_NOT_EMPTY');
    const r = await snapshot(m, cwd, dest, { spawn: fakeSpawn(), gitExe: null, overwrite: true });
    assert.equal(r.copied.length, 2);
    await assert.rejects(snapshot({ files: 'x' }, cwd, path.join(root, 'z'), { spawn: fakeSpawn(), gitExe: null }), (e) => e.code === 'BAD_MANIFEST');
    // an injected guard rooted elsewhere cannot be used to write the snapshot
    const foreign = createGuard({ allowed: [path.join(root, 'elsewhere')], logPath: path.join(root, 'elsewhere', 'log.jsonl'), who: 't' });
    await assert.rejects(snapshot(m, cwd, path.join(root, 'z2'), { spawn: fakeSpawn(), gitExe: null, guard: foreign }), /refused mkdir outside allowed roots/);
  } finally { rmrf(root); }
});

// ---------- runInSnapshot ----------

test('snapshotEnv: TEMP/TMP in the snapshot, HOME in a room-owned empty dir, git confined (NI-1, NI-2)', () => {
  const dir = path.join(testRunsRoot(), 'x', 'snap');
  const home = path.join(path.resolve(dir), SNAPSHOT_META_DIR, 'home');
  const e = snapshotEnv(dir, {
    EXTRA: '1', HOME: 'C:\\evil', GIT_CONFIG_GLOBAL: 'C:\\evil\\.gitconfig', GIT_DIR: 'C:\\seat\\.git', git_config_count: '9',
    GIT_AUTHOR_NAME: 't',
  });
  assert.equal(snapshotHome(dir), home);
  assert.equal(e.HOME, home);
  assert.equal(e.USERPROFILE, home);
  assert.equal(e.XDG_CONFIG_HOME, home);
  assert.notEqual(e.HOME, path.resolve(dir), 'HOME is not the copy: a copied .gitconfig must not become global config');
  assert.equal(e.TEMP, path.resolve(dir));
  assert.equal(e.TMP, path.resolve(dir));
  assert.equal(e.GIT_CEILING_DIRECTORIES, path.dirname(path.resolve(dir)).replace(/\\/g, '/'));
  assert.equal(e.GIT_DIR, path.join(path.resolve(dir), '.git'));
  assert.equal(e.GIT_WORK_TREE, path.resolve(dir));
  assert.equal(e.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(e.GIT_CONFIG_GLOBAL, WIN ? 'NUL' : '/dev/null');
  assert.equal(e.GIT_CONFIG_COUNT, String(SNAPSHOT_GIT_CONFIG.length));
  const forced = Object.fromEntries(SNAPSHOT_GIT_CONFIG.map((_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(forced['core.fsmonitor'], 'false');
  assert.equal(forced['core.hooksPath'], WIN ? 'NUL' : '/dev/null');
  assert.equal(e.EXTRA, '1');
  assert.equal(e.GIT_AUTHOR_NAME, 't', 'author identity may be passed');
  assert.equal('git_config_count' in e, false, 'a caller cannot override the pinned git keys');
});

test('runInSnapshot passes the snapshot env to spawn and hashes the raw output', async () => {
  const root = tempRoot();
  try {
    const dir = path.join(root, '快照 目录');
    fs.mkdirSync(dir, { recursive: true });
    const spawn = fakeSpawn({ code: 2, stdout: 'OUT', stderr: 'ERR' });
    const r = await runInSnapshot({ snapshotDir: dir, argv: [NODE, '-v'], extraEnv: { ROOM_X: '1' }, timeoutMs: 1234, maxOutputBytes: 99, spawn });
    assert.equal(spawn.calls.length, 1);
    const c = spawn.calls[0];
    assert.equal(c.file, NODE);
    assert.deepEqual(c.args, ['-v']);
    assert.equal(c.opts.cwd, dir);
    assert.equal(c.opts.env.HOME, snapshotHome(dir));
    assert.equal(c.opts.env.USERPROFILE, snapshotHome(dir));
    assert.ok(fs.statSync(snapshotHome(dir)).isDirectory(), 'the empty HOME exists for the child');
    assert.equal(c.opts.env.TEMP, dir);
    assert.equal(c.opts.env.TMP, dir);
    assert.equal(c.opts.env.GIT_CEILING_DIRECTORIES, path.dirname(dir).replace(/\\/g, '/'));
    assert.equal(c.opts.env.ROOM_X, '1');
    assert.equal(c.opts.timeoutMs, 1234);
    assert.equal(c.opts.maxOutputBytes, 99);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, 'OUT');
    assert.equal(r.outputSha256, sha('OUTERR'));
    assert.equal(r.stdoutSha256, sha('OUT'));
    assert.equal(r.stderrSha256, sha('ERR'));
    assert.deepEqual(r.argv, [NODE, '-v']);
    assert.equal(r.resolvedFile, NODE);
    assert.equal(r.privatePath, null);
    // argv[0] without a path is resolved on PATH, never through a shell
    const r2 = await runInSnapshot({ snapshotDir: dir, argv: ['node', '-v'], spawn });
    assert.ok(path.isAbsolute(r2.resolvedFile));
    assert.equal(path.basename(r2.resolvedFile).toLowerCase(), path.basename(NODE).toLowerCase());
    // unknown program: a clear error before anything is spawned (not a bare ENOENT later)
    const before = spawn.calls.length;
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: ['no-such-program-7f3a'], spawn }), (e) => e instanceof WorkspaceError && e.code === 'COMMAND_NOT_FOUND');
    assert.equal(spawn.calls.length, before);
  } finally { rmrf(root); }
});

test('runInSnapshot validates input and writes raw output to private/ only through a guard', async () => {
  const root = tempRoot();
  try {
    const dir = path.join(root, 'snap');
    fs.mkdirSync(dir, { recursive: true });
    await assert.rejects(runInSnapshot({ argv: ['x'] }), (e) => e.code === 'NO_SNAPSHOT');
    await assert.rejects(runInSnapshot({ snapshotDir: path.join(root, 'nope'), argv: ['x'] }), (e) => e.code === 'SNAPSHOT_MISSING');
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: [] }), (e) => e.code === 'BAD_ARGV');
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: 'git diff' }), (e) => e.code === 'BAD_ARGV');
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: ['x'], privateDir: path.join(root, 'p') }), (e) => e.code === 'NO_GUARD');
    const roomDir = path.join(root, 'room');
    fs.mkdirSync(roomDir, { recursive: true });
    const guard = createGuard({ allowed: [roomDir], logPath: path.join(roomDir, 'write-log.jsonl'), who: 'service' });
    const privateDir = path.join(roomDir, 'private', 'att-1', 'disclose-1');
    const r = await runInSnapshot({ snapshotDir: dir, argv: [NODE, '-v'], spawn: fakeSpawn({ stdout: 'v1\n' }), privateDir, guard });
    assert.equal(r.privatePath, privateDir);
    assert.equal(fs.readFileSync(path.join(privateDir, 'stdout.bin'), 'utf8'), 'v1\n');
    assert.equal(fs.readFileSync(path.join(privateDir, 'stderr.bin'), 'utf8'), '');
    const rec = JSON.parse(fs.readFileSync(path.join(privateDir, 'result.json'), 'utf8'));
    assert.equal(rec.outputSha256, sha('v1\n'));
    assert.equal('raw' in rec, false);
    // a guard rooted elsewhere refuses
    await assert.rejects(runInSnapshot({ snapshotDir: dir, argv: [NODE, '-v'], spawn: fakeSpawn(), privateDir: path.join(root, 'outside'), guard }), /refused mkdir/);
  } finally { rmrf(root); }
});

test('runInSnapshot (real spawn): the child really sees HOME/TEMP in the snapshot and a Chinese cwd', async () => {
  const root = tempRoot();
  try {
    const dir = path.join(root, '快照 real');
    fs.mkdirSync(dir, { recursive: true });
    const r = await runInSnapshot({ snapshotDir: dir, argv: [NODE, '-e', 'console.log(JSON.stringify({cwd:process.cwd(),HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,TEMP:process.env.TEMP,TMP:process.env.TMP,C:process.env.GIT_CEILING_DIRECTORIES,tmpdir:require("os").tmpdir(),home:require("os").homedir()}))'] });
    assert.equal(r.code, 0, r.stderr);
    const seen = JSON.parse(r.stdout);
    assert.equal(realPathNative(seen.cwd), realPathNative(dir));
    assert.equal(seen.HOME, snapshotHome(dir));
    assert.equal(seen.USERPROFILE, snapshotHome(dir));
    assert.equal(seen.TEMP, dir);
    assert.equal(seen.TMP, dir);
    assert.equal(seen.C, path.dirname(dir).replace(/\\/g, '/'));
    assert.equal(path.resolve(seen.tmpdir), dir);
    assert.equal(path.resolve(seen.home), snapshotHome(dir));
    assert.ok(isInside(seen.home, dir), 'HOME is still inside the snapshot');
    assert.equal(r.outputSha256, sha(Buffer.concat([r.raw.stdout, r.raw.stderr])));
  } finally { rmrf(root); }
});

// ---------- real git (skipped when git is not on PATH) ----------

test('real git (#50): snapshot repo is independent; ceiling blocks upward discovery; seat repo untouched', { skip: !GIT }, async () => {
  const root = tempRoot();
  try {
    // an outer repository that contains everything, standing in for "the seat's real repo above"
    const outer = await spawnClean(GIT, ['init', '-q'], { cwd: root, env: snapshotEnv(root) });
    assert.equal(outer.code, 0, outer.stderr);
    const cwd = path.join(root, '席位 工作目录 A');
    write(cwd, 'src/app.mjs', 'export const a = 1;\n');
    write(cwd, 'src/中文 文件.txt', '你好\n');
    const seatGit = await spawnClean(GIT, ['init', '-q'], { cwd, env: snapshotEnv(cwd) });
    assert.equal(seatGit.code, 0, seatGit.stderr);
    const indexBefore = fs.existsSync(path.join(cwd, '.git', 'index')) ? fs.statSync(path.join(cwd, '.git', 'index')).mtimeMs : null;
    const headBefore = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8');

    const m = await declareArtifacts({ cwd, paths: ['.'] });
    assert.ok(m.excluded.some((e) => e.path === '.git/'));
    const dest = path.join(root, 'snapshots', 'A', m.sha256);
    const r = await snapshot(m, cwd, dest);
    assert.equal(r.git.method, 'git-init');
    assert.equal(r.git.ok, true, r.git.detail);
    assert.ok(fs.existsSync(path.join(dest, '.git')));
    assert.match(fs.readFileSync(path.join(dest, '.git', 'info', 'exclude'), 'utf8'), /\.room-snapshot\//);

    // inside the snapshot: git sees the snapshot as its own top level
    const top = await runInSnapshot({ snapshotDir: dest, argv: ['git', 'rev-parse', '--show-toplevel'] });
    assert.equal(top.code, 0, top.stderr);
    assert.equal(realPathNative(top.stdout.trim()), realPathNative(dest));
    const status = await runInSnapshot({ snapshotDir: dest, argv: ['git', 'status', '--porcelain'] });
    assert.equal(status.code, 0, status.stderr);
    assert.ok(!status.stdout.includes(SNAPSHOT_META_DIR), 'metadata dir is excluded from git status');
    assert.ok(status.stdout.includes('src/'));

    // a snapshot without its own repo: the ceiling stops discovery before the outer repo
    const dest2 = path.join(root, 'snapshots', 'A', 'no-git');
    await snapshot(m, cwd, dest2, { gitExe: null });
    const blocked = await runInSnapshot({ snapshotDir: dest2, argv: ['git', 'rev-parse', '--show-toplevel'] });
    assert.notEqual(blocked.code, 0, `expected discovery to fail, got ${blocked.stdout}`);
    assert.match(blocked.stderr, /not a git repository/i);
    // and the same command without the ceiling would have found the outer repo (proves the ceiling did the work)
    const unblocked = await spawnClean(GIT, ['rev-parse', '--show-toplevel'], { cwd: dest2, env: { HOME: dest2, USERPROFILE: dest2 } });
    assert.equal(unblocked.code, 0, unblocked.stderr);
    assert.equal(realPathNative(unblocked.stdout.trim()), realPathNative(root));

    // the seat's real repository was never touched by declare/recompute/snapshot
    const after = await recompute(m, cwd);
    assert.equal(after.stale, false);
    assert.equal(fs.existsSync(path.join(cwd, '.git', 'index.lock')), false);
    assert.equal(fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8'), headBefore);
    if (indexBefore !== null) assert.equal(fs.statSync(path.join(cwd, '.git', 'index')).mtimeMs, indexBefore);
    const seatStatus = await spawnClean(GIT, ['status', '--porcelain'], { cwd, env: snapshotEnv(cwd) });
    assert.equal(seatStatus.code, 0);
    assert.ok(!seatStatus.stdout.includes('.room-snapshot'));
  } finally { rmrf(root); }
});

// NI-1: the seat cwd is a real `git worktree`. Before the fix its `.git` pointer file was copied, and
// `git init` / `git status` in the snapshot rewrote the real repo's config and the worktree index.
test('real git (NI-1): a worktree seat — .git pointer excluded, real repo config and index untouched', { skip: !GIT }, async () => {
  const root = tempRoot();
  try {
    const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', HOME: root, USERPROFILE: root };
    const repo = path.join(root, 'repo');
    write(repo, 'a.txt', 'a\n');
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'c'], ['worktree', 'add', '-q', path.join(root, '席位 wt'), '-b', 'wt']]) {
      const r = await spawnClean(GIT, args, { cwd: repo, env: id });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    }
    const wt = path.join(root, '席位 wt');
    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'worktree .git is a pointer file');
    write(wt, 'b.txt', 'b\n');
    const configPath = path.join(repo, '.git', 'config');
    const wtIndex = path.join(repo, '.git', 'worktrees', '席位 wt', 'index');
    const wtIndexPath = fs.existsSync(wtIndex) ? wtIndex : path.join(repo, '.git', 'worktrees', fs.readdirSync(path.join(repo, '.git', 'worktrees'))[0], 'index');
    const mt = () => [fs.statSync(configPath).mtimeMs, fs.readFileSync(configPath, 'utf8'), fs.statSync(wtIndexPath).mtimeMs];
    const before = mt();

    const m = await declareArtifacts({ cwd: wt, paths: ['.'] });
    assert.deepEqual(m.files.map((f) => f.path), ['a.txt', 'b.txt']);
    assert.ok(m.excluded.some((e) => e.path === '.git' && e.reason === 'default'));
    const dest = path.join(root, 'snapshots', 'A', m.sha256);
    const s = await snapshot(m, wt, dest);
    assert.equal(s.git.ok, true, s.git.detail);
    assert.ok(fs.statSync(path.join(dest, '.git')).isDirectory());
    const gd = await runInSnapshot({ snapshotDir: dest, argv: ['git', 'rev-parse', '--absolute-git-dir'] });
    assert.equal(gd.code, 0, gd.stderr);
    assert.equal(realPathNative(gd.stdout.trim()), realPathNative(path.join(dest, '.git')));
    const st = await runInSnapshot({ snapshotDir: dest, argv: ['git', 'status', '--short'] });
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /a\.txt/);
    assert.deepEqual(mt(), before, 'real repo config and worktree index unchanged');
  } finally { await rmTree(root); }
});

// NI-2: a .gitconfig at the root of the seat cwd is copied into the snapshot. Before the fix HOME was
// the snapshot root, so it became git's global config and `git status` ran its core.fsmonitor.
test('real git (NI-2): a copied .gitconfig with core.fsmonitor runs nothing (marker never written)', { skip: !GIT }, async () => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, '席位 cwd');
    const marker = path.join(root, 'OUTSIDE-MARKER.txt');
    const hook = `echo pwned > '${marker.replace(/\\/g, '/')}'`;
    write(cwd, '.gitconfig', `[core]\n\tfsmonitor = "${hook}"\n\tpager = "${hook}"\n[diff]\n\texternal = "${hook}"\n`);
    write(cwd, '.config/git/config', `[core]\n\tfsmonitor = "${hook}"\n`);
    write(cwd, 'a.txt', 'a\n');
    const m = await declareArtifacts({ cwd, paths: ['.'] });
    assert.ok(m.files.some((f) => f.path === '.gitconfig'));
    const dest = path.join(root, 'snap');
    const s = await snapshot(m, cwd, dest);
    assert.equal(s.git.ok, true, s.git.detail);
    assert.ok(fs.existsSync(path.join(dest, '.gitconfig')), 'the file is in the copy, as data');
    for (const argv of [['git', 'status', '--short'], ['git', 'diff'], ['git', 'add', '-A'], ['git', 'diff', '--cached', '--stat']]) {
      const r = await runInSnapshot({ snapshotDir: dest, argv });
      assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    }
    assert.equal(fs.existsSync(marker), false, 'marker written outside the snapshot');
    assert.equal(fs.existsSync(path.join(dest, 'OUTSIDE-MARKER.txt')), false);
    // the snapshot repo is a normal non-bare repo with no core.worktree baked in
    const cfg = fs.readFileSync(path.join(dest, '.git', 'config'), 'utf8');
    assert.match(cfg, /bare = false/);
    assert.doesNotMatch(cfg, /worktree/);
  } finally { await rmTree(root); }
});

test('real git (#49): declare + recompute while the seat commits never collide on index.lock', { skip: !GIT }, async () => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'seat B');
    write(cwd, 'a.txt', '1\n');
    const env = snapshotEnv(cwd, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' });
    assert.equal((await spawnClean(GIT, ['init', '-q'], { cwd, env })).code, 0);
    let commits = 0;
    const committer = (async () => {
      for (let i = 0; i < 8; i++) {
        write(cwd, 'a.txt', `${i}\n`);
        const add = await spawnClean(GIT, ['add', '-A'], { cwd, env });
        const c = await spawnClean(GIT, ['commit', '-q', '-m', `c${i}`], { cwd, env });
        if (add.code !== 0 || c.code !== 0) throw new Error(`git failed: ${add.stderr}${c.stderr}`);
        commits++;
      }
    })();
    const roomSide = (async () => {
      for (let i = 0; i < 8; i++) {
        const m = await declareArtifacts({ cwd, paths: ['.'] });
        await recompute(m, cwd);
      }
    })();
    await Promise.all([committer, roomSide]);
    assert.equal(commits, 8);
    assert.equal(fs.existsSync(path.join(cwd, '.git', 'index.lock')), false);
  } finally { rmrf(root); }
});
