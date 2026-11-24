// Packet rendering (plan §4.6, §5.1, §6.4, §7.3, §7.6; INTERFACES §6).
// A packet is: room preamble block (seat=room authority=room) + user task block (authority=user)
// + queued user messages (authority=user) + accepted speeches (authority=none, each with a
// declaration line) + current summary block + material blocks + item table (summary round)
// + superseded notice + void notice + this turn's task. Every block carries the packet's random
// nonce; any '[ROOM:' / '[/ROOM:' inside forwarded text is escaped and counted.
// The per-phase and per-role prose comes from lib/templates/*.md, loaded once. The sha256 of the
// concatenated templates is the manifest's templateHash. Templates only ever go into packets.
// They are written for command-line seats. For a tool or hosted seat (lib/surface.mjs), the
// command lines are replaced by that surface's fragments, and the manifest adds surface and surfaceHash.
// This module is pure apart from reading its own template files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fwd, sha256 } from './common.mjs';
import { trimMessages, computePins, mergeDropped, describeDropped } from './budget.mjs';
import { seatSurface, surfaceText, SURFACE_LINES, SURFACE_LINES_BY_LANG, SURFACE_HASH, surfaceHashOf } from './surface.mjs';
import { DEFAULT_LANG, ROLE_NAMES_BY_LANG, PHASE_NAMES_BY_LANG, normalizeLang, resolveLang, t } from './i18n.mjs';

// Bump when the packet layout changes in a way that makes two packets with equal inputs differ
// (non-cli surfaces are versioned by the manifest's surfaceHash).
export const RENDER_VERSION = 2;

export const TEMPLATE_NAMES = [
  'preamble', 'role-lead', 'role-reviewer', 'role-executor', 'role-participant',
  'phase-assign', 'phase-work', 'phase-meet-open', 'phase-meet', 'phase-summary',
  'farewell', 'void-notice', 'superseded-notice',
];

// Placeholders a template may use ({{name}}); anything else is a lint error.
export const TEMPLATE_VARS = [
  'roomId', 'seatId', 'seatName', 'role', 'roleName', 'phase', 'phaseName', 'roundId', 'turn', 'turnTotal',
  'attemptId', 'packetId', 'nonce', 'deadline', 'roomCmd', 'seatDir', 'cwd', 'executorCwds', 'declaredTier',
  'waitMode', 'voidedAttemptId', 'oldVersion', 'newVersion', 'summaryVersion', 'toolName',
];

