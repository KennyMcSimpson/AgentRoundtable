#!/usr/bin/env node
// Entry-level diff of memory / config directories (plan §1.6 test methods, #45b, #40b).
// A snapshot is the sorted list of entries under each target (relative path, kind, size, sha256 of
// file content). Modification times are never part of a snapshot: other tools touch mtimes without
// changing content, and content is what the contract is about.
//
//   node contract/memory-diff.mjs <target>... --save <snapshot.json>       take a snapshot now
//   node contract/memory-diff.mjs [<target>...] --against <snapshot.json>  compare now vs. saved
//   node contract/memory-diff.mjs --before <a.json> --after <b.json>        compare two saved snapshots
//
// A target may be a directory or a single file; a missing target is recorded as absent (and a
// target that appears or disappears between snapshots is itself a difference).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGuard } from '../lib/guard.mjs';
import { runCli } from './harness.mjs';

const SNAPSHOT_SCHEMA = 1;

export function sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function entryFor(abs, rel) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) {
    let link = '';
    try { link = fs.readlinkSync(abs); } catch { /* unreadable link target */ }
    return { path: rel, kind: 'symlink', size: 0, sha256: crypto.createHash('sha256').update(link).digest('hex') };
  }
  if (st.isDirectory()) return { path: rel, kind: 'dir', size: 0, sha256: null };
  if (st.isFile()) {
    try { return { path: rel, kind: 'file', size: st.size, sha256: sha256File(abs) }; }
    catch (e) { return { path: rel, kind: 'file', size: st.size, sha256: null, error: e.code || String(e) }; }
  }
  return { path: rel, kind: 'other', size: 0, sha256: null };
}

