# INTERFACES · 模块接口与存储契约（实现者必读）

本文件是方案 v0.4 修订 2 的落地契约。方案原文是作者的内部设计稿，不随公开版发布；公开的设计说明见 `docs/DESIGN.md`。
方案是「为什么」；本文件是「长什么样」。两者冲突时以本文件为准并在 PR 说明里指出。

已有代码（P−1 探针，可以改、可以重构，但 README 里写明的席位命令契约不能破）：
`room.mjs`、`lib/common.mjs`、`lib/guard.mjs`、`lib/packet.mjs`、`lib/service.mjs`、`lib/seat.mjs`、`lib/admin.mjs`、`lib/join.mjs`、`lib/audit.mjs`、`lib/codex.mjs`、`test/e2e.mjs`。

硬规则（来自方案 §1.6 不干扰契约，违反即 bug）：
1. 房间服务只写房间目录与快照副本；席位命令只写本席位发件箱；所有写入经 `lib/guard.mjs`。
2. 房间不起、不杀、不附着任何用户 agent 进程；唯一外向动作是对登记线程的唤醒推送与内置 Pi 自己的进程。
3. 任何子进程（唤醒、披露执行、验收命令、Pi worker）都经 `lib/spawn.mjs`，环境只含白名单变量。
4. 不对席位的真实目录调用 git；快照副本里 `git init` 或 `GIT_CEILING_DIRECTORIES`。
5. 读 agent 原生日志只读、流式、读完即关、范围限登记的会话。
6. 永远不说「只读」「无写操作」，只说「未观测到」。
7. 协议标记、状态词、事件类型一律 ASCII；用户可见文案中文。
8. Node ≥ 22，ESM，零运行时依赖（内置 Pi 席位例外：`@earendil-works/pi-coding-agent` 按需安装）。Windows 11 首发，但纯逻辑模块要能在 Linux 跑测试。
9. 每个模块自带 `test/<module>.test.mjs`（`node --test`），纯函数优先。

## 1. 目录与文件

房间目录（默认 `%USERPROFILE%\room-dev\rooms\<id>`，即 `lib/common.mjs` 的 `defaultRoomsRoot()`；建房与建席时校验：不在任何席位 cwd、CODEX_HOME、CLAUDE_CONFIG_DIR 之内，且 `virtualizationRedirect(dir)` 为 null）：