const ROLE_NAMES = { lead: '主力', reviewer: '审方', executor: '执行者', participant: '参与者' };
const PHASE_NAMES = { idle: '待开始', assign: '分派', work: '工作', meet: '开会', summary: '汇总', done: '已结束', closed: '已散会' };
const LIVE_MARKER = /\[\/?ROOM:/;

// ---------------------------------------------------------------- escaping and blocks (kept API)

export function escapeMarkers(text) {
  let count = 0;
  const escaped = String(text).replace(/\[(\/?)ROOM:/g, (m, slash) => { count++; return `[${slash}ROOM\\:`; });
  return { text: escaped, count };
}

// Block header format is a contract: [ROOM:<nonce>:seat=<x> authority=<user|none|room> seq=<n> hash=<16hex>]
// `decl` overrides the declaration line for authority=none content that is not a seat speech
// (summary, material); the default line names the seat.
export function block(nonce, { seat, authority, seq, hash, decl, lang = DEFAULT_LANG }, body) {
  const head = `[ROOM:${nonce}:seat=${seat} authority=${authority} seq=${seq}${hash ? ` hash=${hash.slice(0, 16)}` : ''}]`;
  let declLine = '';
  if (authority === 'none') declLine = `${decl || t(lang, 'peerDecl', { seat })}\n`;
  return `${head}\n${declLine}${body}\n[/ROOM:${nonce}]`;
}

// ---------------------------------------------------------------- templates

const DEFAULT_DIR = fileURLToPath(new URL('./templates/', import.meta.url));
const cache = new Map();

function readTemplateDir(dir) {
  const templates = {};
  for (const name of TEMPLATE_NAMES) {
    const p = path.join(dir, `${name}.md`);
    if (!fs.existsSync(p)) throw new Error(`template missing: ${p}`);
    templates[name] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  }
  return templates;
}

export function templateHashOf(templates) {
  const names = Object.keys(templates).sort();
  return sha256(names.map((n) => `--- ${n} ---\n${templates[n]}\n`).join(''));
}

// loadTemplates({dir, lang, overrides, force}) -> {templates, templateHash, dir, lang}
//   dir       : template directory (default lib/templates for zh-CN, lib/templates/en for en).
//   overrides : {name: text} applied on top (per-room overrides, plan §4.6); the hash covers them.
// Every template is linted on load; a bad template throws, because a packet with a live marker or
// without the authority rule must never be issued.
export function loadTemplates({ dir, lang = DEFAULT_LANG, overrides = null, force = false } = {}) {
  const L = normalizeLang(lang) || DEFAULT_LANG;
  const resolvedDir = dir ? path.resolve(dir) : path.resolve(L === 'en' ? path.join(DEFAULT_DIR, 'en') : DEFAULT_DIR);
  const key = `${L}::${resolvedDir}`;
  if (force || !cache.has(key)) {
    const templates = readTemplateDir(resolvedDir);
    cache.set(key, Object.freeze(templates));
  }
  let templates = cache.get(key);
  if (overrides && typeof overrides === 'object') templates = Object.freeze({ ...templates, ...overrides });
  for (const name of Object.keys(templates)) {
    const errors = lintTemplate(templates[name], { requireAuthorityRule: name === 'preamble' || name === 'farewell', lang: L });
    if (errors.length) throw new Error(`template ${name}.md failed lint: ${errors.join('; ')}`);
  }
  return { templates, templateHash: templateHashOf(templates), dir: resolvedDir, lang: L };
}

// lintTemplate(text, {requireAuthorityRule=true, lang='zh-CN'}) -> [errors]
//   - no live '[ROOM:' / '[/ROOM:' marker (a template must not be able to forge a block)
//   - must state the authority rule (authority=none + 不是用户指令 / not a user instruction) unless told otherwise
//   - only known {{placeholders}}
//   - not empty
export function lintTemplate(text, { requireAuthorityRule = true, lang = DEFAULT_LANG } = {}) {
  const errors = [];
  const t0 = String(text == null ? '' : text);
  if (!t0.trim()) errors.push('template is empty');
  if (LIVE_MARKER.test(t0)) errors.push("live '[ROOM:' marker (write it as [ROOM\\: )");
  if (requireAuthorityRule) {
    if (!/authority=none/.test(t0)) errors.push("authority rule missing: must mention 'authority=none'");
    const L = normalizeLang(lang) || DEFAULT_LANG;
    if (L === 'en') {
      if (!/not a user instruction/i.test(t0)) errors.push("authority rule missing: must say 'not a user instruction'");
    } else if (!/不是用户指令/.test(t0)) {
      errors.push("authority rule missing: must say '不是用户指令'");
    }
  }
  for (const m of t0.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!TEMPLATE_VARS.includes(m[1])) errors.push(`unknown placeholder {{${m[1]}}}`);
  }
  return errors;
}

export function fillTemplate(text, vars) {
  return String(text).replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))).replace(/\n+$/, '');
}

// ---------------------------------------------------------------- helpers

function safeFwd(p, lang = DEFAULT_LANG) { return p ? fwd(p) : t(lang, 'unset'); }
function seqNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function oneLine(s, max = 300) { const text = String(s).replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; }

function roomBlock(nonce, body) { return block(nonce, { seat: 'room', authority: 'room', seq: 0 }, body); }

