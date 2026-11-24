// dist/public-scan.mjs and dist/export-public.mjs: generic scan rules and external --deny-file
// rules (literals and /regex/flags) catch each shape, a planted hit in a temp copy fails the
// export (exit 1, hit listed, nothing rewritten), docs/internal/, dist/out/ and retired host
// plugins never reach the copy, and the repository's own tracked tree exports clean.
// Every planted value is built by concatenation so that this file passes the scan itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testRunsRoot } from '../lib/common.mjs';
import { scanText, isPublicPath, readDenyFile } from '../dist/public-scan.mjs';
import { exportPublic, ExportRefusal, PUBLIC_GITIGNORE } from '../dist/export-public.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'dist', 'export-public.mjs');
const rand = Math.random().toString(16).slice(2, 8);
const base = path.join(testRunsRoot(), `export-public-${rand}`);
after(() => fs.rmSync(base, { recursive: true, force: true }));

const PLANTED_EMAIL = 'alice' + '@' + 'corp.internal.org';
const PLANTED_UUID = ['3f2b9c1e', '7a44', '4d0e', '9b1f', '2c6e8d5a7f90'].join('-');

const gitOk = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const isCheckout = gitOk && spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', windowsHide: true }).stdout.trim() === 'true';

function cleanEnv() {
  const env = { ...process.env };
  delete env.ROOM_PUBLIC_SCAN_DENY;
  return env;
}
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000, env: cleanEnv() });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function rules(text, opts) { return scanText(text, opts).map((h) => h.rule); }

test('rules: generic secret, email, UUID and external deny rules (literal + regex) are caught', () => {
  assert.deepEqual(rules(`mail ${PLANTED_EMAIL}`), ['email']);
  assert.deepEqual(rules(`thread ${PLANTED_UUID}`), ['session-id']);
  assert.deepEqual(rules('token ' + 'ghp_' + 'A1b2'.repeat(9)), ['key']);
  assert.deepEqual(rules('k=' + 'AKIA' + 'Q3ZT7RLM2VWN8HXP'), ['key']);
  assert.deepEqual(rules('entries/' + 'some-private-entry-name.md', { deny: ['Some-Private-Entry-Name'] }), ['deny']);
  assert.deepEqual(rules('path Z:\\secret-lab\\notes.md', { deny: ['/\\bZ:[\\\\/]+secret-lab\\b/i'] }), ['deny']);
  const hit = scanText(`a\nb ${PLANTED_EMAIL}\n`)[0];
  assert.equal(hit.line, 2, 'line numbers are 1-based');
});

test('rules: synthetic and public values pass', () => {
  for (const ok of [
    'Copyright (c) 2026 room-dev contributors',
    'node D:/tools/room-dev/room.mjs wait --seat C:/Users/u/room-dev/rooms/x/seats/A',
    'C:\\Users\\someone\\AppData\\Local\\Packages\\Claude_x\\LocalCache',
    '01a0f000-0000-7000-8000-00000000a001 c1a0f000-0000-4000-8000-000000000b00',
    'noreply' + '@' + 'anthropic.com and a' + '@' + 'example.com',
    'sk-' + 'ant-' + 'FAKE-' + '0'.repeat(20),
    "OPENAI_API_KEY: 'canary-value-2'",
    '@earendil-works/pi-coding-agent',
    'E:\\fixture\\x and E:/probe/y',
  ]) assert.deepEqual(scanText(ok), [], ok);
});

test('public paths leave out docs/internal, dist/out and integrations/pi-desktop-plugin', () => {
  for (const p of [
    'docs/internal/P-1-REPORT.md', 'docs/internal', 'dist/out/public/README.md',
    'integrations/pi-desktop-plugin', 'integrations/pi-desktop-plugin/plugin/main.js',
  ]) assert.equal(isPublicPath(p), false, p);
  for (const p of ['docs/INTERFACES.md', 'dist/export-public.mjs', 'docs/internals.md', 'README.md']) assert.equal(isPublicPath(p), true, p);
});

