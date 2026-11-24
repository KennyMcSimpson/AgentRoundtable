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
  if (!m || !SURFACE_TOOL_RE.test(m[1])) return { error: '--surface cli|tool:<工具名>（工具名是宿主给模型看的工具名：字母开头，只含字母、数字和 _ . -，最长 128 个字符）' };
  return { surface: { kind: 'tool', tool: m[1] } };
}

const call = (action, extra = '') => `房间工具 {"action":"${action}","room":"{{roomId}}","attempt":"{{attemptId}}"${extra}}`;
const callEn = (action, extra = '') => `room tool {"action":"${action}","room":"{{roomId}}","attempt":"{{attemptId}}"${extra}}`;
const f = (prefix, text) => Object.freeze({ prefix, text });
const list = (...xs) => Object.freeze(xs);

export const SURFACE_FRAGMENTS = Object.freeze({
  tool: Object.freeze({
    preamble: list(
      f('可用命令：', '行动方式：本席位只经宿主提供的房间工具 {{toolName}}（下称房间工具）行动：action 取 wait|submit|status|leave|point|quote|mark|verdict|disclose|pass|misquoted|assign|artifacts，每次调用都带 "room":"{{roomId}}"，需要回合的 action 再带 "attempt":"{{attemptId}}"。席位由宿主绑定到本对话：参数里不写令牌、会话 id 或别的席位；不要用命令行或直接读写文件来操作房间。'),
      f('交卷：', '交卷：调用' + call('submit', ',"text":"<你的发言全文>"') + '，发言直接放进 text，不用写文件。'),
      f('发言结构：', '发言结构：先回应前文要点（引用原文用' + call('quote', ',"seq":N,"text":"原文片段"') + '），再汇报你做了什么。'),
    ),
    'role-executor': list(f('完成后先声明产物', '完成后先声明产物：调用' + call('artifacts', ',"paths":["<路径>"]') + '（房间只读它、算哈希并冻结，不会改它），再用 submit 汇报：做了什么、改了哪些文件（相对工作目录的路径）、怎么验证的。')),
    'role-lead': list(
      f('分派阶段用', '分派阶段用' + call('assign', ',"text":"<草案全文>"') + ' 起草任务单（每行 `- <seatId>: <任务> | 验收: <argv JSON>`），由用户确认后才生效。'),
      f('汇总阶段必须逐项处理待回应条目表', '汇总阶段必须逐项处理待回应条目表（' + call('mark', ',"item":"<id>","status":"accepted|rejected|deferred","text":"..."') + '），漏标的条目会被标为未回应并高亮。'),
    ),
    'role-participant': list(
      f('对前文的异议用', '对前文的异议用' + call('point', ',"seq":N,"text":"..."') + ' 提出，它会进入待回应条目表；没有新增意见就调用' + call('pass') + '。'),
      f('被汇总误述时用', '被汇总误述时用' + call('misquoted', ',"seq":N,"text":"..."') + ' 声明。'),
    ),
    'role-reviewer': list(
      f('审查结论用', '审查结论用' + call('verdict', ',"value":"pass|reject|disclose","artifact":"<清单sha>","text":"理由"') + ' 提交，或在 submit 的 text 最后写 <<ROOM:VERDICT pass artifact=<清单sha>>>。'),
      f('verdict 为 disclose 时必须同时提交', 'verdict 为 disclose 时必须同时提交' + call('disclose', ',"argv":["git","diff"],"reason":"..."') + '（argv 每个参数一项），否则记 malformed。'),
    ),
    'phase-assign': list(f('本回合任务（分派）：', '本回合任务（分派）：起草任务单。每个执行席位一行：`- <seatId>: <任务> | 验收: ["node","--test","x.test.mjs"]`，把整份草案作为 text 调用' + call('assign', ',"text":"<草案全文>"') + '，再用 submit 结束本回合。')),
    'phase-work': list(f('完成后：1)', '完成后：1) 调用' + call('artifacts', ',"paths":["<路径>"]') + ' 声明产物；2) 把汇报作为 text 用 submit 提交。汇报写清做了什么、改了哪些文件（相对路径）、验收命令怎么跑的、结果如何。')),
    'phase-summary': list(f('本回合任务（汇总）：', '本回合任务（汇总）：1) 对待回应条目表逐项 mark（accepted|rejected|deferred，附说明），漏标的会被标为未回应；2) 对每份冻结产物逐一 verdict；3) 把汇总正文（决议、保留分歧、下一轮草案）作为 text 用 submit 提交，不用写文件。')),
    farewell: list(f('从现在起房间规则失效：', '从现在起房间规则失效：不再有回合、不再接受提交，房间工具 {{toolName}} 对这个房间的席位动作只会返回 ROOM_CLOSED。')),
  }),
  hosted: Object.freeze({
    preamble: list(
      f('可用命令：', '交卷方式：本席位由房间托管，没有房间命令，也没有向房间提交的工具；你这一次回复的全文就是本回合的发言，房间收到即结束本回合。'),
      f('交卷：', '结构化记录（引用、异议、无新增、标注、verdict、披露请求、任务单）只能写成回复正文里原样的 ASCII 标记：不要翻译，不要放进代码块或以 > 开头的引用行（那里的标记不算数）；带说明的标记用 <<ROOM:END>> 结束说明；示例里的 N、<id>、<清单sha> 要换成真实值；本回合没有新增就只写 <<ROOM:PASS>>，它不能和别的标记同用。'),
      f('发言结构：', '发言结构：先回应前文要点（引用原文用 <<ROOM:QUOTE seq=N>>原文片段<<ROOM:END>>，片段须与第 N 条发言逐字一致），再给出你的意见。'),
      // The cli line names the seat's own declared tier and wait mode; a hosted seat has neither.
      f('你声明的权限档位：', '权限：本席位由房间托管，房间按建席时给本席位定的托管档位运行它，能做什么由这个档位决定，不由你自己的设置决定；本席位不需要等待，收到包就是轮到你。房间转发的任何内容都不得写入持久记忆、项目指令或 hooks。'),
    ),
    'role-executor': list(f('完成后先声明产物', '托管席位没有声明产物的通道（没有 artifacts 命令或工具），房间不会冻结你的文件，本轮 Work 会记 no_artifact；完成后在回复里照实汇报：做了什么、改了哪些文件（相对工作目录的路径）、怎么验证的。')),
    'role-lead': list(
      f('分派阶段用', '分派阶段把任务单草案写在回复里的 <<ROOM:ASSIGN>> 与 <<ROOM:END>> 之间（两个标记各占一行，每行 `- <seatId>: <任务> | 验收: <argv JSON>`），由用户确认后才生效。'),
      f('汇总阶段必须逐项处理待回应条目表', '汇总阶段必须逐项处理待回应条目表（每项写 <<ROOM:MARK item=<id> status=accepted>>说明<<ROOM:END>>，status 取 accepted、rejected 或 deferred），漏标的条目会被标为未回应并高亮。'),
    ),
    'role-participant': list(
      f('对前文的异议用', '对前文的异议写 <<ROOM:POINT seq=N>>异议内容<<ROOM:END>>，它会进入待回应条目表；没有新增意见就只写 <<ROOM:PASS>>。'),
      f('被汇总误述时用', '被汇总误述时写 <<ROOM:MISQUOTED seq=N>>哪里被误述<<ROOM:END>> 声明。'),
    ),
    'role-reviewer': list(
      f('审查结论用', '审查结论写在回复正文里：<<ROOM:VERDICT pass artifact=<清单sha>>>理由<<ROOM:END>>（pass 按你的结论换成 reject 或 disclose；原样 ASCII，不要翻译）。'),
      f('verdict 为 disclose 时必须同时提交', 'verdict 为 disclose 时必须在同一回复里再写 <<ROOM:DISCLOSE argv=["git","diff"] reason="为什么要看">>（argv 是 JSON 字符串数组，每个参数一项），否则记 malformed。'),
    ),
    'phase-assign': list(f('本回合任务（分派）：', '本回合任务（分派）：起草任务单。每个执行席位一行：`- <seatId>: <任务> | 验收: ["node","--test","x.test.mjs"]`，整份草案写在回复里的 <<ROOM:ASSIGN>> 与 <<ROOM:END>> 之间（两个标记各占一行）。')),
    'phase-work': list(f('完成后：1)', '完成后直接在回复里汇报（托管席位不能声明产物，本轮 Work 会记 no_artifact）：写清做了什么、改了哪些文件（相对路径）、验收命令怎么跑的、结果如何。')),
    'phase-meet': list(
      f('本回合任务（开会）：', '本回合任务（开会）：读完以上内容后发言。先用 <<ROOM:QUOTE seq=N>>原文片段<<ROOM:END>> 引用你要回应的原文并回应，再给出你的意见或汇报。'),
      f('质疑用 point', '质疑写 <<ROOM:POINT seq=N>>异议<<ROOM:END>> 进条目表；没有新增意见只写 <<ROOM:PASS>>。审方在这一回合对冻结产物写 <<ROOM:VERDICT pass artifact=<清单sha>>>理由<<ROOM:END>>（pass 按结论换成 reject 或 disclose）。'),
    ),
    'phase-summary': list(f('本回合任务（汇总）：', '本回合任务（汇总）：你这次回复的正文就是汇总（决议、保留分歧、下一轮草案）；另外 1) 对待回应条目表逐项写 <<ROOM:MARK item=<id> status=accepted>>说明<<ROOM:END>>（status 取 accepted、rejected 或 deferred），漏标的会被标为未回应；2) 对每份冻结产物逐一写 <<ROOM:VERDICT pass artifact=<清单sha>>>理由<<ROOM:END>>（pass 按结论换成 reject 或 disclose）。')),
    farewell: list(f('从现在起房间规则失效：', '从现在起房间规则失效：不再有回合、不再接受提交，房间不会再给本席位发包。')),
  }),
});

