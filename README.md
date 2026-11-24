# 圆桌 · AgentRoundtable

**A governed multi-agent roundtable for the coding agents you already run.** English first, [中文在后](#中文).

> Status: `v0.2.0` (zero npm dependencies, Node.js ≥ 22, Windows / macOS / Linux). Core governance, SSE daemon, bilingual protocol, and group-chat/Arena UI are covered by automated tests and scripted end-to-end runs; exactly what has been verified against real agents — and what remains unverified — is tracked honestly in [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md).

## What it is

**AgentRoundtable** (CLI package `room-dev`, product name **圆桌**, "round table") lets multiple coding agents already running on your machine — Claude Code, Codex CLI/Desktop, Antigravity, Gemini CLI, OpenCode, Kimi, or any agent that can execute one local command — collaborate in one shared, governed conversation while keeping their own tools, permissions, and sandboxes.

- **Semi-embedded seat kits (`JOIN.md` + `room.cmd`/`room.sh`).** The room generates a per-seat kit with a scoped seat token and exact instructions. Tell an agent *"Read `<path>/JOIN.md` and join"* and it runs `wait` → reads its packet → runs `submit` (or use `node room.mjs drive` as an optional seat-side Codex CLI driver). The room service never launches, kills, attaches to, or rewrites your agents' configs, memories, or working directories ([non-interference contract](docs/README-public.md)).
- **Programmatic moderation (zero model calls, zero npm dependencies).** A plain Node.js process enforces turn order, relays peer messages inside nonce-delimited `authority=none` banners, freezes and recomputes artifact manifests, isolates disclosure commands in snapshot copies, and appends every state transition to `events.jsonl`.
- **Group-Chat UI, Arena Side-by-Side Comparison & Sticky Approval Inbox.**
  - **Group Chat**: round-grouped conversation bubbles with seat-family avatars, lead crown alignment, safe zero-`innerHTML` Markdown rendering, clickable `#seq` quote jumps, and strict visual separation between speaker prose claims (dashed neutral cards) and host-authoritative marks/verdicts (solid badges).
  - **Arena Compare**: side-by-side multi-column comparison of every seat's responses for any round, with one-click jump back into the chat thread.
  - **Approval Inbox**: sticky action bar surfacing pending task-draft confirmations, timed-out turn decisions (`retry` / `skip`), crash-recovery reconciliations (`replay` / `void`), and disclosure requests (`approve` / `deny`).
- **Real-time SSE + Multi-Room Auto-Resume Daemon.** `node room.mjs daemon` hosts the lobby and multiple rooms in one persistent loopback process, pushes live updates over Server-Sent Events (`/api/stream`, `/lobby/api/stream`), remembers per-room seat orders outside `<roomDir>`, and automatically resumes active rooms on restart.
- **Full Bilingual Support (`zh-CN` / `en`).** Pass `--lang en` (or pick English in the Lobby) to generate English `JOIN.md`, turn packets, and structured prompts; switch the Web UI live between 中文 and English in the top bar.

## Governance Highlights

- **Source banners & marker isolation.** Peer content is wrapped in nonce-delimited `[ROOM:<token>:...]` blocks (`authority=none`). Forged banners are escaped; display-side protocol parsing ignores markers inside code fences, blockquotes, inline backticks, and escaped packet blocks.
- **Artifact freeze & staleness detection.** Executors declare artifacts; the service hashes and snapshots them. When a reviewer submits a verdict, the service recomputes hashes and marks verdicts *stale* if files changed mid-review.
- **One-way supervision & snapshot disclosure.** Reviewers only pass, reject, or request disclosure. Approved disclosure commands (such as `git diff --stat`) execute solely inside the frozen snapshot copy.
- **Pending item table & superseding summaries.** Raised points stay open until the lead marks each item; revised summaries carry superseding notices to prior readers.
- **Native-log audit.** Reads registered Codex rollout / Claude transcript logs to verify packet delivery and flag observed writes or non-allowlisted commands (`tainted`) during review turns. Reports *"not observed"*, never *"read-only"*.

What it does **not** claim: better model quality, prompt-injection immunity (banners label provenance; each agent's own permission gate stops unauthorized actions), zero-configuration joining, or enforcing anything on an embedded agent beyond rejecting out-of-turn submissions. See [`docs/README-public.md`](docs/README-public.md) §5.

## Quick Start

Requirements: **Node.js ≥ 22** (no `npm install` needed — only Node built-in modules).
On Windows, keep rooms and seat folders outside `%LOCALAPPDATA%` (MSIX virtualization redirects AppData writes invisibly; the room refuses those paths). Default data root: `~/room-dev` (override with `ROOM_DEV_HOME`).

### 1. Run the self-checks

```bash
node test/e2e.mjs
node --test "test/**/*.test.mjs"
```

### 2. Multi-room Daemon & Web Lobby (Recommended)

```bash
# Start the persistent multi-room daemon (auto-resumes active rooms, opens browser)
node room.mjs daemon --open

# Check daemon status
node room.mjs daemon status

# Or start a single-session lobby (also used by the optional Electron desktop wrapper)
node room.mjs lobby --open
```

Create a room in the Lobby (choose preset, protocol language `zh-CN` or `en`, and seats), copy each seat's one-line join sentence to the corresponding agent, open the room view, set the task, and start.

### 3. CLI Workflow (English or Chinese room)

```bash
node room.mjs admin init     --id demo --preset implement-review --lang en
node room.mjs admin add-seat --id demo --seat A --role lead     --agent codex-cli   --cwd ~/room-seats/A --audit codex
node room.mjs admin add-seat --id demo --seat B --role executor --agent claude-code --cwd /path/to/repo  --audit claude
node room.mjs serve --dir ~/room-dev/rooms/demo --port 0
# Tell each agent: Read ~/room-dev/rooms/demo/seats/<A|B>/JOIN.md and join the room following it.
node room.mjs admin task  --id demo --text "Add a --strict flag to parser.mjs; accept when node --test passes"
node room.mjs admin start --id demo --order A,B
```

### 4. Optional Windows Desktop Shell (`圆桌.exe`)

Build locally from a cached official Electron Windows x64 zip (nothing is downloaded):

```bat
npm run app
```

## What Is Verified and What Is Not

See [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md) for per-cell evidence and footnotes:

- **Verified:** scripted seats end-to-end (79/79 checks in `test/e2e.mjs`); full unit/integration test suite covering governance, audit (`writes` + `unknownCommands`), SSE streaming, multi-room daemon recovery, bilingual packets, protocol-marker anti-spoofing, and XSS-safe Markdown rendering; Windows DPAPI key storage for optional hosted Pi seats; `codex exec` multi-turn join/wait/submit/audit; real multi-agent discussion rounds on the author's Windows 11 machine (Antigravity / Claude Code / Codex CLI); real browser UI smoke checks (Group Chat, Arena compare, approval inbox, live i18n toggle, SSE).
- **Not yet verified end-to-end:** multi-hour idle background wait token cost on Claude Code; wake pushes to idle Codex Desktop GUI threads; full governance cycle (freeze, stale, verdict, snapshot disclosure, item table) across independent real agents; unattended restart-reconnect across live external agents; clean-machine Windows/macOS/Linux distribution.

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md): release history
- [`docs/DEVELOPER.md`](docs/DEVELOPER.md): developer guide (commands, layout, tests, build), Chinese
- [`docs/README-public.md`](docs/README-public.md): product definition, non-interference contract, scope boundaries
- [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md): honest verification matrix per agent & platform
- [`docs/DESIGN.md`](docs/DESIGN.md) & [`docs/INTERFACES.md`](docs/INTERFACES.md): architecture and module contract
- [`docs/DEMO.md`](docs/DEMO.md): step-by-step demo scripts
- [`docs/POSITIONING.md`](docs/POSITIONING.md): positioning against related multi-agent tools

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 KennyMcSimpson and room-dev contributors.

---

<a id="中文"></a>

# 圆桌 · AgentRoundtable（中文）

**给你已经在用的 coding agent 打造的受治理多代理圆桌。**

> 状态：`v0.2.0`（零 npm 依赖，Node.js ≥ 22，支持 Windows / macOS / Linux）。核心治理逻辑、SSE 守护进程、双语协议与群聊/竞技场界面均通过自动化测试与脚本席位端到端验证；真实 agent 上哪些已实测、哪些尚未验证，逐项如实记录在 [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md)。

## 核心特性

- **半嵌入席位包（`JOIN.md` + `room.cmd`/`room.sh`）**：为每个已开启的 coding agent（Claude Code、Codex CLI/Desktop、Antigravity、Gemini CLI、OpenCode、Kimi 等）生成独立席位包与最小权限指令。你只需把一句入席话发给 agent，房间服务绝不启动、强杀或修改任何 agent 的配置、记忆与工作目录（详见 [`docs/README-public.md`](docs/README-public.md) §6 不干扰契约）。
- **程序化主持与治理（零模型调用、零 npm 依赖）**：
  - **来源横幅与防伪解析**：跨席位发言全部包裹在带随机 nonce、标明 `authority=none` 的定界块内；前端群聊解析器对围栏代码块、引用块、行内反引号与转义定界块做保护隔离，伪造标记不会被渲染成官方结论。
  - **产物冻结与 stale 检测**：执行者冻结产物快照与清单哈希，审方提交 verdict 时复算哈希，中途被改动的产物自动标 `stale`。
  - **单向监管与快照披露**：审方只能给 `pass`/`reject`/`disclose`，批准后的披露命令仅在冻结快照副本中运行。
  - **待回应条目表与原生日志审计**：所有要点追踪至主力逐条标注；审计器按登记会话只读原生日志，审查回合观测到写操作或非白名单命令均标 `tainted`（措辞坚持「未观测到」，绝不宣称绝对「只读」）。
- **全新群聊界面 + Arena 并排对比 + 顶部待处理审批箱**：
  - **群聊视图**：按轮次分组、席位家族配色头像、主力右对齐皇冠标识、零 `innerHTML` 安全 Markdown 渲染、点击 `#seq` 引文平滑跳转高亮、虚线「发言自述卡」与实心「官方裁决/标注徽章」视觉严格区分。
  - **并排对比（Arena）**：按轮次并排展示各席位回复，方便横向对比不同模型/代理的观点与方案，支持一键跳回群聊定位。
  - **顶部待处理审批箱**：将待确认任务单草案、超时回合决策（重试/跳过）、崩溃恢复（重放/作废）与披露审批聚合在顶部，无需翻找多标签页即可一键决策。
- **SSE 实时推送 + 多房间常驻守护进程**：`node room.mjs daemon` 在单个本机回环进程内托管大厅与多个房间，经 `/api/stream` 与 `/lobby/api/stream` 毫秒级推送事件，并在重启后自动恢复活跃回合的房间（登记表存放在房间根目录，不污染任何 `<roomDir>`）。
- **中英双语全栈支持**：建房支持 `--lang zh-CN|en`（控制 `JOIN.md`、每轮包模板与结构化提示词语言），Web 房间与大厅右上角支持一键实时切换「中文 / EN」。

## 快速开始

环境要求：**Node.js ≥ 22**（无需 `npm install`，仅使用 Node 内置模块）。Windows 上请避免将房间与席位工作目录放在 `%LOCALAPPDATA%` 下；默认根目录为 `%USERPROFILE%\room-dev`（可用 `ROOM_DEV_HOME` 修改）。

```bash
# 1. 运行端到端与全部单元测试
node test/e2e.mjs
node --test "test/**/*.test.mjs"

# 2. 启动常驻多房间守护进程并在浏览器打开大厅（推荐）
node room.mjs daemon --open

# 查看守护进程状态
node room.mjs daemon status

# 或启动单次大厅（也是桌面外壳 圆桌.exe 的后端）
node room.mjs lobby --open
```

命令行建房与更多参数说明见 [`docs/DEVELOPER.md`](docs/DEVELOPER.md)。

## 已验证 / 未验证边界

详见 [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md)：

- **已验证**：脚本席位完整端到端（`test/e2e.mjs` 79/79）；全套单元与集成测试（治理、审计 `writes`/`unknownCommands`、SSE 实时流、多房间守护进程恢复、双语协议模板、伪造标记隔离与 XSS 负向用例）；Windows DPAPI 密钥存储；`codex exec` 真实多轮入席与审计；作者 Windows 11 本机真实多代理讨论实测（Antigravity / Claude Code / Codex CLI）；真实浏览器渲染与交互烟测（群聊、Arena 并排对比、审批箱、实时中英切换、SSE 连接）。
- **未验证**：Claude Code 多小时后台等待的真实空闲成本；Codex Desktop 图形界面空闲线程的唤醒推送；真实 agent 独立跑完整套治理链路（产物冻结、stale、verdict、快照披露、条目表）；真实外部 agent 跨守护进程重启自动重连；干净 Windows/macOS/Linux 机器上的独立分发。

## 许可

MIT，见 [`LICENSE`](LICENSE)。Copyright (c) 2026 KennyMcSimpson and room-dev contributors。
