#!/usr/bin/env node
// dist/public-scan.mjs — the personal-data scan run before anything of this repository is published.
//
//   node dist/public-scan.mjs [--all] [--deny-file <file>]
//
// Scans the files git tracks here (without docs/internal/** and dist/out/**, which the public export
// leaves out; --all scans them too) and prints one line per hit, `<path>:<line> [<rule>] <excerpt>`,
// then `PUBLIC_SCAN_OK files=<n> text=<n> binary=<n>` (exit 0) or `PUBLIC_SCAN_FAIL hits=<n> ...`
// (exit 1). File paths are scanned as well as file contents. dist/export-public.mjs runs the same
// rules over its output and fails on any hit. Nothing is ever rewritten: a hit is fixed by hand.
//
// Rules (RULES below):
//   personal-dir   an absolute path to one of the author's working folders (drive E: plus the folder
//                  names of this machine), and the same path in Claude's encoded project-folder form;
//                  also when '-' follows the folder name (a sibling folder, an encoded subfolder)
//   user-home      a Windows or POSIX home folder of the author's account
//   first-name     the author's bare first name in any case (the public name is the handle in LICENSE,
//                  first name and surname joined, which does not match)
//   machine-path   install locations specific to the author's machine
//   email          any e-mail address except documentation domains and no-reply addresses
//   session-id     a UUID: Codex thread ids and Claude session ids are UUIDs. Test fixtures use
//                  synthetic ids with an all-zero group (01a0f000-0000-7000-...), which are allowed
//   internal-name  names of the author's private tooling
//   key            key, token and private-key shapes (the shapes lib/export.mjs scans room exports
//                  for, plus a few more); a match that says fake/test/sim/example/dummy/canary is allowed
//   deny           literals from a deny file kept outside the repository (--deny-file, else the
//                  ROOM_PUBLIC_SCAN_DENY variable): one per line, '#' starts a comment, matched
//                  case-insensitively. Private names that must not appear in public source even as
//                  scan patterns (for example the author's memory-entry names) belong there.
//
// Every regex below is written so that its own source text does not match it; this file passes its
// own scan. Test files that plant hits build them by concatenation at run time for the same reason.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCAN_PATTERNS } from '../lib/export.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Words that mark a key-shaped string as a test value rather than a credential.
const FAKE_MARK = /fake|test|sim|example|dummy|placeholder|redacted|canary|x{8}|0{8}/i;
const KEY_KINDS = new Set(['pem', 'anthropic-key', 'openai-key', 'key-assignment', 'bearer', 'aws-key', 'github-token']);
const EXTRA_KEYS = [
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab token
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
const EMAIL_OK = /@(?:example\.(?:com|org|net)|[a-z0-9-]+\.example|users\.noreply\.github\.com|noreply\.github\.com|anthropic\.com)$|^noreply@|^git@github\.com$/i;

export const RULES = [
  // A folder name followed by '-' is caught too: a sibling folder (<name>-old) or, in the encoded
  // form, a subfolder (E--<name>-sub). pi-local precedes pi, so it still matches as itself.
  { id: 'personal-dir', re: /\bE:[\\/]+(?:codex|pi-local|pi|room-probe|room-dev)(?!\w)/gi },
  { id: 'personal-dir', re: /\bE--(?:codex|pi-local|pi|room-probe|room-dev)(?!\w)/gi },
  { id: 'user-home', re: /\b(?:Users|home)[\\/]+ken{2}y(?![a-z])/gi },
  // Any case, and before '-', '_' or a digit; not the public handle, where a surname follows directly.
  { id: 'first-name', re: /(?<![a-z])ken{2}y(?![a-z])/gi },
  { id: 'machine-path', re: /\b[A-Z]:[\\/]+nodejs(?![\w-])/gi },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, allow: (m) => EMAIL_OK.test(m) },
  { id: 'session-id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, allow: (m) => /-0000-/.test(m) },
  { id: 'internal-name', re: /ken{2}y[-_ ]?ecosystem|\bKEN{2}Y_[A-Z]|主[控]|\.codex[\\/]+visualizations/gi },
  ...SCAN_PATTERNS.filter((p) => KEY_KINDS.has(p.kind)).map((p) => ({ id: 'key', kind: p.kind, re: new RegExp(p.re.source, p.re.flags), allow: (m) => FAKE_MARK.test(m) })),
  ...EXTRA_KEYS.map((re) => ({ id: 'key', re, allow: (m) => FAKE_MARK.test(m) })),
];

// Paths a public copy leaves out: internal records and build output.
export function isPublicPath(rel) {
  const r = rel.replace(/\\/g, '/');
  return !(r === 'docs/internal' || r.startsWith('docs/internal/') || r === 'dist/out' || r.startsWith('dist/out/'));
}

export function readDenyFile(file) {
  if (!file) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function excerpt(rule, m) {
  if (rule === 'key') return `${m.slice(0, 8)}… (${m.length} chars)`;
  const one = m.replace(/\s+/g, ' ');
  return one.length > 90 ? `${one.slice(0, 90)}…` : one;
}

// [{rule, line, match}] for one text. `deny`: extra literals (case-insensitive).
export function scanText(text, { deny = [] } = {}) {
  const hits = [];
  for (const r of RULES) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (r.allow && r.allow(m[0])) continue;
      hits.push({ rule: r.id, line: lineOf(text, m.index), match: excerpt(r.id, m[0]) });
    }
  }
  const lower = text.toLowerCase();
  for (const d of deny) {
    const needle = d.toLowerCase();
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
      hits.push({ rule: 'deny', line: lineOf(text, i), match: excerpt('deny', text.slice(i, i + d.length)) });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

export function isBinary(buf) {
  return buf.subarray(0, Math.min(buf.length, 1 << 20)).includes(0);
}

// Scan files under `root` given as forward-slash relative paths. Paths and text contents are scanned;
// binary files (a NUL byte in the first MiB) only by path.
export function scanFiles(root, rels, { deny = [] } = {}) {
  const hits = [];
  let text = 0;
  let binary = 0;
  for (const rel of rels) {
    for (const h of scanText(rel, { deny })) hits.push({ file: rel, line: 0, rule: h.rule, match: h.match });
    const buf = fs.readFileSync(path.join(root, rel));
    if (isBinary(buf)) { binary++; continue; }
    text++;
    for (const h of scanText(buf.toString('utf8'), { deny })) hits.push({ file: rel, ...h });
  }
  return { hits, files: rels.length, text, binary };
}

// Files git tracks under `root` (the index, so staged new files count), forward-slash relative paths.
export function trackedFiles(root = REPO_ROOT) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer', windowsHide: true, timeout: 60_000, maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.error ? r.error.message : String(r.stderr).trim()}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

// Every file under `dir`, forward-slash relative paths (the export output is scanned this way, so a
// file the export wrote itself, such as .gitignore, is scanned too).
export function listTree(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listTree(dir, r));
    else if (ent.isFile()) out.push(r);
  }
  return out.sort();
}

