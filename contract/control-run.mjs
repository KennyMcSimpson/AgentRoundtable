#!/usr/bin/env node
// Contract 1 control run (plan §1.6 test methods; #40b, #41, #45b, and the listing half of #43):
// run a whole scripted round with NO agent — the room service as a child (`node room.mjs serve`)
// and the seat commands as children, driven only through the CLI — and compare, before vs after,
// entry-level listings (relative path + kind + size + sha256, never mtime) of the files and
// directories that hold agent config, memory, hooks and instructions. Any changed entry is reported.
//
// Session storage (~/.claude/projects/*/*.jsonl, $CODEX_HOME/sessions, the Codex sqlite state) is
// deliberately NOT compared: other threads on this machine keep appending to it while the control
// run executes, so an entry diff there would measure their activity, not the room's. The plan covers
// session storage with the write-log (check-writes.mjs) and the audit reader's set of opened files.
// The memory sub-directories under ~/.claude/projects/*/memory ARE compared (they are memory).
//
// The plan also says the allowlist of "entries that change on their own" must come from a baseline
// window of the same length with no room running, not from a hand-written list. So after the round
// the script waits the same wall time again, snapshots a third time, and excludes (listing them)
// entries that changed during that quiet window.
//
//   node contract/control-run.mjs [<roomDir>] [--dir <path>]... [--extra-dir <path>]...
//                                 [--seats-root <dir>] [--run-dir <dir>] [--no-baseline]
// <roomDir> must not exist yet; it defaults to <runDir>/room. The run directory defaults to
// testRunsRoot()\control-<random>. Exit 0 when no FAIL line was printed, 1 otherwise.
//
// The round only uses the P-1 CLI surface (admin init/add-seat/task/start/close/log, serve, seat
// wait/submit/status) and reads only contract storage (events.jsonl event types, service.lock), so it
// does not depend on the internal shape of lib/service.mjs or lib/seat.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnClean } from '../lib/spawn.mjs';
import { createGuard } from '../lib/guard.mjs';
import { snapshotTargets, diffSnapshots, diffKey, countEntries, formatDiff } from './memory-diff.mjs';
import { snapshotProcesses, compareReport, diffProcessSets } from './pids.mjs';
import { ROOM_MJS, REPO_ROOT, openRunDir, passThroughEnv, runRoom, createReporter, sleep, until, readJsonlFile, runCli } from './harness.mjs';

export const GROUPS = ['config', 'memory', 'hooks', 'instructions'];

// Where agents keep config, memory, hooks and instructions. Missing targets are recorded as absent;
// a target that appears during the run is itself a difference.
export function defaultTargets(env = process.env, home = os.homedir()) {
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const t = (p, group) => ({ path: p, group });
  const list = [
    t(path.join(claudeHome, 'settings.json'), 'config'),
    t(path.join(claudeHome, 'settings.local.json'), 'config'),
    t(path.join(claudeHome, '.claude.json'), 'config'),
    t(path.join(claudeHome, 'CLAUDE.md'), 'instructions'),
    t(path.join(claudeHome, 'agents'), 'instructions'),
    t(path.join(claudeHome, 'commands'), 'instructions'),
    t(path.join(claudeHome, 'skills'), 'instructions'),
    t(path.join(claudeHome, 'hooks'), 'hooks'),
    t(path.join(claudeHome, 'memory'), 'memory'),
    t(path.join(codexHome, 'config.toml'), 'config'),
    t(path.join(codexHome, 'rules'), 'config'),
    t(path.join(codexHome, 'AGENTS.md'), 'instructions'),
    t(path.join(codexHome, 'AGENTS.override.md'), 'instructions'),
    t(path.join(codexHome, 'agents'), 'instructions'),
    t(path.join(codexHome, 'prompts'), 'instructions'),
    t(path.join(codexHome, 'skills'), 'instructions'),
    t(path.join(codexHome, 'hooks.json'), 'hooks'),
    t(path.join(codexHome, 'hooks'), 'hooks'),
    t(path.join(codexHome, 'memories'), 'memory'),
    t(path.join(codexHome, 'memories_1.sqlite'), 'memory'),
  ];
  // ~/.claude.json is the main Claude Code config when CLAUDE_CONFIG_DIR is not set.
  if (!env.CLAUDE_CONFIG_DIR) list.splice(3, 0, t(path.join(home, '.claude.json'), 'config'));
  // Per-project auto-memory. Expanded once, before the run, so all snapshots compare the same set.
  const projects = path.join(claudeHome, 'projects');
  let names = [];
  try { names = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* no projects dir */ }
  for (const n of names) {
    const mem = path.join(projects, n, 'memory');
    if (fs.existsSync(mem)) list.push(t(mem, 'memory'));
  }
  return list;
}

