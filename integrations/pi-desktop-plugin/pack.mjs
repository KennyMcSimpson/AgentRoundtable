#!/usr/bin/env node
// Packs a built plugin folder with the UPSTREAM marketplace scripts and audits the result.
//
//   node integrations/pi-desktop-plugin/pack.mjs --upstream <pi-desktop-plugins clone> --python <python.exe>
//                                               [--plugin <built plugin folder>] [--work <dir>]
//
// pack_plugin.py and security_audit.py only accept plugin folders below <their repo>/plugins/ and
// write <their repo>/packages/<id>-<version>.piplug, so they are not run inside the clone (that
// would modify it). Instead both scripts are copied byte for byte (sha256 printed) into
//   <work>/scripts/, the built plugin into <work>/plugins/<id>/,
// and run there unchanged:
//   python -B scripts/pack_plugin.py plugins/<id>
//   python -B scripts/security_audit.py plugins/<id>                    (source audit)
//   python -B scripts/security_audit.py plugins/<id> --check-packages   (adds the packed .piplug
//                                                     audit and the byte-for-byte package/source comparison)
// Default --plugin: dist/out/pi-desktop-plugin/<id>; default --work: dist/out/pi-desktop-plugin-pack.
// Exit 0 only when every run exits 0. Nothing is installed or downloaded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './build.mjs';

function arg(name) { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function fail(msg) { console.error(`ERROR ${msg}`); process.exit(2); }

const upstream = arg('--upstream');
const python = arg('--python') || process.env.ROOM_PYTHON;
if (!upstream) fail('--upstream <pi-desktop-plugins clone> is required');
if (!python) fail('--python <python.exe> (or ROOM_PYTHON) is required; nothing is installed for you');
if (/[\\/]WindowsApps[\\/]/i.test(python)) fail(`${python} is the Microsoft Store alias, not an interpreter`);
if (!fs.existsSync(python)) fail(`python not found: ${python}`);
const manifestSrc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'pi-desktop-plugin', 'plugin', 'manifest.json'), 'utf8'));
const id = manifestSrc.id;
const pluginDir = path.resolve(arg('--plugin') || path.join(REPO_ROOT, 'dist', 'out', 'pi-desktop-plugin', id));
const work = path.resolve(arg('--work') || path.join(REPO_ROOT, 'dist', 'out', 'pi-desktop-plugin-pack'));
const built = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
if (built.id !== id) fail(`${pluginDir} holds ${built.id}, not ${id}`);

// Fresh work folder; only one this script made before is replaced.
if (fs.existsSync(work)) {
  if (!fs.existsSync(path.join(work, 'PACK-WORK'))) fail(`refusing to replace ${work}: not a pack work folder`);
  fs.rmSync(work, { recursive: true, force: true });
}
fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(work, 'PACK-WORK'), 'scratch folder of integrations/pi-desktop-plugin/pack.mjs\n');
const head = spawnSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
console.log(`upstream ${path.resolve(upstream)} HEAD=${(head.stdout || '').trim() || 'unknown'}`);
for (const s of ['pack_plugin.py', 'security_audit.py']) {
  const buf = fs.readFileSync(path.join(upstream, 'scripts', s));
  fs.writeFileSync(path.join(work, 'scripts', s), buf);
  console.log(`copied scripts/${s} sha256=${sha256(buf)} bytes=${buf.length}`);
}
fs.cpSync(pluginDir, path.join(work, 'plugins', id), { recursive: true });

let worst = 0;
function run(args) {
  const r = spawnSync(python, ['-B', ...args], { cwd: work, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  console.log(`\n$ python -B ${args.join(' ')}  -> exit ${r.status}`);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(r.stderr);
  if (r.status !== 0) worst = Math.max(worst, r.status || 1);
  return r;
}
const plugin = `plugins/${id}`;
run(['scripts/pack_plugin.py', plugin]);
run(['scripts/security_audit.py', plugin]);
run(['scripts/security_audit.py', plugin, '--check-packages']);
const pkg = path.join(work, 'packages', `${id}-${built.version}.piplug`);
if (fs.existsSync(pkg)) console.log(`\nPACKAGE ${pkg} bytes=${fs.statSync(pkg).size} sha256=${sha256(fs.readFileSync(pkg))}`);
process.exitCode = worst;
