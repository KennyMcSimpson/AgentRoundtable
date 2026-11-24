#!/usr/bin/env node
// dist/build.mjs — produce the Windows x64 distribution zip (plan §11, INTERFACES §13).
//
//   node dist/build.mjs [--node-version 22.x.y] [--no-download] [--out <dir>] [--source <projectRoot>]
//
// Output: <out>/room-dev-<version>-win-x64.zip (+ a .sha256 sidecar) laid out as
//
//   room-dev-<version>-win-x64/
//     launch.cmd            launcher rendered from dist/launcher.cmd.template
//     THIRD-PARTY.md        third-party licence table (dist/THIRD-PARTY.md)
//     BUILD.json            build record: versions, inventory with sha256 of every entry
//     app/                  room.mjs, lib/, ui/, docs/ (without docs/internal/ or docs/assets/), README.md, LICENSE (if present), package.json
//     node/                 the official Node.js win-x64 runtime (node.exe, npm, LICENSE, ...)
//                           or node/PLACEHOLDER.txt when built with --no-download
//
// The Node runtime is downloaded from https://nodejs.org/dist/v<ver>/node-v<ver>-win-x64.zip, its
// sha256 is checked against the published SHASUMS256.txt for that version, and both files are cached
// under %USERPROFILE%\room-dev\cache (appRoot(); ~/.cache/room-dev elsewhere). Nothing is trusted from the cache
// without re-checking the hash. With --no-download the network is never touched and a placeholder is
// packed instead; the launcher then falls back to a node found on PATH.
//
// Zip reading and writing use only node:zlib (deflate-raw) and node:fs — no npm dependency. The
// writer is exported so dist/export.mjs can reuse it; the reader is used to unpack the Node zip and
// to self-verify the produced archive. ZIP64 is not implemented (neither archive needs it).
//
// This script is build tooling run by the maintainer, not part of the room service: it writes its
// cache and output directories directly, not through lib/guard.mjs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appRoot } from '../lib/common.mjs';

export const DEFAULT_NODE_VERSION = '22.12.0';
export const DEFAULT_PORT = 7380;
const NODE_DIST_BASE = 'https://nodejs.org/dist';

// The ZIP writer and reader live in lib/zip.mjs (the room export needs them too); re-exported here
// so existing importers of dist/build.mjs keep working.
import { crc32, normalizeEntryName, ZipWriter, readZip } from '../lib/zip.mjs';
export { crc32, normalizeEntryName, ZipWriter, readZip };

// ---------------------------------------------------------------------------------------------
// Source inventory
// ---------------------------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'test-runs']);

function walk(dir, rel = '') {
  const result = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) result.push(...walk(abs, r));
    else if (ent.isFile()) result.push({ rel: r, abs });
  }
  return result;
}

export function collectProjectFiles(root) {
  const files = [];
  const missing = [];
  for (const f of ['room.mjs', 'package.json', 'README.md']) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) files.push({ rel: f, abs });
    else missing.push(f);
  }
  const lic = path.join(root, 'LICENSE');
  if (fs.existsSync(lic)) files.push({ rel: 'LICENSE', abs: lic });
  for (const d of ['lib', 'ui', 'docs']) {
    const abs = path.join(root, d);
    // docs/internal/ holds machine-specific records; docs/assets/ holds screenshots/SVG assets: never packed.
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      files.push(...walk(abs, d).filter((f) => !f.rel.startsWith('docs/internal/') && !f.rel.startsWith('docs/assets/')));
    } else missing.push(`${d}/`);
  }
  return { files, missing };
}

