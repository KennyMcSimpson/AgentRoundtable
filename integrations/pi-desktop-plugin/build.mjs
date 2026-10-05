#!/usr/bin/env node
// Builds the PI-Desktop plugin folder from this repository.
//
//   node integrations/pi-desktop-plugin/build.mjs [--out <dir>] [--source head|worktree]
//
// Output (default dist/out/pi-desktop-plugin/<plugin id>/, which .gitignore keeps out of git):
//   manifest.json, main.js, core.mjs, renderer/**     from integrations/pi-desktop-plugin/plugin/
//   README.md, README.zh-CN.md                        from integrations/pi-desktop-plugin/
//   room-dev/room.mjs, room-dev/lib/**, room-dev/ui/** the vendored engine (ui/fixtures and
//                                                     ui/mock-server.mjs left out, as dist/build-app.mjs does)
//   room-dev/LICENSE                                  room-dev's MIT licence
//   room-dev/VENDORED.json                            {roomDevCommit, source, dirtyAtBuild, files[{path, bytes, sha256}]}
//
// --source head (default) takes every file from the commit HEAD points at, byte for byte as
// committed (git cat-file), so the folder is reproducible from the recorded commit whatever the
// working tree holds; files that differ in the working tree are listed in dirtyAtBuild.
// --source worktree copies the working tree (tracked and untracked, not ignored) instead; the
// plugin's own tests use it so they exercise uncommitted changes.
// Nothing is downloaded and nothing outside --out is written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_SRC = 'integrations/pi-desktop-plugin/plugin';
const DOCS = ['integrations/pi-desktop-plugin/README.md', 'integrations/pi-desktop-plugin/README.zh-CN.md'];
const ENGINE = ['room.mjs', 'lib', 'ui', 'LICENSE'];
const ENGINE_SKIP = (rel) => rel.startsWith('ui/fixtures/') || rel === 'ui/mock-server.mjs';

function git(args, { repo = REPO_ROOT, input, encoding = 'utf8' } = {}) {
  // encoding 'buffer' means raw bytes: spawnSync takes that as no encoding at all.
  const r = spawnSync('git', ['-C', repo, ...args], { input, ...(encoding === 'buffer' ? {} : { encoding }), windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw Object.assign(new Error(`git not runnable: ${r.error.code || r.error.message}`), { code: 'NO_GIT' });
  if (r.status !== 0) throw Object.assign(new Error(`git ${args[0]} failed: ${String(r.stderr || '').trim()}`), { code: 'GIT_FAILED' });
  return r.stdout;
}

function listFiles(source, pathspecs, repo) {
  const args = source === 'head'
    ? ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...pathspecs]
    : ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs];
  const names = [...new Set(git(args, { repo }).split('\0').filter(Boolean))].sort();
  // A tracked file deleted in the working tree is not part of the working tree.
  return source === 'head' ? names : names.filter((p) => fs.existsSync(path.join(repo, p)));
}

// Committed bytes of many files in one git process: `git cat-file --batch` answers
// "<sha> blob <size>\n<bytes>\n" per requested HEAD:<path>.
function headBlobs(paths, repo) {
  if (!paths.length) return new Map();
  const outBuf = git(['cat-file', '--batch'], { repo, input: paths.map((p) => `HEAD:${p}`).join('\n') + '\n', encoding: 'buffer' });
  const res = new Map();
  let off = 0;
  for (const p of paths) {
    const nl = outBuf.indexOf(0x0a, off);
    const header = outBuf.subarray(off, nl).toString('utf8');
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!m) throw Object.assign(new Error(`git cat-file: unexpected answer for ${p}: ${header}`), { code: 'GIT_FAILED' });
    const size = Number(m[2]);
    res.set(p, outBuf.subarray(nl + 1, nl + 1 + size));
    off = nl + 1 + size + 1;
  }
  return res;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

