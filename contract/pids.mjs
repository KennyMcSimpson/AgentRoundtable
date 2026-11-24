#!/usr/bin/env node
// Contract 2 (plan §1.6 clause 2; test #41): the room neither starts nor stops any agent process.
// Method: snapshot the processes whose image name matches codex|claude|node before and after a
// session (tasklist /FO CSV on Windows, ps elsewhere), diff the sets, and after close confirm that
// no room-service process remains for the room. When the agent set did change, the parent chain of
// every new agent process is read (Win32_Process.ParentProcessId / ps ppid) and checked against the
// pids of the room's own processes, so a change made by something else on the machine can be told
// apart from one the room made.
//
// What this does NOT observe: attach / inject / OpenProcess on a running agent, and who terminated
// a process that disappeared. Those need ETW, which the plan leaves to P3. Wording: "not observed".
//
//   node contract/pids.mjs snapshot [--out <file>]
//   node contract/pids.mjs compare <before.json> <after.json> [--service-pid <pid>] [--room <roomDir>] [--room-pids 1,2,3]
//   node contract/pids.mjs services [--room <roomDir>]      list live `room.mjs serve` processes
// Exit 0 when no FAIL line was printed, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { spawnClean } from '../lib/spawn.mjs';
import { createGuard } from '../lib/guard.mjs';
import { canonicalPath, runCli } from './harness.mjs';

export const DEFAULT_PATTERN = /codex|claude|node/i;
export const AGENT_PATTERN = /codex|claude/i;

// Parses `tasklist /FO CSV /NH` output: "Image Name","PID","Session Name","Session#","Mem Usage".
export function parseTasklistCsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('"')) continue;
    const fields = [];
    let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
    fields.push(cur);
    const pid = Number(fields[1]);
    if (!fields[0] || !Number.isInteger(pid)) continue;
    rows.push({ pid, name: fields[0] });
  }
  return rows;
}

// Parses `ps -eo pid=,comm=` output.
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), name: m[2] });
  }
  return rows;
}

// Parses `ps -eo pid=,ppid=,comm=` output into {pid, ppid, name}.
export function parsePsParents(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] });
  }
  return rows;
}

const SPAWN_OPTS = { timeoutMs: 60000, maxOutputBytes: 32 << 20 };