export function formatHits(hits) {
  return hits.map((h) => `${h.file}:${h.line} [${h.rule}] ${h.match}`);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  let all = false;
  let denyFile = process.env.ROOM_PUBLIC_SCAN_DENY || null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') all = true;
    else if (argv[i] === '--deny-file') denyFile = argv[++i];
    else { process.stderr.write('用法：node dist/public-scan.mjs [--all] [--deny-file <文件>]\n'); process.exit(9); }
  }
  try {
    const deny = readDenyFile(denyFile);
    const rels = trackedFiles(REPO_ROOT).filter((r) => all || isPublicPath(r)).filter((r) => fs.existsSync(path.join(REPO_ROOT, r)));
    const res = scanFiles(REPO_ROOT, rels, { deny });
    for (const l of formatHits(res.hits)) process.stdout.write(`${l}\n`);
    const tail = `files=${res.files} text=${res.text} binary=${res.binary} deny_literals=${deny.length} scope=${all ? 'all-tracked' : 'public'}`;
    process.stdout.write(res.hits.length ? `PUBLIC_SCAN_FAIL hits=${res.hits.length} ${tail}\n` : `PUBLIC_SCAN_OK ${tail}\n`);
    process.exit(res.hits.length ? 1 : 0);
  } catch (e) {
    process.stderr.write(`ERROR ${e && e.message ? e.message : e}\n`);
    process.exit(9);
  }
}
