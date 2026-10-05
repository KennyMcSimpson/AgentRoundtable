# 支持矩阵（能力矩阵）

截止日期：2026-10-01（末尾「内置 Pi 的 key 存储（DPAPI）」一节：2026-10-03）。每格只取三值之一：**已验证**（在作者机器上跑过，且记录在 P−1 探针报告里）、**未验证**（设计上应当支持，没跑，或跑过但没有记进探针报告）、**不支持**（设计上明确不做，或对该席位不适用）。每格的脚注说明格子的含义、设计值与证据出处。单元测试通过不算「已验证」：这张表只记真实席位或脚本席位端到端上的观测。唯一的例外是末尾的 DPAPI 一节，它的证据来源与适用范围在那一节开头单独写明。

唯一的证据来源是 P−1 探针报告（2026-10-01）。这份报告含本机路径与会话 id，是内部记录，不随公开版发布；本表脚注转述了每格用到的那条发现。它只跑了一个真实席位种类：由探针会话用 `codex exec` 起的新 Codex 线程（workspace-write，cwd 为空目录）。Claude Code 一侧由探针会话替身，不算「新会话按 JOIN.md 入席」的证据，所以那一行全部未验证。所有其他行没有任何实测。

**已验证格子的适用范围（P−1 发现 0）。** 探针会话跑在一个 MSIX 打包的桌面应用里；P−1 的房间建在 `%LOCALAPPDATA%` 下，写入被重定向进该应用的包缓存目录，只有同一包上下文里的进程看得到。P−1 的 Codex 线程是探针会话的子进程，同在包上下文里，所以看得见房间。因此第一行的「已验证」只对「agent 与房间同在一个包上下文」这一组合成立；从开始菜单打开的 Codex Desktop 或 Claude Code 是否能入席，没有证据。房间默认位置已改为 `%USERPROFILE%\room-dev\rooms`，那个位置上的入席也还没跑过。

列按方案 §3.6，其中「等待方式与每回合唤醒上限 W」拆成两列，因为第一行的等待方式（交卷即退）已验证而唤醒推送未验证，一格放不下两个值。Codex 拆成三行：P−1 实际跑的 `codex exec` 子进程、Desktop 里的交互线程（code-mode exec）、Windows 上的交互 CLI（旧 shell 工具）。后两者用的 exec 工具与 `codex exec` 是否相同，P−1 没有判定，所以不借用第一行的证据。

## 矩阵

| 席位种类 | 形态 | 传输 | 等待方式 | 唤醒推送与 W | 完成信号 | 取消（作废 / 真取消） | 只读审计源与可核项 | 权限提示 | 声明的权限档位 | usage 上报 | 结构化提交通道 | 宿主工具输出上限 | Windows 已验证组合 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Codex · `codex exec` 子进程（与房间同一包上下文，P−1 实测组合） | 已验证[^cx-form] | 已验证[^cx-transport] | 已验证[^cx-wait] | 未验证[^cx-wake] | 已验证[^cx-done] | 未验证[^cx-cancel] | 已验证[^cx-audit] | 未验证[^cx-perm] | 未验证[^cx-tier] | 未验证[^cx-usage] | 未验证[^cx-structured] | 已验证[^cx-output] | 已验证[^cx-win] |
| Codex Desktop（交互线程，code-mode） | 未验证[^dt-all] | 未验证[^dt-all] | 未验证[^dt-all] | 未验证[^cx-wake] | 未验证[^dt-all] | 未验证[^cx-cancel] | 未验证[^dt-all] | 未验证[^dt-all] | 未验证[^dt-all] | 未验证[^cx-usage] | 未验证[^dt-all] | 未验证[^dt-all] | 未验证[^dt-all] |
| Codex CLI（Windows 交互，旧 shell 工具） | 未验证[^cli-form] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] | 未验证[^cli-all] |
| Claude Code | 未验证[^cc-form] | 未验证[^cc-transport] | 未验证[^cc-wait] | 不支持[^cc-wake] | 未验证[^cc-done] | 未验证[^cc-cancel] | 未验证[^cc-audit] | 未验证[^cc-perm] | 未验证[^cc-tier] | 未验证[^cc-usage] | 未验证[^cc-structured] | 未验证[^cc-output] | 未验证[^cc-win] |
| OpenCode | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] |
| Gemini CLI | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] |
| Kimi | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] |
| DSH | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^dsh-audit] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] |
| 用户自己的 Pi | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] | 未验证[^other] |
| 内置 Pi · 讨论档 | 未验证[^pi-form] | 未验证[^pi-transport] | 未验证[^pi-wait] | 不支持[^pi-wake] | 未验证[^pi-done] | 未验证[^pi-cancel] | 不支持[^pi-audit] | 不支持[^pi-perm] | 未验证[^pi-tier-d] | 未验证[^pi-usage] | 未验证[^pi-structured] | 不支持[^pi-output] | 未验证[^pi-win] |
| 内置 Pi · 执行档 | 未验证[^pi-form] | 未验证[^pi-transport] | 未验证[^pi-wait] | 不支持[^pi-wake] | 未验证[^pi-done] | 未验证[^pi-cancel] | 不支持[^pi-audit] | 未验证[^pi-perm-e] | 未验证[^pi-tier-e] | 未验证[^pi-usage] | 未验证[^pi-structured] | 不支持[^pi-output] | 未验证[^pi-win-e] |
| 内置 Pi · 审方档 | 未验证[^pi-form] | 未验证[^pi-transport] | 未验证[^pi-wait] | 不支持[^pi-wake] | 未验证[^pi-done] | 未验证[^pi-cancel] | 不支持[^pi-audit] | 不支持[^pi-perm] | 未验证[^pi-tier-r] | 未验证[^pi-usage] | 未验证[^pi-structured] | 不支持[^pi-output] | 未验证[^pi-win] |
| 脚本席位（仿真 / CI） | 已验证[^ss-form] | 已验证[^ss-transport] | 已验证[^ss-wait] | 不支持[^ss-wake] | 已验证[^ss-done] | 已验证[^ss-cancel] | 不支持[^ss-audit] | 不支持[^ss-perm] | 不支持[^ss-tier] | 不支持[^ss-usage] | 未验证[^ss-structured] | 不支持[^ss-output] | 已验证[^ss-win] |