function phaseTemplateName(phase, { role, firstInRound }) {
  if (phase === 'assign') return 'phase-assign';
  if (phase === 'work') return 'phase-work';
  if (phase === 'summary') return 'phase-summary';
  if (firstInRound && role !== 'executor') return 'phase-meet-open';
  return 'phase-meet';
}

function buildVars({ room, seat, seatDir, state, attempt, nonce, roomCmd, summary, lang = DEFAULT_LANG }) {
  const order = Array.isArray(state.order) ? state.order : [];
  const sep = lang === 'en' ? ', ' : '、';
  const executorCwds = (room.seats || []).filter((s) => s.role === 'executor').map((s) => safeFwd(s.cwd, lang)).join(sep) || t(lang, 'none');
  const phase = attempt.phase || state.phase || 'meet';
  const roleNames = ROLE_NAMES_BY_LANG[lang] || ROLE_NAMES;
  const phaseNames = PHASE_NAMES_BY_LANG[lang] || PHASE_NAMES;
  return {
    roomId: room.id,
    seatId: seat.seatId,
    seatName: seat.name || seat.seatId,
    role: seat.role,
    roleName: roleNames[seat.role] || seat.role,
    phase,
    phaseName: phaseNames[phase] || phase,
    roundId: state.roundId == null ? 0 : state.roundId,
    turn: order.length ? (seqNum(state.turnIndex) + 1) : '-',
    turnTotal: order.length ? order.length : '-',
    attemptId: attempt.attemptId,
    packetId: attempt.packetId,
    nonce,
    deadline: attempt.deadline || t(lang, 'unset'),
    roomCmd,
    seatDir: safeFwd(seatDir, lang),
    cwd: safeFwd(seat.cwd, lang),
    executorCwds,
    declaredTier: seat.declaredTier || t(lang, 'undeclared'),
    waitMode: seat.waitMode || t(lang, 'unset'),
    summaryVersion: summary ? summary.version : '',
  };
}

// ---------------------------------------------------------------- renderPacket

