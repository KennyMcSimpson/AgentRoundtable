// node --test test/surface.test.mjs
// Pure-function tests for lib/surface.mjs (INTERFACES §5a): which surface a seat has, the
// --surface argument, and the per-surface text that replaces the templates' command lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEAT_SURFACES, SURFACE_TOOL_RE, SURFACE_FRAGMENTS, SURFACE_LINES, SURFACE_HASH,
  seatSurface, parseSurfaceArg, surfaceLine, surfaceText,
} from '../lib/surface.mjs';
import { loadTemplates, lintTemplate, fillTemplate, TEMPLATE_NAMES } from '../lib/packet.mjs';
import { AGENT_KIND_NAMES } from '../lib/join.mjs';
import { parseMarkers, resolveSubmission } from '../lib/structured.mjs';
import { SEAT_COMMANDS } from '../lib/seat.mjs';

// A command line, a seat-command flag or an unfilled placeholder: none may reach a tool or hosted seat.
const CLI_LEAK = /room\.mjs|room\.cmd|--(?:seat|attempt|file|declare|seq|text|item|status|artifact|arg|argv-file|reason|log|baseline|exclude)\b|子命令|\{\{/;
const CLI_ONLY = /\{\{\s*(roomCmd|seatDir)\s*\}\}/;
const T = loadTemplates().templates;
const fragments = (kind) => Object.values(SURFACE_FRAGMENTS[kind]).flat();
const texts = (kind) => [...fragments(kind).map((f) => f.text), ...Object.values(SURFACE_LINES[kind])];

// ---------------------------------------------------------------- seatSurface

test('seatSurface: hosted wins, a valid tool surface is a tool, anything else is cli; frozen', () => {
  assert.deepEqual(SEAT_SURFACES, ['cli', 'tool', 'hosted']);
  const tool = { kind: 'tool', tool: 'plugin_x_Room' };
  assert.deepEqual(seatSurface({ hosted: { kind: 'pi', tier: 'discussion' } }), { kind: 'hosted' });
  assert.deepEqual(seatSurface({ hosted: { kind: 'lane', lane: 'pi-complete', tier: 'discussion' } }), { kind: 'hosted' });
  assert.deepEqual(seatSurface({ hosted: { kind: 'pi', tier: 'exec' }, surface: tool }), { kind: 'hosted' });
  // The agent kind never decides the surface.
  assert.deepEqual(seatSurface({ agent: 'pi-user' }), { kind: 'cli' });
  assert.deepEqual(seatSurface({ agent: 'pi-user', surface: tool }), tool);
  for (const seat of [{ surface: { kind: 'tool', tool: '1bad' } }, { surface: { kind: 'tool', tool: 'a b' } }, { surface: { kind: 'tool' } },
    { surface: 'tool:plugin_x_Room' }, { surface: { kind: 'cli' } }, null, undefined, ...AGENT_KIND_NAMES.map((agent) => ({ agent }))]) {
    assert.deepEqual(seatSurface(seat), { kind: 'cli' }, JSON.stringify(seat));
  }
  for (const seat of [{}, { surface: tool }, { hosted: { kind: 'pi' } }]) assert.ok(Object.isFrozen(seatSurface(seat)));
});

// ---------------------------------------------------------------- parseSurfaceArg

test('parseSurfaceArg: cli or absent stores nothing, tool:<name> stores the tool, the rest is refused', () => {
  assert.deepEqual(parseSurfaceArg(undefined), { surface: null });
  assert.deepEqual(parseSurfaceArg('cli'), { surface: null });
  assert.deepEqual(parseSurfaceArg('tool:Room'), { surface: { kind: 'tool', tool: 'Room' } });
  assert.deepEqual(parseSurfaceArg('tool:plugin_io_github_x_Room'), { surface: { kind: 'tool', tool: 'plugin_io_github_x_Room' } });
  assert.ok(SURFACE_TOOL_RE.test('a'.repeat(128)));
  for (const v of [true, '', 'tool', 'tool:', 'tool:1x', 'tool:a b', `tool:${'a'.repeat(129)}`, 'gui', 'hosted']) {
    const r = parseSurfaceArg(v);
    assert.ok(r.error && !r.surface, JSON.stringify(v));
    assert.match(r.error, /^--surface cli\|tool:/);
  }
});

// ---------------------------------------------------------------- coverage guard

test('fragments cover every command line of the shipped templates, one prefix per line', () => {
  const sets = {
    tool: ['preamble', 'role-executor', 'role-lead', 'role-participant', 'role-reviewer', 'phase-assign', 'phase-work', 'phase-summary', 'farewell'],
    hosted: ['preamble', 'role-executor', 'role-lead', 'role-participant', 'role-reviewer', 'phase-assign', 'phase-work', 'phase-meet', 'phase-summary', 'farewell'],
  };
  for (const kind of ['tool', 'hosted']) {
    assert.deepEqual(Object.keys(SURFACE_FRAGMENTS[kind]).sort(), [...sets[kind]].sort(), kind);
    for (const name of TEMPLATE_NAMES) {
      const lines = T[name].split('\n');
      const rules = SURFACE_FRAGMENTS[kind][name] || [];
      for (const line of lines.filter((l) => CLI_ONLY.test(l))) {
        assert.equal(rules.filter((r) => line.startsWith(r.prefix)).length, 1, `${kind} ${name}: ${line}`);
      }
      for (const r of rules) assert.equal(lines.filter((l) => l.startsWith(r.prefix)).length, 1, `${kind} ${name} prefix ${r.prefix}`);
    }
  }
});

// ---------------------------------------------------------------- hygiene

test('fragments and lines lint clean, leak no command line, and name only real actions and fields', () => {
  const vars = { roomId: 'p2', attemptId: 'a1', toolName: 'T' };
  for (const kind of ['tool', 'hosted']) {
    for (const x of texts(kind)) assert.deepEqual(lintTemplate(x, { requireAuthorityRule: false }), [], x);
    for (const f of fragments(kind)) assert.doesNotMatch(fillTemplate(f.text, vars), CLI_LEAK, f.text);
    // turnSubmit is filled by seat.mjs with the same replace; no other line has a placeholder.
    for (const x of Object.values(SURFACE_LINES[kind])) assert.doesNotMatch(x.replace('{{attemptId}}', 'a1'), CLI_LEAK, x);
  }
  for (const x of texts('hosted')) assert.ok(!x.includes('房间工具'), x);
  const KEYS = new Set(['action', 'room', 'attempt', 'text', 'seq', 'item', 'status', 'value', 'artifact', 'argv', 'reason', 'paths']);
  const actions = new Set();
  for (const x of texts('tool')) {
    for (const m of x.matchAll(/"([A-Za-z_]+)":/g)) assert.ok(KEYS.has(m[1]), `key ${m[1]} in ${x}`);
    for (const m of x.matchAll(/"action":"([^"]+)"/g)) actions.add(m[1]);
    // The preamble also lists the actions as a pipe list ("action 取 wait|submit|...").
    for (const m of x.matchAll(/action 取 ([a-z|]+)/g)) for (const a of m[1].split('|')) actions.add(a);
  }
  assert.ok(actions.has('leave') && actions.has('wait'), 'the preamble pipe list is read');
  assert.ok(actions.size >= 10);
  for (const a of actions) assert.ok(Object.hasOwn(SEAT_COMMANDS, a), `action ${a}`);
});

// ---------------------------------------------------------------- hosted marker round-trip

test('hosted marker examples parse once their placeholders are filled, and not before', () => {
  const all = fragments('hosted').map((f) => f.text).join('\n');
  const examples = [...new Set([...all.matchAll(/<<ROOM:(?:QUOTE|POINT|MISQUOTED|VERDICT|MARK)\b.*?<<ROOM:END>>|<<ROOM:DISCLOSE .*?">>|<<ROOM:PASS>>/g)].map((m) => m[0]))];
  const kindOf = (x) => /^<<ROOM:([A-Z]+)/.exec(x)[1];
  assert.deepEqual([...new Set(examples.map(kindOf))].sort(), ['DISCLOSE', 'MARK', 'MISQUOTED', 'PASS', 'POINT', 'QUOTE', 'VERDICT']);
  const count = (r) => ({ VERDICT: r.verdicts.length, DISCLOSE: r.disclose.length, POINT: r.points.length, QUOTE: r.quotes.length, MARK: r.marks.length, MISQUOTED: r.misquoted.length, PASS: r.pass ? 1 : 0 });
  const resolve = (x) => resolveSubmission({ textMarkers: parseMarkers(x).markers });
  for (const x of examples) {
    const filled = x.replace(/seq=N/g, 'seq=2').replace(/<id>/g, 'm2').replace(/<清单sha>/g, 'abc123def');
    const r = resolve(filled);
    assert.equal(r.annotation, 'none', filled);
    const c = count(r);
    assert.deepEqual(Object.entries(c).filter(([, n]) => n > 0), [[kindOf(x), 1]], filled);
    // Verbatim the placeholders do not parse, except where the example has none.
    assert.equal(resolve(x).annotation, ['PASS', 'DISCLOSE'].includes(kindOf(x)) ? 'none' : 'malformed', x);
  }
  assert.equal(resolve('```\n<<ROOM:PASS>>\n```').pass, false, 'a fenced marker does not count');
  const assign = resolve('<<ROOM:ASSIGN>>\n- B: 实现 | 验收: ["node","--test","x.test.mjs"]\n<<ROOM:END>>');
  assert.equal(assign.annotation, 'none');
  assert.equal(assign.assign.assignments.length, 1);
});

// ---------------------------------------------------------------- surfaceText, surfaceLine, SURFACE_HASH

test('surfaceText: cli returns its input; tool and hosted touch only matched or command lines', () => {
  for (const name of TEMPLATE_NAMES) assert.equal(surfaceText(name, T[name], 'cli'), T[name], name);
  assert.equal(surfaceText('preamble', T.preamble, undefined), T.preamble);
  for (const kind of ['tool', 'hosted']) {
    for (const name of TEMPLATE_NAMES) {
      const rules = SURFACE_FRAGMENTS[kind][name] || [];
      const out = surfaceText(name, T[name], kind).split('\n');
      const lines = T[name].split('\n');
      assert.equal(out.length, lines.length, `${kind} ${name}: a shipped command line was dropped instead of replaced`);
      lines.forEach((line, i) => {
        if (!CLI_ONLY.test(line) && !rules.some((r) => line.startsWith(r.prefix))) assert.equal(out[i], line, `${kind} ${name} line ${i}`);
      });
    }
    assert.equal(surfaceText('void-notice', '甲\n{{roomCmd}} status --seat {{seatDir}}\n乙', kind), '甲\n乙');
  }
});

test('surfaceLine: tool and hosted lines, undefined for cli; SURFACE_HASH per surface', () => {
  assert.equal(surfaceLine({ kind: 'cli' }, 'resubmit'), undefined);
  assert.equal(surfaceLine(undefined, 'resubmit'), undefined);
  assert.equal(surfaceLine({ kind: 'tool', tool: 'T' }, 'resubmit'), SURFACE_LINES.tool.resubmit);
  assert.equal(surfaceLine({ kind: 'hosted' }, 'resubmit'), SURFACE_LINES.hosted.resubmit);
  assert.equal(surfaceLine({ kind: 'hosted' }, 'turnSubmit'), undefined);
  assert.match(SURFACE_HASH.tool, /^[0-9a-f]{64}$/);
  assert.match(SURFACE_HASH.hosted, /^[0-9a-f]{64}$/);
  assert.notEqual(SURFACE_HASH.tool, SURFACE_HASH.hosted);
});
