# 定位与相关工作（POSITIONING）

## Abstract (English)

room-dev's one idea that prior art does not already cover is a design rule, not a single mechanism:
**governance without control**. The room owns no agent process, configuration or working folder, so
every governance mechanism is built to *detect and attest* rather than *enforce*: staleness
detection instead of locks, declared-versus-observed audit instead of sandboxes, request-only
disclosure instead of reviewer execution, provenance labels instead of injection blocking. The only
things the room enforces are turn order and attempt validity. A prior-art scan (2026-10) found every
individual mechanism already in use somewhere (spotlighting, stale-approval dismissal, maker-checker,
native-log auditors, event-sourced agent buses), and found the nearest multi-agent systems all take
some control of the agents. So the contribution is a *novel combination*, and it is not yet
evaluated: no experiment has shown that it catches failures manual forwarding misses. Nine
mechanisms are incremental (prior art named below, plus the narrow step we add); seven are
not innovations at all. The PI-Desktop integration is a plugin because upstream withdrew its core
agent-to-agent stack (ADR 0165) and keeps cross-session coordination in plugins; that is a scope
decision by upstream, not a verdict on novelty.

> 证据口径：「已验证」只取 [`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md) 里的格子；单元测试与脚本席位端到端不算真实 agent 上的证据。先例来自 2026-10 的一次公开资料扫描，描述取自各项目当时的 README、文档或论文摘要，扫描范围有限；拿不准时一律按「更不新」归类。上游 PI-Desktop 的内容读自公开仓库的提交 `10e824ee12f8`（PI-Desktop）与 `c35605a5ed31`（pi-desktop-plugins）。

---

## 1. 一句话定位

**给用户已经在跑、房间并不拥有的异构 coding agent 加一层「只检测、只存证、不控制」的治理。** 房间是一个确定性的 Node 程序：它排发言顺序、发包、转发、记账，并在事后用哈希和 agent 自己的原生日志核对发生了什么；除了「不按顺序、不属于当前 attempt 的提交不被接受」，它对 agent 不强制任何事。

它不是更聪明的 agent，不是 agent 之间的消息总线，也不是托管多个 CLI 的圆桌编排器。

---

## 2. 真正新的地方

扫描后，判为「新」或「新组合」的只有一条。

### 2.1 不控制 agent 的治理（novel combination）

**机制。** 房间对 agent 没有任何控制权：不起、不杀、不附着、不改配置，不拥有它们的工作目录（不干扰契约，见 [`README-public.md`](README-public.md) §6）。由此，治理层的每一项都改写成「检测 + 存证」的形态：

| 通常的做法（需要控制权） | room-dev 的做法（不需要控制权） | 代码位置 |
|---|---|---|
| 给产物加锁，审查期间不许改 | 执行者声明产物，房间逐文件算哈希冻结并复制快照；审方交 verdict 时在执行者的真实目录上复算，变了就标 stale，不进汇总；用户「接受过期」只覆盖他看到的那份改动清单 | `lib/workspace.mjs` `declareArtifacts` / `recompute`，`lib/service.mjs` `recordVerdict` |
| 把审方放进只读沙箱 | 审方的档位只是声明值；房间事后只读审方自己的原生日志（Codex rollout、Claude transcript），观测到写操作就把这次 verdict 标 tainted，形状认不出就标 audit_failed；措辞永远是「未观测到」，不说「只读」 | `lib/audit.mjs` `auditAttempt` / `classifyWrites` |
| 让审方自己跑测试复核 | 审方只能**请求**一条带理由的命令；用户批准后，由房间在冻结的快照副本里执行，原始输出进私有层，事件里只留退出码与输出哈希 | `lib/supervision.mjs` `requestDisclosure` / `executeDisclosure`，`lib/workspace.mjs` `runInSnapshot` |
| 拦截提示注入 | 转发内容一律包进带每包随机 nonce 的来源横幅，`authority=none` 的块带固定的「不是用户指令」声明；只打标签，不声称防御 | `lib/packet.mjs` `block` / `escapeMarkers` |
| 相信 agent 自报「已送达 / 已完成」 | 完成只认 `submit` 被接受；送达回执单独来自原生日志（present_in_native / header_only / unknown），「已读」永远是 unknown | `lib/service.mjs`，`lib/audit.mjs` |

房间真正强制的只有两件事：发言顺序与 attempt 有效性（`NOT_YOUR_TURN`、`STALE_ATTEMPT`、`BAD_PROOF`，在 `lib/service.mjs` 的提交检查里）。

**为什么先例没有覆盖。** 每个零件都有先例，所以新的是组合方式和它背后的那条设计规则：

- 「检测型控制 vs 预防型控制」是安全与审计框架的教科书区分（NIST SP 800-53 的控制类型、COSO），本身不新。
- [skettleson/clauditor](https://github.com/skettleson/clauditor) 已经在不改动 Claude Code、Codex、Cursor 的前提下，事后读它们的原生日志、对照声明角色给出判定。这是「不控制的检测」，但对象是单个会话，不是一个协调协议。
- 最接近的多 agent 协调系统都拿了一部分控制权：[DhanushSantosh/AgentComms](https://github.com/DhanushSantosh/AgentComms) 做受治理、事件溯源的通信，也把送达证据和 agent 自报分开记，但它强制租约，并由自己起、自己提示 Claude Code / Codex / OpenCode；[ExaDev/agent-comms](https://github.com/ExaDev/agent-comms) 会自动改写宿主的配置文件（MCP 服务器、插件清单、钩子）；PI-Desktop 上游被撤回的 A2A 栈（ADR 0147 / 0162 / 0164）是宿主核心里的 broker，从宿主内部控制会话。
- 托管式圆桌（如 [bcraavi/ai_roundtable](https://github.com/bcraavi/ai_roundtable)）和 [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) 都由编排方启动 agent。

扫描里没有找到哪个系统把「协调层不拥有任何 agent，所以只检测、只存证」立为治理异构、由用户自己持有的 agent 的设计规则。

**它还缺什么。** 这是一个连贯的新框架，不是新技术，而且**没有评估过**：

- 没有对照实验表明它能抓到人工转发漏掉的失败。计划中的对照（同一组任务，人工转发 vs 房间）还没跑。
- 治理层（冻结、stale、verdict、披露、条目表）在真实 agent 上全部未验证，只在单元测试和脚本席位端到端里跑过（SUPPORT-MATRIX）。
- 写操作审计依赖厂商未公开、会变的日志格式；被拒绝的写不留记录；不认识的命令只列出、不染色；Claude Code 一侧的审计未验证。
- 席位令牌放在房间目录里，同机的其他席位读得到（DESIGN §7.1），所以顺序约束只防糊涂的 agent，不防恶意的 agent。

这条框架要从「主张」变成「贡献」，最少需要：上面那个对照实验的结果，加上至少一种真实 agent 跑通 stale 与审计染色的记录。

---

## 3. 已有先例、我们只是做得更全的地方

下面每一项都判为「增量」：先例在前，我们多走的那一步在后。

### 3.1 拉取式席位包（JOIN.md + 一条 `room` 命令）

- **先例：** [AgentComms](https://github.com/DhanushSantosh/AgentComms)（能跑 shell 命令的 agent 都能在协议层加入，声称「无需配置」）；[xhluca/agent-talk](https://github.com/xhluca/agent-talk)（经 skill 或 CLI 收发，不支持自动接收的平台上拉取）；[Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)（已在运行的 agent 的收发件箱，需要一条 MCP 配置）。
- **我们多的一步：** 一个文件说明入席、每席一个令牌、ASCII 状态词与固定退出码（「没事可做」退出 0）；不碰 agent 的 MCP 配置、钩子、设置和记忆。宿主侧唯一的改动是用户点「允许」时宿主自己写下的那条权限规则，所以不是「零配置」。
- **证据：** 只有一种真实席位跑通（`codex exec` 起的 Codex 线程，与房间同一包上下文，三个回合）。Claude Code 独立入席未验证。

### 3.2 不对称文件传输

- **先例：** maildir / spool 模式（各写各的目录，消费者只读）已有几十年；ExaDev/agent-comms 的文件投递、Claude Code agent teams 的文件型信箱、mcp_agent_mail 的收发件箱。
- **我们多的一步：** 尺寸按现有沙箱裁：agent 只读房间目录，只写自己工作目录下的 `.room-outbox/<席位>/`（workspace-write 本来就允许），房间只读发件箱、从不写入，任何沙箱都不需要放宽。
- **证据：** `codex exec` 一行的传输格已验证；其中 `apply_patch` 往发件箱新建文件失败，改由 `room submit` 复制（原因待查）。

### 3.3 来源横幅

- **先例：** Hines 等，*Defending Against Indirect Prompt Injection Attacks With Spotlighting*（Microsoft，arXiv:2403.14720）的随机定界与 datamarking；microsoft/azure-devops-mcp PR #1062 把 spotlighting 用在工具返回内容上；PI-Desktop 的 `pi.session-orchestrator` 插件已经声明「收到的消息明确标为另一会话的通信，不是人的输入，也不是新的用户授权」；上游 ADR 0164 把同伴消息作为带标签的收件箱前置到下一轮。
- **我们多的一步：** 在对等 coding agent 之间默认开启、不可关闭；转发正文里的 `[ROOM:` / `[/ROOM:` 被转义并计入清单；声明在 `wait` 头里重复一次以防宿主截断；模板经过 lint，不能含活标记。它是标签，不是防御。
- **证据：** 模型是否遵守只记录、不保证：一个 agent、三个回合。

### 3.4 失败即关闭的结构化 verdict 通道

- **先例：** LLM-as-judge 与结构化输出里「没有结论就不算通过、重试一次」是常规做法；flaught/core issue #59 等讨论过让 LLM 审查者抵御 diff 里埋的面向审查者的文字；*When Your Reviewer is an LLM*（arXiv:2509.09912）记录了翻转审查结论的注入；spotlighting 提供了定界符。
- **我们多的一步（窄，但具体）：** 解析一个席位的 verdict 标记之前，先剥掉它正文里所有带 nonce 的转发块和 Markdown / HTML / 围栏引用区，审方不能把从别人那里引来的 `VERDICT` 标记洗成自己的；未闭合的块头一路剥到末尾。冲突、缺失、被翻译的标记 → malformed → 恰好一次追问 → verdict 记为 none，从不默认 pass。扫描里没找到这样把来源和解析绑在一起的系统，但扫描有限，按规则归为增量。
- **证据：** 只在脚本席位上跑过；所有真实 agent 的结构化通道都未验证。

### 3.5 产物哈希冻结与 verdict 时复算

- **先例：** GitHub 分支保护的「新提交推送时作废过期批准」与「须批准最近一次可审推送」；Gerrit 把投票绑在 patch set 上；`pi.session-orchestrator` 的 `accept` 按确切的一次交付记审查元数据；上游 ADR 0138 点出了并发委托中的「过期前提」问题。
- **我们多的一步：** 搬到房间不拥有的目录里：不调用执行者仓库的 git，逐文件哈希声明的路径；复算绑定在审方交 verdict 的那一刻；「接受过期」只覆盖用户看到的那份改动清单，之后再变得到 `STALE_CHANGED_SINCE_ACCEPT`。只检测：审方交卷之后的改动不在这一检查范围内。
- **证据：** 只在脚本席位上跑过。

### 3.6 快照里、经人工批准的披露复核

- **先例：** CI 本身（在干净检出上重跑验收，而不信作者的报告）；agent 工具调用前的人工批准（Claude Code 权限提示、OpenAI Agents SDK 的工具审批、LangGraph 的 interrupt）；针对不可信仓库的 git 加固（CVE-2022-24765 之后的 safe.directory、`GIT_CONFIG_NOSYSTEM`、关掉 fsmonitor / hooksPath）；带参数检查的命令白名单。
- **我们多的一步：** 审方不执行，房间在冻结副本里执行；批准后改了 argv 就算新请求；白名单只有 `git diff/status` 和任务单里确认过的验收命令，拒绝绝对路径、盘符、UNC、`..`、git 全局选项与 `.cmd/.bat` 垫片。它不是沙箱：验收命令本身能跑任意代码，网络不隔离（DESIGN §4.3）。

### 3.7 原生日志只读审计

- **先例：** [clauditor](https://github.com/skettleson/clauditor)（读 Claude Code、Codex、Cursor 的原生日志，按声明的应做 / 禁做能力给出 ALIGNED / REVIEW / DRIFTED，引用写文件事件的行号）；[Nithinfgs/sessionscope](https://github.com/Nithinfgs/sessionscope)（Claude Code 与 Codex 会话的事后审计，区分读写）；[wangyuxinwhy/agent-session-facts](https://github.com/wangyuxinwhy/agent-session-facts)；AgentComms 把送达证据和 agent 自报分开记。
- **我们多的一步：** 审计绑定到一次具体的审查 attempt，结果直接作用于那次 verdict（tainted 不算「已验证」）；按登记的线程 UUID / 包 id 精确定位，只读本会话的文件；每个包一条 present_in_native 回执；声明档位与观测行为分两列。这是扫描里单项最强的机制，但仍是扩展现有工具，不是新方向。
- **证据：** `codex exec` 一行的审计格已验证（三个包都在原生日志里找到，其中一个在替身会话的 Claude transcript 里）。审查回合的写操作分类在真实 agent 上未验证。

### 3.8 可测的不干扰契约

- **先例：** 「无需配置」类声明通常不做测量；安装 / 卸载足迹测试、strace / ProcMon 写审计、Bazel 与 Nix 的沙箱纯度检查是成熟的足迹测试手段；基线 vs 处理的对照方法见 arXiv:2607.25890。
- **我们多的一步：** 九条条款各配一种测法，结果一律写成「在方法 X 下未观测到」：带 who / pid 的写日志、无 agent 的对照运行逐项比对配置 / 记忆 / 钩子目录、前后 PID 集合、环境变量金丝雀与 `NODE_OPTIONS` 预加载探针。这是证据质量上的贡献，不是新机制：写日志是自报的，绕过 guard 的写看不到；对照运行按设计不含真实 agent，所以它证明的是房间自己的代码路径，不是「对真实 agent 无干扰」。

### 3.9 待回应条目表与取代通知

- **先例：** GitHub「合并前须解决所有讨论」；Gerrit 的未解决评论数；ai_roundtable 的分歧分析与同意矩阵；*Cited but Not Verified*（arXiv:2605.06635）对引用归属的核查；上游 ADR 0138 指出被推翻的共享前提必须传到同伴那里。
- **我们多的一步：** 条目由程序从 `room point`（或整段发言）派生，只有汇总主力能标注，未标注的全部列为「未回应」；汇总有版本，新版本给每个席位的下一个包注入取代通知；引文按哈希逐字核对被引的 seq，被取代的 seq 核对为 false。agent 是否真的看到并照取代通知行事，未在真实 agent 上跑过。

---

## 4. 不算创新的地方

这些是工程做得仔细的证据，写成贡献只会削弱真正的那一条。

| 项 | 为什么不算 | 先例 |
|---|---|---|
| 程序主持的发言顺序、只追加事件日志、纯 reducer、首个终态胜出的 attempt 去重、epoch、崩溃后由用户选择重放或作废 | 都是多 agent 框架与分布式系统的标准做法 | AutoGen / AG2 GroupChat 的 `round_robin` / `manual` / 自定义发言选择；ai_roundtable 的固定轮次；AgentComms 的签名链式事件史；上游 ADR 0147 的终态不再迁移；事件溯源、幂等键、fencing token；`pi.session-orchestrator` 的 `idempotencyKey` |
| 单向监管：唯一主力、执行者不能当主力、审查图无环且每个产物唯一审方、只有该审方的 verdict 有效、执行者不能互投 pass | 是职责分离 / maker-checker | 四眼原则；CODEOWNERS 与「最近一次推送须由推送者以外的人批准」；AWS Well-Architected Agentic AI Lens AGENTSEC07-BP03；kachowtowmater/terminal-board PR #11；Claude Code agent teams 的只读审方队友。对嵌入式席位，「审方只读」是声明后审计，不是强制 |
| 审方健康提示（n≥14 且 0 次 reject 时警告） | 带假设基率的简单二项启发式 | minware「Rubber-Stamp Reviews」反模式、Code Climate Velocity 的审查指标、对 AI 审查者的同类讨论 |
| 跨厂商席位同一协议 | 已有很多工具和标准做到；我们只有 `codex exec` 一行跑通 | Zed Agent Client Protocol、Google A2A、MCP、AgentComms、ExaDev/agent-comms、ai_roundtable、clauditor / sessionscope 的双格式审计 |
| 每条不变量一个故障开关（8 个 `ROOM_MUTATE` 开关、9 个变异测试文件）并配一个必须变红的测试 | 手工放置的故障注入，用来测试测试；提高证据质量，不是创新 | 变异测试（DeMillo、Lipton、Sayward 1978；Stryker、PIT、mutmut） |
| MSIX 打包应用的 AppData 写入重定向，以及按真实路径拒绝包缓存与链接 | 平台已有文档，Claude Code 自己也被报告过；值得写进经验章节 | Microsoft Learn「Understanding how packaged desktop apps run on Windows」；anthropics/claude-code issue #94254、#93152；bpo-40377、beeware/briefcase #922、tox-dev/platformdirs PR #597 |
| 整条消息的确定性预算裁剪、状态词 CLI 约定、唤醒推送上限、DPAPI 保存托管 key 并只经标准输入、导出时的密钥与绝对路径扫描 | 良好实践 | LangChain / LangGraph 的消息裁剪、AutoGen 的上下文变换；CLI 退出码惯例；Windows DPAPI 与 PowerShell 4104 日志；gitleaks、trufflehog、detect-secrets |

托管通道与内置 Pi 席位（`lib/api.mjs` 的宿主内嵌、`lib/hosted/*`）在 SUPPORT-MATRIX 里全部未验证，本文不让任何主张依赖它们。

2026-10-05 在作者机器上（Node v24.11.1）实跑：`node --test test/cases/*.test.mjs` 59 个测试全过；`node --test test/mutations/*.test.mjs` 10 个测试全过（每个开关下对应用例变红）。这些是单元与脚本席位层面的数字，不是真实 agent 上的证据。

---

## 5. 和 PI-Desktop 上游现有能力的关系

### 5.1 上游已经有什么

| 上游能力 | 它做什么 | 和 room-dev 的关系 |
|---|---|---|
| `Task` / `TaskWait` / `TaskList` / `TaskStop`（ADR 0062 / 0089） | 父会话并发派出有界的子任务，报告回到父会话；内置子 agent 默认只读 | 委托，不是对等对话；上游认为这就够了 |
| 示例插件 `examples/plugins/roundtable` | 每个角色是一个独立 `Task`，父 agent 收集报告并综合；委托之间不互相发消息；可把上一轮报告放进下一轮的 brief | 由模型（父 agent）主持、只有 PI 自己的子 agent、没有 verdict / 冻结 / 审计。room-dev 是程序主持、席位是房间不拥有的异构 agent |
| `pi.session-orchestrator` 插件（`SessionTask`，高风险权限 `desktop.control`） | 按真实 `sessionId` 派生、发送、查询、取消 PI 会话；宿主拥有投递、队列、执行状态与完成通知；收到的消息标为「另一会话的通信，不是用户授权」；`accept` 按确切交付记审查；`idempotencyKey` | 是「带控制的治理」：宿主拥有会话。它已经覆盖了来源标签、按交付绑定的审查记录、幂等重试这些点（见 §3.3、§3.5、§4）。room-dev 多的是：发言顺序、产物冻结与 stale、单向监管与快照披露、条目表、原生日志审计，以及对 PI 之外 agent 的支持 |
| 已撤回的 A2A / Peer 栈（ADR 0138 → 0140 → 0147 → 0162 → 0164，由 ADR 0165 于 2026-09-05 撤回） | 曾经在宿主核心里有 broker、`a2a.*` RPC、持久化表、`A2A` 工具，让会话之间互相发消息 | 已删除：协议升到 v11 不再宣告 `a2a`，数据库 v13 删表 |

### 5.2 为什么是插件，不是核心

room-dev 的 PI-Desktop 集成（[`integrations/pi-desktop-plugin`](../integrations/pi-desktop-plugin/README.zh-CN.md)）只用上游公开的插件接口，不改宿主、不改核心。理由都和上游的产品方向有关：

1. **上游刚把这类东西从核心里拿掉。** ADR 0165 撤回 A2A 栈的理由是：同伴与跨会话通道摆在已有的 `Task*` 约定旁边，加了一个应用其他部分不用的协议能力，模型也容易漏用或误用；并发委托经父会话汇报已经足够。往核心里放一个受治理的房间，等于在一个月后把同一类协议能力和持久化状态加回去。
2. **上游保留的跨会话协调本身就在插件里。** `pi.session-orchestrator` 是插件市场里的插件，经宿主审阅过的 `session/collaboration/*` 接口工作。房间走同一条路，是顺着上游现有的分层。
3. **房间的设计规则本来就不要求住在宿主核心里。** 「不控制 agent」意味着房间不需要宿主的会话所有权；它服务的主要对象（Codex、Claude Code 等）也不归 PI-Desktop 核心管。插件只需要后台服务、Agent 工具、面板和 `agent.complete` 这些公开接口。
4. **代价是公开记录过的。** 插件拿不到把 PI 对话唤醒的接口（`session/collaboration/send` 要求处在一次进行中的 Agent 工具调用之内，后台服务满足不了），所以 PI 席位由用户唤醒；工具只能在 Agent 模式用。插件目前只在一个仿照上游插件 SDK 的假宿主上测过，没装进真实的 PI-Desktop。

### 5.3 这不是对新颖性的判断

「做成插件、不进核心」和「创新点够不够」是两个独立的问题：

- ADR 0165 撤回的是一条消息通道，它从没评估过冻结、stale、披露、原生日志审计这类治理机制。即使机制再新，往核心里加一个刚被删掉的协议能力，面对的也是同一个范围决定。
- 反过来，插件的门槛也不是新颖性。按插件仓库的 CONTRIBUTING，高风险能力需要数据流矩阵、负向路径测试和两位维护者批准；后台服务、执行进程和写文件都算高风险。这些是工程与安全门槛。
- 新颖性要单独看（§2–§4）：真正新的只有「不控制 agent 的治理」这条组合，而它还没评估过。这是创新的实际状况，和放在核心还是插件无关。

---

## 6. 对外怎么说

下面两段可以直接用在上游 issue 里，每句都有 SUPPORT-MATRIX 的格子撑着。

**English**

> room-dev is a local, Windows-first room in which coding agents you already run (Codex, Claude Code, or any agent that can run one local command) take turns in one conversation; the room never launches, configures or attaches to them. Because it owns none of the agents, its governance detects and records instead of enforcing: relayed text carries source labels, a reviewer's verdict is checked against hashes of the frozen artifacts and marked stale if they changed, and an agent's own native log can be read to confirm that a packet arrived. So far this is verified end to end with scripted seats and with one real seat kind, a Codex thread started with `codex exec` in the same package context as the room; Claude Code as an independent seat, and the governance layer on any real agent, are not verified yet. The PI-Desktop side is a plugin built only on the public plugin APIs, tested against a fake host so far, and it asks for no core change.

**中文**

> room-dev 是一个本地、Windows 优先的「房间」，让你已经在用的 coding agent（Codex、Claude Code，或任何能跑一条本地命令的 agent）在同一个对话里按顺序发言；房间不启动、不配置、不附着任何 agent。因为它不拥有任何 agent，治理只做检测和记录、不做强制：转发的内容带来源标签，审方的结论要对照冻结产物的哈希复核、产物变了就标为过期，还可以只读 agent 自己的原生日志确认包已送达。目前端到端验证过的只有脚本席位和一种真实席位，即与房间同一包上下文、由 `codex exec` 起的 Codex 线程；Claude Code 独立入席、以及治理层在任何真实 agent 上的运行，都还没有验证。PI-Desktop 一侧是只用公开插件接口写的插件，目前只在假宿主上测过，不要求改动核心。