// Lists every entry below `root` (files, directories, symlinks), sorted by relative posix path.
// A file root yields exactly one entry with path "".
export function listEntries(root) {
  const abs = path.resolve(root);
  let st;
  try { st = fs.lstatSync(abs); } catch { return { exists: false, entries: [] }; }
  if (!st.isDirectory()) {
    const e = entryFor(abs, '');
    return { exists: true, entries: e ? [e] : [] };
  }
  const entries = [];
  const walk = (dirAbs, relPrefix) => {
    let names;
    try { names = fs.readdirSync(dirAbs); } catch { return; }
    for (const name of names.sort()) {
      const childAbs = path.join(dirAbs, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const e = entryFor(childAbs, rel);
      if (!e) continue;
      entries.push(e);
      if (e.kind === 'dir') walk(childAbs, rel);
    }
  };
  walk(abs, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { exists: true, entries };
}

export function snapshotTargets(targets, { label = null } = {}) {
  return {
    schema_version: SNAPSHOT_SCHEMA,
    takenAt: new Date().toISOString(),
    label,
    targets: targets.map((t) => {
      const target = typeof t === 'string' ? { path: t, group: null } : t;
      const abs = path.resolve(target.path);
      const { exists, entries } = listEntries(abs);
      return { path: abs, group: target.group || null, exists, entries };
    }),
  };
}

function keyOf(t) { return process.platform === 'win32' ? t.path.toLowerCase() : t.path; }

// Pure: compares two snapshots target by target, entry by entry. Returns one record per difference.
export function diffSnapshots(before, after) {
  const diffs = [];
  const bTargets = new Map((before.targets || []).map((t) => [keyOf(t), t]));
  const aTargets = new Map((after.targets || []).map((t) => [keyOf(t), t]));
  const keys = new Set([...bTargets.keys(), ...aTargets.keys()]);
  for (const k of [...keys].sort()) {
    const b = bTargets.get(k);
    const a = aTargets.get(k);
    const targetPath = (a || b).path;
    const group = (a && a.group) || (b && b.group) || null;
    if (!b || !a) { diffs.push({ target: targetPath, group, path: '', change: !b ? 'target_added' : 'target_removed' }); continue; }
    if (b.exists !== a.exists) { diffs.push({ target: targetPath, group, path: '', change: a.exists ? 'target_appeared' : 'target_disappeared' }); continue; }
    const bMap = new Map(b.entries.map((e) => [e.path, e]));
    const aMap = new Map(a.entries.map((e) => [e.path, e]));
    for (const [p, be] of bMap) {
      const ae = aMap.get(p);
      if (!ae) { diffs.push({ target: targetPath, group, path: p, change: 'removed', before: be }); continue; }
      if (be.kind !== ae.kind || be.sha256 !== ae.sha256 || be.size !== ae.size) diffs.push({ target: targetPath, group, path: p, change: 'changed', before: be, after: ae });
    }
    for (const [p, ae] of aMap) if (!bMap.has(p)) diffs.push({ target: targetPath, group, path: p, change: 'added', after: ae });
  }
  return diffs;
}

export function diffKey(d) { return `${keyOf({ path: d.target })}::${d.path}`; }

export function countEntries(snapshot) { return snapshot.targets.reduce((n, t) => n + t.entries.length, 0); }

export function formatDiff(d) {
  const sha = (e) => (e && e.sha256 ? e.sha256.slice(0, 12) : '-');
  const detail = d.change === 'changed' ? ` ${sha(d.before)}->${sha(d.after)} ${d.before.size}->${d.after.size}B` : '';
  return `${d.change} ${d.target}${d.path ? `/${d.path}` : ''}${detail}`;
}

function parseCli(argv) {
  const res = { _: [], before: null, after: null, save: null, against: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--before' || a === '--after' || a === '--save' || a === '--against') { res[a.slice(2)] = argv[++i]; continue; }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    res._.push(a);
  }
  return res;
}

function readSnapshot(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// Exit 0 when no FAIL line was printed, 1 otherwise. A saved snapshot is written through a guard
// confined to the snapshot's own directory.
export function main(argv, { out = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const args = parseCli(argv);
  let before; let after; let raw = [];
  if (args.before && args.after) {
    before = readSnapshot(args.before); after = readSnapshot(args.after); raw = [args.before, args.after];
  } else if (args.save) {
    if (!args._.length) { out('FAIL memory-diff: --save requires at least one <target>'); return 1; }
    const snap = snapshotTargets(args._, { label: 'manual' });
    const saveAbs = path.resolve(args.save);
    const dir = path.dirname(saveAbs);
    const guard = createGuard({ allowed: [dir], logPath: path.join(dir, 'contract-write-log.jsonl'), who: 'contract' });
    guard.mkdir(dir);
    guard.writeFile(saveAbs, JSON.stringify(snap, null, 1));
    out(`INFO memory-diff: snapshotted ${snap.targets.length} targets, ${countEntries(snap)} entries (entry = relative path + kind + size + sha256, excluding mtime)`);
    out(`RAW ${saveAbs}`);
    return 0;
  } else if (args.against) {
    before = readSnapshot(args.against);
    const targets = args._.length ? args._ : before.targets.map((t) => ({ path: t.path, group: t.group }));
    after = snapshotTargets(targets, { label: 'now' });
    raw = [args.against];
  } else {
    out('FAIL memory-diff: usage: memory-diff.mjs <target>... --save <file> | [<target>...] --against <file> | --before <a> --after <b>');
    return 1;
  }
  const diffs = diffSnapshots(before, after);
  const nTargets = after.targets.length;
  const nEntries = countEntries(after);
  if (diffs.length === 0) {
    out(`PASS memory-diff: ${nTargets} targets, ${nEntries} entries; differences were not observed under entry-level sha256 comparison (excluding mtime)`);
  } else {
    out(`FAIL memory-diff: ${nTargets} targets, ${nEntries} entries; ${diffs.length} entry differences were observed under entry-level sha256 comparison`);
    for (const d of diffs) out(`  ${formatDiff(d)}`);
  }
  for (const r of raw) out(`RAW ${path.resolve(r)}`);
  return diffs.length === 0 ? 0 : 1;
}

runCli(import.meta.url, main);
