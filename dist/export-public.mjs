#!/usr/bin/env node
// dist/export-public.mjs — copy the publishable part of this repository into a folder and prove it
// carries no personal data.
//
//   node dist/export-public.mjs <outDir> [--replace] [--deny-file <file>] [--root <checkout>]
//
// --root exports another checkout instead of this repository (the tests use it on a temp copy).
//
// 1. Lists the files git tracks (the index, so staged files count) and leaves out docs/internal/**
//    (internal records: probe report, evidence snapshot, public scan) and dist/out/** (build output).
// 2. Copies each one byte for byte into <outDir>, then writes a fresh .gitignore there in place of the
//    tracked one (it also lists docs/internal/ and evidence/REPORT.md, so a repository started from
//    the copy keeps them out).
// 3. Scans every file under <outDir>, paths and text contents, with the rules of dist/public-scan.mjs
//    (plus the deny file: --deny-file, else ROOM_PUBLIC_SCAN_DENY). Any hit is listed as
//    `<path>:<line> [<rule>] <excerpt>` and the command exits 1. Content is never rewritten or
//    redacted: a hit is fixed in the repository and the export run again. The failed copy is left in
//    place for inspection.
//
// <outDir> must be empty or absent. --replace first deletes an existing <outDir>, but never one that
// holds a .git folder, the repository itself, or a folder around it. Inside the repository <outDir>
// must be under dist/out/ (ignored by git), so the copy never lands in the tracked tree.
//
// Exit codes: 0 exported and clean; 1 scan hits; 2 refused (outDir); 9 error.
//
// Maintainer tooling, not part of the room service: it writes <outDir> directly, not through
// lib/guard.mjs (like dist/build-app.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, isPublicPath, trackedFiles, scanFiles, listTree, readDenyFile, formatHits } from './public-scan.mjs';

export const PUBLIC_GITIGNORE = [
  'node_modules/',
  '*.tmp-*',
  '.room-outbox/',
  'dist/out/',
  '# evidence/collect.mjs output: holds the machine\'s absolute paths',
  'evidence/REPORT.md',
  '# internal records stay out of the public tree',
  'docs/internal/',
  '',
].join('\n');

export class ExportRefusal extends Error {}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function prepareOut(outDir, root, replace) {
  if (inside(root, outDir)) throw new ExportRefusal(`输出目录 ${outDir} 是仓库本身或包含仓库，拒绝。`);
  if (inside(outDir, root) && !inside(outDir, path.join(root, 'dist', 'out'))) {
    throw new ExportRefusal(`输出目录 ${outDir} 在仓库里但不在 dist/out/ 下：公开副本不能落进被跟踪的目录树。`);
  }
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) throw new ExportRefusal(`输出路径 ${outDir} 已存在且不是文件夹。`);
    if (fs.readdirSync(outDir).length) {
      if (!replace) throw new ExportRefusal(`输出目录 ${outDir} 不是空的；加 --replace 先删掉它（只删以前的导出，不删含 .git 的目录）。`);
      if (fs.existsSync(path.join(outDir, '.git'))) throw new ExportRefusal(`输出目录 ${outDir} 里有 .git，拒绝删除。`);
      await fs.promises.rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (fs.existsSync(outDir)) throw new Error(`没能删除 ${outDir}`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
}

// files: forward-slash paths relative to root (default: what git tracks there).
export async function exportPublic({ root = REPO_ROOT, outDir, files, deny = [], replace = false, log = () => {} } = {}) {
  if (!outDir) throw new ExportRefusal('缺少输出目录。');
  root = path.resolve(root);
  outDir = path.resolve(outDir);
  const listed = files || trackedFiles(root);
  const rels = listed.filter(isPublicPath).sort();
  const excluded = listed.length - rels.length;
  const missing = rels.filter((r) => !fs.existsSync(path.join(root, r)));
  if (missing.length) throw new Error(`这些被跟踪的文件在工作区里不存在（先提交或恢复）：${missing.join(', ')}`);
  await prepareOut(outDir, root, replace);
  let bytes = 0;
  for (const rel of rels) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
    bytes += fs.statSync(dest).size;
  }
  fs.writeFileSync(path.join(outDir, '.gitignore'), PUBLIC_GITIGNORE);
  log(`EXPORTED files=${rels.length} bytes=${bytes} excluded=${excluded} out=${outDir.replace(/\\/g, '/')}`);
  log('GITIGNORE fresh (replaces the tracked .gitignore in the copy)');
  const scan = scanFiles(outDir, listTree(outDir), { deny });
  for (const l of formatHits(scan.hits)) log(l);
  const tail = `files=${scan.files} text=${scan.text} binary=${scan.binary} deny_literals=${deny.length}`;
  log(scan.hits.length ? `PUBLIC_SCAN_FAIL hits=${scan.hits.length} ${tail}（副本留在原处供检查；内容没有被改写）` : `PUBLIC_SCAN_OK ${tail}`);
  return { ok: scan.hits.length === 0, outDir, files: rels.length, bytes, excluded, hits: scan.hits, scanned: scan.files, text: scan.text, binary: scan.binary };
}

export function parseArgs(argv) {
  const o = { positional: [], replace: false, denyFile: process.env.ROOM_PUBLIC_SCAN_DENY || null, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--replace') o.replace = true;
    else if (a === '--deny-file') { o.denyFile = argv[++i]; if (!o.denyFile) throw new Error('--deny-file 需要一个文件'); }
    else if (a === '--root') { o.root = argv[++i]; if (!o.root) throw new Error('--root 需要一个目录'); }
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error(`未知参数 ${a}`);
    else o.positional.push(a);
  }
  return o;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const usage = '用法：node dist/export-public.mjs <outDir> [--replace] [--deny-file <文件>] [--root <仓库目录>]';
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`ERROR ${e.message}\n${usage}\n`); process.exit(9); }
  if (o.help || o.positional.length !== 1) { process.stdout.write(`${usage}\n`); process.exit(o.help ? 0 : 9); }
  let deny;
  try { deny = readDenyFile(o.denyFile); } catch (e) { process.stderr.write(`ERROR 读不了 deny 文件：${e.message}\n`); process.exit(9); }
  exportPublic({ root: o.root || REPO_ROOT, outDir: o.positional[0], replace: o.replace, deny, log: (l) => process.stdout.write(`${l}\n`) })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => {
      if (e instanceof ExportRefusal) { process.stderr.write(`REFUSED ${e.message}\n`); process.exit(2); }
      process.stderr.write(`ERROR ${e && e.stack ? e.stack : e}\n`);
      process.exit(9);
    });
}