function makeSource(dir, planted) {
  const files = {
    'README.md': '# demo\n\nA clean front page.\n',
    'LICENSE': fs.readFileSync(path.join(ROOT, 'LICENSE')),
    'lib/x.mjs': planted ? `// contact: ${PLANTED_EMAIL}\nexport const x = 1;\n` : 'export const x = 1;\n',
    'docs/internal/NOTE.md': `internal record: ${PLANTED_EMAIL}\n`,
    'dist/out/junk.txt': `build output ${PLANTED_UUID}\n`,
    'integrations/pi-desktop-plugin/plugin/main.js': `// retired plugin: ${PLANTED_EMAIL}\n`,
    'app/icon.bin': Buffer.from([0, 1, 2, 0, 255]),
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return Object.keys(files);
}

test('export: a planted hit fails with exit 1 and is listed; nothing is rewritten; excluded dirs stay out', { skip: !gitOk && 'git not available' }, () => {
  const src = path.join(base, 'src');
  const out = path.join(base, 'out');
  makeSource(src, true);
  for (const a of [['init', '-q'], ['add', '-A']]) {
    const g = spawnSync('git', ['-C', src, ...a], { encoding: 'utf8', windowsHide: true });
    assert.equal(g.status, 0, g.stderr);
  }
  let r = run([out, '--root', src]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lib\/x\.mjs:1 \[email\]/);
  assert.match(r.out, /PUBLIC_SCAN_FAIL hits=1 /);
  assert.ok(!/NOTE\.md|junk\.txt|pi-desktop-plugin/.test(r.out), 'excluded files are neither copied nor scanned');
  assert.ok(fs.readFileSync(path.join(out, 'lib', 'x.mjs')).equals(fs.readFileSync(path.join(src, 'lib', 'x.mjs'))), 'the hit is copied as is, not redacted');
  assert.ok(!fs.existsSync(path.join(out, 'docs', 'internal')), 'docs/internal/ not copied');
  assert.ok(!fs.existsSync(path.join(out, 'dist', 'out')), 'dist/out/ not copied');
  assert.ok(!fs.existsSync(path.join(out, 'integrations', 'pi-desktop-plugin')), 'integrations/pi-desktop-plugin/ not copied');

  // Not empty now: refused without --replace, nothing touched.
  r = run([out, '--root', src]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /REFUSED/);

  // Fixed in the source: the export passes, binary files are copied byte for byte.
  makeSource(src, false);
  r = run([out, '--root', src, '--replace']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /EXPORTED files=4 /);
  assert.match(r.out, /PUBLIC_SCAN_OK files=5 text=4 binary=1 /);
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), PUBLIC_GITIGNORE);
  assert.ok(fs.readFileSync(path.join(out, 'app', 'icon.bin')).equals(Buffer.from([0, 1, 2, 0, 255])));
  assert.ok(!fs.existsSync(path.join(out, 'docs', 'internal')));
  assert.ok(!fs.existsSync(path.join(out, 'integrations', 'pi-desktop-plugin')));

  // A deny file adds both literals and /regex/flags rules without putting them in the repository.
  const deny = path.join(base, 'deny.txt');
  fs.writeFileSync(deny, '# private rules\nclean front\n/^export const x = 1;/m\n');
  assert.equal(readDenyFile(deny).length, 2);
  r = run([out, '--root', src, '--replace', '--deny-file', deny]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /README\.md:3 \[deny\] clean front/);
  assert.match(r.out, /lib\/x\.mjs:1 \[deny\] export const x = 1;/);
});

test('export refuses an outDir that is the repository, around it, or inside it outside dist/out', async () => {
  const src = path.join(base, 'refuse-src');
  const files = makeSource(src, false);
  await assert.rejects(exportPublic({ root: src, files, outDir: src }), ExportRefusal);
  await assert.rejects(exportPublic({ root: src, files, outDir: base }), ExportRefusal);
  await assert.rejects(exportPublic({ root: src, files, outDir: path.join(src, 'docs', 'public') }), ExportRefusal);
  const withGit = path.join(base, 'has-git');
  fs.mkdirSync(path.join(withGit, '.git'), { recursive: true });
  await assert.rejects(exportPublic({ root: src, files, outDir: withGit, replace: true }), /\.git/);
  assert.ok(fs.existsSync(path.join(withGit, '.git')), 'a folder holding .git is never deleted');
  const r = await exportPublic({ root: src, files, outDir: path.join(src, 'dist', 'out', 'public') });
  assert.equal(r.ok, true);
  assert.equal(r.excluded, 3, 'docs/internal/NOTE.md, dist/out/junk.txt and integrations/pi-desktop-plugin excluded');
});

test("export: this repository's tracked tree exports clean", { skip: !isCheckout && 'not a git checkout' }, () => {
  const out = path.join(base, 'repo-public');
  const r = run([out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PUBLIC_SCAN_OK /);
  for (const f of ['LICENSE', 'README.md', 'room.mjs', 'dist/public-scan.mjs', 'dist/export-public.mjs', 'docs/SUPPORT-MATRIX.md']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, 'docs', 'internal')), 'docs/internal/ not exported');
  assert.ok(!fs.existsSync(path.join(out, 'integrations', 'pi-desktop-plugin')), 'integrations/pi-desktop-plugin/ not exported');
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), PUBLIC_GITIGNORE);
});
