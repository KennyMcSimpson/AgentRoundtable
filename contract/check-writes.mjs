#!/usr/bin/env node
// Contract 1 and the write-log half of contract 4 (plan §1.6 clauses 1 and 4; tests #40 and #43):
// every write the room reports in a write-log lies inside the directory its author may touch.
//   who=service | who=admin  -> inside <roomDir> (snapshot copies live under <roomDir>/snapshots)
//   who=seat:<id>            -> inside that seat's own outbox, and only in that outbox's own log
// and no room-side write lands in any seat's working directory (#43).
//
// The write-log is the room's own account (lib/guard.mjs appends one line per write), so this check
// proves "every write the guard saw was in bounds", not "no write happened elsewhere": a write that
// bypasses the guard never reaches the log. The independent check is a ProcMon / ETW pass, which the
// plan schedules for P3. Report wording therefore stays "未观测到".
//
//   node contract/check-writes.mjs <roomDir> [--outbox <dir>]...
// Outboxes default to the seats listed in <roomDir>/room.json; --outbox adds more (its basename is
// the seat id, as in <cwd>/.room-outbox/<seatId>). Exit 0 when every line is PASS, 1 otherwise.
//
// Paths are compared after canonicalization (realPathNative on the nearest existing ancestor), because
// the logged paths were resolved by other processes: a junction, a symlink or an 8.3 short name must
// not make an in-bounds write look outside, nor an outside write look inside.
import fs from 'node:fs';
import path from 'node:path';
import { virtualizationRedirect } from '../lib/common.mjs';
import { canonicalPath, runCli } from './harness.mjs';

export function normalizePath(p) {
  let r = path.resolve(p);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

// True when `child` equals `root` or lies below it. Pure string comparison on resolved paths; case
// folded on Windows. Does not touch the file system (callers canonicalize first when they need to).
export function isInsideRoot(child, root) {
  const c = normalizePath(child);
  const r = normalizePath(root);
  if (c === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(withSep);
}

// Malformed lines are kept as {malformed} rows so the checker can flag them.
export function readWriteLog(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch {
      // A torn final line is a process caught mid-append, not a forged entry.
      if (i === lines.length - 1) return;
      rows.push({ malformed: line.slice(0, 200) });
    }
  });
  return rows;
}

export function classifyAuthor(who) {
  if (who === 'service' || who === 'admin') return { kind: who, seatId: null };
  const m = /^seat:([A-Za-z0-9_-]+)$/.exec(String(who || ''));
  if (m) return { kind: 'seat', seatId: m[1] };
  return { kind: 'unknown', seatId: null };
}

// Pure. `entries` are write-log rows; `roomDir` is the service/admin root; `outboxes` maps
// seatId -> outbox directory; `seatCwds` maps seatId -> working directory. `source` labels which log
// the rows came from ('room' or 'seat:<id>'): a seat row inside the room's own log is a violation
// even when its path is in bounds, because the seat command never holds the room's log path.
// `canon` maps a path to the spelling to compare (identity by default; the CLI passes canonicalPath).
export function checkWriteLog({ entries, roomDir, outboxes = {}, seatCwds = {}, source = 'room', canon = (p) => p }) {
  const counts = {};
  const violations = [];
  let inSeatCwd = 0;
  const room = canon(roomDir);
  const snapshotsDir = path.join(room, 'snapshots');
  const boxes = Object.fromEntries(Object.entries(outboxes).map(([k, v]) => [k, canon(v)]));
  const cwds = Object.entries(seatCwds).map(([k, v]) => [k, canon(v)]);
  for (const e of entries) {
    if (e.malformed !== undefined || typeof e.path !== 'string' || !e.path) { violations.push({ who: e.who || null, op: e.op || null, path: e.path || null, reason: 'malformed_entry' }); continue; }
    const who = String(e.who || '');
    counts[who] = (counts[who] || 0) + 1;
    const p = canon(e.path);
    const author = classifyAuthor(who);
    if (author.kind === 'unknown') { violations.push({ who, op: e.op, path: e.path, reason: 'unknown_author' }); continue; }
    if (author.kind === 'service' || author.kind === 'admin') {
      if (source !== 'room') { violations.push({ who, op: e.op, path: e.path, reason: `room_author_in_${source}_log` }); continue; }
      const cwdHit = cwds.find(([, c]) => isInsideRoot(p, c));
      if (cwdHit) { inSeatCwd += 1; violations.push({ who, op: e.op, path: e.path, reason: `inside_seat_cwd:${cwdHit[0]}` }); continue; }
      if (!(isInsideRoot(p, room) || isInsideRoot(p, snapshotsDir))) violations.push({ who, op: e.op, path: e.path, reason: 'outside_room_dir' });
      continue;
    }
    // seat
    if (source !== `seat:${author.seatId}`) { violations.push({ who, op: e.op, path: e.path, reason: `seat_author_in_${source}_log` }); continue; }
    const outbox = boxes[author.seatId];
    if (!outbox) { violations.push({ who, op: e.op, path: e.path, reason: 'unknown_seat' }); continue; }
    if (!isInsideRoot(p, outbox)) violations.push({ who, op: e.op, path: e.path, reason: 'outside_outbox' });
  }
  return { counts, violations, total: entries.length, inSeatCwd };
}