// ---------------------------------------------------------------------------------------------
// Node runtime: download, verify against SHASUMS256.txt, cache
// ---------------------------------------------------------------------------------------------
export function cacheDir() {
  // Not under %LOCALAPPDATA%: from inside an MSIX-packaged app that path is redirected (INTERFACES §1).
  if (process.platform === 'win32' || process.env.ROOM_DEV_HOME) return path.join(appRoot(), 'cache');
  return path.join(os.homedir(), '.cache', 'room-dev');
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export function expectedSha256(shasumsText, fileName) {
  for (const line of shasumsText.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (m && m[2] === fileName) return m[1];
  }
  throw new Error(`${fileName} not found in SHASUMS256.txt`);
}

export async function obtainNodeZip({ nodeVersion, log = () => {} }) {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error(`--node-version must look like 22.12.0, got ${nodeVersion}`);
  const fileName = `node-v${nodeVersion}-win-x64.zip`;
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, fileName);
  const sumsPath = path.join(dir, `SHASUMS256-v${nodeVersion}.txt`);
  let sums;
  if (fs.existsSync(sumsPath)) {
    sums = fs.readFileSync(sumsPath, 'utf8');
  } else {
    const url = `${NODE_DIST_BASE}/v${nodeVersion}/SHASUMS256.txt`;
    log(`Downloading ${url}`);
    sums = (await fetchBuffer(url)).toString('utf8');
    fs.writeFileSync(sumsPath, sums);
  }
  const expected = expectedSha256(sums, fileName);
  let zipBuf = null;
  let source = 'cache';
  if (fs.existsSync(zipPath)) {
    zipBuf = fs.readFileSync(zipPath);
    if (crypto.createHash('sha256').update(zipBuf).digest('hex') !== expected) {
      log(`Cached ${fileName} hash mismatch; discarding and re-downloading`);
      fs.rmSync(zipPath, { force: true });
      zipBuf = null;
    }
  }
  if (!zipBuf) {
    const url = `${NODE_DIST_BASE}/v${nodeVersion}/${fileName}`;
    log(`Downloading ${url}`);
    zipBuf = await fetchBuffer(url);
    source = 'download';
    const got = crypto.createHash('sha256').update(zipBuf).digest('hex');
    if (got !== expected) throw new Error(`${fileName} sha256 mismatch: expected ${expected}, got ${got}`);
    fs.writeFileSync(zipPath, zipBuf);
  }
  return { zipBuf, sha256: expected, fileName, source, zipPath };
}

// ---------------------------------------------------------------------------------------------
// Launcher rendering
// ---------------------------------------------------------------------------------------------
export function renderTemplate(template, vars) {
  const text = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in vars)) throw new Error(`Template is missing variable ${key}`);
    return String(vars[key]);
  });
  const leftover = text.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`Template still has unrendered placeholder ${leftover[0]}`);
  // Batch files want CRLF and must not start with a BOM (cmd.exe would not recognise the first line).
  return text.replace(/\r?\n/g, '\r\n').replace(/^\uFEFF/, '');
}