## 内置 Pi 的 key 存储（DPAPI，P3）

这一节只说 key 的保存与取用，不说托管席位能否完成回合（那是上表三行内置 Pi，仍全部未验证）。证据不是 P−1 探针报告，而是 `test/dpapi.test.mjs` 在作者机器上的一次运行：2026-10-03，Windows 11 Pro 10.0.26200，Windows PowerShell 5.1，Node v24.11.1，13/13 通过、0 跳过。这些用例调用的是真实 DPAPI（经真实的 `powershell.exe`）、真实的 `node room.mjs admin pi-key …` 子进程（`ROOM_DEV_HOME` 指向 `%USERPROFILE%\room-dev\test-runs` 下的临时目录）和进程内的真实房间服务；托管席位本身用的是假 provider。「已验证」只覆盖这些用例实际跑到的内容，其余一律未验证。三个档位共用同一把 key，所以只有一行。

| 席位种类 | 加密保存 `--save` | 状态 `--status` | 删除 `--forget` | 改动后解不开 | key 只经标准输入 | 落盘位置与 write-log | 被重定向时拒绝 | 服务启动时取用 | 解不开时警告并继续 | 换 Windows 用户或机器 | 受限语言模式 | 带保存的 key 跑真实 Pi 回合 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 内置 Pi（三档共用） | 已验证[^dp-save] | 已验证[^dp-status] | 已验证[^dp-forget] | 已验证[^dp-tamper] | 已验证[^dp-stdin] | 已验证[^dp-where] | 未验证[^dp-redirect] | 已验证[^dp-service] | 已验证[^dp-warn] | 未验证[^dp-user] | 未验证[^dp-clm] | 未验证[^dp-real] |

非 Windows 平台：不支持（`isAvailable()` 为 false，`--save` 报 `DPAPI_UNAVAILABLE`，只有注入的单元测试覆盖这条拒绝）。

