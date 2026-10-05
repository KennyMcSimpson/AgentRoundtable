// Shared plumbing for the contract scripts (contract/*.mjs) and evidence/collect.mjs.
//
// The contract scripts are the user's measuring tools, not part of the room, but they follow the
// same two rules as the room itself so that their own footprint is accountable:
//   - every file they write goes through lib/guard.mjs, confined to their run directory under
//     testRunsRoot() (never %LOCALAPPDATA%, see INTERFACES §1 on MSIX redirection), and logged to
//     <runDir>/contract-write-log.jsonl with who=contract;
//   - every child they start goes through lib/spawn.mjs (no shell, capped output, timeout).
// They drive the room only through its CLI (`node room.mjs ...`) and read only the storage the
// contract fixes (room.json, events.jsonl, write-log.jsonl, service.lock), so they keep working when
// lib/service.mjs or lib/seat.mjs change shape.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testRunsRoot, realPathNative } from '../lib/common.mjs';
import { createGuard } from '../lib/guard.mjs';
import { spawnClean } from '../lib/spawn.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOM_MJS = path.join(REPO_ROOT, 'room.mjs');

// Variables the room CLI legitimately reads (where the app root, agent homes and the user profile
// are). spawnClean's whitelist does not carry them, so the scripts pass them explicitly.
export const PASS_THROUGH_KEYS = ['ROOM_DEV_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_CLI_PATH'];

export function passThroughEnv(extra = {}, source = process.env) {
  const env = {};
  for (const k of PASS_THROUGH_KEYS) if (source[k] !== undefined) env[k] = source[k];
  return { ...env, ...extra };
}

// True when this module file is the script node was started with.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => { const r = realPathNative(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(path.resolve(process.argv[1])) === norm(fileURLToPath(metaUrl));
}

// Real on-disk spelling of `p` even when its tail does not exist (yet or any more): the nearest
// existing ancestor goes through realPathNative (junctions, symlinks, 8.3 names, MSIX redirection)
// and the missing remainder is appended. The \\?\ prefix is dropped so results compare as text.
export function canonicalPath(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    if (fs.existsSync(cur)) break;
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const real = realPathNative(cur).replace(/^\\\\\?\\/, '');
  return rest.length ? path.join(real, ...rest) : real;
}

// Creates (or adopts) a run directory under testRunsRoot() and a guard confined to it.
export function openRunDir({ runDir = null, prefix = 'contract', extraRoots = [] } = {}) {
  const dir = path.resolve(runDir || path.join(testRunsRoot(), `${prefix}-${crypto.randomBytes(4).toString('hex')}`));
  const guard = createGuard({ allowed: [dir, ...extraRoots], logPath: path.join(dir, 'contract-write-log.jsonl'), who: 'contract' });
  guard.mkdir(dir);
  return { runDir: dir, guard };
}

// Runs `node room.mjs <argv>` through spawnClean. Returns {code, out, pid, timedOut}. When `log` is a
// file path inside the guard's roots, the command and its output are appended there.
export async function runRoom(argv, { env = passThroughEnv(), cwd = REPO_ROOT, timeoutMs = 120000, guard = null, log = null, label = null } = {}) {
  const r = await spawnClean(process.execPath, [ROOM_MJS, ...argv], { cwd, env, timeoutMs, maxOutputBytes: 4 << 20 });
  const text = (r.stdout || '') + (r.stderr || '') + (r.spawnError ? `\nSPAWN_ERROR ${r.spawnError}` : '');
  if (guard && log) guard.appendFsync(log, `### ${label || argv[0]}: node room.mjs ${argv.join(' ')} -> exit ${r.code}${r.timedOut ? ' (timeout)' : ''}\n${text}\n`);
  return { code: r.code, out: text, stdout: r.stdout || '', stderr: r.stderr || '', pid: r.pid, timedOut: r.timedOut };
}

// Line printer that also keeps a structured copy, so a script can both print and return results.
// Kinds: PASS, FAIL, SKIP, INFO, RAW. A line's "check" is the token before the first ':'.
export function createReporter(out = (l) => process.stdout.write(`${l}\n`)) {
  const lines = [];
  const emit = (kind, text) => { lines.push({ kind, text }); out(`${kind} ${text}`); };
  return {
    lines,
    pass: (t) => emit('PASS', t),
    fail: (t) => emit('FAIL', t),
    skip: (t) => emit('SKIP', t),
    info: (t) => emit('INFO', t),
    raw: (p) => { if (p) emit('RAW', p); },
    detail: (t) => { lines.push({ kind: 'DETAIL', text: t }); out(`  ${t}`); },
    get failed() { return lines.some((l) => l.kind === 'FAIL'); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// Tolerant JSONL reader for contract storage (events.jsonl, write-log.jsonl); a torn tail is skipped.
export function readJsonlFile(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return rows;
}

// Every CLI ends the same way: exit 0 when no FAIL line was printed, 1 otherwise (including crashes).
export function runCli(metaUrl, main) {
  if (!isMain(metaUrl)) return;
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => process.exit(code === 0 ? 0 : 1), (e) => {
      process.stdout.write(`FAIL script: ${path.basename(fileURLToPath(metaUrl))} 异常退出：${e && e.message ? e.message : e}\n`);
      process.stderr.write(`ERROR ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    });
}