export function renderPacket(input) {
  const { room, seat, seatDir, state, attempt, nonce, roomCmd } = input;
  if (!room || !seat || !state || !attempt || !nonce) throw new Error('renderPacket: room, seat, state, attempt and nonce are required');
  const lang = resolveLang({ lang: input.lang || (input.templates && input.templates.lang), room });
  const tpl = input.templates || loadTemplates({ lang });
  const T = tpl.templates;
  const surfaceLines = SURFACE_LINES_BY_LANG[lang] || SURFACE_LINES;
  const summary = input.summary || null;
  const materials = Array.isArray(input.materials) ? input.materials : [];
  const items = Array.isArray(input.items) ? input.items : [];
  const userMessages = Array.isArray(input.userMessages) ? input.userMessages : [];
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const allMessages = [...(Array.isArray(state.messages) ? state.messages : [])].sort((a, b) => seqNum(a.seq) - seqNum(b.seq));
  const vars = buildVars({ room, seat, seatDir, state, attempt, nonce, roomCmd, summary, lang });
  const surface = seatSurface(seat);
  vars.toolName = surface.kind === 'tool' ? surface.tool : '';
  const fillT = (name, extra) => fillTemplate(surfaceText(name, T[name], surface.kind, lang), extra ? { ...vars, ...extra } : vars);
  const roleTpl = T[`role-${seat.role}`] ? `role-${seat.role}` : 'role-participant';
  const phase = vars.phase;
  const roundMessages = allMessages.filter((m) => m.roundId == null || Number(m.roundId) === Number(state.roundId));
  const firstInRound = roundMessages.length === 0;

  // Each render pass returns the text plus what it counted, so the budget pass can rerun it.
  function pass(messages, dropped) {
    let escaped = 0;
    const blocks = [];
    const esc = (text) => { const r = escapeMarkers(text == null ? '' : text); escaped += r.count; return r.text; };
    const L = [];
    L.push(t(lang, 'packetTitle', { roomId: room.id, packetId: attempt.packetId }));
    L.push('');

    // 1. room preamble + role
    const pre = [fillT('preamble'), fillT(roleTpl)];
    if (artifacts.length) {
      pre.push(t(lang, 'pendingArtifacts'));
      for (const a of artifacts) {
        const bytesPart = a.bytes != null ? t(lang, 'artifactMetaBytes', { bytes: a.bytes }) : '';
        const meta = a.fileCount != null ? t(lang, 'artifactMetaFiles', { fileCount: a.fileCount, bytesPart }) : '';
        pre.push(t(lang, 'artifactRow', { seatId: a.seatId, manifestSha: a.manifestSha, meta }));
      }
    }
    blocks.push({ seat: 'room', authority: 'room', seq: 0, hash: null });
    L.push(roomBlock(nonce, pre.join('\n')));
    L.push('');

    // 2. user task
    if (state.task && state.task.text != null) {
      const hash = state.task.sha256 || sha256(String(state.task.text));
      blocks.push({ seat: 'user', authority: 'user', seq: 1, hash });
      L.push(block(nonce, { seat: 'user', authority: 'user', seq: 1, hash, lang }, esc(state.task.text)));
      L.push('');
    }

    // 3. queued user messages (admin say) — user authority, their own seqs
    if (userMessages.length) {
      L.push(t(lang, 'secUserMessages'));
      for (const u of userMessages) {
        const hash = u.sha256 || sha256(String(u.text == null ? '' : u.text));
        blocks.push({ seat: 'user', authority: 'user', seq: seqNum(u.seq), hash });
        L.push('');
        L.push(block(nonce, { seat: 'user', authority: 'user', seq: seqNum(u.seq), hash, lang }, esc(u.text)));
      }
      L.push('');
    }

    // 4. accepted speeches
    L.push(t(lang, 'secSpeeches'));
    if (messages.length === 0) L.push(dropped.length ? t(lang, 'noSpeechesDropped') : t(lang, 'noSpeechesYet'));
    for (const m of messages) {
      const hash = m.sha256 || sha256(String(m.text == null ? '' : m.text));
      blocks.push({ seat: m.seatId, authority: 'none', seq: seqNum(m.seq), hash });
      escaped += Number(m.escaped) || 0; // escapes the service counted when it accepted the speech
      L.push('');
      L.push(block(nonce, { seat: m.seatId, authority: 'none', seq: seqNum(m.seq), hash, lang }, esc(m.text)));
    }
    if (dropped.length) {
      L.push('');
      const tail = surface.kind === 'cli' ? t(lang, 'budgetCliTail', { roomCmd, seatDir: vars.seatDir }) : surfaceLines[surface.kind].dropped;
      L.push(roomBlock(nonce, t(lang, 'budgetTrimmed', { dropped: describeDropped(dropped, { lang }), tail })));
      blocks.push({ seat: 'room', authority: 'room', seq: 0, hash: null });
    }
    L.push('');

    // 5. current summary
    if (summary && summary.text != null) {
      const sseat = summary.seatId || 'summary';
      const hash = summary.sha256 || sha256(String(summary.text));
      const seq = seqNum(summary.seq);
      L.push(t(lang, 'secSummary', { version: summary.version }));
      L.push('');
      blocks.push({ seat: sseat, authority: 'none', seq, hash });
      const seatPart = summary.seatId ? t(lang, 'summarySeatPart', { seatId: summary.seatId }) : '';
      L.push(block(nonce, { seat: sseat, authority: 'none', seq, hash, decl: t(lang, 'summaryDecl', { seatPart, version: summary.version }), lang }, esc(summary.text)));
      L.push('');
    }

    // 6. materials
    if (materials.length) {
      L.push(t(lang, 'secMaterials'));
      for (const mat of materials) {
        const hash = mat.sha256 || sha256(String(mat.text == null ? '' : mat.text));
        blocks.push({ seat: 'material', authority: 'none', seq: 0, hash, id: mat.id, version: mat.version });
        L.push('');
        L.push(block(nonce, { seat: 'material', authority: 'none', seq: 0, hash, decl: t(lang, 'materialDecl', { id: mat.id, version: mat.version }), lang }, esc(mat.text)));
      }
      L.push('');
    }

    // 7. item table (summary round)
    if (items.length) {
      const rows = [t(lang, 'itemTableIntro'), '', t(lang, 'itemTableHeader'), '|---|---|---|---|---|'];
      for (const it of items) {
        rows.push(`| ${it.itemId} | ${it.seatId} | ${seqNum(it.seq)} | ${it.status || 'open'} | ${esc(oneLine(it.text == null ? '' : it.text)).replace(/\|/g, '\\|')} |`);
      }
      L.push(t(lang, 'secItemTable'));
      L.push('');
      blocks.push({ seat: 'room', authority: 'room', seq: 0, hash: null });
      L.push(roomBlock(nonce, rows.join('\n')));
      L.push('');
    }

    // 8. superseded notice
    if (input.supersededNotice) {
      const sn = input.supersededNotice;
      L.push(t(lang, 'secSuperseded'));
      L.push('');
      blocks.push({ seat: 'room', authority: 'room', seq: 0, hash: null });
      L.push(roomBlock(nonce, fillT('superseded-notice', { oldVersion: sn.oldVersion, newVersion: sn.newVersion })));
      L.push('');
    }

    // 9. void notice (the seat's previous attempt was voided, plan §6.4)
    if (input.voidNotice && input.voidNotice.attemptId) {
      L.push(t(lang, 'secVoid'));
      L.push('');
      blocks.push({ seat: 'room', authority: 'room', seq: 0, hash: null });
      L.push(roomBlock(nonce, fillT('void-notice', { voidedAttemptId: input.voidNotice.attemptId })));
      L.push('');
    }

    // 10. this turn's task
    const task = [fillT(phaseTemplateName(phase, { role: seat.role, firstInRound }))];
    if (attempt.turnTask) task.push('', t(lang, 'assignedTaskHead'), esc(attempt.turnTask));
    L.push(t(lang, 'secTurnTask'));
    L.push('');
    blocks.push({ seat: 'room', authority: 'room', seq: 0, hash: null });
    L.push(roomBlock(nonce, task.join('\n')));
    L.push('');
    return { text: L.join('\n'), escaped, blocks };
  }

  // Budget pass (plan §7.6): engage only when the full packet exceeds packetMaxBytes.
  const callerDropped = mergeDropped(Array.isArray(input.dropped) ? input.dropped : [], []);
  let messages = allMessages;
  let dropped = callerDropped;
  let r = pass(messages, dropped);
  const maxBytes = room.budget && Number(room.budget.packetMaxBytes);
  if (Number.isFinite(maxBytes) && maxBytes > 0 && Buffer.byteLength(r.text, 'utf8') > maxBytes) {
    const overhead = Buffer.byteLength(pass([], [{ fromSeq: 0, toSeq: 0 }]).text, 'utf8');
    const pins = computePins({
      messages: allMessages,
      roundId: state.roundId,
      quotedSeqs: input.quotedSeqs || [],
      summarySeq: summary && summary.seq != null ? summary.seq : null,
      extra: input.pinnedSeqs || [],
    });
    const sizeOf = (m) => Buffer.byteLength(block(nonce, { seat: m.seatId, authority: 'none', seq: seqNum(m.seq), hash: m.sha256 || 'x', lang }, escapeMarkers(m.text == null ? '' : m.text).text), 'utf8') + 2;
    const trimmed = trimMessages({ messages: allMessages, pinnedSeqs: pins, maxBytes: Math.max(0, maxBytes - overhead), sizeOf });
    messages = trimmed.kept;
    dropped = mergeDropped(callerDropped, trimmed.dropped);
    r = pass(messages, dropped);
  }

  const text = r.text;
  const seatSeqs = messages.map((m) => seqNum(m.seq));
  const userSeqs = userMessages.map((u) => seqNum(u.seq));
  const manifest = {
    packetId: attempt.packetId,
    seatId: seat.seatId,
    attemptId: attempt.attemptId,
    roundId: state.roundId == null ? 0 : state.roundId,
    epoch: state.epoch == null ? 0 : state.epoch,
    phase,
    nonce,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    messageSeqs: [...new Set([...seatSeqs, ...userSeqs])].sort((a, b) => a - b),
    seatMessageSeqs: seatSeqs,
    userMessageSeqs: userSeqs,
    summaryVersion: summary ? summary.version : null,
    materialVersions: materials.map((m) => ({ id: m.id, version: m.version })),
    templateHash: tpl.templateHash,
    renderVersion: RENDER_VERSION,
    declaredTier: seat.declaredTier || null,
    auditSource: seat.audit && seat.audit.kind ? seat.audit.kind : null,
    hostOutputLimit: input.hostOutputLimit == null ? null : input.hostOutputLimit,
    escaped: r.escaped,
    prevManifestId: input.prevManifestId == null ? null : input.prevManifestId,
    dropped,
    blocks: r.blocks,
    itemIds: items.map((it) => it.itemId),
    voidedAttemptId: input.voidNotice && input.voidNotice.attemptId ? input.voidNotice.attemptId : null,
    supersededNotice: input.supersededNotice ? { oldVersion: input.supersededNotice.oldVersion, newVersion: input.supersededNotice.newVersion } : null,
    ...(surface.kind === 'cli' ? {} : { surface: surface.kind, surfaceHash: surfaceHashOf(surface.kind, lang) }),
  };
  return { text, manifest };
}

