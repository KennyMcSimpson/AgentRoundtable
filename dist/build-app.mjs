#!/usr/bin/env node
// dist/build-app.mjs — build the AgentRoundtable desktop app (AgentRoundtable.exe) on a cached Electron runtime.
//
//   node dist/build-app.mjs [--electron-zip <path>] [--rcedit <path>] [--out <dir>] [--zip] [--dry-run]
//   (npm run app)
//
// Output: <out>\AgentRoundtable\ (default out = <repo>\dist\out)
//
//   AgentRoundtable\
//     AgentRoundtable.exe         electron.exe renamed; icon and version strings set with rcedit
//     LICENSE, LICENSES.chromium.html, ...   the Electron runtime as shipped (licences stay)
//     THIRD-PARTY.md              what is bundled and under which licence
//     BUILD.json                  electronVersion, nodeVersion, roomDevCommit, sha256 of every file
//     resources\app\              app/ (main.mjs, main-helpers.mjs, preload.cjs, icon.ico, package.json)
//     resources\app\room-dev\     room.mjs, package.json, README.md, LICENSE, docs/INTERFACES.md, lib/**, ui/**
//                                 (without ui/fixtures and ui/mock-server.mjs)
//   resources\default_app.asar is never extracted, so the exe can only run this app.
//
// Nothing is downloaded, ever. The Electron zip comes from --electron-zip, else ROOM_ELECTRON_ZIP,
// else the newest electron-v*-win32-x64.zip under %LOCALAPPDATA%\electron\Cache\*\ (where an earlier
// npm install of electron left it); without one the script stops with an error message. rcedit
// comes from --rcedit, else ROOM_RCEDIT, else the newest rcedit-x64.exe under
// %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*\. Those caches are only read.
//
// The new folder is assembled next to the old one and swapped in only when complete; with --zip it
// is also packed into <out>\AgentRoundtable-<version>-win-x64.zip (lib/zip.mjs). --dry-run locates
// the inputs and prints the file plan without writing anything.
//
// Build tooling run by the maintainer, not part of the room service: it writes its output directory
// directly, not through lib/guard.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZip, ZipWriter } from '../lib/zip.mjs';

export const APP_FOLDER = 'AgentRoundtable';
export const EXE_NAME = 'AgentRoundtable.exe';
// Electron's demo app: left out so the exe can only run resources\app.
export const DEFAULT_APP_ASAR = 'resources/default_app.asar';
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(DIST_DIR, '..');

export class BuildRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'BuildRefusal'; }
}