function parseCli(argv) {
  const res = { _: [], outbox: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--outbox') { res.outbox.push(argv[++i]); continue; }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    res._.push(a);
  }
  return res;
}

// Seats from room.json (contract storage, INTERFACES §2): seatId -> {outbox, cwd}.
export function collectSeats(roomDir, extraOutboxes = []) {
  const outboxes = {};
  const cwds = {};
  const roomJson = path.join(roomDir, 'room.json');
  if (fs.existsSync(roomJson)) {
    try {
      const room = JSON.parse(fs.readFileSync(roomJson, 'utf8'));
      for (const s of room.seats || []) {
        if (!s.seatId) continue;
        if (s.outbox) outboxes[s.seatId] = path.resolve(s.outbox);
        if (s.cwd) cwds[s.seatId] = path.resolve(s.cwd);
      }
    } catch { /* unreadable room.json: fall through to explicit outboxes */ }
  }
  for (const o of extraOutboxes) outboxes[path.basename(path.resolve(o))] = path.resolve(o);
  return { outboxes, cwds };
}

// Back-compat name used by earlier callers.
export function collectOutboxes(roomDir, extra = []) { return collectSeats(roomDir, extra).outboxes; }

const fmtCounts = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ') || '-';

export function main(argv, { out = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const args = parseCli(argv);
  if (!args._[0]) { out('FAIL check-writes: 用法 check-writes.mjs <roomDir> [--outbox <dir>]...'); return 1; }
  const roomDir = path.resolve(args._[0]);
  const { outboxes, cwds } = collectSeats(roomDir, args.outbox);
  let failed = false;
  const report = (res, label, scopeText) => {
    if (res.violations.length === 0) out(`PASS ${label}: ${res.total} 条写入（${fmtCounts(res.counts)}），在 write-log 方法下未观测到${scopeText}之外的写入`);
    else {
      failed = true;
      out(`FAIL ${label}: ${res.total} 条写入（${fmtCounts(res.counts)}），在 write-log 方法下观测到 ${res.violations.length} 条越界或异常`);
      for (const v of res.violations) out(`  ${v.reason} who=${v.who} op=${v.op} path=${v.path}`);
    }
  };

  if (!fs.existsSync(roomDir)) { out(`FAIL write-log(room): 房间目录不存在 ${roomDir}`); return 1; }
  const redirect = virtualizationRedirect(roomDir);
  if (redirect) { failed = true; out(`FAIL location(room): 房间目录被重定向到 ${redirect.real}${redirect.packaged ? '（MSIX 包虚拟化，其他进程看不到原路径）' : ''}`); }
  else out(`PASS location(room): 在 realpath 比对下未观测到房间目录被重定向（${roomDir}）`);

  const roomLog = path.join(roomDir, 'write-log.jsonl');
  const roomRes = checkWriteLog({ entries: readWriteLog(roomLog), roomDir, outboxes, seatCwds: cwds, source: 'room', canon: canonicalPath });
  if (roomRes.total === 0) { failed = true; out(`FAIL write-log(room): ${roomLog} 为空或不存在，无法观测`); }
  else report(roomRes, 'write-log(room)', '房间目录（含 snapshots/）');
  out(`RAW ${roomLog}`);
  if (roomRes.total > 0) {
    const n = Object.keys(cwds).length;
    if (roomRes.inSeatCwd === 0) out(`PASS write-log(workdir): 房间侧 ${roomRes.total} 条写入，在 write-log 方法下未观测到落在 ${n} 个席位工作目录内的写入（#43 的 write-log 部分；写句柄与 git 调用由 P3 ProcMon 复核）`);
    else { failed = true; out(`FAIL write-log(workdir): 在 write-log 方法下观测到 ${roomRes.inSeatCwd} 条房间侧写入落在席位工作目录内`); }
  }

  for (const [seatId, outbox] of Object.entries(outboxes).sort()) {
    const seatLog = path.join(outbox, 'write-log.jsonl');
    const res = checkWriteLog({ entries: readWriteLog(seatLog), roomDir, outboxes, seatCwds: cwds, source: `seat:${seatId}`, canon: canonicalPath });
    if (res.total === 0) out(`SKIP write-log(seat ${seatId}): 发件箱无 write-log（该席位未运行过 room 命令），无写入可观测`);
    else report(res, `write-log(seat ${seatId})`, '本席位发件箱');
    out(`RAW ${seatLog}`);
  }
  if (Object.keys(outboxes).length === 0) out('INFO write-log: 没有已知的席位发件箱（room.json 无席位且未给 --outbox）');
  return failed ? 1 : 0;
}

runCli(import.meta.url, main);