[^dp-save]: 真实 CLI 子进程：key 经标准输入一次、经 `ROOM_PI_API_KEY` 一次；输出只有一行 `SAVED <路径> length=<n> sha256=<前 8 位>`，与测试自己算的 sha256 前缀一致；文件用 `unprotect` 解回来正好是那把 key；ASCII、中文、200 字符三种 key 都往返成功，密文里找不到明文（UTF-8、base64、UTF-16LE 三种形式都查了）。`--save <值>` 被拒绝（退出 9）且不回显，空标准输入被拒绝。
[^dp-status]: 真实 CLI 子进程：保存前 `saved=no`，保存后 `saved=yes decrypts=yes` 并给出长度与 sha256 前缀，文件被改动后 `decrypts=no code=DPAPI_FAILED`。
[^dp-forget]: 真实 CLI 子进程：`FORGOTTEN <路径>` 后文件不在；再来一次 `NOT_SAVED`。
[^dp-tamper]: 改动密文的三个不同字节、截短、非 DPAPI 字节串，`unprotect` 都报 `DPAPI_FAILED`，错误文本里没有 key。
[^dp-stdin]: 记录真实 `spawnClean` 调用：两次 PowerShell 的命令行与环境里都没有 key（环境只有白名单），key 只以 base64 出现在标准输入里。另读事件日志 Microsoft-Windows-PowerShell/Operational：调用之后的 4104 事件里有 DPAPI 脚本（说明这台机器在记脚本块），但没有一条含 key 或它的 base64。对照：写代码时的探针把 key 写进 `-Command -` 的脚本正文，那一条被记了下来。
[^dp-where]: 文件落在 `<ROOM_DEV_HOME>\secrets\pi-key.dpapi`，`virtualizationRedirect()` 为 null；整个过程后 `ROOM_DEV_HOME` 下只剩 `secrets\write-log.jsonl`，其中每条写入的 who 都是 `admin:pi-key`、路径都在 `secrets\` 之内；任何文件里都没有 key。只在 `%USERPROFILE%` 下跑过，没有在 AppData 或包上下文里的路径上跑。
[^dp-redirect]: 只用注入的 `redirect` 函数测过（写前发现 → 什么也不写；写后发现 → 删掉刚写的文件；链接 → 给出真实路径），中文文案也只在那里检查过。没有在真实的 MSIX 重定向位置上跑过。
[^dp-service]: 进程内真实房间服务（discussion 预设，一个托管讨论档席位，假 provider），进程里没有 `ROOM_PI_API_KEY`：`ROOM_DEV_HOME` 指向测试目录时按默认路径找到 CLI 存的文件，托管席位拿到的正是那把 key，回合被接受，`state.json` 记 `piKeySource: saved`；房间目录与服务日志里都没有 key。给了 key（`piApiKey`）、或房间没有托管席位时不读文件，只用注入的解密函数测过。
[^dp-warn]: 同上的服务，文件被改动：日志里一条含「警告」与 `DPAPI_FAILED` 的中文行，托管席位 `seat_failed`、detail 含 `PI_NO_KEY`，服务继续；之后经 admin 交的 key 照样生效（这一步用注入的解密函数测）。
[^dp-user]: 设计上应解不开（DPAPI CurrentUser）；没有在别的用户或别的机器上试过。
[^dp-clm]: AppLocker / WDAC 让 PowerShell 进入受限语言模式时应报 `DPAPI_UNAVAILABLE`；只用注入的假输出测过。
[^dp-real]: 本机没有装 `@earendil-works/pi-coding-agent`，没有真实 Pi 回合。

## 桌面程序 圆桌.exe（2026-10-04）

`node dist/build-app.mjs` 用本机缓存的 Electron 43.6.0（自带 Node 24.20）打出 `dist\out\圆桌\圆桌.exe`，大厅和房间界面都在程序自己的窗口里。

| 项 | 结论 | 依据 |
|---|---|---|
| 启动、主窗口加载大厅、建测试房间、在程序内开房间窗口、正常退出时删服务锁且不留进程 | 已验证（自检模式） | 程序的 `--smoke` / `--smoke-room` 实跑，结果文件 `problems: []`、`serviceLockRemoved: true` |
| 只开一份、拒绝相对路径的 `ROOM_DEV_HOME`、房间窗口标题带房间编号 | 已验证（自检与单元测试） | `test/app.test.mjs` 35/35 与实跑 |
| 浏览…（系统文件夹对话框）、右键菜单、外链确认、屏蔽刷新、复制按钮、导出证据的保存对话框 | 未验证 | 只有静态与替身测试，没有人在窗口里实际点过 |
| PATH 上没有 `node` 的机器上，席位改用程序自带运行时（`room.cmd` + `ELECTRON_RUN_AS_NODE`） | 未验证 | 两种分支有单元测试，没有在无 Node 的机器上跑过 |
| Chromium 是否只写 `app-data` | 未验证 | 只粗查过 AppData 顶层，没有 ProcMon 测量 |

## 宿主内嵌（2026-10-04）

room-dev 可以被别的程序在进程内嵌入（`lib/api.mjs`，见 `docs/INTERFACES.md` §15）。嵌入它的宿主能带来两种席位：

| 席位 | 登记方式 | 真实宿主应用里 | 已测到的范围 |
|---|---|---|---|
| 宿主自己的对话会话 | `agent pi-user`，`wait turn_over`，宿主注入的唤醒种类（`wake-kind`，例如 `pi-session`） | 未验证 | 本仓库的进程内测试（`test/api.test.mjs`、`test/service.test.mjs`）：注入的唤醒函数每回合至多调用一次、文案固定且不含房间内容。一个私有宿主在纯 Node 下跑过它自己的集成链路，记录不在本仓库 |
| 宿主的执行通道 | `hosted lane:<通道>:discussion`，宿主注入通道工厂（`hostedProviders`） | 未验证 | 进程内测试用假的通道工厂；失败分类映射有单元测试。真实通道没有调用过 |

两行都不是「已验证」：本表的已验证要求在真实 agent 上跑过，而这里只有纯 Node 下的测试，没有真实宿主应用，也没有真实模型参与。审计列对通道席位恒为「未审计」：通道自己的工具不受 room-dev 权限档位约束，所以首版只开讨论档。

## 列的含义

| 列 | 含义 |
|---|---|
| 形态 | 嵌入式（用户的进程）或托管（房间的进程） |
| 传输 | 不对称文件式（agent 只读房间目录，提交写自己的发件箱）；loopback HTTP 可选 |
| 等待方式 | 后台等待 / 交卷即退 / 需用户唤醒 / 轮询（脚本席位） |
| 唤醒推送与 W | 房间是否向它推送固定唤醒文案；每回合上限 W（默认 1） |
| 完成信号 | 只认 `submit` 被接受（ACCEPTED） |
| 取消 | 作废 = 房间作废 attempt，席位下一条命令得到 NOTICE；真取消 = 房间能停掉它正在跑的回合 |
| 只读审计源与可核项 | 房间按登记 id 只读哪份原生日志，能核出什么（包是否到达、审查回合里有没有观测到写操作） |
| 权限提示 | 每次 `room` 调用是否弹宿主权限提示、「不再询问」持久化到哪个文件 |
| 声明的权限档位 | 建席时填的 discussion / readonly / workspace / full（声明值，不是观测值） |
| usage 上报 | 房间能否得到该席位的 token 用量 |
| 结构化提交通道 | `room` 子命令（命令形）与正文 ASCII 标记（文本形）两条路 |
| 宿主工具输出上限 | 宿主对工具输出的截断行为，以及 agent 是否按 JOIN.md 自己去读包文件 |
| Windows 已验证组合 | 在 Windows 11 上实际跑过的宿主版本、沙箱、shell 组合 |

## 脚注（证据）

[^cx-form]: 嵌入式。P−1 报告「做了什么」第 3 条：A 是经 `codex exec` 新开的 Codex 线程，房间服务没有起它（是探针会话起的）。它与房间同在一个包上下文（P−1 发现 0），这是本行全部「已验证」的前提。
[^dt-all]: Desktop 窗口里的交互线程在 P−1 里没有入过席；`codex exec` 一行的证据不外推到这里。设计值与第一行相同（文件式、交卷即退、同一审计源）。P−1「要本人跑的」第 1 条就是这一行。
[^cx-transport]: 不对称文件式。P−1 发现 1：status → wait → 读包 → submit（ACCEPTED）在 workspace-write 加空目录 cwd 下走通；发现 5：`apply_patch` 往 `.room-outbox\` 下新建文件失败，改为把发言文件放工作目录根后由 `room submit` 复制进发件箱，原因待查。loopback 未试。房间目录当时在 `%LOCALAPPDATA%` 的重定向位置（发现 0）；默认位置改到 `%USERPROFILE%\room-dev\rooms` 后没有重跑。
[^cx-wait]: 交卷即退。P−1 发现 1：三个回合都在 submit 后再 `wait` 得到 TURN_OVER 并结束回合；发现 4：TURN_OVER 原退出码 4 被宿主标成失败工具调用，已改为退出 0。回合 2 的「唤醒」是用 `codex exec resume` 模拟的，不是推送。
[^cx-wake]: 设计值：`codex queue --thread <专用线程>`，W=1。P−1 发现 6：对一个已结束的 exec 线程 `codex queue` 返回成功但线程不会因此开始回合，所以 `wake_pushed` 只证明命令成功；对 Desktop 里空闲线程的效果要用户本人跑（报告「要本人跑的」第 1 条）。
[^cx-done]: P−1 发现 1：三个回合 submit 均返回 ACCEPTED，房间记 submission_accepted。
[^cx-cancel]: 设计值：只能作废（席位下一条命令得到 NOTICE 与新 attempt）；真取消不支持。作废路径只在脚本席位端到端里测过（见脚本席位行），没有对真实 Codex 线程作废过。
[^cx-audit]: 审计源 `$CODEX_HOME/sessions/.../rollout-<时间>-<threadId>.jsonl`。P−1 实测数字表：房间 p1（顺序 A,B,A）三个包全部 present_in_native，其中 A 的两个在 Codex rollout 里找到，B 的一个在替身会话的 Claude transcript 里找到；发现 10：审计器能看到它读了什么、跑了什么。写操作分类（tainted）是 P1 功能，未验证；发现 8 记录了审方在他人目录执行命令，分类表要记 unknown。
[^cx-perm]: P−1 在 `codex exec` 非交互模式下跑，没有权限提示可观测；Desktop 交互线程里每次 `room` 调用弹不弹、「不再询问」落在哪，未验证。
[^cx-tier]: 设计值：审方 readonly（靠 workspace-write 加空目录 cwd）。P−1 只验证了它写不了他人目录（发现 8），声明档位字段本身在 P−1 的 room.json 里尚不存在。
[^cx-usage]: 设计值：嵌入式席位不上报，显示未知。P−1 的 token 数字来自 `codex exec --json` 的输出，不是房间采集的。
[^cx-structured]: 设计值：命令形与文本标记形都支持。P−1 的 A 在正文里写了 verdict 字样，但 P−1 没有结构化提交解析器，没有验证任何一条通道。
[^cx-output]: P−1 发现 2：51,130 字节的包第一次整读被宿主截断，agent 自己判断未读完并分四段读完，答对了埋在中段的暗号。截断的确切阈值没有测量；验证的是「头不内联正文、agent 自己读文件」这一设计。
[^cx-win]: P−1 发现 12 与「做了什么」第 3 条：Windows 11，`codex exec`，workspace-write，PowerShell 执行命令、Get-Content 读文件，中文路径与 UTF-8 内容一轮无误。只跑了一轮；发现 11 记录了 `codex exec` 的参数顺序限制。
[^cli-form]: 方案 §3.3 把 Windows CLI（unified_exec 默认关闭、旧 shell 工具、timeout_ms 默认 10 秒）与 Desktop code-mode 分成两行。P−1 用的 `codex exec` 在 Windows 上走的是哪一种 exec 工具，报告没有判定，所以这一行不借用第一行的证据。
[^cli-all]: 设计值与第一行相同（文件式、交卷即退、同一审计源、每次 `room` 可能审批）。方案排在 P2 核。
[^cc-form]: 嵌入式。P−1 发现 7：桌面 app 捆绑的 `claude.exe -p` 单独起时未登录，无头跑不了；本轮 B 由探针会话替身，不是「新会话按 JOIN.md 入席」的证据。
[^cc-transport]: 设计值：不对称文件式（loopback 可选）。替身用真实的 Bash/Read/Write 工具跑了 wait/submit，但替身不是独立会话，不计。
[^cc-wait]: 设计值：Bash `run_in_background`（默认 30 分钟，最长 2 小时）后台等待，零模型调用，结束时唤醒会话；唤醒失败的兜底是前台 `wait --timeout 110`。是否真的唤醒会话、30 分钟耐力是否零模型调用，要用户本人跑（报告「要本人跑的」第 2、3 条）。
[^cc-wake]: 设计上房间不向 Claude Code 推送；它靠自己的后台命令结束被唤醒。
[^cc-done]: 设计值同 Codex。替身 submit 得到 ACCEPTED，不计。
[^cc-cancel]: 设计值：只能作废；真取消不支持。
[^cc-audit]: 审计源 `$CLAUDE_CONFIG_DIR/projects/<编码后的 cwd>/<session>.jsonl` 及旁边的 `tool-results/`、`subagents/`。P−1 发现 9：审计器已改为会话级定位（只打开登记后新建或修改的 transcript，找到首个 packetId 的那份登记为会话），在替身的 transcript 里找到了包、只打开 27 个本会话文件。替身不算新会话，所以记未验证；但审计器对 Claude transcript 形状的读取逻辑已经在真实文件上跑过。
[^cc-perm]: 设计值：默认模式下非只读 Bash 要审批；「不再询问」写项目下 `.claude/settings.local.json`；JOIN.md 只推荐一条规则 `Bash(node <app>/room.mjs:*)`。弹几次、落在哪，要用户本人跑。
[^cc-tier]: 设计值：执行者 workspace（限定工作目录）。
[^cc-usage]: 设计值：不上报，显示未知。
[^cc-structured]: 设计值：命令形与文本标记形都支持。P−1 无解析器。
[^cc-output]: 作者复核：约 3 万字符以上的工具输出外存到 `tool-results/`，上下文里只剩预览。这是方案「头不超过 8 KB、正文走文件」的依据，但在新会话里未验证。
[^cc-win]: 没有任何一轮由独立的 Claude Code 会话完成。
[^other]: 方案 §3.4：OpenCode、Gemini CLI、Kimi、DSH、用户自己的 Pi 的传输、等待方式、审计源、权限提示全部排在 P2a 核。没有任何实测。
[^dsh-audit]: 同上；另外 DSH 默认上传会话日志，JOIN.md 要提示，这影响「只读审计」的范围声明。
[^pi-form]: 托管：房间自己的进程（`lib/hosted/pi.mjs`，`@earendil-works/pi-coding-agent` 按需安装）。P1b 做讨论档，P2b 做执行档与审方档。没有任何实测。
[^pi-transport]: 托管席位不经文件式传输，包直接作为 prompt 文本进 worker。
[^pi-wait]: 托管席位由房间直接调用 `prompt()`，没有等待问题；等待成本为零。
[^pi-wake]: 托管席位不需要唤醒；房间直接驱动它。
[^pi-done]: `prompt()` 返回 `stopReason: end_turn` 并由房间代为提交。
[^pi-cancel]: 设计值：真取消（`cancel()`），cancel_unconfirmed 记为 canceled 加 unconfirmed 属性。
[^pi-audit]: 托管席位的工具调用由房间自己记录（`onEvent`），不需要只读外部日志。
[^pi-perm]: 讨论档 `noTools`、审方档只读工具集，没有权限提示。
[^pi-perm-e]: 执行档的高危工具调用（写 cwd 外、网络、删除）在工具层拦截后以 `permission_pending` 事件交 UI，由用户用 admin 令牌放行。
[^pi-tier-d]: discussion（真无工具）。
[^pi-tier-e]: 设计值：full 或 workspace。工具档位由房间在 worker 里设定，所以设计上不只是声明值；没有任何实测。
[^pi-tier-r]: 设计值：readonly（只给只读工具集）。设计上「强制审方只读」对它成立；没有任何实测。
[^pi-usage]: 托管席位上报 usage（`usage_reported` 事件，source=hosted）。
[^pi-structured]: 命令形对托管席位由房间内部完成；文本标记形同嵌入式席位。
[^pi-output]: 房间持有 worker，不存在宿主工具输出上限。
[^pi-win]: 需要 Node ≥ 22.19；首发只验证 Windows 11 x64。未跑。
[^pi-win-e]: 执行档在 Windows 上额外需要 Git for Windows 或 powershell 工具。未跑。
[^ss-form]: 脚本席位是测试进程，既不是用户的 agent 也不是托管 Pi；它直接调用席位命令。P−1 `test/e2e.mjs` 47/47 通过（报告「做了什么」第 2 条）。
[^ss-transport]: 不对称文件式。P−1 端到端：顺序、迟交、坏令牌、伪造横幅转义、写日志全部在界内。
[^ss-wait]: 轮询 `wait --timeout`。P−1 端到端覆盖。
[^ss-wake]: 脚本席位由测试驱动，不需要唤醒。
[^ss-done]: P−1 端到端：submit 被接受、迟交被拒。
[^ss-cancel]: 作废：P−1 端到端覆盖「取消后 NOTICE 与新 attempt」「墙钟过期」「服务崩溃重启后旧 attempt 仍可交卷」。真取消不适用。
[^ss-audit]: 脚本席位没有原生日志。
[^ss-perm]: 没有宿主，没有权限提示。
[^ss-tier]: 没有真实权限可声明。
[^ss-usage]: 没有模型调用。
[^ss-structured]: 结构化提交解析器是 P1 功能；P−1 的脚本席位只提交纯文本发言。
[^ss-win]: P−1 端到端在作者的 Windows 11 机器上跑通 47/47；纯逻辑模块在 Linux 上跑的 CI 尚未在 P−1 里跑过。脚本席位与房间服务是同一台机器上的普通进程，P−1 时房间在 `%LOCALAPPDATA%`（发现 0），双方同在一个包上下文，所以这一格不说明从别的包上下文能否访问房间。