export const NO_ZIP_MESSAGE = [
  'No Electron runtime zip found (electron-v<version>-win32-x64.zip). This script never downloads anything.',
  'Provide a local zip using any of the following:',
  '  node dist/build-app.mjs --electron-zip <full path to zip>',
  '  or set environment variable ROOM_ELECTRON_ZIP=<full path to zip>',
  '  or place it under %LOCALAPPDATA%\\electron\\Cache\\<any folder>\\ (where npm install electron caches it).',
].join('\n');
export const NO_RCEDIT_MESSAGE = [
  `No rcedit-x64.exe found (used to set the icon and version strings on ${EXE_NAME}). This script never downloads anything.`,
  'Provide it with --rcedit <full path to rcedit-x64.exe> or environment variable ROOM_RCEDIT,',
  'or place it under %LOCALAPPDATA%\\electron-builder\\Cache\\winCodeSign\\<any folder>\\ (the electron-builder cache).',
].join('\n');

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------
export function parseBuildAppArgs(argv) {
  const o = { electronZip: null, rcedit: null, out: null, zip: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} requires a path argument`); return v; };
    if (a === '--electron-zip') o.electronZip = val();
    else if (a === '--rcedit') o.rcedit = val();
    else if (a === '--out') o.out = val();
    else if (a === '--zip') o.zip = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// Locating inputs (read-only)
// ---------------------------------------------------------------------------------------------
const ZIP_RE = /^electron-v(\d+)\.(\d+)\.(\d+)-win32-x64\.zip$/;

// path.win32.basename splits on both / and \, so a Windows path names its zip on every host OS.
export function electronVersionFromName(name) {
  const m = ZIP_RE.exec(path.win32.basename(String(name)));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function cmpVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; }
}
function fileStat(p) { try { const s = fs.statSync(p); return s.isFile() ? s : null; } catch { return null; } }

// {path, version, source: 'option'|'env'|'cache'} or null. An explicit path that does not exist is a
// refusal, not a fallback.
export function locateElectronZip({ option = null, env = process.env } = {}) {
  for (const [p, source] of [[option, 'option'], [env.ROOM_ELECTRON_ZIP, 'env']]) {
    if (!p) continue;
    if (!fileStat(p)) throw new BuildRefusal('ELECTRON_ZIP_MISSING', `Specified Electron zip does not exist: ${p}`);
    return { path: path.resolve(p), version: electronVersionFromName(p), source };
  }
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const found = [];
  for (const d of subdirs(path.join(local, 'electron', 'Cache'))) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { names = []; }
    for (const n of names) {
      const version = electronVersionFromName(n);
      const st = version ? fileStat(path.join(d, n)) : null;
      if (st) found.push({ path: path.join(d, n), version, mtimeMs: st.mtimeMs });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => cmpVersion(b.version, a.version) || b.mtimeMs - a.mtimeMs);
  return { path: found[0].path, version: found[0].version, source: 'cache' };
}

export function locateRcedit({ option = null, env = process.env } = {}) {
  for (const [p, source] of [[option, 'option'], [env.ROOM_RCEDIT, 'env']]) {
    if (!p) continue;
    if (!fileStat(p)) throw new BuildRefusal('RCEDIT_MISSING', `Specified rcedit does not exist: ${p}`);
    return { path: path.resolve(p), source };
  }
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const found = [];
  for (const d of subdirs(path.join(local, 'electron-builder', 'Cache', 'winCodeSign'))) {
    const p = path.join(d, 'rcedit-x64.exe');
    const st = fileStat(p);
    if (st) found.push({ path: p, mtimeMs: st.mtimeMs });
  }
  if (!found.length) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { path: found[0].path, source: 'cache' };
}

// ---------------------------------------------------------------------------------------------
// File plan
// ---------------------------------------------------------------------------------------------
function walk(dir, rel, skip) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.startsWith('.') || skip(r)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, r, skip));
    else if (e.isFile()) out.push({ rel: r, abs });
  }
  return out;
}

// Paths (relative to the repo root) that are not shipped inside the app.
export function runtimeExcluded(rel) {
  return rel === 'ui/fixtures' || rel.startsWith('ui/fixtures/') || rel === 'ui/mock-server.mjs' || rel === 'node_modules' || rel.includes('/node_modules');
}

// [{dest, abs, rel}] where dest is relative to the app folder (AgentRoundtable\).
export function planAppFiles(root = REPO_ROOT) {
  const plan = [];
  const missing = [];
  for (const f of walk(path.join(root, 'app'), '', () => false)) plan.push({ dest: `resources/app/${f.rel}`, abs: f.abs, rel: `app/${f.rel}` });
  for (const f of ['room.mjs', 'package.json', 'README.md', 'LICENSE', 'docs/INTERFACES.md']) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) plan.push({ dest: `resources/app/room-dev/${f}`, abs, rel: f });
    else missing.push(f);
  }
  for (const d of ['lib', 'ui']) {
    const files = walk(path.join(root, d), d, (r) => runtimeExcluded(r));
    if (!files.length) missing.push(`${d}/`);
    for (const f of files) plan.push({ dest: `resources/app/room-dev/${f.rel}`, abs: f.abs, rel: f.rel });
  }
  return { plan, missing };
}

// rcedit's fixed version fields need four numbers: 0.1.0-dev -> 0.1.0.0.
export function numericVersion(v) {
  const nums = String(v || '').split(/[^0-9]+/).filter(Boolean).slice(0, 4).map((x) => String(Number(x)));
  while (nums.length < 4) nums.push('0');
  return nums.join('.');
}

export function rceditArgs({ exe, icon, version }) {
  const num = numericVersion(version);
  return [
    exe,
    '--set-icon', icon,
    '--set-file-version', num,
    '--set-product-version', num,
    '--set-version-string', 'FileDescription', 'AgentRoundtable',
    '--set-version-string', 'ProductName', 'AgentRoundtable',
    '--set-version-string', 'CompanyName', 'KennyMcSimpson',
    '--set-version-string', 'OriginalFilename', EXE_NAME,
    '--set-version-string', 'InternalName', 'AgentRoundtable',
  ];
}

export function thirdPartyNotes({ electronVersion, nodeVersion }) {
  return [
    '# Third-Party Components (AgentRoundtable Desktop App)',
    '',
    `Every file in this folder outside \`resources/app/\` comes unmodified from the official Electron Windows x64 runtime zip (\`electron.exe\` is renamed to \`${EXE_NAME}\` with updated icon and version strings, and \`resources/default_app.asar\` is omitted).`,
    '',
    '| Component | Version | License | License Text |',
    '|---|---|---|---|',
    `| Electron | ${electronVersion || 'unknown'} | MIT | \`LICENSE\` |`,
    '| Chromium and its dependencies | bundled with Electron | Various (BSD, LGPL, MPL, etc.) | `LICENSES.chromium.html` |',
    `| Node.js (embedded in Electron) | ${nodeVersion || 'bundled with Electron'} | MIT and dependency licenses | \`LICENSES.chromium.html\` (Electron bundle) |`,
    '',
    '`resources/app/` contains AgentRoundtable source code (`app/` and `room-dev/`), MIT licensed (`resources/app/room-dev/LICENSE`), with zero runtime dependencies (Node built-in modules only).',
    '',
  ].join('\n');
}

