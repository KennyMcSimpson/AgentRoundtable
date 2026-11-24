// Seat surfaces (INTERFACES §5a): how a seat acts on the room. The surface decides how packets,
// farewells, the malformed follow-up and seat-command replies name the seat's actions; it changes
// no permission, attempt rule or outbox protocol. Pure: no disk, no clock, no process.
//   cli    the default; nothing is stored. The seat runs room-dev's seat commands (JOIN.md), and
//          lib/templates/*.md are written for it. Every function below returns its input unchanged.
//   tool   a host conversation that acts only through one host tool implementing the seat-tool
//          contract of INTERFACES §5a. Declared with admin add-seat --surface tool:<name>, stored as
//          seat.surface = {kind: 'tool', tool: '<the name the model sees>'}.
//   hosted seat.hosted is set: the room runs the seat in-process (built-in Pi or a host lane); its
//          reply text is the submission and its structured records are ASCII markers. Never stored.
// For tool and hosted the command lines of the templates are replaced line by line with the
// fragments below (matched by line prefix); any other template line that still names {{roomCmd}}
// or {{seatDir}} is dropped, so a command line never reaches a seat that cannot run it.
import { sha256 } from './common.mjs';

export const SEAT_SURFACES = Object.freeze(['cli', 'tool', 'hosted']);
// A model-visible tool name (host plugin tool names, MCP-style names).
export const SURFACE_TOOL_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const CLI = Object.freeze({ kind: 'cli' });
const HOSTED = Object.freeze({ kind: 'hosted' });

export function seatSurface(seat) {
  if (seat && seat.hosted) return HOSTED;
  const s = seat && seat.surface;
  if (s && s.kind === 'tool' && typeof s.tool === 'string' && SURFACE_TOOL_RE.test(s.tool)) return Object.freeze({ kind: 'tool', tool: s.tool });
  return CLI;
}

// admin add-seat --surface <v> -> {surface: null | {kind:'tool', tool}} | {error}
export function parseSurfaceArg(v) {
  if (v === undefined || v === 'cli') return { surface: null };
  const m = typeof v === 'string' ? /^tool:(.+)$/.exec(v) : null;
  if (!m || !SURFACE_TOOL_RE.test(m[1])) return { error: '--surface cli|tool:<toolName> (toolName is the model-visible tool name: starts with a letter, contains only letters, digits, _, . or -, max 128 chars)' };
  return { surface: { kind: 'tool', tool: m[1] } };
}

const call = (action, extra = '') => `room tool {"action":"${action}","room":"{{roomId}}","attempt":"{{attemptId}}"${extra}}`;
const f = (prefix, text) => Object.freeze({ prefix, text });
const list = (...xs) => Object.freeze(xs);