export async function buildPlugin({ out, source = 'head', repo = REPO_ROOT, log = () => {} } = {}) {
  if (!['head', 'worktree'].includes(source)) throw Object.assign(new Error('--source head|worktree'), { code: 'BAD_ARGS' });
  const manifestRel = `${PLUGIN_SRC}/manifest.json`;
  const pluginFiles = listFiles(source, [PLUGIN_SRC], repo);
  if (!pluginFiles.includes(manifestRel)) throw Object.assign(new Error(`${manifestRel} is not in the ${source === 'head' ? 'HEAD commit' : 'working tree'}`), { code: 'NO_PLUGIN_SOURCE' });
  const docFiles = listFiles(source, DOCS, repo);
  const engineFiles = listFiles(source, ENGINE, repo).filter((p) => !ENGINE_SKIP(p));
  const all = [...pluginFiles, ...docFiles, ...engineFiles];
  let bytesOf;
  if (source === 'head') {
    const blobs = headBlobs(all, repo);
    bytesOf = (p) => blobs.get(p);
  } else {
    bytesOf = (p) => fs.readFileSync(path.join(repo, p));
  }
  const manifest = JSON.parse(bytesOf(manifestRel).toString('utf8'));
  const id = manifest.id;
  if (typeof id !== 'string' || !/^[a-z0-9]+(\.[a-z0-9_-]+)+$/.test(id)) throw Object.assign(new Error(`manifest id ${id} does not match PI-Desktop's PLUGIN_ID_PATTERN`), { code: 'BAD_MANIFEST' });
  const target = path.resolve(out || path.join(repo, 'dist', 'out', 'pi-desktop-plugin', id));

  // Replace only a folder this build made before (its manifest carries our id), never anything else.
  if (fs.existsSync(target)) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')); } catch { prev = null; }
    if (!prev || prev.id !== id) throw Object.assign(new Error(`refusing to replace ${target}: it is not an earlier build of ${id}`), { code: 'OUT_NOT_OURS' });
    await fs.promises.rm(target, { recursive: true, force: true });
    if (fs.existsSync(target)) throw Object.assign(new Error(`could not remove ${target}`), { code: 'RM_FAILED' });
  }

  const commit = git(['rev-parse', 'HEAD'], { repo }).trim();
  const dirtyAtBuild = git(['status', '--porcelain', '-z', '--', ...ENGINE, PLUGIN_SRC, ...DOCS], { repo })
    .split('\0').filter(Boolean).map((l) => l.slice(3)).filter((p) => p && !ENGINE_SKIP(p)).sort();

  const written = [];
  const put = (rel, buf) => {
    const dest = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    written.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
  };
  for (const p of pluginFiles) put(p.slice(PLUGIN_SRC.length + 1), bytesOf(p));
  for (const p of docFiles) put(path.posix.basename(p), bytesOf(p));
  const engine = [];
  for (const p of engineFiles) {
    const buf = bytesOf(p);
    put(`room-dev/${p}`, buf);
    engine.push({ path: p, bytes: buf.length, sha256: sha256(buf) });
  }
  const vendored = { roomDevCommit: commit, source, dirtyAtBuild: source === 'head' ? dirtyAtBuild : undefined, workingTreeChanges: source === 'worktree' ? dirtyAtBuild : undefined, builtAt: new Date().toISOString(), files: engine };
  put('room-dev/VENDORED.json', Buffer.from(`${JSON.stringify(vendored, null, 1)}\n`));
  log(`built ${id}@${manifest.version} from ${source === 'head' ? `commit ${commit}` : `the working tree at ${commit}`} -> ${target} (${written.length} files)`);
  return { out: target, id, version: manifest.version, roomDevCommit: commit, source, dirtyAtBuild, files: written };
}

function parseCli(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--source') o.source = argv[++i];
    else throw Object.assign(new Error(`unknown argument ${a}`), { code: 'BAD_ARGS' });
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const r = await buildPlugin({ ...parseCli(process.argv.slice(2)), log: (l) => console.log(l) });
    console.log(`BUILT ${r.out}`);
    console.log(`roomDevCommit=${r.roomDevCommit} source=${r.source} files=${r.files.length}${r.source === 'head' && r.dirtyAtBuild.length ? ` dirtyAtBuild=${r.dirtyAtBuild.length} (not included: ${r.dirtyAtBuild.join(', ')})` : ''}`);
  } catch (e) {
    console.error(`ERROR ${e.code || ''} ${e.message}`);
    process.exitCode = 1;
  }
}