// Sync removal is avoided: on Node 24.11 / Windows it can silently leave paths with non-ASCII
// characters in place without throwing. fs.promises.rm removes them; the result is checked so a
// leftover is reported instead of ignored.
export async function removeTree(p) {
  await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (fs.existsSync(p)) throw new Error(`Could not remove ${p}`);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function gitCommit(root) {
  try {
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (head.status !== 0) return null;
    const st = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return { commit: head.stdout.trim(), dirty: st.status === 0 ? st.stdout.trim().length > 0 : null };
  } catch { return null; }
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(abs, r));
    else if (e.isFile()) out.push({ rel: r, abs });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------
export async function buildApp(opts = {}) {
  const log = opts.log || ((line) => process.stdout.write(`${line}\n`));
  const env = opts.env || process.env;
  const root = path.resolve(opts.root || REPO_ROOT);
  const outDir = path.resolve(opts.out || path.join(root, 'dist', 'out'));
  const finalDir = path.join(outDir, APP_FOLDER);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version || '0.0.0';

  const zip = locateElectronZip({ option: opts.electronZip, env });
  if (!zip) throw new BuildRefusal('NO_ELECTRON_ZIP', NO_ZIP_MESSAGE);
  const rcedit = locateRcedit({ option: opts.rcedit, env });
  const { plan, missing } = planAppFiles(root);
  if (missing.length) throw new BuildRefusal('SOURCES_MISSING', `Missing source files: ${missing.join(', ')}`);
  if (!plan.some((p) => p.dest === 'resources/app/main.mjs') || !plan.some((p) => p.dest === 'resources/app/icon.ico')) throw new BuildRefusal('APP_MISSING', 'app/ is missing main.mjs or icon.ico (generate the icon with node dist/make-icon.mjs).');

  if (opts.dryRun) {
    log(`DRY-RUN electronZip=${zip.path.replace(/\\/g, '/')} version=${zip.version || '?'} source=${zip.source}`);
    log(`DRY-RUN rcedit=${rcedit ? rcedit.path.replace(/\\/g, '/') : '(not found)'} out=${finalDir.replace(/\\/g, '/')} files=${plan.length}`);
    return { dryRun: true, electronZip: zip, rcedit, out: finalDir, plan: plan.map(({ dest, rel }) => ({ dest, rel })), version };
  }
  if (!rcedit) throw new BuildRefusal('NO_RCEDIT', NO_RCEDIT_MESSAGE);
  if (process.platform !== 'win32') throw new BuildRefusal('NOT_WINDOWS', `${EXE_NAME} can only be built on Windows (rcedit is a Windows binary).`);

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = crypto.randomBytes(4).toString('hex');
  const stage = path.join(outDir, `.${APP_FOLDER}.building-${stamp}`);
  try {
    // 1. Electron runtime
    log(`Reading ${zip.path}`);
    const zipBuf = fs.readFileSync(zip.path);
    const zipSha = sha256(zipBuf);
    const entries = readZip(zipBuf);
    let electronVersion = zip.version;
    let n = 0;
    for (const e of entries) {
      if (e.isDir) continue;
      if (!e.crc32Ok) throw new Error(`CRC mismatch for ${e.name} in Electron zip`);
      const rel = e.name.replace(/\\/g, '/');
      if (rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) throw new Error(`Unsafe path in Electron zip: ${e.name}`);
      // Never written at all: deleting it right after writing was observed to leave it in place
      // (a freshly written file can still be held open by a scanner on Windows).
      if (rel.toLowerCase() === DEFAULT_APP_ASAR) continue;
      const dest = path.join(stage, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
      if (rel === 'version') electronVersion = e.data.toString('utf8').trim().replace(/^v/, '') || electronVersion;
      n++;
    }
    log(`Electron runtime ${electronVersion}: ${n} files`);
    const electronExe = path.join(stage, 'electron.exe');
    if (!fs.existsSync(electronExe)) throw new Error('electron.exe not found in Electron zip (not a win32-x64 runtime?)');
    const exe = path.join(stage, EXE_NAME);
    fs.renameSync(electronExe, exe);
    if (fs.existsSync(path.join(stage, ...DEFAULT_APP_ASAR.split('/')))) throw new Error('resources\\default_app.asar must not appear in the build');

    // 2. app + room-dev runtime
    for (const f of plan) {
      const dest = path.join(stage, ...f.dest.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (f.dest === 'resources/app/package.json') {
        const appPkg = JSON.parse(fs.readFileSync(f.abs, 'utf8'));
        appPkg.version = version;
        fs.writeFileSync(dest, `${JSON.stringify(appPkg, null, 2)}\n`);
      } else {
        fs.copyFileSync(f.abs, dest);
      }
    }
    log(`AgentRoundtable app files: ${plan.length}`);

    // 3. icon and version strings
    const args = rceditArgs({ exe, icon: path.join(stage, 'resources', 'app', 'icon.ico'), version });
    const rc = spawnSync(rcedit.path, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    if (rc.error || rc.status !== 0) throw new Error(`rcedit failed (${rc.error ? rc.error.message : `exit code ${rc.status}`}): ${String(rc.stderr || rc.stdout || '').trim().slice(0, 400)}`);
    log(`rcedit: wrote icon and version info to ${EXE_NAME} (${numericVersion(version)})`);

    // 4. Node version of the bundled runtime (the exe in Node mode prints it; writes nothing)
    let nodeVersion = null;
    const nv = spawnSync(exe, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
    if (nv.status === 0 && /^\d+\.\d+\.\d+/.test(String(nv.stdout).trim())) nodeVersion = String(nv.stdout).trim();

    // 5. notes and build record
    fs.writeFileSync(path.join(stage, 'THIRD-PARTY.md'), thirdPartyNotes({ electronVersion, nodeVersion }));
    const files = listFiles(stage).map((f) => { const buf = fs.readFileSync(f.abs); return { path: f.rel, bytes: buf.length, sha256: sha256(buf) }; });
    const record = {
      schema_version: 1,
      name: 'room-dev-app',
      productName: APP_FOLDER,
      version,
      builtAt: new Date().toISOString(),
      electronVersion,
      nodeVersion,
      roomDevCommit: gitCommit(root),
      electronZip: { name: path.basename(zip.path), sha256: zipSha },
      rcedit: path.basename(rcedit.path),
      files,
    };
    fs.writeFileSync(path.join(stage, 'BUILD.json'), `${JSON.stringify(record, null, 1)}\n`);

    // 6. swap in only now that the new folder is complete
    let old = null;
    if (fs.existsSync(finalDir)) {
      old = path.join(outDir, `.${APP_FOLDER}.old-${stamp}`);
      try { fs.renameSync(finalDir, old); } catch (e) {
        throw new Error(`Could not replace existing ${finalDir} (${e.code || e.message}): is AgentRoundtable still running? Close it and rebuild.`);
      }
    }
    try { fs.renameSync(stage, finalDir); } catch (e) {
      if (old) { try { fs.renameSync(old, finalDir); } catch { /* reported below */ } }
      throw new Error(`Could not move new ${finalDir} into place (${e.code || e.message}); previous build ${old ? 'restored' : 'did not exist'}.`);
    }
    if (old) await removeTree(old);
    log(`BUILT app=${path.join(finalDir, EXE_NAME).replace(/\\/g, '/')} files=${files.length + 1} electron=${electronVersion} node=${nodeVersion || '?'}`);

    let zipOut = null;
    if (opts.zip) {
      const zw = new ZipWriter({ level: 6 });
      for (const f of listFiles(finalDir)) zw.add(`${APP_FOLDER}/${f.rel}`, fs.readFileSync(f.abs));
      const bytes = zw.finish();
      zipOut = path.join(outDir, `${APP_FOLDER}-${version}-win-x64.zip`);
      fs.writeFileSync(zipOut, bytes);
      const zsha = sha256(bytes);
      fs.writeFileSync(`${zipOut}.sha256`, `${zsha}  ${path.basename(zipOut)}\n`);
      log(`ZIPPED ${zipOut.replace(/\\/g, '/')} bytes=${bytes.length} sha256=${zsha}`);
    }
    return { dir: finalDir, exe: path.join(finalDir, EXE_NAME), electronVersion, nodeVersion, files: files.length + 1, zip: zipOut, version };
  } finally {
    if (fs.existsSync(stage)) { try { await removeTree(stage); } catch (e) { log(`WARNING ${e.message}`); } }
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  let opts;
  try { opts = parseBuildAppArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`ERROR ${e.message}\n`); process.exit(9); }
  if (opts.help) {
    process.stdout.write('Usage: node dist/build-app.mjs [--electron-zip <zip>] [--rcedit <rcedit-x64.exe>] [--out <dir>] [--zip] [--dry-run]\n');
    process.exit(0);
  }
  buildApp(opts).then(() => { process.exitCode = 0; }, (e) => {
    if (e instanceof BuildRefusal) { process.stderr.write(`REFUSED ${e.code}\n${e.message}\n`); process.exitCode = 2; return; }
    process.stderr.write(`ERROR ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 9;
  });
}