// ---------------------------------------------------------------- renderFarewell

export function renderFarewell({ room, seat, nonce, roomCmd = 'room', packetId, templates, lang: langArg } = {}) {
  if (!room || !seat || !nonce) throw new Error('renderFarewell: room, seat and nonce are required');
  const lang = resolveLang({ lang: langArg || (templates && templates.lang), room });
  const tpl = templates || loadTemplates({ lang });
  const surface = seatSurface(seat);
  const roleNames = ROLE_NAMES_BY_LANG[lang] || ROLE_NAMES;
  const vars = {
    roomId: room.id, seatId: seat.seatId, seatName: seat.name || seat.seatId, role: seat.role,
    roleName: roleNames[seat.role] || seat.role, nonce, roomCmd, cwd: safeFwd(seat.cwd, lang),
    toolName: surface.kind === 'tool' ? surface.tool : '',
  };
  const id = packetId || `farewell-${room.id}-${seat.seatId}-${nonce}`;
  const L = [];
  L.push(t(lang, 'farewellTitle', { roomId: room.id, packetId: id }));
  L.push('');
  L.push(roomBlock(nonce, fillTemplate(surfaceText('farewell', tpl.templates.farewell, surface.kind, lang), vars)));
  L.push('');
  const text = L.join('\n');
  return {
    text,
    manifest: {
      packetId: id, seatId: seat.seatId, attemptId: null, kind: 'farewell', nonce,
      sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'),
      messageSeqs: [], summaryVersion: null, materialVersions: [],
      templateHash: tpl.templateHash, renderVersion: RENDER_VERSION,
      declaredTier: seat.declaredTier || null, auditSource: seat.audit && seat.audit.kind ? seat.audit.kind : null,
      hostOutputLimit: null, escaped: 0, prevManifestId: null, dropped: [],
      blocks: [{ seat: 'room', authority: 'room', seq: 0, hash: null }],
      ...(surface.kind === 'cli' ? {} : { surface: surface.kind, surfaceHash: surfaceHashOf(surface.kind, lang) }),
    },
  };
}