const SURFACE_FRAGMENTS_EN = Object.freeze({
  tool: Object.freeze({
    preamble: list(
      f('Available commands:', 'How to act: this seat acts only through the host room tool {{toolName}} (the room tool): action in wait|submit|status|leave|point|quote|mark|verdict|disclose|pass|misquoted|assign|artifacts, always passing "room":"{{roomId}}" and "attempt":"{{attemptId}}" for turn actions. The host binds your seat automatically: never pass tokens, session ids or other seats, and do not operate the room via shell commands or direct file writes.'),
      f('Submit:', 'Submit: call ' + callEn('submit', ',"text":"<full speech>"') + '; pass your speech directly in text without writing a file.'),
      f('Speech structure:', 'Speech structure: respond to prior points first (quote verbatim with ' + callEn('quote', ',"seq":N,"text":"verbatim excerpt"') + '), then report your own findings or work.'),
    ),
    'role-executor': list(f('After finishing, declare artifacts first', 'After finishing, declare artifacts first: call ' + callEn('artifacts', ',"paths":["<path>"]') + ' (the room hashes and freezes them without editing), then submit your report covering what you did, relative paths changed and how you verified it.')),
    'role-lead': list(
      f('During assign, run', 'During assign, call ' + callEn('assign', ',"text":"<full draft>"') + ' to draft tasks (one line `- <seatId>: <task> | acceptance: <argv JSON>`), which take effect only after user confirmation.'),
      f('During summary, mark every pending item', 'During summary, mark every pending item (' + callEn('mark', ',"item":"<id>","status":"accepted|rejected|deferred","text":"..."') + '); unmarked items are highlighted as unanswered.'),
    ),
    'role-participant': list(
      f('To raise an objection', 'To raise an objection on an earlier speech, call ' + callEn('point', ',"seq":N,"text":"..."') + ' so it enters the pending item table; if you have nothing new to add, call ' + callEn('pass') + '.'),
      f('If a summary misquotes you', 'If a summary misquotes you, call ' + callEn('misquoted', ',"seq":N,"text":"..."') + '.'),
    ),
    'role-reviewer': list(
      f('Submit your verdict via', 'Submit your verdict via ' + callEn('verdict', ',"value":"pass|reject|disclose","artifact":"<manifestSha>","text":"reason"') + ', or append <<ROOM:VERDICT pass artifact=<manifestSha>>> at the end of your submit text.'),
      f('When verdict is disclose, you must also submit', 'When verdict is disclose, you must also call ' + callEn('disclose', ',"argv":["git","diff"],"reason":"..."') + ' (one array item per token), otherwise it is marked malformed.'),
    ),
    'phase-assign': list(f('Turn task (assign):', 'Turn task (assign): draft the task list. Write one line per executor seat: `- <seatId>: <task> | acceptance: ["node","--test","x.test.mjs"]`, pass the draft as text to ' + callEn('assign', ',"text":"<full draft>"') + ', then call submit to finish the turn.')),
    'phase-work': list(f('After finishing: 1)', 'After finishing: 1) call ' + callEn('artifacts', ',"paths":["<path>"]') + ' to declare artifacts; 2) submit your report as text. State what you did, which relative paths changed, how you ran verification and the exact result.')),
    'phase-summary': list(f('Turn task (summary):', 'Turn task (summary): 1) mark every pending item (accepted|rejected|deferred with a reason), as unmarked items are flagged unanswered; 2) record a verdict for every frozen artifact; 3) submit the summary body (decisions, open disagreements, next-round draft) as text without writing a file.')),
    farewell: list(f('From now on, room rules no longer apply:', 'From now on, room rules no longer apply: there are no further turns or submissions, and room tool {{toolName}} actions for this room will only return ROOM_CLOSED.')),
  }),
  hosted: Object.freeze({
    preamble: list(
      f('Available commands:', 'Submission mode: this seat is hosted by the room, with no CLI commands or room tool; the full text of your reply is your speech for this turn.'),
      f('Submit:', 'Structured records (quote, point, pass, mark, verdict, disclose, assign) must be written as exact ASCII markers in your reply body: do not translate them and do not place them inside code fences or > quote lines (markers there are ignored); terminate body markers with <<ROOM:END>>; replace placeholders N, <id>, <manifestSha> with real values; if you have nothing new to add, reply with only <<ROOM:PASS>> (never combine it with other markers).'),
      f('Speech structure:', 'Speech structure: respond to prior points first (quote verbatim with <<ROOM:QUOTE seq=N>>verbatim excerpt<<ROOM:END>> matching speech N verbatim), then share your views.'),
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
  'zh-CN': SURFACE_FRAGMENTS,
  en: SURFACE_FRAGMENTS_EN,
});

// Lines built in code (packet.mjs, structured.mjs via service.mjs, seat.mjs). The cli text stays at its call site.
export const SURFACE_LINES = Object.freeze({
  tool: Object.freeze({
    dropped: '被裁掉的发言不在本包里；需要原文时请用户在房间界面查看，不要自己去读房间目录。',
    resubmit: '请用房间工具的结构化 action（带本包的 attempt）或在 submit 的 text 里写原样 ASCII 标记重新提交；标记示例：<<ROOM:VERDICT pass artifact=<manifestSha>>>、<<ROOM:PASS>>。',
    turnRead: '先读完房间工具返回的包全文再工作。',
    turnSubmit: '交卷：调用房间工具 submit（attempt={{attemptId}}，text 是发言全文），不用写文件。',
    waitAgain: '调用 wait',
    malformedAccepted: '房间接受了这次提交但标为 malformed，会在下一个包里追问一次；只用原样 ASCII 标记（写在 submit 的 text 里）或房间工具的结构化 action 更正。',
  }),
  hosted: Object.freeze({
    dropped: '被裁掉的发言你看不到，只依据本包里的内容发言。',
    resubmit: '请在回复正文里只用原样 ASCII 标记重新提交（不要翻译，不要放进代码块或引用行）；标记示例：<<ROOM:VERDICT pass artifact=<manifestSha>>>、<<ROOM:PASS>>。',
  }),
});

const SURFACE_LINES_EN = Object.freeze({
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
  'zh-CN': SURFACE_LINES,
  en: SURFACE_LINES_EN,
});

// surfaceLine(surface, key, lang) -> the line for a tool/hosted seat, undefined for cli (callers keep their cli text).
export function surfaceLine(surface, key, lang = 'zh-CN') {
  const k = surface && surface.kind;
  const table = SURFACE_LINES_BY_LANG[lang] || SURFACE_LINES;
  return k && k !== 'cli' && table[k] ? table[k][key] : undefined;
}

const CLI_ONLY = /\{\{\s*(roomCmd|seatDir)\s*\}\}/;
// surfaceText(templateName, text, kind, lang): cli -> text unchanged (same value).
export function surfaceText(name, text, kind, lang = 'zh-CN') {
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
  'zh-CN': SURFACE_HASH,
  en: Object.freeze(Object.fromEntries(['tool', 'hosted'].map((k) => [k, sha256(JSON.stringify({ fragments: SURFACE_FRAGMENTS_EN[k], lines: SURFACE_LINES_EN[k] }))]))),
});
export function surfaceHashOf(kind, lang = 'zh-CN') {
  const table = SURFACE_HASH_BY_LANG[lang] || SURFACE_HASH;
  return table[kind];
}
