// node --test test/guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGuard, renameRetry, GuardViolation } from '../lib/guard.mjs';
import { spawnClean } from '../lib/spawn.mjs';
import { testRunsRoot, readJsonl, sleep } from '../lib/common.mjs';

const NODE = process.execPath;

// testRunsRoot(), never %LOCALAPPDATA% (MSIX redirection, INTERFACES §1).
function tempRoot() {
  const dir = path.join(testRunsRoot(), crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function rmTree(dir) { await fs.promises.rm(dir, { recursive: true, force: true }); }
const errCode = (code) => Object.assign(new Error(code), { code });
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n));

test('guard refuses writes outside its roots', async () => {
  const root = tempRoot();
  try {
    const g = createGuard({ allowed: [path.join(root, 'in')], logPath: path.join(root, 'in', 'log.jsonl'), who: 't' });
    assert.throws(() => g.atomicWrite(path.join(root, 'out.json'), '{}'), GuardViolation);
    assert.throws(() => g.rename(path.join(root, 'in', 'a'), path.join(root, 'b')), GuardViolation);
  } finally { await rmTree(root); }
});

test('renameRetry retries EPERM/EACCES/EBUSY, not other codes, and gives up after its budget', () => {
  let n = 0;
  const flaky = () => { n++; if (n <= 2) throw errCode(n === 1 ? 'EPERM' : 'EBUSY'); };
  assert.equal(renameRetry('a', 'b', { renameFn: flaky }), 2);
  assert.equal(n, 3);

  let m = 0;
  assert.throws(() => renameRetry('a', 'b', { renameFn: () => { m++; throw errCode('ENOENT'); } }), (e) => e.code === 'ENOENT');
  assert.equal(m, 1, 'ENOENT is not retried');

  let k = 0;
  const started = Date.now();
  assert.throws(() => renameRetry('a', 'b', { renameFn: () => { k++; throw errCode('EACCES'); }, budget: { budgetMs: 120, firstDelayMs: 1, maxDelayMs: 20 } }), (e) => e.code === 'EACCES');
  assert.ok(k > 3, `expected several attempts, got ${k}`);
  assert.ok(Date.now() - started < 2000, 'bounded');
});

test('atomicWrite that cannot rename removes its tmp file and rethrows; target keeps old content', async () => {
  const root = tempRoot();
  try {
    const target = path.join(root, 'state.json');
    fs.writeFileSync(target, 'old');
    const g = createGuard({
      allowed: [root], logPath: path.join(root, 'write-log.jsonl'), who: 't',
      renameFn: () => { throw errCode('EPERM'); },
    });
    assert.throws(() => g.atomicWrite(target, 'new'), (e) => e.code === 'EPERM');
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(tmpLeftovers(root), []);
    // a transient failure is absorbed and logged with its retry count
    let fails = 2;
    const g2 = createGuard({
      allowed: [root], logPath: path.join(root, 'write-log.jsonl'), who: 't',
      renameFn: (s, d) => { if (fails-- > 0) throw errCode('EBUSY'); fs.renameSync(s, d); },
    });
    g2.atomicWrite(target, 'new');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    const last = readJsonl(path.join(root, 'write-log.jsonl')).at(-1);
    assert.equal(last.op, 'write');
    assert.equal(last.retries, 2);
    assert.deepEqual(tmpLeftovers(root), []);
  } finally { await rmTree(root); }
});

// W2: a seat polling state.json (readFileSync in a loop) while the service replaces it. Before the
// retry, renameSync threw EPERM on most writes and left *.tmp-<pid> files behind.
test('atomicWrite survives a concurrent reader process (Windows share modes) and leaves no tmp files', async () => {
  const root = tempRoot();
  try {
    const dir = path.join(root, '房间 目录');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'state.json');
    const g = createGuard({ allowed: [dir], logPath: path.join(dir, 'write-log.jsonl'), who: 'service' });
    g.atomicWrite(target, JSON.stringify({ seq: 0 }));
    const readerMs = 2600;
    const reader = spawnClean(NODE, ['-e', `
      const fs = require('fs'); const p = process.argv[1];
      const end = Date.now() + ${readerMs}; let reads = 0, errors = 0, codes = {};
      while (Date.now() < end) {
        try { JSON.parse(fs.readFileSync(p, 'utf8')); reads++; } catch (e) { errors++; codes[e.code || 'PARSE'] = (codes[e.code || 'PARSE'] || 0) + 1; }
      }
      console.log(JSON.stringify({ reads, errors, codes }));`, target], { timeoutMs: 20_000 });
    await sleep(300);
    let writes = 0;
    const thrown = [];
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      try { g.atomicWrite(target, JSON.stringify({ seq: ++writes, pad: 'x'.repeat(2000) })); } catch (e) { thrown.push(e.code || e.message); }
      await sleep(5);
    }
    const r = await reader;
    assert.equal(r.code, 0, r.stderr);
    const seen = JSON.parse(r.stdout);
    assert.ok(seen.reads > 0, 'the reader really ran');
    assert.deepEqual(thrown, [], `atomicWrite threw: ${thrown.slice(0, 5).join(', ')}`);
    // A sanity floor only (each contended write may back off for a while under a loaded test run);
    // the property under test is "no throw, no tmp leftovers".
    assert.ok(writes >= 5, `writes=${writes}`);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).seq, writes);
    assert.deepEqual(tmpLeftovers(dir), []);
  } finally { await rmTree(root); }
});