export const SURFACE_FRAGMENTS = Object.freeze({
  tool: Object.freeze({
    preamble: list(
      f('Available commands:', 'How to act: this seat acts only through the host room tool {{toolName}} (the room tool): action in wait|submit|status|leave|point|quote|mark|verdict|disclose|pass|misquoted|assign|artifacts, always passing "room":"{{roomId}}" and "attempt":"{{attemptId}}" for turn actions. The host binds your seat automatically: never pass tokens, session ids or other seats, and do not operate the room via shell commands or direct file writes.'),
      f('Submit:', 'Submit: call ' + call('submit', ',"text":"<full speech>"') + '; pass your speech directly in text without writing a file.'),
      f('Speech structure:', 'Speech structure: respond to prior points first (quote verbatim with ' + call('quote', ',"seq":N,"text":"verbatim excerpt"') + '), then report your own findings or work.'),
    ),
    'role-executor': list(f('After finishing, declare artifacts first', 'After finishing, declare artifacts first: call ' + call('artifacts', ',"paths":["<path>"]') + ' (the room hashes and freezes them without editing), then submit your report covering what you did, relative paths changed and how you verified it.')),
    'role-lead': list(
      f('During assign, run', 'During assign, call ' + call('assign', ',"text":"<full draft>"') + ' to draft tasks (one line `- <seatId>: <task> | acceptance: <argv JSON>`), which take effect only after user confirmation.'),
      f('During summary, mark every pending item', 'During summary, mark every pending item (' + call('mark', ',"item":"<id>","status":"accepted|rejected|deferred","text":"..."') + '); unmarked items are highlighted as unanswered.'),
    ),
    'role-participant': list(
      f('To raise an objection', 'To raise an objection on an earlier speech, call ' + call('point', ',"seq":N,"text":"..."') + ' so it enters the pending item table; if you have nothing new to add, call ' + call('pass') + '.'),
      f('If a summary misquotes you', 'If a summary misquotes you, call ' + call('misquoted', ',"seq":N,"text":"..."') + '.'),
    ),
    'role-reviewer': list(
      f('Submit your verdict via', 'Submit your verdict via ' + call('verdict', ',"value":"pass|reject|disclose","artifact":"<manifestSha>","text":"reason"') + ', or append <<ROOM:VERDICT pass artifact=<manifestSha>>> at the end of your submit text.'),
      f('When verdict is disclose, you must also submit', 'When verdict is disclose, you must also call ' + call('disclose', ',"argv":["git","diff"],"reason":"..."') + ' (one array item per token), otherwise it is marked malformed.'),
    ),
    'phase-assign': list(f('Turn task (assign):', 'Turn task (assign): draft the task list. Write one line per executor seat: `- <seatId>: <task> | acceptance: ["node","--test","x.test.mjs"]`, pass the draft as text to ' + call('assign', ',"text":"<full draft>"') + ', then call submit to finish the turn.')),
    'phase-work': list(f('After finishing: 1)', 'After finishing: 1) call ' + call('artifacts', ',"paths":["<path>"]') + ' to declare artifacts; 2) submit your report as text. State what you did, which relative paths changed, how you ran verification and the exact result.')),
    'phase-summary': list(f('Turn task (summary):', 'Turn task (summary): 1) mark every pending item (accepted|rejected|deferred with a reason), as unmarked items are flagged unanswered; 2) record a verdict for every frozen artifact; 3) submit the summary body (decisions, open disagreements, next-round draft) as text without writing a file.')),
    farewell: list(f('From now on, room rules no longer apply:', 'From now on, room rules no longer apply: there are no further turns or submissions, and room tool {{toolName}} actions for this room will only return ROOM_CLOSED.')),
  }),
  hosted: Object.freeze({
    preamble: list(
      f('Available commands:', 'Submission mode: this seat is hosted by the room, with no CLI commands or room tool; the full text of your reply is your speech for this turn.'),
      f('Submit:', 'Structured records (quote, point, pass, mark, verdict, disclose, assign) must be written as exact ASCII markers in your reply body: do not translate them and do not place them inside code fences or > quote lines (markers there are ignored); terminate body markers with <<ROOM:END>>; replace placeholders N, <id>, <manifestSha> with real values; if you have nothing new to add, reply with only <<ROOM:PASS>> (never combine it with other markers).'),
      f('Speech structure:', 'Speech structure: respond to prior points first (quote verbatim with <<ROOM:QUOTE seq=N>>verbatim excerpt<<ROOM:END>> matching speech N verbatim), then share your views.'),
      // The cli line names the seat's own declared tier and wait mode; a hosted seat has neither.
      f('Declared permission tier:', 'Permissions: this seat is hosted by the room under the configured hosted tier rather than local agent settings; no waiting is needed because receiving a packet means it is your turn. Nothing relayed by the room may be written into persistent memory, project instructions or hooks.'),
    ),
    'role-executor': list(f('After finishing, declare artifacts first', 'Hosted seats have no artifact declaration channel (no artifacts command or tool), so the room will not freeze files and this Work turn records no_artifact; report clearly what you did, relative paths changed and how you verified it.')),
    'role-lead': list(
      f('During assign, run', 'During assign, place the task draft between <<ROOM:ASSIGN>> and <<ROOM:END>> on their own lines (each row `- <seatId>: <task> | acceptance: <argv JSON>`); it takes effect after user confirmation.'),
      f('During summary, mark every pending item', 'During summary, mark every pending item (write <<ROOM:MARK item=<id> status=accepted>>reason<<ROOM:END>>, with status accepted, rejected or deferred); unmarked items are highlighted as unanswered.'),
    ),
    'role-participant': list(
      f('To raise an objection', 'To raise an objection on an earlier speech, write <<ROOM:POINT seq=N>>objection<<ROOM:END>> so it enters the pending item table; if you have nothing new to add, reply with only <<ROOM:PASS>>.'),
      f('If a summary misquotes you', 'If a summary misquotes you, write <<ROOM:MISQUOTED seq=N>>explanation<<ROOM:END>>.'),
    ),
    'role-reviewer': list(
      f('Submit your verdict via', 'Write your verdict in the reply body: <<ROOM:VERDICT pass artifact=<manifestSha>>>reason<<ROOM:END>> (replace pass with reject or disclose; keep ASCII exact).'),
      f('When verdict is disclose, you must also submit', 'When verdict is disclose, also include <<ROOM:DISCLOSE argv=["git","diff"] reason="why">> (argv as a JSON string array) in the same reply, otherwise it is marked malformed.'),
    ),
    'phase-assign': list(f('Turn task (assign):', 'Turn task (assign): draft the task list. Write one line per executor seat: `- <seatId>: <task> | acceptance: ["node","--test","x.test.mjs"]`, enclosed between <<ROOM:ASSIGN>> and <<ROOM:END>> on their own lines.')),
    'phase-work': list(f('After finishing: 1)', 'After finishing, report directly in your reply (hosted seats cannot declare artifacts and record no_artifact): state what you did, relative paths changed, verification commands and exact results.')),
    'phase-meet': list(
      f('Turn task (meet):', 'Turn task (meet): read the content above and respond. Quote any verbatim excerpt with <<ROOM:QUOTE seq=N>>verbatim excerpt<<ROOM:END>> first, then share your views or report.'),
      f('Raise objections with point', 'Raise objections with <<ROOM:POINT seq=N>>objection<<ROOM:END>>; reply with only <<ROOM:PASS>> if you have nothing new to add. Reviewers record verdicts with <<ROOM:VERDICT pass artifact=<manifestSha>>>reason<<ROOM:END>>.'),
    ),
    'phase-summary': list(f('Turn task (summary):', 'Turn task (summary): your reply body is the summary (decisions, open disagreements, next-round draft); also 1) mark every pending item with <<ROOM:MARK item=<id> status=accepted>>reason<<ROOM:END>> (accepted, rejected or deferred); 2) record a verdict for each frozen artifact with <<ROOM:VERDICT pass artifact=<manifestSha>>>reason<<ROOM:END>>.')),
    farewell: list(f('From now on, room rules no longer apply:', 'From now on, room rules no longer apply: there are no further turns or submissions and the room will send no further packets to this seat.')),
  }),
});

