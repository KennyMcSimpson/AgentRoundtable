#!/usr/bin/env node
// Evidence collector (INTERFACES §12; plan §1.6 test methods, §12.3 must-pass list, §13.1 rows
// 40-47/45b, §13.4). Runs, in order and each as its own child process through lib/spawn.mjs:
//   1. node --test --test-reporter=tap "test/**/*.test.mjs"     (unit, case and mutation tests)
//   2. node test/e2e.mjs                                         (scripted seats, real service)
//   3. node contract/control-run.mjs --run-dir <run>/control-run (fresh scripted room, no agent)
//   4. node contract/check-writes.mjs <run>/control-run/room     (write-log of that room)
//   5. node contract/env.mjs --run-dir <run>/env                 (polluted-environment probe)
// then checks that no `room.mjs serve` process is left for any room under the run directory, and
// writes evidence/REPORT.md: one table row per check (check | plan row | result | raw path), the
// exact commands with exit codes and durations, and every raw record path.
//
// Wording in the report follows the contract: a PASS reads "... not observed under <method>", never
// "none" or "read-only"; what each method does not prove is in contract/README.md.
//
//   node evidence/collect.mjs [--run-dir <dir>] [--report <file>] [--skip-tests] [--skip-e2e] [--no-baseline]
// The run directory defaults to testRunsRoot()\collect-<random>. Exit 0 when every row is PASS or
// SKIP, 1 otherwise.
//
// The test runner and the scripts get the operator's full environment (passed explicitly to
// spawnClean), as a terminal or CI would give them; the room processes the contract scripts start
// get only what those scripts choose to pass.
import fs from 'node:fs';
import path from 'node:path';
import { spawnClean } from '../lib/spawn.mjs';
import { REPO_ROOT, openRunDir, createReporter, runCli } from '../contract/harness.mjs';
import { findRoomServiceProcesses } from '../contract/pids.mjs';

export const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence');

// ---- pure parsers ----

// node --test TAP summary ("# pass 12" ...) plus the names of failing tests ("not ok N - name").
export function parseTapSummary(text) {
  const num = (k) => { const m = new RegExp(`^# ${k} (\\d+)\\s*$`, 'm').exec(String(text)); return m ? Number(m[1]) : null; };
  const failures = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\s*)not ok \d+ - (.+?)(\s+#.*)?$/.exec(line);
    if (m) failures.push({ depth: Math.floor(m[1].length / 4), name: m[2] });
  }
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled'), skipped: num('skipped'), todo: num('todo'), failures };
}

// test/e2e.mjs ends with "N/M passed; room=...".
export function parseE2eSummary(text) {
  const m = /(\d+)\/(\d+) passed/.exec(String(text));
  const lines = String(text).split(/\r?\n/);
  const failures = lines.filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5));
  const passLines = lines.filter((l) => l.startsWith('PASS ')).length;
  const crash = (lines.find((l) => /^(\w*Error|TypeError|RangeError)\b/.test(l.trim())) || '').trim() || null;
  return m ? { pass: Number(m[1]), total: Number(m[2]), failures, passLines, crash } : { pass: null, total: null, failures, passLines, crash };
}

// PASS/FAIL/SKIP/INFO/RAW lines printed by the contract scripts. A check's name is the text before
// the first ':' ("write-log(seat A)", "control-run(memory)", ...).
export function parseContractLines(text) {
  const checks = []; const raws = []; const infos = [];
  let last = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(PASS|FAIL|SKIP|INFO|RAW) (.*)$/.exec(line);
    if (!m) { if (last && /^ {2}\S/.test(line)) last.details.push(line.trim()); continue; }
    const [, kind, rest] = m;
    if (kind === 'RAW') { raws.push(rest.trim()); last = null; continue; }
    const i = rest.indexOf(':');
    const rec = { kind, check: i > 0 ? rest.slice(0, i).trim() : rest.trim(), text: i > 0 ? rest.slice(i + 1).trim() : '', details: [] };
    if (kind === 'INFO') infos.push(rec); else checks.push(rec);
    last = rec;
  }
  return { checks, raws, infos };
}