**不放 AppData 的原因（2026-10-01 实测）**：从 MSIX 打包应用（Claude 桌面应用就是）里起的进程，写 `%LOCALAPPDATA%` 会被重定向到 `AppData\Local\Packages\<pkg>\LocalCache\Local\...`，只有同一包上下文里的进程看得到原路径；从开始菜单打开的 Codex Desktop、Claude Code 看不到。`virtualizationRedirect(p)` 用 `fs.realpathSync.native` 比对真实位置，命中 `\Packages\*\LocalCache\` 时 `admin init` 与 `admin add-seat` 必须拒绝并用中文说明原因。席位 cwd 同样检查。临时目录一律用 `testRunsRoot()`（`%USERPROFILE%\room-dev\test-runs`），可用环境变量 `ROOM_DEV_HOME` 改根。

```
room.json                 配置（见 §2）
events.jsonl              唯一提交点，只有服务写（append + fsync）
state.json                由 events 归约出的派生状态，原子写
packets/<packetId>.md     包正文
manifests/<packetId>.json 包清单（§7）
artifacts/<seatId>/<manifestSha>.json   冻结清单
snapshots/<seatId>/<manifestSha>/       快照副本（披露/验收在此执行）
seats/<seatId>/{JOIN.md, token, seat.json, room.cmd}
replies/<seatId>/<submissionId>.json    服务对席位提交的回执
admin.token               只有用户可读
admin-queue/*.json        admin 命令队列；处理后移到 admin-queue/done/
private/<attemptId>/      原始记录（包头、提交字节、命令原始输出）
private/audit/<seatId>.json  服务自己的审计续读状态 {kind, threadId, cwd, sessionId?, childThreads?, discoveryCursors?, cursors?}
write-log.jsonl           guard 写日志
service.lock              {pid, startedAt, procStartedAt, heartbeatAt}
```
`service.lock` 的存活判定（服务启动与 admin 命令共用 `lib/common.mjs` 的 `lockHolderAlive`）：pid 不在、或 `heartbeatAt` 超过 120 秒没更新（服务每 20 秒写一次）即视为过期；服务启动前还向系统查询该 pid（`probeLockHolder`），进程名不是锁里记的 `image`（旧锁按 node）、或启动时间晚于写锁的进程，也视为过期。PowerShell 5.1 重定向输出用 OEM 代码页（中文系统是 936），所以查询把进程名按 UTF-8 字节转成 base64 输出（`b64:<...>|<启动时间>`，`lockProbeScript` / `parseLockProbeOutput`），`圆桌` 这样的非 ASCII 进程名也能对上；读不出来时判 `unknown`（不接管）。拒绝启动第二个实例时的提示是中文，错误码 `SERVICE_RUNNING`。
Pi 的 API key 明文从不落盘，也从不进房间目录：没有 `private/pi-key-*.key` 交接文件（旧版本留下的在服务启动时删除），admin-queue 里带 key 的记录读到即删、不执行。唯一落盘的是用户用 `admin pi-key --save` 存的 DPAPI 密文，在应用级 `secrets/` 下（见下文与 §9）。

席位发件箱 `<seat.cwd>/.room-outbox/<seatId>/`：
```
joined.json  leave.json  last-attempt.json  write-log.jsonl
<submissionId>.md + <submissionId>.json     发言提交（submissionId = <attemptId>-s<hex>）
<submissionId>.json 也用于结构化提交：meta.kind ∈ speech|point|quote|mark|verdict|disclose|pass|misquoted|assign|artifacts
```
应用级：`%USERPROFILE%\room-dev\adjudications.jsonl`（跨房间 verdict 记录，`path.join(appRoot(), 'adjudications.jsonl')`）。
应用级（P3）：`%USERPROFILE%\room-dev\secrets\pi-key.dpapi`（`path.join(appRoot(), 'secrets', 'pi-key.dpapi')`，内置 Pi key 的 DPAPI 密文，CurrentUser 作用域）与 `secrets\write-log.jsonl`（只记 `admin pi-key --save/--forget` 的写入，who=`admin:pi-key`）。同样不放 AppData；写入经根为 `appRoot()/secrets` 的 guard，写完用 `virtualizationRedirect()` 查这个文件本身，被重定向（MSIX 包缓存或链接）就删掉刚写的文件并用中文拒绝。

## 2. room.json

```jsonc
{
  "schema_version": 2,
  "id": "p2", "createdAt": "...",
  "preset": "implement-review" | "discussion" | "report" | "cross-check" | "division" | "simplified",
  "wallClockSec": 2700, "workWallClockSec": 3600, "maxWorkConcurrent": 2,
  "budget": { "maxTokens": null, "packetMaxBytes": 200000 },
  "disclosureAllowlist": [["git","diff"],["git","status"]],      // argv 前缀；任务单里的验收命令自动加入
  "templates": { "preamble": "<sha256>", "roles": { "executor": "<sha256>", "lead": "...", "participant": "...", "reviewer": "..." }, "all": "<templateHash>" },
                                                                  // 模板哈希（CRLF 归一后）；all = 包清单里的 templateHash
  "seats": [ Seat ]
}
Seat = {
  "seatId": "A", "name": "...", "role": "lead"|"reviewer"|"executor"|"participant",
  "waitMode": "background"|"turn_over"|"manual", "cwd": "...", "outbox": "...", "roomDir": "...",
  "createdAt": "...", "wallClockSec"?: n, "waitTimeoutSec"?: n,
  "declaredTier": "discussion"|"readonly"|"workspace"|"full",   // 声明值；观测值在审计里
  "wake": { "enabled": bool, "kind": "codex-queue", "thread": "<uuid|name>", "maxPerTurn": 1 },
  "audit": null | { "kind": "codex"|"claude", "threadId"?: "<完整 UUID>", "sessionId"?: "...", "cwd": "...", "knownTranscripts"?: [...] },
                              // codex 的 threadId 必须是完整 UUID（admin 拒绝前缀或名字）；审计按文件名里的 UUID 精确匹配。
                              // 服务把审计中学到的 sessionId / childThreads / discoveryCursors / cursors 存在 private/audit/<seatId>.json，
                              // 下次审计不再探测候选、不从头重读（见 §7 audit）
  "hosted": null | { "kind": "pi", "tier": "discussion"|"exec"|"reviewer" },
  "reviews": ["B"]            // 分工模式：本席位审查哪些席位的产物（审查边）
}
```

## 3. 状态机

阶段：`idle → assign? → work? → meet → summary → done → closed`。`assign` 与 `work` 按预设可跳过。
- assign：主力 `room assign --file` 起草 → `task_drafted`；用户 `admin confirm-task` → `task_confirmed` → 进 work（有执行席位）或 meet。
- work：执行席位各自 `wait` 得到 Work 包（attempt），完成后 `room artifacts --declare` + `submit` 汇报；同时持有 attempt 的席位 ≤ `maxWorkConcurrent`；整体墙钟超时 → `work_partial`。
- meet：串行，order 决定；主力第一位。
- summary：主力一回合：`room mark` 逐项标注 + `room verdict`（逐产物）+ submit（汇总正文）；漏标项标 unanswered；汇总有 version；交付后给各席位的下一个包附取代通知。
- 终态词表（每个 attempt 恰一个）：`submitted | failed(class) | canceled | expired | work_partial`。
- 标注（附在提交/verdict 上）：`malformed | audit_failed | tainted | stale | accepted_stale | none`。
- epoch 递增：`interrupt`（打断并重开本轮）、`reassign`、`reverse`（换向）、服务重启时发现未决 attempt 且用户选择 void。
- 用户新消息：`admin say --text` → `user_message_queued`，默认下一轮边界进入包；`admin interrupt` 立即重开。
- 超时等决定（有预设的房间）：assign / meet / summary 的非追问 attempt 超时 → `attempt_expired {hold:true}`，回合不前进，`state.awaitingDecision = {seatId, attemptId, phase, roundId, epoch}`，不再发包，直到用户选择：`admin retry [--seat <id>]`（同一席位为同一回合领新 attempt；没有等待中的决定时失败 `NO_DECISION_PENDING`）、`admin skip`（`seat_skipped`，记入 `state.absent`，汇总带「缺席标记」）、`admin reassign`；新一轮或重开也清除它。无预设（P−1）房间仍自动前进。
- 披露与过期的用户决定：`admin approve-disclose <id>`、`admin deny-disclose <id> --reason <理由>`（理由必填）、`admin accept-stale <manifestSha>`（只有复算出变化才可接受，否则 `NOT_STALE`；带 `changed` 时必须与最新复算一致，否则 `CHANGED_MISMATCH`）。托管 Pi 的工具许可走 `/api/admin` 的 `pi-permission {seatId, id, decision}`。
- 任务单验收命令必须能不经 shell 执行：`argv[0]` 在干净 PATH 上找不到（`COMMAND_NOT_FOUND`）或只有 .cmd/.bat 包装（`BATCH_SHIM_UNSUPPORTED`，例如 `npm`）时，起草回合记 malformed（reason `acceptance_unresolvable`，追问一次），`admin confirm-task` 失败 `ACCEPTANCE_BATCH_SHIM` / `ACCEPTANCE_UNRESOLVABLE`，中文说明改用 `["node","<脚本路径>",...]` 或 .exe。

## 4. 事件（events.jsonl，每行 `{seq, ts, type, ...}`）

已有：`seat_joined seat_left task_set round_started packet_issued submission_accepted submission_rejected attempt_canceled attempt_expired seat_skipped epoch_bumped round_done room_closed wake_pushed`。
新增：
```
task_drafted {seatId, attemptId, draft:{assignments:[{seatId, text, acceptance:[argv]}], text}}
task_confirmed {by:'admin', assignments}
phase_changed {from, to, roundId}
work_started {roundId, seats:[...]}            work_partial {roundId, seatId, attemptId}
artifacts_frozen {seatId, roundId, manifestSha, baseline, fileCount, bytes, excluded:[...], copyTorn:bool, attemptId, snapshotDir, manifestPath, empty,
                  snapshotStale:bool, snapshotChanged:[...], refused?:[{path, reason:'reserved'|'symlink'|'outside'}]}
                                              （snapshotStale：声明后、复制前文件变了，副本与冻结清单不符 → 披露拒绝 SNAPSHOT_STALE；
                                               refused：快照不复制的条目，.git / .room-snapshot、路径上有链接、真实路径在 cwd 外）
artifacts_recomputed {seatId, manifestSha, changed:[{path, from, to}], stale:bool, error?}
stale_accepted {manifestSha, by:'admin', changed:[...], error?, recomputedTs?}   （只覆盖这份变化清单；之后又变的文件让 verdict 仍是 stale，reason STALE_CHANGED_SINCE_ACCEPT）
work_no_artifact {seatId, attemptId, roundId, reason:'none_declared'|'empty', manifestSha}   （Work 汇报声称完成但本轮没冻结或冻结为空；回执 annotation 'no_artifact'）
point_added {itemId, seatId, attemptId, aboutSeq, text}       （attempt 之后被作废/过期 → 该 point 标 voided，不进条目表；他人对某条发言的 point 不替换原条目）
quote_submitted {seatId, attemptId, quotedSeq, text, verified:bool, reason}   （引用被取代的 seq → verified=false reason=superseded）
item_marked {itemId, by, status:'accepted'|'rejected'|'deferred', text, phase}   （只有汇总回合的牵头席位能标；其他标记不记录，回执 notes 带 code 'mark_not_permitted'）
misquoted_declared {seatId, aboutSeq, text}
verdict_recorded {seatId, attemptId, artifactSha, verdict:'pass'|'reject'|'disclose'|'none', annotation, annotations:[...], entersSummary, authorized:bool, tainted:bool, producer,
                  evidence?:{reason, changed, recomputeError?, audit, text, source}}
disclose_requested {id, seatId, attemptId, argv, reason, manifestSha, allowed, matched?, matchKind?:'exact'|'prefix'}
disclose_approved {id, by}
disclose_denied {id, by:'admin'|'room', reason, message?}     （room 的理由：NOT_IN_ALLOWLIST、ARG_NOT_ALLOWED、NO_SNAPSHOT、SNAPSHOT_STALE、BATCH_SHIM_UNSUPPORTED、COMMAND_NOT_FOUND、ARGV_CHANGED）
disclose_executed {id, manifestSha, exitCode, outputSha256, truncated, privatePath}
summary_published {version, seatId, attemptId, unanswered:[itemId], supersedes:version|null,
                   verdicts:[Entry], excluded:[Entry], verified:[{artifactSha, producer, verified, reason, by}],
                   absent:[{seatId, phase, by, attemptId}], noArtifact:[{seatId, attemptId, reason, manifestSha}]}
                                              Entry = {artifactSha, verdict, seatId, annotation, annotations, tainted, authorized, producer, verified?, verifiedReason?, originalAnnotation?}
                                              （只有产物的审方给的 verdict 有约束力；其他席位的 verdict 进 excluded，annotation 'not_reviewer'，原标注在 originalAnnotation）
superseded_notice {forSeat, oldVersion, newVersion, packetId}
direction_reversed {epoch, before:{reviewer, executor}, after:{...}}
needs_reconcile {attemptId, seatId}           reconciled {attemptId, action:'replay'|'void', receipt?:'sent'|'unknown'|'room'}
packet_resent {seatId, attemptId, packetId, path, manifestPath, sha256, bytes, resend:n, reason:'receipt_unknown'}
                                              （replay 时席位发件箱 last-attempt.json 没有记下取走本 attempt → 回执 unknown → 同一 attempt 重发，
                                               新包文件 packets/<packetId>.resend-<n>.md 在标题后加房间块「重发说明…若已收到请忽略…」；回执 sent 的原样交回）
user_message_queued {msgSeq, text, sha256, deliverFromRound, immediate?}   （msgSeq 是消息序号；事件自己的 seq 是信封序号）
round_reopened {epoch, supersededSeqs:[...], phase, phases}   （被取代的 seq 上的 point、被取代回合的 point/quote、重开前本轮记的 point 都标 voided）
attempt_expired {seatId, attemptId, hold?:true}   （hold：有预设的房间等用户 retry / skip / reassign，见 §3）
wake_pushed {seatId, attemptId, thread, threadId?, by, roundId, turnKey, command_ok, detail, refused?:'THREAD_BUSY'|'IDLE_UNKNOWN', turn_observed}
                                              （thread：登记的线程 UUID 或线程名；线程名先经 CODEX_HOME/session_index.jsonl 只读解析成 UUID 再推送，threadId 记实际推送的 UUID；重名时不推，refused IDLE_UNKNOWN）
                                              （refused：推送前只读空闲检查不通过，什么也没推，需用户唤醒；不计入每回合 W 次；state.wakes 没有 attempt 时键为 seat:<id>）
seat_failed {seatId, attemptId, class:'rate_limited'|'quota_exhausted'|'auth_expired'|'crashed'|'denied'|'other', detail}
usage_reported {seatId, attemptId, input, output, cached, source:'hosted'|'declared'|'audit'}
farewell_issued {packetId, seats:[...]}
audit_observed {seatId, attemptId, status:'present_in_native'|'header_only'|'unknown', writes:[...], unknownCommands:[...], tainted:bool}
```
归约器 `reduce(state, ev)` 必须纯函数；`rebuild(roomDir)` 从 events 重建；崩溃后未决 attempt → `needs_reconcile`，席位下一条命令得到 `NEEDS_RECONCILE`，用户 `admin reconcile <attemptId> replay|void`。
state 另有：`awaitingDecision`（§3）、`absent[]`（被跳过的席位）、`noArtifact[]`（work_no_artifact）、`disclosures[id].matched / matchKind / denyMessage`。
提交回执：迟到的提交属于本席位已取消/过期/作废/跳过的 attempt → `REJECTED STALE_ATTEMPT`（不论席位手里有没有新 attempt）；别人的 attempt → `NOT_YOUR_TURN`。Work 汇报无产物 → 回执 `annotation:'no_artifact'`；非牵头席位的标记 → 回执 `notes:[{code:'mark_not_permitted', items}]`。

## 5. 席位命令（lib/seat.mjs）

通用：`--seat <seatDir>`；需要回合的带 `--attempt <id>`。第一行状态词是契约；预期结果退出 0；`REJECTED` 2；`PENDING`/`NO_SERVICE` 8；错误 9。
```
wait [--timeout S] [--once]      TURN | TURN_OVER | NOT_YOUR_TURN | NOTICE ... | NEEDS_RECONCILE | ROOM_CLOSED | LEFT
submit --file <path>             ACCEPTED [MALFORMED <reason>] | REJECTED <reason>
status [--log] [--whoami]        STATUS ...；--whoami 打印登记的审计源与线程/会话 id
leave                            LEFT
artifacts --declare <path>... [--baseline none|whole|<manifestSha>] [--exclude <glob>]   FROZEN manifest=<sha> files=<n>
point --seq N --text "..."       ACCEPTED item=<id>
quote --seq N --text "..."       ACCEPTED verified=true|false
mark --item <id> --status accepted|rejected|deferred --text "..."
verdict pass|reject|disclose --artifact <manifestSha> --text "..."      （disclose 必须同时 disclose 命令，否则 malformed）
disclose --arg git --arg diff --reason "..."        REQUESTED id=<id>
                                 （每个参数一个 --arg，不用引号；以 - 开头的写 --arg=--stat；也可 --argv-file <JSON 文件>；
                                  旧写法 --argv '["git","diff"]' 仍接受，含 PowerShell 5.1 / cmd.exe 改写后的形式）
                                 （房间前缀白名单之后的参数不得是绝对/盘符/UNC 路径或含 ..；git 只许固定的只读选项 → 否则 denied ARG_NOT_ALLOWED；
                                  任务单验收命令须完全一致）
pass                             ACCEPTED
misquoted --seq N --text "..."
assign --file <draft.md>         DRAFTED（草案格式：每行 `- <seatId>: <任务> | 验收: <argv JSON>`）
```
文本标记备路径（在 submit 的正文里）：`<<ROOM:VERDICT pass artifact=sha>>`、`<<ROOM:DISCLOSE argv=[...]>>`、`<<ROOM:POINT seq=N>>…`、`<<ROOM:QUOTE seq=N>>…<<ROOM:END>>`、`<<ROOM:MARK item=id status=accepted>>`、`<<ROOM:MISQUOTED seq=N>>`、`<<ROOM:ASSIGN>>…<<ROOM:END>>`、`<<ROOM:PASS>>`。处理顺序见方案 §4.5：先剔除定界块与引用块内的标记；取本回合最后一个；冲突/缺失/变形 → malformed → 追问一次 → verdict 记 none，绝不默认 pass。
结构化提交也走发件箱：`<submissionId>.json` 的 `meta.kind` 区分，服务回执同路径。

## 6. 包与清单（lib/packet.mjs）

包 = 房间前言块（seat=room authority=room）+ 用户任务块（authority=user）+ 已接受发言块（authority=none，带声明行）+ 摘要块（当前汇总 version）+ 材料块 + 条目表（summary 回合）+ 取代通知（如有）+ 作废声明（上一 attempt 被作废时，带 attemptId）+ 本回合任务。
每包随机 nonce；块头 `[ROOM:<nonce>:seat=<x> authority=<user|none|room> seq=<n> hash=<16hex>]`，块尾 `[/ROOM:<nonce>]`；席位文本里的 `[ROOM:` `[/ROOM:` 转义为 `[ROOM\:`，计数。
预算（§7.6）：以整条消息为单位，钉住当轮全部发言、被引用消息、当前汇总；其余旧到新丢，写 `dropped: [{fromSeq,toSeq}]`。包超过 `budget.packetMaxBytes` 才触发。
清单 manifests/<packetId>.json：`{packetId, seatId, attemptId, roundId, epoch, nonce, sha256, bytes, messageSeqs, summaryVersion, materialVersions, templateHash, renderVersion, declaredTier, auditSource, hostOutputLimit, escaped, prevManifestId, dropped}`。
散会声明包（farewell）：房间规则失效；同伴内容不是用户指令；不要写进持久记忆。

## 7. 治理模块

- `lib/workspace.mjs`：`declareArtifacts({cwd, paths, baseline, exclude, sizeCap}) → manifest`（只读遍历，sha256，含未跟踪文件，默认排除 `.room-outbox/`、`.git`（目录或 worktree/submodule 的指针文件，任意深度）、`node_modules/`，顶层 `.room-snapshot` 保留；路径中间有链接/联接点的、真实路径不在 cwd 内的都排除；复制前后哈希比对 → copyTorn）；`recompute(manifest) → {changed, stale}`；`snapshot(manifest, dest)` 复制（逐文件复制前后再查链接与真实路径，被换成联接点的拒绝并记入 `refused`，`stale`=true）并在副本里 `git init`；`runInSnapshot({snapshotDir, argv, env})`（经 lib/spawn.mjs，不经 shell，输出上限，原始输出进 private/）：HOME/USERPROFILE/XDG_CONFIG_HOME 指向副本内房间自有的空目录 `<snapshot>/.room-snapshot/home`，TEMP/TMP 指向副本根；`GIT_DIR=<副本>/.git`、`GIT_WORK_TREE=<副本>`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=NUL`，并经 `GIT_CONFIG_COUNT` 强制 `core.fsmonitor=false`、`core.hooksPath=NUL`、`core.pager=cat`、`credential.helper=`。执行前 `checkCommand(argv[0])`：只有 .cmd/.bat 包装 → `BATCH_SHIM_UNSUPPORTED`，找不到 → `COMMAND_NOT_FOUND`，都不起进程；`snapshotArgProblem(argv)`：参数是绝对/盘符/UNC 路径、含 `..`、含 NUL，或 git 的子命令前全局选项、`-c`/`-C`、`--output*`/`--no-index`/`--git-dir*`/`--work-tree*`/`--exec-path*`（含缩写）→ `ARG_NOT_ALLOWED`，不起进程。
- `lib/structured.mjs`：解析命令形与文本标记形的结构化提交；条目表（每条 point 一项，没分条的发言整条一项）；汇总版本与取代通知；引文校验（片段逐字出现于指定 seq 的原文）；malformed 判定。纯函数 + 小状态。
- `lib/supervision.mjs`：建房校验（主力不领活、审方不领活、执行者不兼主力、审查边不成环、每产物唯一审方）；`reverse(state)` 前置条件；verdict 绑定清单（stale → 不进汇总）；披露请求状态机（requested → approved|denied → executed）、白名单匹配（argv 前缀）；adjudications.jsonl 追加与驳回率提示（n≥14 且 k=0 → 提示；n<14 → 样本不足；阈值可配）。
- `lib/audit.mjs`（扩展现有）：写操作分类表（`apply_patch`/`FileChange` = write；`exec_command`/`CommandExecution` 的 argv 不在只读白名单 = unknown；`room` 自身命令排除）；Codex 子线程（parent_thread_id / forked_from_id）与 archived_sessions；Claude subagents/tool-results；`auditAttempt({seat, attempt, files, cursors?}) → audit_observed + cursors`；tainted = 审查回合里观测到 write。只打开登记的文件：Codex 线程 id 必须是完整 UUID（`isCodexThreadId`），rollout 按文件名里的 UUID 精确匹配且文件头确认；子线程只跟随登记的 rollout 里 SubAgentActivity 点名的（`findCodexChildThreads` 是 async），没被点名的分叉记为 unknown。`locateFiles(audit, since, firstPacketId)` 返回可选 `persist`（Claude `{sessionId}`；Codex `{childThreads, discoveryCursors}`），`auditAttempt` 返回 `cursors`（每文件 `{offset, lines, size, skipBefore, threadId, shapeOk}`）；服务把两者存进 `private/audit/<seatId>.json`，下次从游标续读、不重复探测。
- `lib/spawn.mjs`：`spawnClean(file, args, {cwd, env: {...只白名单}, timeoutMs, maxOutputBytes, input?})`；白名单：PATH、SystemRoot、SYSTEMROOT、TEMP、TMP、COMSPEC、PATHEXT、WINDIR、LOCALAPPDATA（仅唤醒需要）与调用方显式传入的键。`input`（字符串或 Buffer）写进子进程标准输入后关闭，不进结果对象；它是不能进 argv、也不能进环境的数据（DPAPI 的明文 key）唯一的通道。
- `lib/budget.mjs`：§7.6 预算裁剪，纯函数。
- `lib/usage.mjs`：用量累计（托管席位上报、嵌入式席位 unknown）、paused 判定。

## 8. 服务（lib/service.mjs 重构为可进程内驱动）

```js
export function createRoomService({ roomDir, now = () => Date.now(), log, spawn = spawnClean, codexExe }) 
  → { tick(), state, emit(ev), close(), http?: { port, token } }
export async function serve({ roomDir, tickMs, port?, once? })   // CLI 包装：循环 tick，可选起 HTTP
```
`now` 可注入 → 仿真用假时钟；`tick()` 幂等；所有 I/O 经 guard。Pi key 相关：`piApiKey`（内存）、`savedPiKeyPath`（默认 `appRoot()/secrets/pi-key.dpapi`）、`savedPiKey: false`（不读保存的 key；仿真驱动默认如此）、`piKeyUnprotect`（测试替换 DPAPI 解密）。测试还可注入 `idleCheck`（唤醒前的只读空闲检查；默认先用 `resolveCodexThread` 把登记的线程名经 `CODEX_HOME/session_index.jsonl` 查成 UUID，再读该线程的 rollout，推送也发给这个 UUID）、`snapshot`、`checkCommand`（验收命令 argv[0] 查找）、`codexEnv`（findCodex 查找 codex.exe 的环境：CODEX_CLI_PATH、CODEX_HOME/config.toml、LOCALAPPDATA 安装目录、PATH，只认 .exe/.com）。state.json 写失败（读者占着文件，guard 重试约 1.2 秒后仍失败）只记日志、下个 tick 重写；回执照写；`serve()` 的一次 tick 出错记日志后继续循环。HTTP（可选，`--port`）：loopback 绑定 127.0.0.1，每个请求先过 `checkHostOrigin(headers, port, {method, path})`（`ui/mock-server.mjs` 同规则）：Host 必须正好是 `127.0.0.1:<port>` 或 `localhost:<port>`，带 Origin 时必须是同一回环源，带 Sec-Fetch-Site 时必须是 `same-origin` 或 `none`；唯一例外 `pageNavigation`：`same-site` 的顶层文档导航（GET/HEAD、Sec-Fetch-Mode `navigate`、Sec-Fetch-Dest `document` 或缺省）可以打开 `/`、`/index.html`，这样启动器（另一个回环端口）的链接能打开房间界面；页面不含秘密（admin 令牌只在 URL fragment 里，不发给服务端），`frame-ancestors 'none'` 与 `X-Frame-Options: DENY` 禁止嵌入，`/api/*`、`/seat/*`、脚本样式和所有 fetch 仍只收同源；`GET /api/state`、`GET /api/events?since=`、`POST /api/admin`（body 含 admin 令牌，映射 admin 命令）、`GET /` 静态 `ui/`；席位 loopback 传输 `POST /seat/<cmd>`（席位令牌）作为文件式之外的可选传输。

## 9. 托管席位（lib/hosted/pi.mjs）

```js
export function createPiSeat({ tier, apiKey, model, cwd, sessionDir, onEvent }) → { prompt(packetText, {signal}) → {text, stopReason:'end_turn'|'cancelled'|'error', usage, failureClass?}, cancel(), dispose() }
```
- discussion：`noTools`；reviewer：只读工具集；exec：读写工具但高危调用（写 cwd 外、网络、删除）在工具层拦截 → `permission_pending` 事件交 UI。
- 明文 key 只在内存，从不落盘。四种交法，前三种只在内存：启动服务的环境变量 `ROOM_PI_API_KEY`；`room.mjs serve --pi-key-stdin`（读标准输入第一行，空则退出 9）；服务带 `--port <n>` 运行时 `admin pi-key --dir <room> --port <n> [--seat <id>]`（key 来自标准输入或 ROOM_PI_API_KEY，经 127.0.0.1 的 `POST /api/admin` 交给运行中的服务，带 admin 令牌）；第四种（P3，只在 Windows）是事先保存的 DPAPI 密文，见下一条。不带 `--port`、`--save`、`--status`、`--forget` 的 `admin pi-key` 什么也不写，只用中文说明这几种办法。没有文件或 admin-queue 交接给服务：队列里带 key 的记录读到即删、不执行；服务启动时删除旧版本留下的 `private/pi-key-*.key`。缺 key 时托管席位 `seat_failed {class:'auth_expired'}`，detail 含 `PI_NO_KEY` 与上述办法。
- DPAPI 保存（P3，`lib/hosted/dpapi.mjs`）。`protect(plaintextUtf8) → Buffer`、`unprotect(Buffer) → string`：`[System.Security.Cryptography.ProtectedData]`（`Add-Type -AssemblyName System.Security`），作用域 CurrentUser，固定的应用 entropy（`DPAPI_ENTROPY`）；每次调用经 `spawnClean` 起一个 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <固定脚本>`，环境只有白名单。明文（或密文）只作为一行 base64 经 `input` 进标准输入，脚本用 `[Console]::In.ReadToEnd()` 当数据读；结果以 `DPAPI_OK:<base64>` 从标准输出回来（`[Console]::Out` 直写，不经 PowerShell 宿主）。只有 base64 过管道，CP936 控制台代码页无从破坏。脚本不用 `-Command -` 从标准输入送：实测（2026-10-03，PowerShell 5.1）`-Command -` 会把整个标准输入当脚本先读完，key 就只能写进脚本正文，而含 `Add-Type` 的脚本块在没有任何策略时也会被自动记进事件日志（Microsoft-Windows-PowerShell/Operational 4104，实测记下了探针脚本里的 base64 key）；key 当数据读时不在任何 4104 事件里（`test/dpapi.test.mjs` 每次在 Windows 上复核）。错误只带 ASCII 码：`DPAPI_UNAVAILABLE`（非 Windows、起不了 powershell.exe、受限语言模式）、`DPAPI_FAILED`（解不开、被改动、超时、输出不对）；错误文本从不引用子进程的输出，也从不含 key。`isAvailable()` 在非 Windows 上为 false。
- 保存的位置与命令：`path.join(appRoot(), 'secrets', 'pi-key.dpapi')`（不在 AppData，见 §1），写入经根为 `appRoot()/secrets` 的 guard 与该目录自己的 `write-log.jsonl`，原子写，写完用 `virtualizationRedirect()` 查文件本身。`admin pi-key --save`（不需要 `--dir`；key 来自标准输入或 `ROOM_PI_API_KEY`，`--save <值>` 被拒绝且不回显）只打印 `SAVED <路径> length=<字符数> sha256=<sha256 前 8 位十六进制>`；`admin pi-key --status` 打印 `PI_KEY_STATUS saved=no|yes [decrypts=yes|no|unknown] [code=…] [length=… sha256=…] path=<路径>`；`admin pi-key --forget` 经 guard 删除，打印 `FORGOTTEN <路径>` 或 `NOT_SAVED <路径>`。三者都退出 0；四种模式一次只能用一个。
- 服务启动时：没有来自 `piApiKey`（`--pi-key-stdin`）或 `ROOM_PI_API_KEY` 的 key、房间里有托管席位、保存的文件存在，才解密它（一个 PowerShell 子进程）；所有串行操作（tick、admin、HTTP 席位请求）排在它之后，所以托管回合不会先于它开始；之后经 loopback 交来的 key 照样覆盖它。key 不写日志、不进事件、不进 state.json（只有 `piKey: present|absent` 与 `piKeySource: option|env|admin|saved|null`）。解不开时记一条中文警告（含 ASCII 码，例如 `DPAPI_FAILED`），服务照常运行，托管席位的回合照旧报 `PI_NO_KEY`。
- 失败分类只看退出码/错误码/ASCII 标识；识别不出 other。
- 依赖缺失时模块可加载但 `createPiSeat` 抛 `PI_NOT_INSTALLED`；测试用 `fakeProvider` 注入（`createPiSeat({ provider: fake })`）。

## 10. 界面（ui/）

无构建步骤的静态页（HTML/JS/CSS），由服务 `GET /` 提供；URL fragment 带 admin 令牌。视图按方案 §10：发言流、席位栏、席位包、任务单、条目表、verdict 与冻结、回执、用量、恢复、合并、契约。每个动作 POST `/api/admin`。中文界面，协议标记 ASCII。

**桌面应用 `圆桌.exe`（`app/`，构建 `dist/build-app.mjs`）。** 用户的入口；不再有 `启动圆桌.cmd`。Electron 主进程 `app/main.mjs`（ESM），可测的纯逻辑在 `app/main-helpers.mjs`（`test/app.test.mjs`，不需要 Electron），预加载 `app/preload.cjs`（CommonJS、sandbox）。
- 数据位置：`ROOM_DEV_HOME` 设了但不是绝对路径（Windows 上要带盘符或 UNC）时，`appPaths()` 给出 `problem`，主进程不建任何目录、不调用 `setPath`，弹中文错误框（`--smoke` 时不弹）后 `app.exit(1)`；`setPath` 抛错同样给中文错误框后退出。ready 之前 `app.setPath('userData' | 'sessionData', appRoot()/app-data)`，`crashDumps`、日志（`app-data/logs/main.log`，所有回环地址的 fragment 打码）、`TEMP`/`TMP` 都在 `app-data` 下；不写 AppData（§1）。单实例：第二次启动聚焦已有窗口。`Menu.setApplicationMenu(null)`。
- 启动器进程：`utilityProcess.fork(<room-dev>/room.mjs, ['lobby', '--port', '0'], {stdio: 'pipe', env: {...env, ROOM_SEAT_RUNTIME: process.execPath}})`；`<room-dev>` 是打包后的 `resources/app/room-dev`，开发时是仓库根。主进程从标准输出解析唯一的 `圆桌启动器：http://127.0.0.1:<port>/#<token>` 行（`parseLobbyLine`，令牌是不可枚举属性，不进日志）。在 `process.parentPort` 下，`lib/lobby.mjs` 对每个打开 / 停止的房间发 `{t: 'room-opened' | 'room-closed', id, port}`（不带令牌），收到 `{t: 'quit'}` 时 `close()`（停止它打开的每个房间、删除 `service.lock`）后 `process.exit(0)`；命令行（没有 parentPort）行为不变。
- 窗口：主窗口标题「圆桌」，1180×800（最小 820×560），背景色同 `ui/lobby.css --bg`，ready-to-show 后显示，加载启动器地址。`webPreferences`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`、`preload: preload.cjs`、`devTools` 只在 `ROOM_APP_DEVTOOLS=1` 时。导航：主窗口只留在 `http://127.0.0.1:<启动器端口>`；`window.open` / 链接指向启动器宣布过的房间端口的 `/` 或 `/index.html` 时开一个新的房间窗口，标题 `roomWindowTitle(id)` =「圆桌 · 房间 · <房间编号>」（编号来自启动器的 `room-opened` 消息；`page-title-updated` 被拦下，标题不随页面变）（同样的 webPreferences、无菜单，导航只留在该房间端口；端口还没宣布时最多等 3 秒）；`https:` 弹确认框后交 `shell.openExternal`；其余一律拒绝。`before-input-event` 屏蔽 Ctrl+R、Ctrl+Shift+R、F5（令牌只在页面内存里）。右键菜单只有 复制 / 粘贴 / 剪切 / 全选。权限请求只放行 `clipboard-sanitized-write`，下载一律取消（`will-download` 全局取消；房间界面的导出走下面的 `saveEvidence`）。
- `window.roomApp`（preload，只有这一个对象）：`isApp: true`、`pickFolder(defaultPath) → Promise<string|null>`（IPC `room:pickFolder` → `dialog.showOpenDialog`，`openDirectory` + `createDirectory`，只回应主窗口）、`copyText(text) → Promise<boolean>`（IPC `room:copyText` → 系统剪贴板，只回应应用自己的窗口）、`saveEvidence(name, text) → Promise<{saved: true, path} | {saved: false, canceled: true} | {saved: false, error}>`（IPC `room:saveEvidence`，只回应停在自己房间端口上的房间窗口：在发起窗口上 `dialog.showSaveDialog`，默认路径 `appRoot()/exports/<name>`（名字只留字母、数字、`.`、`_`、`-`，以 `.json` 结尾，`evidenceDefaultPath`），用户确认后 `fs.writeFile` 到用户选的位置；文本上限 `MAX_EVIDENCE_CHARS`）。`ui/app.js` 的「导出证据」在 `window.roomApp.isApp` 时走 `saveEvidence`，只有 `saved: true` 才提示「已导出证据 JSON：<路径>」，取消或失败分别给中性 / 错误提示；浏览器里照旧是 blob + `<a download>`。`ui/lobby.js` 在有 `window.roomApp` 时给每个「工作文件夹」加「浏览…」按钮、复制按钮走 `copyText`、「打开房间界面」在启动器回答后 `window.open(房间地址)`（由主进程变成应用窗口），并照旧留下备用链接。
- 退出：关主窗口即退出。发 `{t: 'quit'}`，最多等 4 秒（`QUIT_GRACE_MS`），没退就 kill。启动器进程意外退出：中文错误框后退出。
- `--smoke`（`--smoke-room` 另建一个临时房间、经同一条 window.open 路径打开它的窗口、等它 did-finish-load、记下标题，退出后删掉这个房间和它的席位文件夹）配合 `ROOM_APP_SMOKE_OUT=<appRoot() 之内的文件>`：主窗口 did-finish-load 后在页面里取 `{title, hasCreate, isApp, hasToken, fragmentCleared}`，加 `{lobbyPortOk, windows, userData, problems}` 写成 JSON，再走同一条优雅退出路径；退出后补写 `shutdown: {graceful, lobbyExitCode, serviceLockRemoved?, cleaned}`。退出码 0 = `problems` 为空。
- 席位运行时（`lib/join.mjs`）：建席时 PATH 上有 `node.exe`，席位命令前缀和允许规则照旧是 `node <room.mjs>` / `Bash(node <room.mjs>:*)`；没有 node 且设了 `ROOM_SEAT_RUNTIME`（绝对路径）时，`seat.json` 记 `runtime: {kind: 'app', exe}`，`room.cmd` 为 `setlocal` + `set "ELECTRON_RUN_AS_NODE=1"` + `"<exe>" "<room.mjs>" %*`，JOIN.md、包、散会包、唤醒文案、`wait` 的交卷提示都改用这个 `room.cmd`，允许规则 `Bash(<room.cmd>:*)`。建席时 `seat.json`（和 room.json 的席位记录）另记 `roomMjs`：建席那个进程的 room.mjs 绝对路径（应用里是打包的 `resources/app/room-dev/room.mjs`，命令行是被调用的那份）。之后由任何一份 room.mjs 渲染的命令前缀（`seatCommandPrefix` / `seatRoomCmd`：启动器入席提示、包、散会包、唤醒文案、`wait` 的交卷提示）都用 `recordedRoomMjs(seat, seatDir)`：`seat.roomMjs`，没有时读席位自己 `room.cmd` 里的 `node "<room.mjs>" %*`，都没有才用当前进程的 `roomMjsPath()`。

**圆桌启动器（`lib/lobby.mjs`，`ui/lobby.*`，`room.mjs lobby [--port N] [--open]`；用户经 `圆桌.exe` 用它，开发者也可以在浏览器里用）。** `startLobby({port = 7380（占用时换空闲端口）, roomsRoot = defaultRoomsRoot(), log, openBrowser = false, parentPort = process.parentPort, exit}) → {url, port, token, close()}`。回环 127.0.0.1，复用 `lib/http.mjs` 的 `checkHostOrigin`、`tokenEquals`、`SECURITY_HEADERS`、`send`、`jsonBody`（POST 只收 application/json、≤ 64 KiB、不带查询串）。每次启动一个随机令牌，只出现在打印的那一行 URL 的 fragment 和 POST 正文里；页面读一次后用 `history.replaceState` 抹掉。接口：`GET /lobby/api/meta`、`GET /lobby/api/rooms`（id、preset、phase、roundId、席位 {seatId, role, agent, cwd, waitMode, wakeThread, joinPath, sentence, hint}、`serviceRunning`（`lockHolderAlive`）、`openedHere`、本启动器打开时的房间界面地址（不带令牌））、`GET /lobby/api/seat-defaults?id=&seat=`（`%USERPROFILE%\room-seats\<id>-<seat>`）、`GET /lobby/api/folder?path=<绝对路径>`（只读，只答 `{exists, isDir}`；页面据此对已存在的文件夹取消勾选「替我新建」）。房间列表的 `id` 是房间目录名，open/stop/task/start 都按它找房间；room.json 自己的 id 另给 `roomId`，不同时 `idMismatch: true`。`meta` 另给 `hostedTiers`：席位选「房间内置 Pi」时发 `hosted: 'pi:<档位>'`，不带 agent、等待方式和线程名。Codex 席位的默认线程名是 `room-<房间>-<席位>`（按名字唤醒时要求不重名）。POST（正文带 `token`）`create {id, preset, seats:[{seatId, role, agent, cwd, createCwd, wait?, wakeThread?, hosted?}]}`（经 `api.createRoom` + `api.addSeat`，CLI 规则全部适用；`createCwd` 只新建不存在的空文件夹，事先检查 AppData、CODEX_HOME / CLAUDE_CONFIG_DIR、与房间互相包含、包含房间的 git 仓库；任一席位失败就删掉本次建的房间目录和新建的空文件夹，只删到本次请求之前不存在的最上层文件夹为止，原有的空文件夹保留；Windows 上工作文件夹路径任一层名字以句点或空格结尾、含 `<>:"|?*` 或控制字符、或是设备名时拒绝 `CWD_BAD_NAME`（`admin add-seat` 同样拒绝）；新建失败拒绝 `CWD_CREATE_FAILED`，已建的上层文件夹同样删掉）、`open {id}`（`api.openRoom({roomDir, port: 0})`，别的服务持锁时拒绝；返回带 admin 令牌 fragment 的房间界面地址）、`stop {id}`、`task {id, text}`、`start {id, order}`（经打开的句柄 `admin()`）。拒绝一律 `{ok:false, error:<ASCII 码>, message:<中文>}`。`close()` 停掉它打开的每个房间。

## 11. 仿真与测试（sim/, test/）

- `sim/driver.mjs`：进程内起服务（假时钟）、脚本席位（`createScriptedSeat({seatId, script})`，script 是步骤数组：wait/submit/point/…/sleep/crash），断言 helper，每用例独立临时房间目录。
- `test/cases/<nn>-<slug>.test.mjs`：方案 §13.1 的 #1–#50 逐条（仿真层能做的全做；真实层的写成 `test/real/` 本机脚本并标注）。
- 变异测试 `test/mutations/`：去掉去重 / attempt 校验 / 复算 / 审计 / 转义 / 未回应计算 / 披露审批闸门 / 标记严格判定 后对应用例必须变红（通过环境变量 `ROOM_MUTATE=no-dedupe|no-attempt-check|no-recompute|no-audit|no-escape|no-unanswered|no-disclose-gate|no-marker-strict` 让服务故意坏掉；列表即 `lib/service.mjs` 的 `MUTATIONS`，`state().mutate` 回显生效的开关）。
- CI：`.github/workflows/ci.yml` windows-latest + ubuntu-latest 跑 `node --test`。

## 12. 契约与证据（contract/, evidence/）

- `contract/check-writes.mjs`（write-log 全在界内）、`contract/control-run.mjs`（不开 agent 跑一整场，配置/记忆/hooks 目录按条目零差异）、`contract/pids.mjs`、`contract/env.mjs`、`contract/memory-diff.mjs`。
- `evidence/collect.mjs`：跑全部检查，输出 pass/fail 表 + 原始记录路径，写 `evidence/REPORT.md`（含本机路径，列入 `.gitignore`，不进版本库）。

## 13. 打包与文档（dist/, docs/）

- `dist/build-app.mjs [--electron-zip <zip>] [--rcedit <exe>] [--out <dir>] [--zip] [--dry-run]`（`npm run app`）：桌面应用。Electron 运行时 zip 取自参数、`ROOM_ELECTRON_ZIP` 或 `%LOCALAPPDATA%\electron\Cache\*\` 下版本最新的 `electron-v*-win32-x64.zip`（只读）；没有就拒绝（退出 2，中文说明），从不下载。用 `lib/zip.mjs` 的 `readZip` 解到 `<out>\圆桌\`（默认 `dist\out`），`electron.exe` 改名 `圆桌.exe`，`resources\default_app.asar` 不解出，`app/` 复制到 `resources\app\`（`package.json` 的 version 取根 `package.json`），room-dev 运行时（`room.mjs`、`package.json`、`README.md`、`docs/INTERFACES.md`、`lib/**`、`ui/**` 去掉 `ui/fixtures` 与 `ui/mock-server.mjs`）复制到 `resources\app\room-dev\`，Electron 的 `LICENSE` 与 `LICENSES.chromium.html` 保留并写 `THIRD-PARTY.md`；rcedit（参数、`ROOM_RCEDIT` 或 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*\rcedit-x64.exe`）设图标与 FileDescription / ProductName「圆桌」、CompanyName「KennyMcSimpson」、OriginalFilename「圆桌.exe」、FileVersion / ProductVersion；写 `BUILD.json {electronVersion, nodeVersion, roomDevCommit, files[{path, bytes, sha256}]}`。新文件夹在旁边组装完整后才替换旧的；删目录用 `fs.promises.rm` 并核对结果（Node 24.11 的 `fs.rmSync` 遇到含中文的路径会静默什么都不删）。`--zip` 另用 `ZipWriter` 打包。`dist/make-icon.mjs` 用纯 Node 画图标（圆桌加四座，16/24/32/48/64/128/256 的 PNG 装进一个 ICO），结果固定，提交的 `app/icon.ico` 必须与它一致。
- `dist/build.mjs`（开发者 ZIP，不是用户的主要用法）：下载官方 Node zip（版本写死并校验 sha256）、复制源码与 ui、生成 `启动器.cmd`、第三方许可表、输出 `room-dev-<ver>-win-x64.zip`；内置 Pi 首次运行按用户选择安装。
- `lib/export.mjs`（命令行包装 `dist/export.mjs`）：导出包只含公开层，密钥与绝对路径扫描，预埋假密钥测试。ZIP 读写在 `lib/zip.mjs`，`dist/build.mjs` 也从那里引用。`lib/` 不得引用 `dist/` 等目录（`test/lib-selfcontained.test.mjs`），因为宿主只内嵌 `lib/`。
- `docs/DESIGN.md`、`README.md`（公开首页，英文在前、中文在后）、`docs/DEVELOPER.md`（开发者说明）、`docs/README-public.md`（产品定义与不干扰契约）、`docs/SUPPORT-MATRIX.md`（能力矩阵，格子取值 已验证/未验证/不支持）、`LICENSE`（MIT）。
- `docs/internal/**`：内部记录（探针报告、证据快照、公开前扫描），不随公开版发布。`dist/public-scan.mjs` 是个人数据扫描规则（绝对个人路径、用户名、邮箱、会话 id 形状、内部名、密钥形状）；`dist/export-public.mjs <outDir>` 把版本库里跟踪的文件（去掉 `docs/internal/**` 与 `dist/out/**`）复制到 `outDir`，写一份新的 `.gitignore`，再用同一套规则扫描每个文本文件，有命中就列出并退出 1，从不改写内容。`dist/build.mjs` 与 `dist/build-app.mjs` 都不打包 `docs/internal/`。

## 14. 文件归属（并行实现时只改自己的文件）

| 模块 | 文件 |
|---|---|
| workspace | lib/workspace.mjs, test/workspace.test.mjs |
| structured | lib/structured.mjs, test/structured.test.mjs |
| supervision | lib/supervision.mjs, test/supervision.test.mjs |
| audit | lib/audit.mjs, test/audit.test.mjs, test/fixtures/audit/* |
| spawn+budget+usage | lib/spawn.mjs, lib/budget.mjs, lib/usage.mjs, test/{spawn,budget,usage}.test.mjs |
| packet | lib/packet.mjs, lib/templates/*.md, test/packet.test.mjs |
| service | lib/service.mjs, lib/reducer.mjs, lib/http.mjs, test/service.test.mjs |
| seat+join+admin | lib/seat.mjs, lib/join.mjs, lib/admin.mjs, room.mjs, test/seat.test.mjs |
| hosted pi | lib/hosted/pi.mjs, lib/hosted/dpapi.mjs, test/hosted-pi.test.mjs, test/dpapi.test.mjs |
| sim | sim/driver.mjs, sim/scripted-seat.mjs, test/cases/*, test/mutations/* |
| ui | ui/* |
| contract+evidence | contract/*, evidence/* |
| dist+docs | dist/*, docs/DESIGN.md, docs/SUPPORT-MATRIX.md, README.md, .github/workflows/ci.yml |
| app | app/*, dist/build-app.mjs, dist/make-icon.mjs, test/app.test.mjs |
| api | lib/api.mjs, lib/api.d.mts, test/api.test.mjs |

## 15. 嵌入接口（lib/api.mjs，给宿主进程用）

宿主（PI-Desktop 的 Electron 主进程、测试、脚本）在自己的进程里跑房间时用它；类型在 `lib/api.d.mts`。它不打印、不退出进程，每个命令返回 `{code, status, fields, lines, error?}`：`status` 是第一行的状态词（§5 的契约），`fields` 是那一行的 `key=value`。命令参数被转成和用户在命令行敲的完全相同的 argv，再交给 `room.mjs` 调用的同一个函数，所以嵌入调用和命令行调用走同一条代码路径。

- `createRoom(params)`、`addSeat(params)`、`admin(sub, params, positional)`：§3/§8 的管理命令；`addSeat` 要在 `openRoom` 之前调用（服务运行时不能加席位，同 CLI）。
- `openRoom({roomDir, tickMs, port, hostedProviders, piApiKey, log})`：在本进程里起 `createRoomService`，定时 tick，维护 `service.lock` 心跳，可选起回环 UI；返回 `{view(), events(since), admin(cmd, params), url, adminToken, close()}`。`admin()` 直接进运行中服务的处理函数，和 admin-queue 记录等价。
- `seatClient({roomDir, seatId})`：一个席位的全部命令（`wait/submit/status/leave/pass/point/quote/mark/misquoted/verdict/disclose/assign/artifacts`）。`submit({text})` 把发言写进该席位自己发件箱的 `drafts/` 再提交，席位仍然只写自己的发件箱。
- 托管通道席位：`addSeat({hosted: 'lane:<名字>[:<档位>]'})` 建席，`openRoom({hostedProviders: {lane: (ctx) => handle}})` 注入运行它的工厂；`handle` 与 `createPiSeat` 的返回同形（`prompt(packetText) -> {text, stopReason, usage, failureClass?}`、`cancel()`、`busy`）。命令行起的服务没有通道，轮到它时记 `seat_failed`，错误码 `HOSTED_PROVIDER_MISSING`。PI-Desktop 用它把 v-subagent 通道（claude-code、anyrouter、webchat…）作为托管席位坐进受治理的房间。托管席位可带模型：`addSeat({hosted: 'lane:anyrouter', model: 'gpt-6-astra'})`（CLI `--model`），记在 `seat.hosted.model`，工厂拿到的 `ctx.seat.hosted.model` 就是它，宿主据此调用通道；外部 agent 不接受 `--model`（模型在它自己那里选）。
- 宿主唤醒：`addSeat({'wake-thread': <会话 id>, 'wake-kind': 'pi-session'})` 登记，`openRoom({wakers: {'pi-session': ({seat, attemptId, thread, text}) => ({ok, detail})}})` 注入投递方式。上限、不重复推送、`wake_pushed` 事件与 Codex queue 完全相同；文案固定为「[ROOM authority=none] 轮到席位 X，请取本回合的包」，不含房间内容。没注入时该席位记为需用户唤醒。
- 服务锁记录写入者自己的进程名（`image`），宿主用自带运行时（`ELECTRON_RUN_AS_NODE`）跑服务时，命令行再起服务不会把它误判为失效而接管。
- `view()` 带 `items`：当前轮的条目表（整段发言条目加意见条目，已套上主力在汇总回合的标注），界面条目表直接用它。
