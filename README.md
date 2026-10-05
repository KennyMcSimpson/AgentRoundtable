# 圆桌 · room-dev

**A governed room for the coding agents you already run.** English first, [中文在后](#中文).

> Status: development release (0.1.0-dev), Windows 11 first. Most of what is described here is tested
> only with scripted seats and unit tests; exactly what has run against real agents is listed in
> [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md). Read that before relying on anything below.

## What it is

room-dev (product name 圆桌, "round table") lets several coding agents that are already open on your
machine (Codex, Claude Code, or any agent that can run one local command) take turns in one shared,
governed conversation, each still working with its own tools, permissions and sandbox.

- **A semi-embedded seat kit.** For each agent the room writes a seat kit: a `JOIN.md` and a `room`
  command. You tell the agent "read `<path>\JOIN.md` and join". From then on the agent itself runs
  `room wait`, reads its packet, and `room submit`s its turn. The room never launches, kills,
  attaches to or reconfigures your agents, and never writes to their config, session storage, memory
  or working folders (the non-interference contract, [`docs/README-public.md`](docs/README-public.md) §6).
- **A room service that moderates by program, not by model.** A plain Node process (no model calls,
  no npm dependencies) orders turns, hands out per-turn packets, relays what others said, always
  with a source label, and records everything in an append-only event log.
- **A desktop app.** `圆桌.exe` (Electron shell) gives you a lobby to create rooms and seats, copy the
  join sentence for each agent, open the room view, and give the task. A CLI does the same.

## Why

Putting two agents on one task is easy; trusting the result is not. What room-dev adds is a
governance layer around the conversation, not a smarter agent (see
[`docs/POSITIONING.md`](docs/POSITIONING.md) for how this compares with other multi-agent tools):

- **Source banners.** Everything relayed from another seat is wrapped in a labelled, nonce-delimited
  block with `authority=none`; forged banners are escaped.
- **Artifact freeze and staleness.** An executor declares its artifacts; the room hashes them into a
  manifest and copies a snapshot. When the reviewer gives its verdict the room recomputes the hashes:
  an artifact changed mid-review marks the verdict *stale*.
- **One-way supervision.** A reviewer can only pass, reject, or ask for disclosure; disclosure
  commands (for example `git diff`) run only in the snapshot copy, after you approve them.
- **Pending items and superseding notices.** Points raised in a meeting are tracked until the lead
  marks each one; a revised summary carries a notice that supersedes the old one.
- **Read-only audit.** The room can read a seat's own native log (Codex rollout, Claude transcript)
  to confirm that a packet arrived and to flag writes seen during a review turn. It reports "not
  observed", never "read-only".

What it does not claim: better model quality, protection against prompt injection (banners are
labels; your agent's own permission gate is what stops actions), zero-configuration joining, or
enforcing anything on an embedded agent beyond "a submission out of turn is not accepted". The full
list is in [`docs/README-public.md`](docs/README-public.md) §5.

## Quick start

Requirements: Windows 11. Node.js ≥ 22 for the CLI and for building the app (no `npm install`: only
Node built-in modules are used). Keep rooms and seat folders out of `%LOCALAPPDATA%`: a process
started from an MSIX-packaged app has its AppData writes redirected where other agents cannot see
them, so the room refuses such locations. The default root is `%USERPROFILE%\room-dev`
(`ROOM_DEV_HOME` changes it).

Self-check, from the repository folder `<repo>`:

```bat
node test\e2e.mjs
node --test "test\**\*.test.mjs"
```

**Desktop app.** Build it from files already on the machine; nothing is downloaded:

```bat
npm run app
:: = node dist\build-app.mjs [--electron-zip <zip>] [--rcedit <rcedit-x64.exe>] [--out <dir>] [--zip] [--dry-run]
```

It needs an official Electron Windows x64 zip (`--electron-zip`, `ROOM_ELECTRON_ZIP`, or the npm
cache under `%LOCALAPPDATA%\electron\Cache\`) and optionally rcedit for the icon. Then double-click
`dist\out\圆桌\圆桌.exe`.

**Lobby.** The app's main window is the lobby (developers can run it in a browser with
`node room.mjs lobby --open`). Create a room from a preset (default: seat A = Codex as lead and
reviewer, seat B = Claude Code as executor), give each seat a working folder, copy each seat's join
sentence into that agent, open the room view, write the task and start.

**CLI.** The same flow without the lobby, in `cmd.exe`:

```bat
node <repo>\room.mjs admin init     --id demo --preset implement-review
node <repo>\room.mjs admin add-seat --id demo --seat A --role lead     --agent codex-desktop --cwd %USERPROFILE%\room-seats\A --audit codex
node <repo>\room.mjs admin add-seat --id demo --seat B --role executor --agent claude-code   --cwd <your project> --audit claude
node <repo>\room.mjs serve --dir %USERPROFILE%\room-dev\rooms\demo --port 0
:: tell each agent: read %USERPROFILE%\room-dev\rooms\demo\seats\<A|B>\JOIN.md and join
node <repo>\room.mjs admin task  --id demo --text "Add a --strict flag to parser.mjs; accept when node --test parser.test.mjs passes"
node <repo>\room.mjs admin start --id demo --order A,B
```

Every command, preset and option is documented (in Chinese) in [`docs/DEVELOPER.md`](docs/DEVELOPER.md).

## What is verified and what is not

As of 2026-10-04, from [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md), which has one footnote of
evidence per cell. Unit tests passing does not count as verified there.

- **Verified on the author's Windows 11 machine:** scripted seats end to end (turn order, file
  transport, waiting, completion, voiding); one real seat kind, a Codex thread started with
  `codex exec` in the same package context as the room, which completed wait → read packet → submit →
  turn over for three turns, with the auditor finding the packets in its rollout; saving the built-in
  Pi key with Windows DPAPI; the desktop app's self-test mode (start, lobby, test room, room window,
  clean exit, single instance).
- **Not verified:** Codex Desktop interactive threads, Codex CLI, Claude Code as an independent
  session, OpenCode, Gemini CLI, Kimi, DSH, a user's own Pi; built-in Pi seat turns; wake pushes to
  an idle Codex Desktop thread; the governance layer (freeze, stale, verdicts, disclosure, item table)
  on real agents, so far run only in unit tests and scripted-seat end-to-end tests; the audit of
  writes during review turns on real agents; joining from
  agents opened from the Start menu with rooms in the default location; the app's dialogs and context
  menu clicked by hand; seats using the app's bundled runtime on a machine without Node; distribution
  to a clean machine.

## Documentation

- [`docs/DEVELOPER.md`](docs/DEVELOPER.md): developer guide (build, commands, layout, tests), Chinese
- [`docs/README-public.md`](docs/README-public.md): product definition, non-interference contract and how each clause is measured, first public promise
- [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md): what has been verified, per agent
- [`docs/DESIGN.md`](docs/DESIGN.md) (English abstract, then Chinese) and [`docs/INTERFACES.md`](docs/INTERFACES.md): design and module contract
- [`docs/DEMO.md`](docs/DEMO.md): two step-by-step demo scripts
- [`docs/POSITIONING.md`](docs/POSITIONING.md): positioning against related work
- [`integrations/pi-desktop-plugin/README.md`](integrations/pi-desktop-plugin/README.md): a PI-Desktop plugin that runs the room inside upstream PI-Desktop through its public plugin APIs (development build, tested against a fake host only)

## Third-party software

This source tree contains no third-party code: room-dev uses only Node.js built-in modules. The one
thing that bundles third-party software is the desktop app built by `dist/build-app.mjs`. It ships
the official Electron Windows x64 runtime you provide (Electron, MIT; Chromium and its dependencies,
various licences; the Node.js runtime inside Electron, MIT and its dependencies' licences) unchanged
apart from renaming `electron.exe` and setting its icon. Their licence files (`LICENSE`,
`LICENSES.chromium.html`) stay in the built folder next to `圆桌.exe`, and the build writes a
`THIRD-PARTY.md` there listing them. The optional built-in Pi seat uses `@earendil-works/pi-coding-agent`
only if you install it yourself; it is not bundled.

## License

MIT, see [`LICENSE`](LICENSE). Copyright (c) 2026 KennyMcSimpson and room-dev contributors.

---

<a id="中文"></a>

# 圆桌 · room-dev（中文）

**给你已经在用的 coding agent 的受治理圆桌。**

> 状态：开发版（0.1.0-dev），Windows 11 首发。这里写的大部分能力只在脚本席位和单元测试上跑过；哪些真的在真实 agent 上跑过，逐格列在 [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md)。依赖下面任何一条之前先看那张表。

## 它是什么

room-dev（产品名「圆桌」）让你机器上已经开着的几个 coding agent（Codex、Claude Code，或任何能跑一条本地命令的 agent）在同一个受治理的对话里按顺序发言，各自仍用自己的工具、权限和沙箱干活。

- **半嵌入的席位包。** 房间给每个 agent 生成一份席位包：`JOIN.md` 加一条 `room` 命令。你对 agent 说「读 `<路径>\JOIN.md`，按它入席」，之后由 agent 自己运行 `room wait`、读包、`room submit` 交卷。房间不起、不杀、不附着、不改配置任何 agent，也不写它们的配置、会话存储、记忆和工作目录（不干扰契约，[`docs/README-public.md`](docs/README-public.md) §6）。
- **由程序主持的房间服务。** 一个普通的 Node 进程（不调用任何模型、没有 npm 依赖）排顺序、发每回合的包、转发别的席位说的话（永远带来源标签），并把一切记进只追加的事件日志。
- **桌面应用。** `圆桌.exe`（Electron 外壳）里有圆桌启动器：建房建席、复制每个 agent 的入席句子、打开房间界面、给任务并开始。命令行能做同样的事。

## 为什么

把两个 agent 放到一个任务上不难，难的是信得过结果。room-dev 加的是对话外面的一层治理，而不是更聪明的 agent（和其他多 agent 工具的比较见 [`docs/POSITIONING.md`](docs/POSITIONING.md)）：

- **来源横幅**：别的席位转来的内容一律包在带标签、带 nonce 定界、`authority=none` 的块里，伪造的横幅会被转义。
- **产物冻结与过期**：执行者声明产物，房间算哈希成清单并复制快照；审方给结论时房间复算哈希，审到一半被改过的产物让结论标为 stale。
- **单向监管**：审方只能 pass、reject 或请求披露；披露命令（例如 `git diff`）只在快照副本里、经你批准后执行。
- **待回应条目表与取代通知**：会上提出的条目一直挂着，直到主力逐条标注；改过的汇总带一条取代旧版的通知。
- **只读审计**：房间可以只读席位自己的原生日志（Codex rollout、Claude transcript），确认包送到了、审查回合里有没有观测到写操作。措辞是「未观测到」，从不说「只读」。

不宣称：模型质量提升、防住提示注入（横幅是标签，拦住越权动作的是 agent 自己的权限门）、零配置入席、对嵌入式 agent 强制「不按顺序的提交不被接受」以外的任何事。完整列表见 [`docs/README-public.md`](docs/README-public.md) §5。

## 快速开始

需要 Windows 11；命令行和构建桌面应用需要 Node.js ≥ 22（不需要 `npm install`，只用 Node 内置模块）。房间和席位工作目录不要放在 `%LOCALAPPDATA%` 下：从 MSIX 打包应用里起的进程写 AppData 会被重定向，别的 agent 看不到，所以房间会拒绝这类位置。默认根目录 `%USERPROFILE%\room-dev`（`ROOM_DEV_HOME` 可改）。

自检（在仓库目录 `<repo>` 里）：

```bat
node test\e2e.mjs
node --test "test\**\*.test.mjs"
```

**桌面应用。** 只用本机已有的文件构建，不下载任何东西：

```bat
npm run app
```

需要一个 Electron 官方 Windows x64 zip（`--electron-zip`、`ROOM_ELECTRON_ZIP`，或 `%LOCALAPPDATA%\electron\Cache\` 下 npm 留下的缓存），图标可选用 rcedit 写入。之后双击 `dist\out\圆桌\圆桌.exe`。

**启动器。** 应用主窗口就是圆桌启动器（开发者也可以用 `node room.mjs lobby --open` 在浏览器里打开）。选预设建房（默认 A = Codex 主力兼审方，B = Claude Code 执行者），给每个席位一个工作文件夹，把每个席位的入席句子发给对应的 agent，打开房间界面，写任务并开始。

**命令行。** 不用启动器时，同样的流程见上文英文部分的命令块；全部命令、预设与参数见 [`docs/DEVELOPER.md`](docs/DEVELOPER.md)。

## 已验证 / 未验证

截至 2026-10-04，摘自 [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md)（每格一条证据脚注；单元测试通过不算已验证）。

- **在作者的 Windows 11 机器上已验证：** 脚本席位端到端（顺序、文件式传输、等待、完成、作废）；一种真实席位：由 `codex exec` 起、与房间同在一个包上下文的 Codex 线程，走完三个回合的 wait → 读包 → 交卷 → TURN_OVER，审计器在它的 rollout 里找到了包；内置 Pi key 的 DPAPI 保存；桌面应用的自检模式（启动、启动器、测试房间、房间窗口、正常退出、只开一份）。
- **未验证：** Codex Desktop 交互线程、Codex CLI、作为独立会话的 Claude Code、OpenCode、Gemini CLI、Kimi、DSH、用户自己的 Pi；内置 Pi 席位的回合；对空闲 Codex Desktop 线程的唤醒推送；真实 agent 上的治理层（冻结、stale、verdict、披露、条目表，目前只在单元测试与脚本席位端到端里跑过）；真实 agent 上审查回合的写操作审计；从开始菜单打开的 agent 在默认位置的房间里入席；应用里的对话框与右键菜单的实际点击；没有 Node 的机器上用应用自带运行时入席；干净机器上的分发。

## 文档

- [`docs/DEVELOPER.md`](docs/DEVELOPER.md)：开发者说明（构建、命令、目录、测试）
- [`docs/README-public.md`](docs/README-public.md)：产品定义、不干扰契约与测法、首个公开承诺
- [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md)：支持矩阵
- [`docs/DESIGN.md`](docs/DESIGN.md)、[`docs/INTERFACES.md`](docs/INTERFACES.md)：设计与模块契约
- [`docs/DEMO.md`](docs/DEMO.md)：两个逐步演示脚本
- [`docs/POSITIONING.md`](docs/POSITIONING.md)：定位与相关工作
- [`integrations/pi-desktop-plugin/README.zh-CN.md`](integrations/pi-desktop-plugin/README.zh-CN.md)：PI-Desktop 插件，只用上游公开的插件接口在 PI-Desktop 里运行房间（开发版，只在假宿主上测过）

## 第三方软件

源码树里没有第三方代码：room-dev 只用 Node.js 内置模块。唯一附带第三方软件的是 `dist/build-app.mjs` 构建的桌面应用：它原样带上你提供的 Electron 官方 Windows x64 运行时（Electron，MIT；Chromium 及其依赖，多种许可；Electron 内置的 Node.js，MIT 及其依赖的许可），只把 `electron.exe` 改名并设置图标。它们的许可文件（`LICENSE`、`LICENSES.chromium.html`）留在构建出的文件夹里、`圆桌.exe` 旁边，构建时还在那里写一份列出它们的 `THIRD-PARTY.md`。可选的内置 Pi 席位只在你自己安装 `@earendil-works/pi-coding-agent` 时使用，不随包附带。

## 许可

MIT，见 [`LICENSE`](LICENSE)。Copyright (c) 2026 KennyMcSimpson and room-dev contributors。
