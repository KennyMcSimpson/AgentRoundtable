// lib/ must run on its own: hosts such as PI-Desktop vendor only room.mjs, lib/** and ui/ (no dist/,
// no test/), so no module under lib/ may import from dist/, test/, sim/, contract/ or evidence/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const FORBIDDEN = /(?:from\s+|import\s*\(\s*)['"](\.\.\/)+(dist|test|sim|contract|evidence)\//;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else if (/\.m?js$/.test(e.name)) acc.push(p);
  }
  return acc;
}

test('no lib/ module imports from dist/, test/, sim/, contract/ or evidence/', () => {
  const offenders = [];
  for (const f of walk(LIB)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => { if (!/^\s*\/\//.test(l) && FORBIDDEN.test(l)) offenders.push(`${path.relative(LIB, f)}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(offenders, []);
});

test('the pattern catches a dist import (negative control)', () => {
  assert.ok(FORBIDDEN.test("const { exportRoom } = await import('../dist/export.mjs');"));
  assert.ok(FORBIDDEN.test("import { x } from '../../test/helpers.mjs';"));
  assert.ok(!FORBIDDEN.test("import { x } from './export.mjs';"));
});

test('admin export runs with only lib/ available (the vendored layout)', async () => {
  const mod = await import('../lib/export.mjs');
  assert.equal(typeof mod.exportRoom, 'function');
  assert.equal(typeof mod.scanText, 'function');
});