// The rendered launcher starts the lobby and shows the rooms root where every other tool looks: defaultRoomsRoot()
// in lib/common.mjs, i.e. (ROOM_DEV_HOME or %USERPROFILE%\room-dev)\rooms. Any AppData variable is
// refused: from inside an MSIX-packaged parent those writes are redirected (INTERFACES §1).
export function checkLauncher(text) {
  const appData = text.match(/%(?:LOCALAPPDATA|APPDATA)%/i);
  if (appData) throw new Error(`Launcher references ${appData[0]}: rooms must not be placed under AppData (INTERFACES §1)`);
  if (!/^set "ROOMS=%USERPROFILE%\\room-dev\\rooms"\r?$/m.test(text)) throw new Error('Launcher rooms root is not %USERPROFILE%\\room-dev\\rooms');
  if (!/^if defined ROOM_DEV_HOME set "ROOMS=%ROOM_DEV_HOME%\\rooms"\r?$/m.test(text)) throw new Error('Launcher does not override rooms root with ROOM_DEV_HOME (must match appRoot())');
  // The launcher starts the lobby (room.mjs lobby --open), the page where rooms are created and opened.
  if (!/^"%NODE_EXE%" "%APP%" lobby --open\b/m.test(text)) throw new Error('Launcher does not start the AgentRoundtable lobby (room.mjs lobby --open)');
  // The runtime it uses (bundled or the PATH fallback) is checked for Node >= 22 before room.mjs runs.
  const probe = text.search(/^"%NODE_EXE%" -e "process\.exit\(Number\(process\.versions\.node\.split\('\.'\)\[0\]\) >= 22 \? 0 : 1\)"\r?$/m);
  const run = text.search(/^"%NODE_EXE%" "%APP%"/m);
  if (probe < 0 || probe > run) throw new Error('Launcher does not check the Node version (>= 22) before running room.mjs');
  return text;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------
export function parseBuildArgs(argv) {
  const opts = { nodeVersion: DEFAULT_NODE_VERSION, download: true, out: null, source: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--node-version') opts.nodeVersion = argv[++i];
    else if (a === '--no-download') opts.download = false;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

export async function build(opts = {}) {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(opts.source || path.join(distDir, '..'));
  const outDir = path.resolve(opts.out || path.join(distDir, 'out'));
  const nodeVersion = opts.nodeVersion || DEFAULT_NODE_VERSION;
  const log = opts.log || ((line) => process.stdout.write(`${line}\n`));
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(`Source root has no package.json: ${root}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version || '0.0.0';
  const top = `room-dev-${version}-win-x64`;
  const builtAt = new Date().toISOString();
  const zip = new ZipWriter({ level: 6 });
  const inventory = [];
  const addEntry = (name, data, extra = {}) => {
    const info = zip.add(name, data, extra);
    inventory.push({ path: info.name, bytes: info.bytes, sha256: crypto.createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')).digest('hex') });
    return info;
  };

  // 1. project files
  const { files, missing } = collectProjectFiles(root);
  for (const f of files) addEntry(`${top}/app/${f.rel}`, fs.readFileSync(f.abs));
  log(`Sources: ${files.length} files${missing.length ? `; missing ${missing.join(', ')} (skipped)` : ''}`);

  // 2. node runtime
  let nodeInfo;
  if (opts.download === false) {
    const note = [
      'Placeholder: this archive was built with --no-download and does not bundle a Node.js runtime.',
      'The launcher falls back to node on PATH (requires Node >= 22).',
      `Official archives use dist/build.mjs to download Node v${nodeVersion} win-x64, verify SHASUMS256.txt, and place it in this directory.`,
      '',
    ].join('\n');
    addEntry(`${top}/node/PLACEHOLDER.txt`, note);
    nodeInfo = { bundled: false, version: nodeVersion, sha256: null, files: 0 };
    log('Node runtime: not downloaded (--no-download); packed placeholder node/PLACEHOLDER.txt');
  } else {
    const got = await obtainNodeZip({ nodeVersion, log });
    const entries = readZip(got.zipBuf);
    const prefix = `node-v${nodeVersion}-win-x64/`;
    let n = 0;
    for (const e of entries) {
      if (e.isDir) continue;
      if (!e.crc32Ok) throw new Error(`CRC mismatch for ${e.name} in Node zip`);
      const rel = e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
      addEntry(`${top}/node/${rel}`, e.data);
      n++;
    }
    nodeInfo = { bundled: true, version: nodeVersion, sha256: got.sha256, files: n, source: got.source };
    log(`Node runtime: v${nodeVersion} (${got.source}, sha256=${got.sha256}), ${n} files`);
  }

  // 3. launcher
  const template = fs.readFileSync(path.join(distDir, 'launcher.cmd.template'), 'utf8');
  const launcher = renderTemplate(template, {
    VERSION: version,
    NODE_VERSION: nodeVersion,
    BUILD_DATE: builtAt.slice(0, 10),
    NODE_NOTE: nodeInfo.bundled ? `Bundled Node v${nodeVersion}` : 'Runtime not bundled in this archive',
    DEFAULT_PORT: DEFAULT_PORT,
  });
  checkLauncher(launcher);
  addEntry(`${top}/launch.cmd`, launcher);

  // 4. third-party table
  addEntry(`${top}/THIRD-PARTY.md`, fs.readFileSync(path.join(distDir, 'THIRD-PARTY.md')));

  // 5. build record (added last so it can list everything else)
  const record = { schema_version: 1, name: 'room-dev', version, builtAt, node: nodeInfo, platform: 'win-x64', missingSources: missing, files: inventory.slice() };
  addEntry(`${top}/BUILD.json`, JSON.stringify(record, null, 1));

  const bytes = zip.finish();
  // self-verify: every entry must read back with a matching CRC
  const back = readZip(bytes);
  const bad = back.filter((e) => !e.crc32Ok).map((e) => e.name);
  if (bad.length) throw new Error(`Self-verify failed, CRC mismatch: ${bad.join(', ')}`);
  if (back.length !== inventory.length) throw new Error(`Self-verify failed, entry count ${back.length} != ${inventory.length}`);

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${top}.zip`);
  fs.writeFileSync(zipPath, bytes);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(`${zipPath}.sha256`, `${sha}  ${top}.zip\n`);
  log(`BUILT zip=${zipPath.replace(/\\/g, '/')} entries=${back.length} bytes=${bytes.length} sha256=${sha} node=${nodeInfo.bundled ? 'bundled' : 'placeholder'}`);
  return { zipPath, sha256: sha, entries: back.length, bytes: bytes.length, version, node: nodeInfo, missing };
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  let opts;
  try { opts = parseBuildArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`ERROR ${e.message}\n`); process.exit(9); }
  if (opts.help) {
    process.stdout.write('Usage: node dist/build.mjs [--node-version 22.x.y] [--no-download] [--out <dir>] [--source <projectRoot>]\n');
    process.exit(0);
  }
  build(opts).catch((e) => { process.stderr.write(`ERROR ${e && e.stack ? e.stack : e}\n`); process.exit(9); });
}
