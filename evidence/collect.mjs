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
// Wording in the report follows the contract: a PASS reads "在<方法>下未观测到…", never "没有"
// or "只读"; what each method does not prove is in contract/README.md.
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
  if (/^cleanup/.test(check)) return '硬规则（不留进程）';
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
  L.push('# 证据报告');
  L.push('');
  L.push(`生成：${takenAt}　平台：${platform}　Node：${nodeVersion}`);
  L.push(`运行目录：${code(runDir)}`);
  L.push('');
  L.push('措辞：PASS 一律写成「在<方法>下未观测到…」，不等于「没有发生」；每种方法证明什么、不证明什么见 `contract/README.md`。write-log 是房间自报的，独立复核（ProcMon / ETW）在 P3。');
  L.push('');
  L.push(`合计：PASS ${n('PASS')}　FAIL ${n('FAIL')}　SKIP ${n('SKIP')}`);
  L.push('');
  L.push('| 检查 | 方案条目 | 结果 | 原始记录 |');
  L.push('|---|---|---|---|');
  for (const r of rows) L.push(`| ${cell(r.check)} | ${cell(r.plan)} | **${r.kind}** ${cell(r.text)} | ${r.raws.map((p) => code(p)).join('<br>')} |`);
  L.push('');
  const failed = rows.filter((r) => r.kind === 'FAIL');
  if (failed.length) {
    L.push('## 失败明细');
    L.push('');
    for (const r of failed) {
      L.push(`- **${r.check}**：${r.text}`);
      for (const d of (r.details || []).slice(0, 40)) L.push(`  - ${d}`);
    }
    L.push('');
  }
  L.push('## 命令（按执行顺序）');
  L.push('');
  stages.forEach((s, i) => {
    L.push(`${i + 1}. 工作目录 ${code(s.cwd)}`);
    L.push('');
    L.push('   ```');
    L.push(`   ${s.argv.map(quoteArg).join(' ')}`);
    L.push('   ```');
    L.push('');
    L.push(`   退出码 ${s.code === null ? '无（' + (s.timedOut ? '超时' : s.spawnError || '未知') + '）' : s.code}，耗时 ${(s.durationMs / 1000).toFixed(1)} s，完整输出 ${code(s.log)}`);
    L.push('');
  });
  if (notes.length) {
    L.push('## 说明');
    L.push('');
    for (const x of notes) L.push(`- ${x}`);
    L.push('');
  }
  L.push('## 各阶段原始记录');
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
    rep.info(`collect(stage): ${name} 开始`);
    const r = await spawnClean(node, argvChild, { cwd: REPO_ROOT, env: { ...process.env }, timeoutMs, maxOutputBytes: 32 << 20 });
    const log = path.join(runDir, `${name.replace(/[^A-Za-z0-9_-]+/g, '-')}.log`);
    const text = `${r.stdout}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''}${r.spawnError ? `\nSPAWN_ERROR ${r.spawnError}` : ''}`;
    guard.writeFile(log, text);
    const s = { name, argv: [node, ...argvChild], cwd: REPO_ROOT, code: r.code, durationMs: r.durationMs, timedOut: r.timedOut, spawnError: r.spawnError, truncated: r.truncated, log, stdout: r.stdout, stderr: r.stderr, raws: [] };
    stages.push(s);
    rep.info(`collect(stage): ${name} 退出 ${r.code}${r.timedOut ? '（超时）' : ''}，${(r.durationMs / 1000).toFixed(1)} s`);
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
    if (parsed.checks.length === 0) addRow({ check: s.name, plan: '-', kind: 'FAIL', text: `脚本未输出任何 PASS/FAIL 行（退出 ${s.code}）`, raws: [s.log] });
    else if (s.code !== 0 && !parsed.checks.some((c) => c.kind === 'FAIL')) addRow({ check: s.name, plan: '-', kind: 'FAIL', text: `退出码 ${s.code} 但没有 FAIL 行`, raws: [s.log] });
  };

  // 1. unit / case / mutation tests
  if (args.skipTests) addRow({ check: 'node --test', plan: planRowFor('node --test'), kind: 'SKIP', text: '已用 --skip-tests 跳过', raws: [] });
  else {
    const s = await stage('node-test', ['--test', '--test-reporter=tap', 'test/**/*.test.mjs'], { timeoutMs: 20 * 60 * 1000 });
    const t = parseTapSummary(s.stdout);
    const ok = s.code === 0 && t.fail === 0 && t.pass !== null;
    const text = t.pass === null ? `未解析到 TAP 汇总（退出 ${s.code}${s.timedOut ? '，超时' : ''}）` : `${t.pass}/${t.tests} 通过，失败 ${t.fail}，跳过 ${t.skipped || 0}，取消 ${t.cancelled || 0}`;
    addRow({ check: 'node --test', plan: planRowFor('node --test'), kind: ok ? 'PASS' : 'FAIL', text, details: t.failures.map((f) => `${'  '.repeat(f.depth)}not ok ${f.name}`), raws: [s.log] });
  }

  // 2. scripted-seat end to end
  if (args.skipE2e) addRow({ check: 'e2e', plan: planRowFor('e2e'), kind: 'SKIP', text: '已用 --skip-e2e 跳过', raws: [] });
  else {
    const s = await stage('e2e', ['test/e2e.mjs'], { timeoutMs: 10 * 60 * 1000 });
    const e = parseE2eSummary(`${s.stdout}\n${s.stderr}`);
    const ok = s.code === 0 && e.pass !== null && e.pass === e.total;
    addRow({ check: 'e2e', plan: planRowFor('e2e'), kind: ok ? 'PASS' : 'FAIL', text: e.pass === null ? `未跑完、无汇总行（退出 ${s.code}）；中断前 PASS ${e.passLines} 项、FAIL ${e.failures.length} 项${e.crash ? `；异常：${e.crash.slice(0, 160)}` : ''}` : `${e.pass}/${e.total} 通过`, details: e.failures, raws: [s.log] });
    notes.push('test/e2e.mjs 的临时目录在 testRunsRoot()\\e2e-<随机> 下（不在本运行目录里），全部通过后由它自己删除、失败时保留供检查；本收集器与契约脚本的临时目录也都在 testRunsRoot() 之下。');
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
    if (leftover.length === 0) addRow({ check: 'cleanup(processes)', plan: planRowFor('cleanup'), kind: 'PASS', text: `在命令行枚举下未观测到本次收集期间起的、仍在运行的 room.mjs serve 进程（开始前已有 ${servicesBefore.length} 个，不计）`, raws: [] });
    else addRow({ check: 'cleanup(processes)', plan: planRowFor('cleanup'), kind: 'FAIL', text: `本次收集期间起的 room.mjs serve 仍在运行：${leftover.map((p) => `${p.pid} ${p.cmd.slice(0, 160)}`).join('；')}`, raws: [] });
  } catch (e) { addRow({ check: 'cleanup(processes)', plan: planRowFor('cleanup'), kind: 'FAIL', text: `无法枚举进程：${e.message}`, raws: [] }); }

  notes.push('control-run 的 PASS 只覆盖「不开 agent、脚本席位」这一场；真实 agent 入席时的同类比对属于 §12.3 的真实层，由维护者在本机另跑。');
  const md = renderReport({ takenAt: new Date().toISOString(), runDir, nodeVersion: process.version, platform: `${process.platform}-${process.arch}`, rows, stages, notes });
  guard.writeFile(path.join(runDir, 'REPORT.md'), md);
  guard.writeFile(reportPath, md);
  rep.raw(path.join(runDir, 'REPORT.md'));
  rep.raw(reportPath);
  return rows.some((r) => r.kind === 'FAIL') ? 1 : 0;
}

runCli(import.meta.url, main);