export const SESSION_STORAGE_NOTE = 'Session storage (~/.claude/projects/*/*.jsonl, $CODEX_HOME/sessions, and its sqlite state database) is not compared: other threads on this machine continue appending to it during the control run, so entry diffs there would measure their activity rather than the room\'s; that scope is covered by the write-log (check-writes.mjs) and the auditor\'s opened-file set.';

function parseCli(argv) {
  const res = { _: [], dir: [], extraDir: [], seatsRoot: null, runDir: null, baseline: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { res.dir.push(argv[++i]); continue; }
    if (a === '--extra-dir') { res.extraDir.push(argv[++i]); continue; }
    if (a === '--seats-root') { res.seatsRoot = argv[++i]; continue; }
    if (a === '--run-dir') { res.runDir = argv[++i]; continue; }
    if (a === '--no-baseline') { res.baseline = false; continue; }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    res._.push(a);
  }
  return res;
}

// Pure. Splits the before->after diffs into those to judge and those a baseline window explains.
export function applyBaseline(diffs, baselineDiffs) {
  const self = new Set(baselineDiffs.map(diffKey));
  const judged = diffs.filter((d) => !self.has(diffKey(d)));
  const excluded = diffs.filter((d) => self.has(diffKey(d)));
  return { judged, excluded };
}

// Pure. Relative paths under a seat cwd that are not the room outbox and not files the scripted
// agent itself wrote: what is left is something else writing the working directory.
export function unexpectedWorkdirEntries(relPaths, agentWrites = []) {
  const own = new Set(agentWrites.map((p) => p.replace(/\\/g, '/')));
  return relPaths.map((p) => p.replace(/\\/g, '/')).filter((p) => p !== '.room-outbox' && !p.startsWith('.room-outbox/') && !own.has(p)).sort();
}

function listRel(root) {
  const outRows = [];
  const walk = (d, rel) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      outRows.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(root, '');
  return outRows;
}

const firstLine = (t) => String(t).split(/\r?\n/).find((l) => l.trim()) || '';
const attemptOf = (txt) => (String(txt).match(/^TURN attempt=(\S+)/m) || [])[1] || null;