// Which raw files back a given check, chosen among the RAW paths its script printed.
export function pickRaw(check, raws) {
  const base = (p) => path.basename(p).toLowerCase();
  const has = (pred) => raws.filter(pred);
  const seat = /^write-log\(seat ([^)]+)\)/.exec(check);
  const workdir = /^control-run\(workdir ([^)]+)\)/.exec(check);
  const fwdOf = (p) => p.replace(/\\/g, '/');
  let hit = [];
  if (seat) hit = has((p) => fwdOf(p).includes(`/.room-outbox/${seat[1]}/`) && base(p) === 'write-log.jsonl');
  else if (/^(write-log\((room|workdir)\)|location\()/.test(check)) hit = has((p) => base(p) === 'write-log.jsonl' && !/[\\/]\.room-outbox[\\/]/.test(p));
  else if (/^control-run\(round\)/.test(check)) hit = has((p) => ['control-run-commands.log', 'control-run-service.log', 'control-run-admin-log.txt'].includes(base(p)));
  else if (workdir) hit = has((p) => base(p) === 'control-run-commands.log' || fwdOf(p).endsWith(`/.room-outbox/${workdir[1]}`));
  else if (/^control-run\(/.test(check)) hit = has((p) => /^snapshot-(before|after|baseline)\.json$/.test(base(p)) || base(p) === 'control-run.json');
  else if (/^pids\(/.test(check)) hit = has((p) => /^pids-(before|after|baseline)\.json$/.test(base(p)) || base(p) === 'control-run-service.log');
  else if (/^env\(/.test(check)) hit = has((p) => base(p) === 'env-children.log');
  return hit.length ? hit : raws.slice(0, 3);
}

// The plan row (§13.1) or rule a check speaks to.
export function planRowFor(check) {
  if (/^write-log\((room|seat)/.test(check)) return '#40';
  if (/^write-log\(workdir\)|^control-run\(workdir/.test(check)) return '#43';
  if (/^location\(/.test(check)) return 'INTERFACES §1';
  if (/^control-run\(memory\)/.test(check)) return '#45b';
  if (/^control-run\(/.test(check)) return '#40b';
  if (/^pids\(/.test(check)) return '#41';
  if (/^env\(/.test(check)) return '#42';
  if (/^node --test/.test(check)) return '§13.4';
  if (/^e2e/.test(check)) return '§12.3 / §13.4';
  if (/^cleanup/.test(check)) return 'Hard rule (no leftover processes)';
  return '-';
}

const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

export function quoteArg(a) { return /[\s"*?]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

// Renders REPORT.md. `rows`: [{check, plan, kind, text, raws:[...]}]; `stages`: [{name, argv, cwd,
// code, durationMs, log, timedOut}]. Pure.
export function renderReport({ takenAt, runDir, nodeVersion, platform, rows, stages, notes = [] }) {
  const n = (k) => rows.filter((r) => r.kind === k).length;
  const L = [];
  L.push('# Evidence Report');
  L.push('');
  L.push(`Generated: ${takenAt} | Platform: ${platform} | Node: ${nodeVersion}`);
  L.push(`Run directory: ${code(runDir)}`);
  L.push('');
  L.push('Wording: PASS lines always read "... not observed under <method>", which does not prove absolute absence; what each method proves and does not prove is documented in `contract/README.md`. The write-log is self-reported by the room; independent verification (ProcMon / ETW) is scheduled for P3.');
  L.push('');
  L.push(`Total: PASS ${n('PASS')} | FAIL ${n('FAIL')} | SKIP ${n('SKIP')}`);
  L.push('');
  L.push('| Check | Clause | Result | Raw Record |');
  L.push('|---|---|---|---|');
  for (const r of rows) L.push(`| ${cell(r.check)} | ${cell(r.plan)} | **${r.kind}** ${cell(r.text)} | ${r.raws.map((p) => code(p)).join('<br>')} |`);
  L.push('');
  const failed = rows.filter((r) => r.kind === 'FAIL');
  if (failed.length) {
    L.push('## Failure Details');
    L.push('');
    for (const r of failed) {
      L.push(`- **${r.check}**: ${r.text}`);
      for (const d of (r.details || []).slice(0, 40)) L.push(`  - ${d}`);
    }
    L.push('');
  }
  L.push('## Commands (in execution order)');
  L.push('');
  stages.forEach((s, i) => {
    L.push(`${i + 1}. Working directory ${code(s.cwd)}`);
    L.push('');
    L.push('   ```');
    L.push(`   ${s.argv.map(quoteArg).join(' ')}`);
    L.push('   ```');
    L.push('');
    L.push(`   Exit code ${s.code === null ? 'none (' + (s.timedOut ? 'timed out' : s.spawnError || 'unknown') + ')' : s.code}, duration ${(s.durationMs / 1000).toFixed(1)} s, full output ${code(s.log)}`);
    L.push('');
  });
  if (notes.length) {
    L.push('## Notes');
    L.push('');
    for (const x of notes) L.push(`- ${x}`);
    L.push('');
  }
  L.push('## Raw Records by Stage');
  L.push('');
  for (const s of stages) {
    if (!s.raws || !s.raws.length) continue;
    L.push(`- ${s.name}`);
    for (const p of s.raws) L.push(`  - ${code(p)}`);
  }
  L.push('');
  return L.join('\n');
}

// ---- driver ----

function parseCli(argv) {
  const res = { runDir: null, report: null, skipTests: false, skipE2e: false, baseline: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dir') { res.runDir = argv[++i]; continue; }
    if (a === '--report') { res.report = argv[++i]; continue; }
    if (a === '--skip-tests') { res.skipTests = true; continue; }
    if (a === '--skip-e2e') { res.skipE2e = true; continue; }
    if (a === '--no-baseline') { res.baseline = false; continue; }
    throw new Error(`unknown option ${a}`);
  }
  return res;
}

export async function main(argv, { out } = {}) {
  const args = parseCli(argv);
  const rep = createReporter(out);
  const reportPath = path.resolve(args.report || path.join(EVIDENCE_DIR, 'REPORT.md'));
  const { runDir, guard } = openRunDir({ runDir: args.runDir, prefix: 'collect', extraRoots: [path.dirname(reportPath)] });
  const node = process.execPath;
  const stages = [];
  const rows = [];
  const notes = [];
  let servicesBefore = [];
  try { servicesBefore = await findRoomServiceProcesses(); } catch { /* reported by the cleanup row */ }

  const stage = async (name, argvChild, { timeoutMs = 10 * 60 * 1000 } = {}) => {
    rep.info(`collect(stage): ${name} started`);
    const r = await spawnClean(node, argvChild, { cwd: REPO_ROOT, env: { ...process.env }, timeoutMs, maxOutputBytes: 32 << 20 });
    const log = path.join(runDir, `${name.replace(/[^A-Za-z0-9_-]+/g, '-')}.log`);
    const text = `${r.stdout}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''}${r.spawnError ? `\nSPAWN_ERROR ${r.spawnError}` : ''}`;
    guard.writeFile(log, text);
    const s = { name, argv: [node, ...argvChild], cwd: REPO_ROOT, code: r.code, durationMs: r.durationMs, timedOut: r.timedOut, spawnError: r.spawnError, truncated: r.truncated, log, stdout: r.stdout, stderr: r.stderr, raws: [] };
    stages.push(s);
    rep.info(`collect(stage): ${name} exited ${r.code}${r.timedOut ? ' (timed out)' : ''}, ${(r.durationMs / 1000).toFixed(1)} s`);
    rep.raw(log);
    return s;
  };
  const addRow = (row) => {
    rows.push(row);
    const line = `${row.check}: ${row.text}`;
    if (row.kind === 'PASS') rep.pass(line); else if (row.kind === 'FAIL') rep.fail(line); else rep.skip(line);
  };
  const absorb = (s) => {
    const parsed = parseContractLines(s.stdout);
    s.raws = parsed.raws;
    for (const c of parsed.checks) addRow({ check: c.check, plan: planRowFor(c.check), kind: c.kind, text: c.text, details: c.details, raws: [...pickRaw(c.check, parsed.raws), s.log] });
    if (parsed.checks.length === 0) addRow({ check: s.name, plan: '-', kind: 'FAIL', text: `script emitted no PASS/FAIL lines (exit ${s.code})`, raws: [s.log] });
    else if (s.code !== 0 && !parsed.checks.some((c) => c.kind === 'FAIL')) addRow({ check: s.name, plan: '-', kind: 'FAIL', text: `exit code ${s.code} without any FAIL line`, raws: [s.log] });
  };

  // 1. unit / case / mutation tests
  if (args.skipTests) addRow({ check: 'node --test', plan: planRowFor('node --test'), kind: 'SKIP', text: 'skipped via --skip-tests', raws: [] });
  else {
    const s = await stage('node-test', ['--test', '--test-reporter=tap', 'test/**/*.test.mjs'], { timeoutMs: 20 * 60 * 1000 });
    const t = parseTapSummary(s.stdout);
    const ok = s.code === 0 && t.fail === 0 && t.pass !== null;
    const text = t.pass === null ? `TAP summary not parsed (exit ${s.code}${s.timedOut ? ', timed out' : ''})` : `${t.pass}/${t.tests} passed, ${t.fail} failed, ${t.skipped || 0} skipped, ${t.cancelled || 0} cancelled`;
    addRow({ check: 'node --test', plan: planRowFor('node --test'), kind: ok ? 'PASS' : 'FAIL', text, details: t.failures.map((f) => `${'  '.repeat(f.depth)}not ok ${f.name}`), raws: [s.log] });
  }

  // 2. scripted-seat end to end
  if (args.skipE2e) addRow({ check: 'e2e', plan: planRowFor('e2e'), kind: 'SKIP', text: 'skipped via --skip-e2e', raws: [] });
  else {
    const s = await stage('e2e', ['test/e2e.mjs'], { timeoutMs: 10 * 60 * 1000 });
    const e = parseE2eSummary(`${s.stdout}\n${s.stderr}`);
    const ok = s.code === 0 && e.pass !== null && e.pass === e.total;
    addRow({ check: 'e2e', plan: planRowFor('e2e'), kind: ok ? 'PASS' : 'FAIL', text: e.pass === null ? `did not finish, no summary line (exit ${s.code}); before abort: ${e.passLines} PASS, ${e.failures.length} FAIL${e.crash ? `; error: ${e.crash.slice(0, 160)}` : ''}` : `${e.pass}/${e.total} passed`, details: e.failures, raws: [s.log] });
    notes.push('Temporary directories for test/e2e.mjs live under testRunsRoot()\\e2e-<random> (outside this run directory), are removed automatically when all checks pass, and are kept on failure for inspection; this collector and the contract scripts also keep their temporary directories under testRunsRoot().');
  }

  // 3-5. contract scripts against a fresh scripted room
  const crDir = path.join(runDir, 'control-run');
  absorb(await stage('control-run', ['contract/control-run.mjs', '--run-dir', crDir, ...(args.baseline ? [] : ['--no-baseline'])], { timeoutMs: 15 * 60 * 1000 }));
  absorb(await stage('check-writes', ['contract/check-writes.mjs', path.join(crDir, 'room')], { timeoutMs: 5 * 60 * 1000 }));
  absorb(await stage('env', ['contract/env.mjs', '--run-dir', path.join(runDir, 'env')], { timeoutMs: 5 * 60 * 1000 }));

  // 6. nothing left running
  // A `room.mjs serve` that exists now but did not before this collector started was left behind by
  // one of the stages (the e2e rooms live outside the run directory, so a path filter is not enough).
  try {
    const live = await findRoomServiceProcesses();
    const leftover = live.filter((p) => !servicesBefore.some((b) => b.pid === p.pid && b.cmd === p.cmd));
    if (leftover.length === 0) addRow({ check: 'cleanup(processes)', plan: planRowFor('cleanup'), kind: 'PASS', text: `live room.mjs serve processes started during this collection were not observed under command-line enumeration (${servicesBefore.length} already running beforehand, excluded)`, raws: [] });
    else addRow({ check: 'cleanup(processes)', plan: planRowFor('cleanup'), kind: 'FAIL', text: `room.mjs serve processes started during this collection are still running: ${leftover.map((p) => `${p.pid} ${p.cmd.slice(0, 160)}`).join('; ')}`, raws: [] });
  } catch (e) { addRow({ check: 'cleanup(processes)', plan: planRowFor('cleanup'), kind: 'FAIL', text: `could not enumerate processes: ${e.message}`, raws: [] }); }

  notes.push('A PASS from control-run covers only the scripted-seat round (no real agent launched); equivalent comparisons with real agents seated belong to the §12.3 real-agent tier and are run separately by the maintainer.');
  const md = renderReport({ takenAt: new Date().toISOString(), runDir, nodeVersion: process.version, platform: `${process.platform}-${process.arch}`, rows, stages, notes });
  guard.writeFile(path.join(runDir, 'REPORT.md'), md);
  guard.writeFile(reportPath, md);
  rep.raw(path.join(runDir, 'REPORT.md'));
  rep.raw(reportPath);
  return rows.some((r) => r.kind === 'FAIL') ? 1 : 0;
}

runCli(import.meta.url, main);