async function must(file, args) {
  const r = await spawnClean(file, args, SPAWN_OPTS);
  if (r.spawnError) throw new Error(`${file}: ${r.spawnError}`);
  if (r.timedOut) throw new Error(`${file}: timed out`);
  if (r.code !== 0) throw new Error(`${file}: exit ${r.code} ${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

// Windows PowerShell 5.1 writes redirected stdout in the console (OEM) code page, CP936 on a Chinese
// system, while spawnClean decodes stdout as UTF-8: a command line holding a Chinese room path came
// back as U+FFFD and never matched. Every PowerShell call made here switches its output to UTF-8
// (no BOM) first; a BOM that still slips through is stripped before parsing.
export const POWERSHELL_UTF8_PREFIX = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ';

export async function powershellJson(script) {
  const txt = (await must('powershell', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_UTF8_PREFIX + script])).replace(/^\uFEFF/, '').trim();
  if (!txt) return [];
  const parsed = JSON.parse(txt);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function listProcesses() {
  if (process.platform === 'win32') return parseTasklistCsv(await must('tasklist', ['/FO', 'CSV', '/NH']));
  return parsePs(await must('ps', ['-eo', 'pid=,comm=']));
}

// Every process with its parent pid: [{pid, ppid, name}].
export async function listProcessParents() {
  if (process.platform === 'win32') {
    const rows = await powershellJson('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress');
    return rows.map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || '') }));
  }
  return parsePsParents(await must('ps', ['-eo', 'pid=,ppid=,comm=']));
}

// A snapshot keeps the matching processes (what the diff is about) and, when the platform gives it,
// the full parent table taken at the same moment (what the ancestry check reads), so a process that
// appeared and is still there can be attributed without a second, later enumeration.
export async function snapshotProcesses({ pattern = DEFAULT_PATTERN, label = null } = {}) {
  let parents = null;
  let all;
  try { parents = await listProcessParents(); all = parents.map(({ pid, name }) => ({ pid, name })); }
  catch { all = await listProcesses(); }
  const processes = all.filter((p) => pattern.test(p.name)).sort((a, b) => a.pid - b.pid);
  return { schema_version: 2, takenAt: new Date().toISOString(), platform: process.platform, label, pattern: String(pattern), processes, parents };
}

// Pure. Compares two snapshots; agent processes (codex|claude) are the ones the contract is about.
export function diffProcessSets(before, after) {
  const key = (p) => `${p.pid}:${p.name.toLowerCase()}`;
  const b = new Map(before.processes.map((p) => [key(p), p]));
  const a = new Map(after.processes.map((p) => [key(p), p]));
  const added = [...a.values()].filter((p) => !b.has(key(p)));
  const removed = [...b.values()].filter((p) => !a.has(key(p)));
  return {
    added, removed,
    agentAdded: added.filter((p) => AGENT_PATTERN.test(p.name)),
    agentRemoved: removed.filter((p) => AGENT_PATTERN.test(p.name)),
  };
}

// Pure. Walks the parent chain of `pid` in `parents` ([{pid, ppid}]). Returns {found:false} when
// `pid` is not in the table (cannot be attributed), else {found:true, ancestor} where ancestor is the
// first pid of the chain that is in `roomPids`, or null. Stops on a cycle or a parent no longer
// listed (a dead parent's pid is still compared: Windows keeps ParentProcessId after it exits).
export function roomAncestor(pid, parents, roomPids) {
  const byPid = new Map(parents.map((p) => [p.pid, p]));
  const room = new Set(roomPids);
  const seen = new Set();
  let cur = byPid.get(pid);
  if (!cur) return { found: false, ancestor: null };
  while (cur && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    if (room.has(cur.ppid)) return { found: true, ancestor: cur.ppid };
    cur = byPid.get(cur.ppid);
  }
  return { found: true, ancestor: null };
}

// Pure. Judges an agent-set diff. Started processes are attributed through the parent table; a
// process that disappeared cannot be attributed by this method at all (that needs ETW), so it fails.
export function judgeAgentDiff(diff, parents, roomPids) {
  const attributed = []; const unknown = []; const foreign = [];
  for (const p of diff.agentAdded) {
    if (!parents) { unknown.push(p); continue; }
    const r = roomAncestor(p.pid, parents, roomPids);
    if (!r.found) unknown.push(p);
    else if (r.ancestor !== null) attributed.push({ ...p, ancestor: r.ancestor });
    else foreign.push(p);
  }
  const ok = attributed.length === 0 && unknown.length === 0 && diff.agentRemoved.length === 0;
  return { ok, attributed, unknown, foreign, removed: diff.agentRemoved };
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Pure. Selects `room.mjs serve` command lines, optionally for one room directory.
export function filterServiceCommandLines(rows, roomDir = null) {
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s).replace(/\\/g, '/');
  const wants = roomDir ? [...new Set([path.resolve(roomDir), canonicalPath(roomDir)])].map(norm) : null;
  return rows.filter((p) => /room\.mjs["']?\s+serve\b/i.test(p.cmd) && (!wants || wants.some((w) => norm(p.cmd).includes(w))));
}

// Live processes whose command line runs `room.mjs serve` (optionally for one room directory).
export async function findRoomServiceProcesses({ roomDir = null } = {}) {
  let rows = [];
  if (process.platform === 'win32') {
    const parsed = await powershellJson("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress");
    rows = parsed.map((p) => ({ pid: Number(p.ProcessId), cmd: String(p.CommandLine || '') }));
  } else {
    for (const line of (await must('ps', ['-eo', 'pid=,args='])).split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), cmd: m[2] });
    }
  }
  return filterServiceCommandLines(rows, roomDir);
}

function parseCli(argv) {
  const res = { _: [], out: null, servicePid: null, room: null, roomPids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { res.out = argv[++i]; continue; }
    if (a === '--service-pid') { res.servicePid = Number(argv[++i]); continue; }
    if (a === '--room') { res.room = argv[++i]; continue; }
    if (a === '--room-pids') { res.roomPids = String(argv[++i]).split(',').map(Number).filter(Number.isInteger); continue; }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    res._.push(a);
  }
  return res;
}

const fmt = (list) => list.map((p) => `${p.name}(${p.pid})`).join(', ') || '-';

// Returns {lines, ok, diff}: the PASS/FAIL/INFO lines for an after-session check. `roomPids` are
// pids of the room's own processes (service, room CLI children) used for the ancestry check;
// `parents` may be injected (tests), otherwise it is read live when the agent set changed.
export async function compareReport({ before, after, servicePid = null, roomDir = null, roomPids = [], parents = null, ambient = null }) {
  const lines = [];
  let ok = true;
  const d = diffProcessSets(before, after);
  const nAgents = after.processes.filter((p) => AGENT_PATTERN.test(p.name)).length;
  const pids = [...new Set([...(servicePid ? [servicePid] : []), ...roomPids])];
  if (d.agentAdded.length === 0 && d.agentRemoved.length === 0) {
    lines.push(`PASS pids(agents): codex|claude process set unchanged before vs after (${nAgents} processes); room-initiated start or termination of any agent process was not observed under PID-set comparison`);
  } else {
    let rows = parents || after.parents || null;
    if (!rows && d.agentAdded.length) { try { rows = await listProcessParents(); } catch (e) { lines.push(`INFO pids(ancestry): could not read parent process table (${e.message})`); } }
    const j = judgeAgentDiff(d, rows, pids);
    if (j.ok) {
      lines.push(`PASS pids(agents): agent process set had ${j.foreign.length} added [${fmt(j.foreign)}], 0 removed; agent processes with a room process (${pids.length} pids) as ancestor were not observed under PID-set + parent-chain comparison (additions came from other processes on the machine)`);
    } else {
      ok = false;
      lines.push(`FAIL pids(agents): agent process set changes were observed under PID-set comparison: added=[${fmt(d.agentAdded)}] removed=[${fmt(d.agentRemoved)}]`);
      if (j.attributed.length) lines.push(`INFO pids(ancestry): new agent processes with a room process as ancestor: ${j.attributed.map((p) => `${p.name}(${p.pid})<-${p.ancestor}`).join(', ')}`);
      if (j.unknown.length) lines.push(`INFO pids(ancestry): new processes missing from the parent table (cannot be attributed): ${fmt(j.unknown)}`);
      if (j.foreign.length) lines.push(`INFO pids(ancestry): new processes without a room process in their parent chain: ${fmt(j.foreign)}`);
      if (j.removed.length) lines.push('INFO pids(ancestry): disappeared agent processes cannot be attributed under this method (identifying the terminator requires ETW in P3); if agent processes also came and went during the baseline window, they are likely other local sessions and require manual review');
    }
  }
  if (ambient) lines.push(`INFO pids(baseline): during the baseline window (room stopped, same duration), ${ambient.agentAdded.length} agent processes were added and ${ambient.agentRemoved.length} removed (ambient machine noise reference)`);
  const nodeAdded = d.added.filter((p) => !AGENT_PATTERN.test(p.name));
  const nodeRemoved = d.removed.filter((p) => !AGENT_PATTERN.test(p.name));
  lines.push(`INFO pids(node): added=[${fmt(nodeAdded)}] removed=[${fmt(nodeRemoved)}] (node processes include the room's own children and other local sessions; recorded for reference only)`);
  if (servicePid) {
    if (pidAlive(servicePid)) { ok = false; lines.push(`FAIL pids(service): room service pid ${servicePid} is still alive after close`); }
    else lines.push(`PASS pids(service): room service pid ${servicePid} exited after close`);
  }
  if (roomDir) {
    const lock = path.join(roomDir, 'service.lock');
    const lockLive = fs.existsSync(lock);
    let live = [];
    let probeError = null;
    try { live = await findRoomServiceProcesses({ roomDir }); } catch (e) { probeError = e; }
    if (probeError) { ok = false; lines.push(`FAIL pids(service-cmdline): could not enumerate command lines (${probeError.message})`); }
    else if (live.length || lockLive) { ok = false; lines.push(`FAIL pids(service-cmdline): room service processes remain after close [${live.map((p) => p.pid).join(',') || '-'}] lock=${lockLive}`); }
    else lines.push(`PASS pids(service-cmdline): live room.mjs serve processes for ${roomDir} after close were not observed under command-line enumeration, and service.lock was removed`);
  }
  return { lines, ok, diff: d };
}

export async function main(argv, { out = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const args = parseCli(argv);
  const sub = args._[0];
  if (sub === 'snapshot') {
    const snap = await snapshotProcesses({ label: 'manual' });
    const text = JSON.stringify(snap, null, 1);
    if (args.out) {
      const abs = path.resolve(args.out);
      const dir = path.dirname(abs);
      const guard = createGuard({ allowed: [dir], logPath: path.join(dir, 'contract-write-log.jsonl'), who: 'contract' });
      guard.mkdir(dir);
      guard.writeFile(abs, text);
      out(`INFO pids(snapshot): ${snap.processes.length} processes matching ${snap.pattern}`);
      out(`RAW ${abs}`);
    } else out(text);
    return 0;
  }
  if (sub === 'compare') {
    const [bf, af] = [args._[1], args._[2]];
    if (!bf || !af) { out('FAIL pids: usage: pids.mjs compare <before.json> <after.json> [--service-pid <pid>] [--room <roomDir>] [--room-pids 1,2]'); return 1; }
    const before = JSON.parse(fs.readFileSync(bf, 'utf8'));
    const after = JSON.parse(fs.readFileSync(af, 'utf8'));
    const rep = await compareReport({ before, after, servicePid: args.servicePid, roomDir: args.room ? path.resolve(args.room) : null, roomPids: args.roomPids });
    for (const l of rep.lines) out(l);
    out(`RAW ${path.resolve(bf)}`); out(`RAW ${path.resolve(af)}`);
    return rep.ok ? 0 : 1;
  }
  if (sub === 'services') {
    const live = await findRoomServiceProcesses({ roomDir: args.room ? path.resolve(args.room) : null });
    for (const p of live) out(`INFO pids(services): ${p.pid} ${p.cmd}`);
    out(`INFO pids(services): ${live.length} room.mjs serve processes`);
    return 0;
  }
  out('FAIL pids: usage: pids.mjs snapshot [--out <file>] | compare <before.json> <after.json> [--service-pid <pid>] [--room <roomDir>] | services [--room <roomDir>]');
  return 1;
}

runCli(import.meta.url, main);
