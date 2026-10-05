// The manifest and panel page carry what the pi-desktop-plugins marketplace asks for (its AGENTS.md
// "Manifest Requirements", CONTRIBUTING.md "Recommended fields for marketplace quality" and "Panel
// title and host chrome compatibility", and the checks scripts/security_audit.py and
// tests/panel-chrome.test.mjs make there), so a submission does not depend on hand edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE_FRAGMENTS, SURFACE_LINES } from '../../../lib/surface.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'));
const panelHtml = fs.readFileSync(path.join(PLUGIN, 'renderer', 'index.html'), 'utf8');

test('identity, entry, engine and the exact permission list', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'io.github.kennymcsimpson.governed-roundtable');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.author, 'KennyMcSimpson');
  assert.equal(manifest.main, 'main.js');
  assert.deepEqual(manifest.permissions, ['ui.panel', 'agent.tool.register', 'background.service', 'agent.complete', 'shell.openExternal']);
  // The only release whose source was read (shallow clone of PI-Desktop at v0.16.1).
  assert.deepEqual(manifest.engines, { piDesktop: '>=0.16.1' });
});

test('marketplace fields: categories, changelog, safety notes in en and zh-CN', () => {
  assert.deepEqual(manifest.categories, ['developer-tools', 'productivity', 'community']);
  assert.equal(typeof manifest.changelog, 'string');
  assert.match(manifest.changelog, /^Release 0\.1\.0: /);
  for (const locale of ['en', 'zh-CN']) {
    const e = manifest.i18n[locale];
    for (const field of ['name', 'description', 'safetyNotes']) assert.ok(typeof e[field] === 'string' && e[field].trim(), `i18n.${locale}.${field}`);
  }
  // The catalog reads the top-level safetyNotes (rebuild_catalog.py); keep it the English text.
  assert.equal(manifest.safetyNotes, manifest.i18n.en.safetyNotes);
  assert.match(manifest.i18n.en.safetyNotes, /^High risk\./);
  assert.match(manifest.i18n['zh-CN'].safetyNotes, /^高风险。/);
  for (const s of [manifest.i18n.en.safetyNotes, manifest.i18n['zh-CN'].safetyNotes]) {
    assert.match(s, /admin\.token/, 'safety notes name the admin token file');
    assert.match(s, /agent\.complete/, 'safety notes name the model-quota use');
    assert.match(s, /adjudications\.jsonl/, 'safety notes name the one write outside the rooms folder');
    assert.match(s, /\.claude\\projects/, 'safety notes name the read-only native-log reads');
  }
});

test('panel: bilingual title, declared page, the host chrome contract documented', () => {
  assert.equal(manifest.ui.panel, 'renderer/index.html');
  assert.deepEqual(manifest.ui.title, { en: 'Governed Roundtable', 'zh-CN': '圆桌' });
  assert.match(panelHtml, /<meta\s+name="pi-plugin-chrome"\s+content="v3"\s*\/>/);
  assert.match(panelHtml, /PI-Desktop owns exactly (?:a transparent 46px drag band|a 46px drag band)/);
  assert.match(panelHtml, /three-button[\s\S]*window-control capsule/);
  assert.match(panelHtml, /var\(--pi-plugin-titlebar-height, 46px\)/);
});

test('README (the marketplace detail page) explains every permission and says plainly what is not verified', () => {
  const readme = fs.readFileSync(path.join(PLUGIN, '..', 'README.md'), 'utf8');
  for (const p of manifest.permissions) assert.match(readme, new RegExp(`^\\| \`${p.replace(/\./g, '\\.')}\` \\|`, 'm'), `permissions table row for ${p}`);
  assert.match(readme, /## Capability and data-flow matrix/);
  assert.match(readme, /not yet loaded in a real PI-Desktop/);
  assert.match(readme, /PI seats are not\s+(?:>\s*)?woken automatically/);
  assert.match(readme, /hosted seats are discussion-only/);
  const zh = fs.readFileSync(path.join(PLUGIN, '..', 'README.zh-CN.md'), 'utf8');
  for (const p of manifest.permissions) assert.match(zh, new RegExp(`^\\| \`${p.replace(/\./g, '\\.')}\` \\|`, 'm'), `zh-CN permissions table row for ${p}`);
  assert.match(zh, /还没有装进真实的 PI-Desktop/);
});

test('contributions match the permissions (the marketplace audit blocks a mismatch)', () => {
  const c = manifest.contributes;
  assert.deepEqual(c.agentTools.map((t) => t.name), ['Room']);
  assert.equal(c.agentTools[0].risk, 'high');
  assert.deepEqual(c.services.map((s) => s.id), ['room-host']);
  assert.deepEqual(c.commands.map((x) => x.id), ['roundtable.openPanel']);
  assert.equal(c.skills, undefined, 'no skills, so no agent.prompt.inject');
  assert.ok(!manifest.permissions.includes('desktop.control'));
  assert.ok(!manifest.permissions.includes('net.fetch'));
});

test('the Room tool schema covers every call a tool-seat packet names (room-dev lib/surface.mjs)', () => {
  const schema = manifest.contributes.agentTools[0].schema;
  const texts = [...Object.values(SURFACE_FRAGMENTS.tool).flat().map((f) => f.text), ...Object.values(SURFACE_LINES.tool)];
  const actions = new Set(texts.flatMap((t) => [...t.matchAll(/"action":"([^"]+)"/g)].map((m) => m[1])));
  // The preamble also lists the actions as a pipe list ("action 取 wait|submit|...").
  for (const t of texts) for (const m of t.matchAll(/action 取 ([a-z|]+)/g)) for (const a of m[1].split('|')) actions.add(a);
  assert.ok(actions.has('leave') && actions.has('wait'), 'the preamble pipe list is read');
  assert.ok(actions.size > 0);
  for (const a of actions) assert.ok(schema.properties.action.enum.includes(a), `action ${a} is in the schema`);
  for (const t of texts) for (const m of t.matchAll(/"([A-Za-z_]+)":/g)) assert.ok(Object.hasOwn(schema.properties, m[1]), `field ${m[1]} is a schema property`);
});