export async function main(argv, { out } = {}) {
  const args = parseCli(argv);
  const rep = createReporter(out);
  const { runDir, guard } = openRunDir({ runDir: args.runDir, prefix: 'control' });
  const roomDir = path.resolve(args._[0] || path.join(runDir, 'room'));
  if (fs.existsSync(path.join(roomDir, 'room.json'))) throw new Error(`room already exists at ${roomDir}; give a fresh directory`);
  const seatsRoot = path.resolve(args.seatsRoot || path.join(runDir, 'seat-cwds'));
  const targets = [
    ...(args.dir.length ? args.dir.map((p) => ({ path: path.resolve(p), group: 'custom' })) : defaultTargets()),
    ...args.extraDir.map((p) => ({ path: path.resolve(p), group: 'extra' })),
  ];
  const writeJson = (name, obj) => { const p = path.join(runDir, name); guard.writeFile(p, JSON.stringify(obj, null, 1)); return p; };

  rep.info(`control-run(targets): ${targets.length} comparison targets`);
  for (const t of targets) rep.detail(`[${t.group}] ${t.path}${fs.existsSync(t.path) ? '' : ' (missing, recorded as absent)'}`);
  rep.info(`control-run(scope): ${SESSION_STORAGE_NOTE}`);

  const cmdLog = path.join(runDir, 'control-run-commands.log');
  const serviceLogPath = path.join(runDir, 'control-run-service.log');
  const env = passThroughEnv();
  const roomPids = new Set();
  const run = async (label, argvRoom, timeoutMs = 60000) => {
    const r = await runRoom(argvRoom, { env, cwd: runDir, timeoutMs, guard, log: cmdLog, label });
    if (r.pid) roomPids.add(r.pid);
    return r;
  };
  const seatDir = (id) => path.join(roomDir, 'seats', id);
  const seatCmd = (id, cmd, extra = []) => run(`seat ${id} ${cmd}`, [cmd, '--seat', seatDir(id), ...extra]);
  const admin = (sub, extra = []) => run(`admin ${sub}`, ['admin', sub, '--dir', roomDir, ...extra]);
  const events = () => readJsonlFile(path.join(roomDir, 'events.jsonl'));
  const writeTmp = (name, text) => { const p = path.join(runDir, name); guard.writeFile(p, text); return p; };
  const cwdA = path.join(seatsRoot, 'A'); const cwdB = path.join(seatsRoot, 'B');
  // The scripted executor's own work goes through its own guard, so its writes are on record too.
  const agentLogDir = path.join(runDir, 'scripted-agent');
  const agentGuard = createGuard({ allowed: [cwdB, agentLogDir], logPath: path.join(agentLogDir, 'write-log.jsonl'), who: 'scripted-agent:B' });
  const agentWrites = { A: [], B: [] };

  // Polls the seat's `wait` until it hands out a TURN (works for turn_over and background seats).
  const waitTurn = async (id, ms = 30000) => {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < ms) {
      const r = await seatCmd(id, 'wait', ['--timeout', '1']);
      last = r.out;
      const a = attemptOf(r.out);
      if (r.code === 0 && a) return { attempt: a, out: r.out };
      if (/^(ROOM_CLOSED|LEFT)/m.test(r.out)) break;
      if (serviceResult) { last = `${firstLine(r.out)} (room service exited with code ${serviceResult.code})`; break; }
      await sleep(250);
    }
    return { attempt: null, out: last };
  };

  // ---- before ----
  const pidsBefore = await snapshotProcesses({ label: 'before' });
  const snapBefore = snapshotTargets(targets, { label: 'before' });
  const fBefore = writeJson('snapshot-before.json', snapBefore);
  const fPidsBefore = writeJson('pids-before.json', pidsBefore);
  const t0 = Date.now();

  // ---- the scripted round: A opens, B works, A reviews; nobody but child processes ----
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); guard.appendFsync(cmdLog, `${ok ? 'ok' : 'FAILED'} ${name} ${detail}\n`); return !!ok; };
  let servicePromise = null; let servicePid = null; let serviceResult = null;
  const round = async () => {
    let r = await admin('init', ['--id', 'control', '--wall', '600']);
    if (!step('admin init', r.code === 0, firstLine(r.out))) return;
    // The seat working directories are the user's to create (add-seat refuses a missing one, NI-13);
    // here the run creates them itself, through its own guard, so the creation is on record.
    const setupDir = path.join(runDir, 'seat-setup');
    const setupGuard = createGuard({ allowed: [cwdA, cwdB, setupDir], logPath: path.join(setupDir, 'write-log.jsonl'), who: 'control-run:seat-setup' });
    setupGuard.mkdir(setupDir);
    setupGuard.mkdir(cwdA);
    setupGuard.mkdir(cwdB);
    r = await admin('add-seat', ['--seat', 'A', '--role', 'reviewer', '--wait', 'turn_over', '--cwd', cwdA]);
    if (!step('add-seat A', r.code === 0, firstLine(r.out))) return;
    r = await admin('add-seat', ['--seat', 'B', '--role', 'executor', '--wait', 'background', '--cwd', cwdB, '--wait-timeout', '20']);
    if (!step('add-seat B', r.code === 0, firstLine(r.out))) return;
    servicePromise = spawnClean(process.execPath, [ROOM_MJS, 'serve', '--dir', roomDir, '--tick', '120'], { cwd: runDir, env, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 8 << 20 })
      .then((res) => { serviceResult = res; return res; });
    const lock = await until(() => { const l = JSON.parse(fs.readFileSync(path.join(roomDir, 'service.lock'), 'utf8')); return l && l.pid ? l : null; }, 15000);
    servicePid = lock ? Number(lock.pid) : null;
    if (servicePid) roomPids.add(servicePid);
    const ready = await until(async () => { const s = await seatCmd('B', 'status'); return s.code === 0 && /^STATUS/m.test(s.out); }, 15000, 300);
    if (!step('service started', ready && servicePid, `pid ${servicePid}`)) return;
    r = await admin('task', ['--text', 'Control run: B writes "hello room" to hello.txt; A opens and reviews.']);
    if (!step('admin task queued', r.code === 0, firstLine(r.out))) return;
    r = await admin('start', ['--order', 'A,B,A']);
    if (!step('admin start queued', r.code === 0, firstLine(r.out))) return;
    let w = await waitTurn('A');
    if (!step('A wait -> TURN', w.attempt, firstLine(w.out))) return;
    r = await seatCmd('A', 'submit', ['--attempt', w.attempt, '--file', writeTmp('cr-a1.md', 'Opening: B, please write "hello room" to hello.txt. Acceptance: cat hello.txt.')]);
    if (!step('A submit -> ACCEPTED', r.code === 0 && /^ACCEPTED/m.test(r.out), firstLine(r.out))) return;
    w = await waitTurn('B');
    if (!step('B wait -> TURN', w.attempt, firstLine(w.out))) return;
    agentGuard.writeFile(path.join(cwdB, 'hello.txt'), 'hello room\n'); // the executor's own work in its own cwd
    agentWrites.B.push('hello.txt');
    r = await seatCmd('B', 'submit', ['--attempt', w.attempt, '--file', writeTmp('cr-b1.md', 'Done: hello.txt has been written with hello room.')]);
    if (!step('B submit -> ACCEPTED', r.code === 0 && /^ACCEPTED/m.test(r.out), firstLine(r.out))) return;
    w = await waitTurn('A');
    if (!step('A wait (review) -> TURN', w.attempt, firstLine(w.out))) return;
    r = await seatCmd('A', 'submit', ['--attempt', w.attempt, '--file', writeTmp('cr-a2.md', 'Review: hello.txt content is correct.\nVERDICT: pass')]);
    if (!step('A review submit -> ACCEPTED', r.code === 0 && /^ACCEPTED/m.test(r.out), firstLine(r.out))) return;
    const done = await until(() => events().some((e) => e.type === 'round_done'), 15000);
    const accepted = events().filter((e) => e.type === 'submission_accepted').length;
    if (!step('round_done event with 3 accepted submissions', done && accepted === 3, `submission_accepted=${accepted}`)) return;
    r = await seatCmd('A', 'wait');
    if (!step('A wait after round -> not TURN', r.code === 0 && !attemptOf(r.out), firstLine(r.out))) return;
    r = await admin('close');
    if (!step('admin close queued', r.code === 0, firstLine(r.out))) return;
    const closed = await until(async () => /^ROOM_CLOSED/m.test((await seatCmd('B', 'wait', ['--timeout', '0'])).out), 15000, 300);
    step('seat sees ROOM_CLOSED', closed);
  };
  try {
    await round();
  } finally {
    if (servicePromise) {
      const exited = await Promise.race([servicePromise.then(() => true), sleep(15000).then(() => false)]);
      step('service exited on close', exited, exited ? `exit ${serviceResult && serviceResult.code}` : 'still running after 15 s; killed');
      if (!exited) {
        try { if (servicePid) process.kill(servicePid); } catch { /* already gone */ }
        await Promise.race([servicePromise, sleep(10000)]);
      }
      if (serviceResult) guard.writeFile(serviceLogPath, `${serviceResult.stdout}${serviceResult.stderr}`);
    }
  }
  const adminLog = await admin('log');
  const fAdminLog = path.join(runDir, 'control-run-admin-log.txt');
  guard.writeFile(fAdminLog, adminLog.out);
  const roundOk = steps.length > 0 && steps.every((s) => s.ok);
  const durationMs = Date.now() - t0;
  if (roundOk) rep.pass(`control-run(round): scripted seats completed a full A,B,A round via CLI (${steps.length} steps, ${(durationMs / 1000).toFixed(1)} s); agent launches were not observed during the round`);
  else rep.fail(`control-run(round): scripted round did not complete — ${steps.filter((s) => !s.ok).map((s) => `${s.name}${s.detail ? ` (${s.detail.slice(0, 160)})` : ''}`).join('; ')}`);

  // ---- after ----
  const pidsAfter = await snapshotProcesses({ label: 'after' });
  const snapAfter = snapshotTargets(targets, { label: 'after' });
  const fAfter = writeJson('snapshot-after.json', snapAfter);
  const fPidsAfter = writeJson('pids-after.json', pidsAfter);
  const diffs = diffSnapshots(snapBefore, snapAfter);

  // ---- baseline window: same wall time, no room running ----
  let excluded = []; let judged = diffs; let fBaseline = null; let pidsBaseline = null; let fPidsBaseline = null;
  if (args.baseline) {
    const waitMs = Math.max(durationMs, 2000);
    rep.info(`control-run(baseline): waiting another ${(waitMs / 1000).toFixed(1)} s (room stopped) before taking a third snapshot; entries that change on their own during the baseline window will be excluded`);
    await sleep(waitMs);
    const snapBaseline = snapshotTargets(targets, { label: 'baseline' });
    pidsBaseline = await snapshotProcesses({ label: 'baseline' });
    fPidsBaseline = writeJson('pids-baseline.json', pidsBaseline);
    fBaseline = writeJson('snapshot-baseline.json', snapBaseline);
    ({ judged, excluded } = applyBaseline(diffs, diffSnapshots(snapAfter, snapBaseline)));
    if (excluded.length) { rep.info(`control-run(baseline): excluded ${excluded.length} entries that changed on their own during the baseline window`); for (const d of excluded) rep.detail(formatDiff(d)); }
  } else rep.info('control-run(baseline): baseline window disabled via --no-baseline; all differences will be judged');

  // ---- verdict per group ----
  const groups = [...new Set(targets.map((t) => t.group))];
  for (const g of groups) {
    const gTargets = snapAfter.targets.filter((t) => t.group === g);
    const present = gTargets.filter((t) => t.exists).length;
    const n = gTargets.reduce((s, t) => s + t.entries.length, 0);
    const gDiffs = judged.filter((d) => d.group === g);
    if (gDiffs.length === 0) rep.pass(`control-run(${g}): ${gTargets.length} targets (${present} present), ${n} entries; differences were not observed under entry-level sha256 comparison across the scripted control run (no agent launched)`);
    else { rep.fail(`control-run(${g}): ${gTargets.length} targets, ${n} entries; ${gDiffs.length} entry differences were observed under entry-level sha256 comparison`); for (const d of gDiffs) rep.detail(formatDiff(d)); }
  }

  // ---- seat working directories: only the outbox and the scripted agent's own files ----
  for (const [id, cwd] of [['A', cwdA], ['B', cwdB]]) {
    const rel = listRel(cwd);
    const extra = unexpectedWorkdirEntries(rel, agentWrites[id]);
    if (extra.length === 0) rep.pass(`control-run(workdir ${id}): ${rel.length} entries; entries outside the outbox and the scripted agent's own files (${agentWrites[id].join(',') || 'none'}) were not observed under directory listing (write handles verified by P3 ProcMon)`);
    else { rep.fail(`control-run(workdir ${id}): ${extra.length} unexpected entries outside the outbox were observed under directory listing`); for (const p of extra) rep.detail(p); }
  }

  // ---- processes ----
  const ambient = pidsBaseline ? diffProcessSets(pidsAfter, pidsBaseline) : null;
  const pidRep = await compareReport({ before: pidsBefore, after: pidsAfter, servicePid, roomDir, roomPids: [...roomPids], ambient });
  for (const l of pidRep.lines) {
    const sp = l.indexOf(' ');
    const kind = l.slice(0, sp); const text = l.slice(sp + 1);
    if (kind === 'PASS') rep.pass(text); else if (kind === 'FAIL') rep.fail(text); else rep.info(text);
  }

  const outboxes = { A: path.join(cwdA, '.room-outbox', 'A'), B: path.join(cwdB, '.room-outbox', 'B') };
  const summary = {
    schema_version: 2, takenAt: new Date().toISOString(), repo: REPO_ROOT, runDir, roomDir, outboxes, servicePid, serviceExit: serviceResult ? serviceResult.code : null, durationMs,
    roomPids: [...roomPids], targets, sessionStorageNote: SESSION_STORAGE_NOTE,
    files: { commands: cmdLog, serviceLog: serviceLogPath, adminLog: fAdminLog, snapshotBefore: fBefore, snapshotAfter: fAfter, snapshotBaseline: fBaseline, pidsBefore: fPidsBefore, pidsAfter: fPidsAfter, pidsBaseline: fPidsBaseline, agentWriteLog: path.join(agentLogDir, 'write-log.jsonl') },
    entries: countEntries(snapAfter), diffs, excluded, judged, steps, lines: rep.lines, ok: !rep.failed,
  };
  const fSummary = writeJson('control-run.json', summary);
  for (const p of [roomDir, outboxes.A, outboxes.B, cmdLog, serviceLogPath, fAdminLog, fBefore, fAfter, fBaseline, fPidsBefore, fPidsAfter, fPidsBaseline, fSummary]) if (p) rep.raw(p);
  return rep.failed ? 1 : 0;
}

runCli(import.meta.url, main);