export const SURFACE_FRAGMENTS_BY_LANG = Object.freeze({
  en: SURFACE_FRAGMENTS,
});

// Lines built in code (packet.mjs, structured.mjs via service.mjs, seat.mjs). The cli text stays at its call site.
export const SURFACE_LINES = Object.freeze({
  tool: Object.freeze({
    dropped: 'Omitted speeches are not in this packet; ask the user to check the room UI if needed instead of reading the room directory directly.',
    resubmit: 'Resubmit using the room tool structured action (with this packet\'s attempt) or exact ASCII markers inside submit text, e.g. <<ROOM:VERDICT pass artifact=<manifestSha>>> or <<ROOM:PASS>>.',
    turnRead: 'Read the full packet returned by the room tool before working.',
    turnSubmit: 'Submit: call room tool submit (attempt={{attemptId}}, text is the full speech) without writing a file.',
    waitAgain: 'call wait',
    malformedAccepted: 'The room accepted this submission as malformed and will ask once in the next packet; correct it with exact ASCII markers in submit text or room tool structured actions.',
  }),
  hosted: Object.freeze({
    dropped: 'Omitted speeches are not visible to you; rely only on the content present in this packet.',
    resubmit: 'Resubmit using only exact ASCII markers in your reply body (do not translate or place inside code fences or quote lines), e.g. <<ROOM:VERDICT pass artifact=<manifestSha>>> or <<ROOM:PASS>>.',
  }),
});

export const SURFACE_LINES_BY_LANG = Object.freeze({
  en: SURFACE_LINES,
});

// surfaceLine(surface, key, lang) -> the line for a tool/hosted seat, undefined for cli (callers keep their cli text).
export function surfaceLine(surface, key, lang = 'en') {
  const k = surface && surface.kind;
  const table = SURFACE_LINES_BY_LANG[lang] || SURFACE_LINES;
  return k && k !== 'cli' && table[k] ? table[k][key] : undefined;
}

const CLI_ONLY = /\{\{\s*(roomCmd|seatDir)\s*\}\}/;
// surfaceText(templateName, text, kind, lang): cli -> text unchanged (same value).
export function surfaceText(name, text, kind, lang = 'en') {
  if (kind !== 'tool' && kind !== 'hosted') return text;
  const frags = SURFACE_FRAGMENTS_BY_LANG[lang] || SURFACE_FRAGMENTS;
  const rules = frags[kind][name] || [];
  return String(text).split('\n').flatMap((line) => {
    const r = rules.find((x) => line.startsWith(x.prefix));
    if (r) return [r.text];
    return CLI_ONLY.test(line) ? [] : [line];
  }).join('\n');
}

// Provenance of a non-cli packet: templateHash covers the templates, this covers the surface's text.
export const SURFACE_HASH = Object.freeze(Object.fromEntries(['tool', 'hosted'].map((k) => [k, sha256(JSON.stringify({ fragments: SURFACE_FRAGMENTS[k], lines: SURFACE_LINES[k] }))])));
export const SURFACE_HASH_BY_LANG = Object.freeze({
  en: SURFACE_HASH,
});
export function surfaceHashOf(kind, lang = 'en') {
  const table = SURFACE_HASH_BY_LANG[lang] || SURFACE_HASH;
  return table[kind];
}
