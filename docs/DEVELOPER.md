# 开发者说明 · room-dev（中文）

> 这是原来的仓库首页，现在是开发者说明：构建、命令、目录、测试的细节都在这里。公开首页是仓库根目录的 `README.md`（英文在前，中文在后）。

一个本地圆桌房间（Windows 11 首发，Node ≥ 22，零运行时依赖）：你把一份席位包（`JOIN.md`）交给每个已经开着的 coding agent（Codex、Claude Code、任何能跑一条本地命令的 agent），它们就在同一个房间里按顺序发言、各自用自己的工具干活。房间由程序主持：发包、转发（永远带来源标签）、记账；执行者声明的产物被冻结成清单并复制成快照，审方交卷时房间复算哈希，审到一半被改过的产物让结论标为 stale；审方只能给 verdict（pass / reject / disclose）或请求在快照副本里跑白名单命令。房间不起、不杀、不接管任何用户的 agent，也不写它们的配置、会话存储、记忆和工作目录（「不干扰契约」，见 [`docs/README-public.md`](README-public.md) §6）。

这是开发树，不是发布包：没有安装程序。日常用法是桌面应用 `圆桌.exe`（下一节）；命令行和「浏览器里的启动器」是开发者的做法。哪些能力在真实 agent 上跑过、哪些只在脚本席位上跑过，见本页末「已验证 / 未验证」和 [`docs/SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md)。

## 桌面应用：圆桌.exe（先看这一节）

**双击 `<app>\dist\out\圆桌\圆桌.exe`**（先按下面构建一次）。它是一个本地窗口程序：不开黑色命令行窗口，也不在浏览器里打开页面；不需要另装 Node.js（应用自带运行时：Electron 43，内置 Node 24）。

构建（在这个目录里，只用本机已有的文件，**不下载任何东西**）：

```bat
npm run app
:: 等同于 node dist\build-app.mjs [--electron-zip <zip>] [--rcedit <rcedit-x64.exe>] [--out <目录>] [--zip] [--dry-run]
```

- Electron 运行时 zip：`--electron-zip`，否则环境变量 `ROOM_ELECTRON_ZIP`，否则 `%LOCALAPPDATA%\electron\Cache\*\` 下版本最新的 `electron-v*-win32-x64.zip`（以前 npm 安装 electron 时留下的缓存，只读）。都没有就停下并用中文说明怎么指定。
- 图标和版本信息用 rcedit 写进 exe：`--rcedit`，否则 `ROOM_RCEDIT`，否则 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*\rcedit-x64.exe`（只读）。图标 `app/icon.ico` 由 `node dist\make-icon.mjs` 用纯 Node 画出来（圆桌加四个座位）。
- 输出 `dist\out\圆桌\`：`圆桌.exe`（由 electron.exe 改名）、Electron 自带的许可文件、`THIRD-PARTY.md`、`BUILD.json`（Electron / Node 版本、本仓库提交、每个文件的 sha256）、`resources\app\`（`app/` 的外壳代码）和 `resources\app\room-dev\`（room.mjs、lib、ui）。整个文件夹可以拷到别处，`圆桌.exe` 要和旁边的文件在一起。`--zip` 另外打一个 `dist\out\圆桌-<版本>-win-x64.zip`。重新构建时，新文件夹完整之后才替换旧的；圆桌开着时替换会失败并说明。

窗口做什么：

- 主窗口「圆桌」就是圆桌启动器（建房建席、入席卡片、打开房间、给任务并开始，见下文「前五分钟」）。启动器在应用自己的后台进程里运行（`room.mjs lobby --port 0`，Electron utilityProcess），令牌不进任何日志。
- 「工作文件夹」旁边有「浏览…」按钮（系统的选择文件夹对话框，可以在里面新建文件夹）；「复制这句话」用系统剪贴板；右键菜单只有复制、粘贴、剪切、全选。
- 「打开房间界面」开一个新的「圆桌 · 房间 · <房间编号>」窗口（标题带房间编号，开着几个房间时任务栏和 Alt+Tab 里分得清；只放行这个启动器打开的房间）；https 链接先问你，再交给默认浏览器；其他跳转一律拒绝。页面下方仍留一条「点这里打开房间界面」的链接。
- 房间窗口里的「导出证据」弹系统的保存对话框，默认位置 `%USERPROFILE%\room-dev\exports\`（`ROOM_DEV_HOME` 改根时跟着改），你点「保存」后才写文件，提示里写出保存的路径；取消就不写。应用不接受任何下载。
- 不能刷新（Ctrl+R、Ctrl+Shift+R、F5 被屏蔽）：启动器令牌和房间的 admin 令牌只在页面内存里，刷新会丢掉它们。
- 关掉主窗口就退出：启动器先停止它打开的每个房间（删除 `service.lock`），最多等 4 秒，之后强制结束。启动器进程意外退出时，弹一个中文错误框后退出。再次双击 `圆桌.exe` 会切回已经开着的窗口。
- 应用自己的数据（Electron 的缓存、会话、日志 `logs\main.log`、临时文件）放在 `%USERPROFILE%\room-dev\app-data`（`ROOM_DEV_HOME` 改根时跟着改），不写 AppData（原因见下一节）。`ROOM_DEV_HOME` 必须是绝对路径；设成相对路径时圆桌弹中文错误框后退出，不建任何文件夹。
- 席位命令的运行时：建席时 PATH 上有 `node.exe`，JOIN.md 和允许规则照旧是 `node <room.mjs>`；没有 node 时，席位目录里的 `room.cmd` 设 `ELECTRON_RUN_AS_NODE=1` 后用 `圆桌.exe` 自带的运行时执行 room.mjs，JOIN.md、包和唤醒文案都让 agent 调用这个 `room.cmd`，Claude Code 的允许规则是 `Bash(<room.cmd 路径>:*)`。这种席位记住的是建席时 `圆桌.exe` 的位置：把应用挪走后要重新建席。
- 应用和命令行用的是两个不同位置的 room.mjs：应用跑的是打包在 `圆桌\resources\app\room-dev\room.mjs` 的那份，命令行跑的是你调用的那份（例如仓库里的 `room.mjs`）。每个席位在 `seat.json` 的 `roomMjs` 里记下建席时用的 room.mjs（更早建的席位按它自己的 `room.cmd`），之后的入席提示、包、散会包、唤醒文案和 `wait` 的交卷提示都用这个路径，和它的 JOIN.md、允许规则一致；所以用命令行建的房间在应用里打开（或反过来）不会改变已有席位的命令。新建的席位用建席那一方的 room.mjs；那份 room.mjs 挪走或删掉后，要重新建席。
- 开发者工具默认关闭，设环境变量 `ROOM_APP_DEVTOOLS=1` 才能打开。`圆桌.exe --smoke`（或 `--smoke-room`，另建一个临时房间并打开它的窗口）配合 `ROOM_APP_SMOKE_OUT=<appRoot 之内的文件>` 自检：检查页面后把结果写成 JSON 并退出（退出码 0 表示通过）。

验证状态：`test/app.test.mjs` 在纯 Node 下测外壳的判断逻辑（导航、开窗、刷新键、令牌不进日志、数据目录、smoke 结果）、图标、构建脚本的 `--dry-run` 与拒绝、启动器的退出消息和席位运行时回退。2026-10-04 在作者机器上真实构建并运行过（Electron 43.6.0，内置 Node 24.20.0）：exe 的 FileDescription / ProductName 是「圆桌」，没有 `default_app.asar`；`--smoke` 与 `--smoke-room`（`ROOM_DEV_HOME` 指向一个测试目录）都通过：启动器页面标题「圆桌启动器」、`window.roomApp` 存在、userData 在该目录的 `app-data` 下，临时房间的「圆桌 · 房间」窗口打开，退出时启动器退出码 0、`service.lock` 已删、临时房间已清理、没有 `圆桌.exe` 进程残留；第二次启动约 1 秒内退出（测了三次：0.1、1.0、1.0 秒）、只剩一个主进程；向主窗口发关闭消息后启动器进程随之退出。没测过的：文件夹选择对话框和右键菜单的实际点击、https 外链确认框、没有 node 的机器上用 `room.cmd` 入席、Chromium 是否还碰了 `app-data` 以外的位置。

## MSIX / AppData 注意事项（先读这一条）

**房间目录、席位工作目录、临时目录都不要放在 `%LOCALAPPDATA%`（AppData）下。** 实测（2026-10-01，P−1 探针报告发现 0；该报告含本机路径与会话 id，是内部记录，不随公开版发布）：从 MSIX 打包的应用（例如 Claude 桌面应用）里起的进程写 `%LOCALAPPDATA%` 时，文件会被悄悄重定向进 `AppData\Local\Packages\<包名>\LocalCache\Local\...`，只有同一个包上下文里的进程看得到原路径；从开始菜单打开的 Codex Desktop、Claude Code 会找不到房间目录，席位命令和房间服务就对不上。用户目录本身不被重定向。

- 默认根目录是 `%USERPROFILE%\room-dev`（`lib/common.mjs` 的 `appRoot()`）：房间在 `%USERPROFILE%\room-dev\rooms\<id>`，测试临时目录在 `%USERPROFILE%\room-dev\test-runs\<随机>`，跨房间的 verdict 记录在 `%USERPROFILE%\room-dev\adjudications.jsonl`，构建缓存在 `%USERPROFILE%\room-dev\cache`，`admin pi-key --save` 保存的内置 Pi key（DPAPI 密文）在 `%USERPROFILE%\room-dev\secrets\pi-key.dpapi`。
- 环境变量 `ROOM_DEV_HOME` 可以整体改掉这个根。
- `admin init` 与 `admin add-seat` 用 `fs.realpathSync.native` 比对房间目录和席位工作目录的真实位置（`virtualizationRedirect()`）；落进包缓存就拒绝，并用中文说明原因；经过链接（junction / symlink）的位置也会拒绝并给出真实路径。检查先在最近的已存在祖先目录上做，所以被拒绝时什么都不会创建。
- 跨进程比较路径一律用真实位置（`realPathNative()`），不要用字面路径。
- `lib/codex.mjs` 到 `%LOCALAPPDATA%\OpenAI\Codex\bin` 找 Codex 安装是正确的：那是读取别人的安装，不是房间写入的位置。

## 安装

1. 用桌面应用 `圆桌.exe` 时不需要 Node.js（构建它的那台机器需要）。命令行做法和开发需要 Node.js ≥ 22（`node --version`）。不需要 `npm install`：运行时只用 Node 内置模块。
2. 可选：Git for Windows（`git` 在 PATH 上）。房间在快照副本里 `git init`，披露命令（例如 `git diff`、`git status`）在那里执行。按代码（没有在无 git 的机器上跑过）：找不到 git 时快照照常复制、只是不做 `git init`，git 类披露命令也就跑不起来。
3. 可选：内置 Pi 托管席位需要 `@earendil-works/pi-coding-agent`，按需安装。按代码（没有在未安装的机器上端到端跑过）：没装时 `--hosted pi:*` 席位的回合记 `seat_failed`，错误码 `PI_NOT_INSTALLED`，其余席位不受影响。
4. 把这个目录放在任意位置（下文用 `<app>` 表示它，例如 `D:\tools\room-dev`）。自检：

```bat
node <app>\test\e2e.mjs
node --test "<app>\test\**\*.test.mjs"
```

## 前五分钟（实现 → 审查，两个席位）

席位 A 是主力兼审方（建议给它一个专门的空文件夹当工作文件夹，这样「只能写自己目录」的沙箱让它对产物只读），席位 B 是执行者（工作文件夹是任务项目）。

1. **双击 `圆桌.exe`**（上一节）。主窗口就是「圆桌启动器」；关掉它就退出，并停止从启动器打开的房间。开发者做法（不用应用、在浏览器里）：在终端运行 `node <app>\room.mjs lobby --open`，它在默认浏览器里打开同一个页面，那个终端要一直开着。页面地址只在 127.0.0.1 上，`#` 后面是这次启动的随机令牌（只在地址片段和请求正文里，页面读到后就从地址栏抹掉；刷新页面会丢掉它：应用里刷新键被屏蔽，浏览器里回到终端重新打开那条链接即可）。
2. **新建房间。** 填房间编号、选预设（每个预设下面有一行说明），默认就是两席模板：A = Codex Desktop 主力，B = Claude Code 执行者。每个席位可以改编号、职责、agent、等待方式和工作文件夹。工作文件夹默认建议 `%USERPROFILE%\room-seats\<房间>-<席位>`，勾选「替我新建这个空文件夹」时启动器只新建一个不存在的空文件夹（同样拒绝 AppData、CODEX_HOME / CLAUDE_CONFIG_DIR 之内、包含房间的 git 仓库之内的位置）；B 一般改成你的项目文件夹：手动填或粘贴路径后，页面会只读地查一次，文件夹已存在就自动取消勾选。以句点或空格结尾的文件夹名（例如 `AppData.`）、含 Windows 不允许字符的名字和设备名一律拒绝。Codex 席位还有「Codex 线程名」（默认 `room-<房间>-<席位>`，每个房间不重复），用于唤醒推送。agent 选「房间内置 Pi」时这个席位由房间自己托管（`simplified` 预设默认就是 A + 一个内置 Pi 席位），启动房间前用 `ROOM_PI_API_KEY` 或 `admin pi-key --save` 准备好 key。建房和建席走的是和 `admin init` / `admin add-seat` 完全相同的代码与规则；任何一个席位被拒绝，整个房间连同刚新建的文件夹都会撤掉，并用中文说明原因。
3. **把每句话发给对应的 agent。** 建好后每个席位一张「入席」卡片：一句「读 `<JOIN.md 绝对路径>`，按它入席。」加「复制这句话」按钮，下面是这个 agent 的做法（Codex Desktop：新建线程、项目文件夹选席位工作文件夹、线程重命名为卡片上的线程名、沙箱 workspace-write；Claude Code：在席位工作文件夹里新开会话，第一次弹权限提示时只允许 JOIN.md 里写的那一条规则）。
4. **打开房间界面。** 启动器在自己的进程里启动这个房间的服务（端口随机），在应用里开一个「圆桌 · 房间」窗口（浏览器里是新标签页）显示房间界面（admin 令牌在地址片段里）。从启动器跳到另一个回环端口在浏览器看来是 same-site 的顶层导航，房间服务只对这种导航放行页面本身（`/`、`/index.html`），`/api/*` 和其他请求仍只收同源请求。房间服务已经在别的窗口里运行时会拒绝并说明。
5. **给任务并开始。** 在卡片下面（或房间列表里）写任务、填发言顺序（默认主力在前，例如 `A,B`），点「给任务并开始」。之后在房间界面里看发言流、批准披露、散会；房间列表里的「停止」只停这个房间的服务。

### 命令行做法（不用启动器时）

在 cmd.exe 里运行：

```bat
:: 1. 建房、建席（服务未运行时）。只给 --id 时房间目录就是 %USERPROFILE%\room-dev\rooms\<id>
node <app>\room.mjs admin init     --id demo --preset implement-review --wall 2700
mkdir %USERPROFILE%\room-seats\A
node <app>\room.mjs admin add-seat --id demo --seat A --role lead     --agent codex-desktop --cwd %USERPROFILE%\room-seats\A --audit codex --wake-thread room-A
node <app>\room.mjs admin add-seat --id demo --seat B --role executor --agent claude-code   --cwd D:\work\my-project       --audit claude

:: 2. 起服务（自己的终端，一直开着）。--port 0 另开 loopback 界面，地址和令牌打印在服务日志里
node <app>\room.mjs serve --dir %USERPROFILE%\room-dev\rooms\demo --port 0

:: 3. 对每个 agent 说一句话（写展开后的绝对路径）
::    「读 C:\Users\<你>\room-dev\rooms\demo\seats\A\JOIN.md，按它入席。」
::    「读 C:\Users\<你>\room-dev\rooms\demo\seats\B\JOIN.md，按它入席。」

:: 4. 给任务、开轮（另一个终端）
node <app>\room.mjs admin task  --id demo --text "给 parser.mjs 加 --strict 开关，验收：node --test parser.test.mjs"
node <app>\room.mjs admin start --id demo --order A,B

:: 5. 看、处理请求、散会
node <app>\room.mjs admin show --id demo
node <app>\room.mjs admin approve-disclose <id> --id demo
node <app>\room.mjs admin close --id demo
```

`implement-review` 预设的一轮是：Work（B 干活，`room artifacts --declare` 冻结产物，`submit` 汇报）→ Meet（A 开题、B 答复，按 `--order` 串行）→ Summary（A 用 `room mark` 逐项标注条目表、用 `room verdict` 对每个冻结清单给结论、`submit` 汇总正文）。不带 `--preset` 的房间是 P−1 的纯 Meet 房间（只按顺序发言）。其他预设：`discussion`、`report`、`cross-check`、`division`（先由主力起草任务单，`admin confirm-task` 确认后才进 Work）、`simplified`。

`--wake-thread` 填 Codex 线程的 UUID 或精确线程名：线程名先在 `CODEX_HOMEsession_index.jsonl`（Codex 的线程改名记录）里只读查成 UUID，查到恰好一个才推送（重名就拒绝、不猜，记 `IDLE_UNKNOWN`）；轮到 A 时服务执行 `codex queue --thread <UUID>`，推送固定文案「[ROOM authority=none] 轮到席位 A，请运行 …」，每回合至多一次，每次记 `wake_pushed` 事件。没登记就不推，A 由用户提醒。

## 命令一览

全部命令都是 `node <app>\room.mjs <命令> ...`（或席位目录里的 `room.cmd`）。第一行大写状态词是结果；预期结果退出 0，`REJECTED` 退出 2，`PENDING` / `NO_SERVICE` 退出 8，错误退出 9。

### 席位命令（agent 运行；只写本席位工作目录下的 `.room-outbox\<seatId>\`）

| 命令 | 结果 |
|---|---|
| `wait --seat <seatDir> [--timeout S] [--once]` | `TURN attempt=… packet=…` / `TURN_OVER` / `NOT_YOUR_TURN` / `NOTICE …`（上一 attempt 已作废）/ `NEEDS_RECONCILE` / `ROOM_CLOSED`（随后一行 `FAREWELL packet=…` 指向散会声明包）/ `LEFT` |
| `submit --seat <seatDir> --attempt <id> --file <path>` | `ACCEPTED [MALFORMED <原因>] …` / `REJECTED reason=…` |
| `status --seat <seatDir> [--log] [--whoami]` | `STATUS …`；`--whoami` 打印登记的审计源与线程 / 会话 id |
| `leave --seat <seatDir>` | `LEFT` |
| `artifacts --seat <seatDir> [--attempt <id>] --declare <path>... [--baseline none\|whole\|<manifestSha>] [--exclude <glob>]` | `FROZEN manifest=<sha> files=<n>`；不带 `--attempt` 是回合前声明 |
| `point --seat … --attempt … --seq N --text "…"` | `ACCEPTED item=<id>` |
| `quote --seat … --attempt … --seq N --text "…"` | `ACCEPTED verified=true\|false\|unknown` |
| `misquoted --seat … --attempt … --seq N --text "…"` | `ACCEPTED kind=misquoted` |
| `mark --seat … --attempt … --item <id> --status accepted\|rejected\|deferred --text "…"` | `ACCEPTED kind=mark` |
| `verdict pass\|reject\|disclose --seat … --attempt … --artifact <manifestSha> --text "…"` | `ACCEPTED kind=verdict` |
| `disclose --seat … --attempt … --arg git --arg diff --reason "…"` | `REQUESTED id=<id>`（用户批准前不执行）。每个参数一个 `--arg`，不用引号，以 `-` 开头的写 `--arg=--stat`；也可 `--argv-file <JSON 文件>`；旧的 `--argv '["git","diff"]'` 仍接受 |
| `pass --seat … --attempt …` | `ACCEPTED kind=pass` |
| `assign --seat … --attempt … --file <draft.md>` | `DRAFTED assignments=<n>`（草案每行 `- <seatId>: <任务> \| 验收: <argv JSON>`） |

结构化内容也可以写在 `submit` 的正文里，用 ASCII 文本标记：`<<ROOM:VERDICT pass artifact=<sha>>>`、`<<ROOM:DISCLOSE argv=[...]>>`、`<<ROOM:POINT seq=N>>…`、`<<ROOM:QUOTE seq=N>>…<<ROOM:END>>`、`<<ROOM:MARK item=<id> status=accepted>>`、`<<ROOM:MISQUOTED seq=N>>`、`<<ROOM:ASSIGN>>…<<ROOM:END>>`、`<<ROOM:PASS>>`。标记写错（例如翻译成中文）→ 接受但标 malformed → 追问一次 → 仍不成立则 verdict 记 none，绝不默认成 pass。

### 服务（用户自己的终端）

| 命令 | 说明 |
|---|---|
| `lobby [--port N] [--open]` | 圆桌启动器（`圆桌.exe` 在后台进程里运行的就是它，带 `--port 0`；开发者 ZIP 的 `启动器.cmd` 也运行它）：127.0.0.1 上的页面，默认端口 7380，被占用时换一个空闲端口；建房建席、生成入席句子、在本进程里打开 / 停止房间、给任务并开始。只打印一次地址，令牌只在地址片段里；`--open` 用默认浏览器打开。Ctrl+C 或关窗口退出，并停止它打开的每个房间 |
| `serve --dir <roomDir> [--tick ms] [--once] [--port N] [--pi-key-stdin]` | events.jsonl 的唯一写者；同一房间只允许一个实例。`--port` 在 127.0.0.1 上起界面（`ui/`）和 `/api/*`，令牌在 URL fragment 里，从不进查询串。`--pi-key-stdin` 从标准输入读内置 Pi 的 key（只在内存）；没有它也没有 `ROOM_PI_API_KEY` 时，有托管席位的房间在启动时解密 `admin pi-key --save` 保存的 key |

### 管理命令（用户自己的终端；`--dir <roomDir>` 或 `--id <roomId>`）

| 命令 | 说明 |
|---|---|
| `admin init --id <id> [--dir …] [--preset …] [--wall s] [--work-wall s] [--max-work n] [--max-tokens n] [--packet-max-bytes n]` | 建房；拒绝被重定向的位置、CODEX_HOME / CLAUDE_CONFIG_DIR 之内的位置 |
| `admin add-seat --seat <id> --role executor\|reviewer\|lead\|participant --cwd <dir> [--agent …] [--wait background\|turn_over\|manual] [--tier discussion\|readonly\|workspace\|full] [--reviews A,B] [--hosted pi:discussion\|pi:exec\|pi:reviewer\|lane:<通道>[:<档位>]] [--model <模型 id>（只用于托管席位）] [--surface cli\|tool:<工具名>（工具席位：宿主对话只经这个工具行事（INTERFACES §5a））] [--wake-thread …] [--wake-max n] [--audit codex\|claude --thread-id … --session-id …] [--name …] [--wall s] [--wait-timeout s]` | 建席（服务未运行时）；生成 `seats/<id>/JOIN.md`、`room.cmd`。`--cwd` 必须是已存在的目录（房间不写也不替你创建席位工作目录）；房间目录不能在任何席位工作目录所属的 git 仓库之内 |
| `admin set-audit --seat <id> --kind codex\|claude [--thread-id …] [--session-id …]` | 事后登记审计源 |
| `admin task\|say --text "…" \| --file <path>` | 任务；用户消息（默认下一轮进包） |
| `admin start --order A,B[,A]` | 开一轮 |
| `admin cancel \| skip \| close \| reverse` | 作废当前 attempt / 跳过当前席位 / 散会（发散会声明包）/ 换向 |
| `admin confirm-task [--file <改过的草案>]` | 确认任务单 |
| `admin interrupt [--text "…"]` | 打断并重开本轮（epoch 递增） |
| `admin reassign --seat <from> --to <seat> [--text "…"]` | 改派 |
| `admin wake --seat <id>` | 手动唤醒推送（受每回合上限约束） |
| `admin reconcile <attemptId> replay\|void` | 服务重启后处理未决 attempt |
| `admin approve-disclose <id>` / `admin deny-disclose <id> --reason "…"` | 批准（在快照副本里执行）/ 拒绝披露请求 |
| `admin accept-stale <manifestSha>` | 接受过期产物上的结论（记 accepted_stale） |
| `admin retry [--seat <id>]` | 有预设的房间里某席位回合超时后，房间等你决定：让同一席位重新领这一回合（也可 `skip` 记缺席，或 `reassign`） |
| `admin pi-key --port <n> [--seat <id>]` | 把 Pi 的 API key（来自标准输入或 `ROOM_PI_API_KEY`）经本机回环 `POST /api/admin` 交给用 `--port <n>` 运行的服务，只在内存、不落盘。也可以在启动服务时用环境变量 `ROOM_PI_API_KEY` 或 `serve --pi-key-stdin` 交；没有文件或队列交接 |
| `admin pi-key --save` / `--status` / `--forget` | 只在 Windows，不需要 `--dir`（这是当前 Windows 用户的 key，不属于某个房间）。`--save` 从标准输入或 `ROOM_PI_API_KEY` 读 key，用 DPAPI（CurrentUser）加密后存到 `%USERPROFILE%\room-dev\secrets\pi-key.dpapi`（`ROOM_DEV_HOME` 可改根），只打印 `SAVED <路径> length=<n> sha256=<前 8 位>`；`--status` 说有没有保存、能不能解密；`--forget` 删除。详见下文「内置 Pi 的 key」 |
| `admin export [--out <zip>] [--redact]` | 导出公开层；发现密钥形状的内容就失败，`--redact` 打码后导出 |
| `admin log` / `admin show` | 事件流 / 汇总（条目、产物、verdict、披露、用量、驳回率提示） |

### 内置 Pi 的 key

明文 key 从不落盘，也从不进房间目录、事件、日志或 `state.json`（`state.json` 只记 `piKey: present|absent` 和来源 `piKeySource`）。四种交法：

1. 启动服务的终端里设置 `ROOM_PI_API_KEY`（只在内存）；
2. `<输出 key 的命令> | node <app>\room.mjs serve --dir <房间目录> --pi-key-stdin`（只在内存）；
3. 服务带 `--port <n>` 运行时，`node <app>\room.mjs admin pi-key --dir <房间目录> --port <n>`，key 来自标准输入或 `ROOM_PI_API_KEY`，经本机回环交给运行中的服务（只在内存）；
4. 只在 Windows：事先保存一次，之后启动的服务没有 1–3 的 key 时自动用它。

```bat
:: 保存（key 从标准输入或 ROOM_PI_API_KEY 来；不要写在命令行参数里，--save <值> 会被拒绝）
<输出 key 的命令> | node <app>\room.mjs admin pi-key --save
::   SAVED C:/Users/<你>/room-dev/secrets/pi-key.dpapi length=<n> sha256=<前 8 位>（…）
node <app>\room.mjs admin pi-key --status
::   PI_KEY_STATUS saved=yes decrypts=yes length=<n> sha256=<前 8 位> path=…
node <app>\room.mjs admin pi-key --forget
::   FORGOTTEN C:/Users/<你>/room-dev/secrets/pi-key.dpapi（…）
```

- 存的是 Windows DPAPI 的密文（作用域 CurrentUser，加一段固定的应用 entropy），文件在 `%USERPROFILE%\room-dev\secrets\pi-key.dpapi`（`ROOM_DEV_HOME` 改根时跟着改），不在 AppData（原因见上文 MSIX 一节）；写完会检查文件的真实位置，被重定向就删掉并拒绝。同目录的 `write-log.jsonl` 记下 `--save` / `--forget` 的每次写入。
- 只有同一个 Windows 用户在同一台机器上能解密；换用户、换机器、文件被改过，`--status` 显示 `decrypts=no code=DPAPI_FAILED`，服务启动时记一条中文警告后照常运行，托管席位的回合报 `PI_NO_KEY`。同一用户下运行的任何程序也都能解密它，这是 DPAPI CurrentUser 的边界。
- 加解密由 Windows PowerShell 5.1 完成（不装任何 npm 包）：key 只作为一行 base64 经标准输入交给它，不进命令行、不进环境变量、不写临时文件，也不进 PowerShell 的脚本块日志（事件 4104；在 Windows 上 `test/dpapi.test.mjs` 每次复核）。受 AppLocker / WDAC 限制、PowerShell 处于受限语言模式的机器上 `--save` 报 `DPAPI_UNAVAILABLE`，请改用 1–3。
- 优先级：1、2 给了 key 就不读保存的文件；3 在服务运行中随时覆盖当前 key。房间里没有托管席位时服务不读它。

### 审计、契约与证据、打包

| 命令 | 说明 |
|---|---|
| `audit --seat <seatDir> [--packet <id>] [--verbose]` | 只读审计：按登记的线程 / 会话找包、分类写操作 |
| `node <app>\contract\check-writes.mjs <roomDir> [--outbox <dir>]...` | write-log 是否全在界内 |
| `node <app>\contract\control-run.mjs` | 不开 agent 跑一整场，配置 / 记忆 / hooks 目录按条目比对 |
| `node <app>\contract\env.mjs` / `pids.mjs` / `memory-diff.mjs` | 环境变量探针 / 进程集合 / 记忆目录比对 |
| `node <app>\evidence\collect.mjs [--skip-tests] [--skip-e2e]` | 跑以上全部，写 `evidence/REPORT.md`（本机生成，含本机路径，已列入 `.gitignore`，不进版本库） |
| `node <app>\dist\build-app.mjs [--electron-zip <zip>] [--rcedit <exe>] [--out <dir>] [--zip] [--dry-run]`（`npm run app`） | 构建桌面应用 `dist\out\圆桌\圆桌.exe`（见「桌面应用」一节；不下载任何东西） |
| `node <app>\dist\make-icon.mjs [--out <ico>]` | 重画 `app/icon.ico`（纯 Node，结果固定） |
| `node <app>\dist\build.mjs [--no-download]` | 开发者 ZIP：`room-dev-<ver>-win-x64.zip`（命令行做法 + `启动器.cmd`，官方 Node zip 校验 sha256）。日常用法是桌面应用，不是这个 |
| `node <app>\dist\export.mjs <roomDir> <out.zip> [--redact]` | 同 `admin export` |

## 目录

```
room.mjs              入口；席位命令只加载 lib/seat.mjs，并在启动时把自己的环境清到白名单
lib/seat.mjs          席位命令            lib/admin.mjs     管理命令          lib/join.mjs    JOIN.md / room.cmd
lib/service.mjs       房间服务（可进程内驱动）  lib/reducer.mjs  事件归约（纯函数）  lib/http.mjs    loopback HTTP
lib/packet.mjs        包渲染 + lib/templates/*.md   lib/budget.mjs  包预算裁剪    lib/usage.mjs   用量
lib/structured.mjs    结构化提交解析、条目表、汇总版本      lib/supervision.mjs  建房校验、verdict 绑定、披露状态机、驳回率
lib/workspace.mjs     产物冻结、复算、快照、快照内执行      lib/audit.mjs   只读审计
lib/spawn.mjs         所有子进程（白名单环境）   lib/guard.mjs   所有写入（越界拒绝 + write-log）
lib/hosted/pi.mjs     内置 Pi 托管席位            lib/common.mjs  路径根（appRoot 等）、虚拟化检测
lib/hosted/dpapi.mjs  内置 Pi key 的 DPAPI 保存（Windows PowerShell 5.1，无 npm 依赖）
app/                  桌面应用外壳（Electron 主进程 main.mjs、可测的 main-helpers.mjs、preload.cjs、icon.ico）
lib/lobby.mjs         圆桌启动器（建房建席、打开房间，经 lib/api.mjs）
ui/                   无构建步骤的界面：index.html/app.*（房间界面，serve --port）、lobby.*（启动器）
contract/  evidence/  不干扰契约的测法与证据
dist/                 打包与导出                  test/      单元测试（node --test）与 e2e.mjs
docs/                 INTERFACES.md（契约）、DESIGN.md、README-public.md、SUPPORT-MATRIX.md、DEMO.md、DEVELOPER.md（本页）
                      docs/internal/ 是内部记录（探针报告、证据快照、公开前扫描），不随公开版发布
```

## 测试

```bat
node --test "<app>\test\**\*.test.mjs"
node <app>\test\e2e.mjs
node <app>\evidence\collect.mjs
```

`test/e2e.mjs` 用真实的 CLI 进程（脚本席位 + 真实服务）跑三个房间：P−1 的顺序、迟交、坏令牌、伪造横幅转义、取消、过期、崩溃重启、退席；以及一个 `implement-review` 房间里的 Work 冻结、命令形 verdict、披露请求 → 批准 → 在快照副本里执行、外部改动后的 stale 与 accept-stale、malformed verdict → 追问 → none、重启后 needs_reconcile → reconcile void、散会声明包；当前进程能看到被重定向的 AppData 时，还检查 MSIX 拒绝文案。全部通过后它删除自己的临时目录（`%USERPROFILE%\room-dev\test-runs\e2e-<随机>`），失败时保留供检查。

## 已验证 / 未验证

完整表格与每格的证据脚注在 `docs/SUPPORT-MATRIX.md`；那张表只记真实席位或脚本席位端到端上的观测，单元测试通过不算「已验证」。截至 2026-10-01：

- **已验证（有记录）**：脚本席位（仿真 / CI）的形态、文件式传输、等待、完成信号、作废，在作者的 Windows 11 机器上端到端跑通；由探针会话用 `codex exec` 起的 Codex 线程完成了 wait → 读包 → 交卷 → TURN_OVER 三个回合，审计器在它的 rollout 里找到了包（P−1 探针报告，内部记录）。
- **这条「已验证」的适用范围**：那个 Codex 线程与房间同在一个 MSIX 包上下文里（房间当时在 `%LOCALAPPDATA%`）。从开始菜单打开的 agent 能否入席，以及新的默认位置 `%USERPROFILE%\room-dev\rooms` 上的入席，都还没跑过。
- **未验证**：Codex Desktop 交互线程、Codex CLI、Claude Code（P−1 里只有替身）、OpenCode / Gemini CLI / Kimi / DSH / 用户自己的 Pi，以及内置 Pi 的三个档位（只有假 provider 的单元测试）；唤醒推送对空闲 Desktop 线程的效果；真实 agent 上的结构化提交、冻结与过期、审方写操作审计；ProcMon / ETW 抽查；干净机器上的 ZIP 分发。
- 圆桌启动器（2026-10-04，作者机器）：`test/lobby.test.mjs` 进程内跑通建房、拒绝不留残余、打开、给任务并开始、停止、退出；页面在一个嵌入式浏览器里点过一遍（建房、入席卡片、打开房间服务、给任务后进入 Work、停止），房间界面按 `http://127.0.0.1:<端口>/#<admin 令牌>` 手动打开后显示 Work 阶段。没有跑过的：`--open` 经 rundll32 打开默认浏览器、「打开房间界面」在普通浏览器里弹出新标签页、关窗口时的退出路径。「打开房间界面」的跳转原先会被房间服务按 Sec-Fetch-Site: same-site 拒绝（403 BAD_FETCH_SITE），现已对页面本身的顶层导航放行；放行规则只在测试里用构造的 Sec-Fetch 请求头验证过（`test/lobby.test.mjs`、`test/service.test.mjs`），还没有在普通浏览器里点过。
- 治理层（冻结、复算与 stale、verdict、披露、条目表、取代通知、needs_reconcile、散会声明）目前只在单元测试和脚本席位 e2e 上跑过。
- 内置 Pi key 的 DPAPI 保存（2026-10-03，作者机器 Windows 11 Pro 10.0.26200、Windows PowerShell 5.1、Node v24.11.1，`test/dpapi.test.mjs`）：真实 DPAPI 的加密、解密、改动后解不开，真实 CLI 进程的 `admin pi-key --save/--status/--forget`，服务启动时取用保存的 key（托管席位用假 provider）都跑过；用真实 Pi SDK 带着保存的 key 跑一个回合、别的 Windows 用户或机器上的行为、受限语言模式下的拒绝都没有跑过。逐格见 `docs/SUPPORT-MATRIX.md`。

## 文档

- `docs/INTERFACES.md`：模块接口与存储契约（实现以它为准）
- `README.md`：公开首页（英文 / 中文）
- `docs/README-public.md`：产品定义、不干扰契约与测法、首个公开承诺
- `docs/SUPPORT-MATRIX.md`：支持矩阵
- `docs/DESIGN.md`：设计文档；`docs/DEMO.md`：演示脚本
- `evidence/REPORT.md`：最近一次 `evidence/collect.mjs` 的结果表（本机生成，不进版本库）
- `docs/internal/`：内部记录（P−1 探针报告、证据快照、公开前扫描）；`node dist/export-public.mjs <目录>` 导出公开版时排除
