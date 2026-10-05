# contract/ · 不干扰契约的量具

这些脚本是**用户自己的量具**，不是房间的一部分。它们回答方案 §1.6 的「测法」与 §13.1 第 40–47、45b 行：房间有没有越界写、有没有动 agent 的配置与记忆、有没有起停 agent 进程、有没有把继承的密钥带出去。

结论措辞一律是「在 <方法> 下未观测到 …」。PASS 的意思是「这个方法没看到」，**不是**「没有发生」。下面每节都写了该方法看不到什么。

## 怎么跑

一次全部（推荐）：

```bash
node <repo>/evidence/collect.mjs
```

它依次跑 `node --test --test-reporter=tap "test/**/*.test.mjs"`、`node test/e2e.mjs`，再起一间新的脚本房间跑下面的契约脚本，最后写 `evidence/REPORT.md`（检查 | 方案条目 | 结果 | 原始记录 的表，加上逐条命令、退出码与耗时）。选项：`--run-dir <dir>`、`--report <file>`、`--skip-tests`、`--skip-e2e`、`--no-baseline`。

单独跑：

```bash
node contract/control-run.mjs [<新房间目录>] [--run-dir <dir>] [--dir <path>]... [--extra-dir <path>]... [--no-baseline]
node contract/check-writes.mjs <roomDir> [--outbox <dir>]...
node contract/env.mjs [--run-dir <dir>] [--room <roomDir> --seat <seatDir>]
node contract/pids.mjs snapshot [--out <file>] | compare <before.json> <after.json> [--service-pid N] [--room <roomDir>] [--room-pids 1,2] | services [--room <roomDir>]
node contract/memory-diff.mjs <target>... --save <file> | [<target>...] --against <file> | --before <a.json> --after <b.json>
```

共同约定：

- 输出行以 `PASS` / `FAIL` / `SKIP` / `INFO` / `RAW` 开头；`RAW` 后面是原始记录的绝对路径；缩进两格的行是上一条的明细。检查名是冒号前的部分，例如 `write-log(seat A)`。
- 退出码：没有 FAIL 行为 0，否则 1；用法错误与脚本异常也是 1（并打印一条 `FAIL script:` 行）。SKIP 不算失败。
- 临时目录只在 `testRunsRoot()`（`%USERPROFILE%\room-dev\test-runs\<前缀>-<随机>`，可用 `ROOM_DEV_HOME` 改根），从不用 `%LOCALAPPDATA%`：从 MSIX 打包应用（如 Claude 桌面应用）里起的进程写 AppData 会被重定向，别的进程看不到（见 `docs/INTERFACES.md` §1）。
- 脚本自己的写入也经 `lib/guard.mjs`，限定在运行目录内，记在 `<runDir>/contract-write-log.jsonl`（`who=contract`）；子进程一律经 `lib/spawn.mjs`（不经 shell、输出有上限、有超时）。
- 只通过 CLI 驱动房间（`node room.mjs admin|serve|wait|submit|status ...`），只读契约规定的存储（`room.json`、`events.jsonl` 的事件类型、`write-log.jsonl`、`service.lock`），所以 `lib/service.mjs`、`lib/seat.mjs` 内部怎么改都不影响这些脚本；CLI 契约变了才需要改它们。
- 共用代码在 `contract/harness.mjs`。

## check-writes.mjs · 契约 1 与契约 4 的 write-log 部分（#40、#43）

**做什么**：读房间的 `write-log.jsonl` 和每个席位发件箱里的 `write-log.jsonl`（席位来自 `room.json`），逐条判断：

- `who=service` / `who=admin` 的路径必须在房间目录（含 `snapshots/`）之下，而且不能落在任何席位工作目录里（#43）；
- `who=seat:<id>` 的路径必须在该席位自己的发件箱之下，而且只能出现在该发件箱自己的日志里（席位行出现在房间日志里、或 A 的行出现在 B 的日志里，都算违规）；
- 不认识的作者、坏行都算违规，不跳过；房间日志为空算 FAIL（「什么也没看到」不是通过）；某席位从没运行过 `room` 命令则该席位 SKIP。
- 另查一次房间目录本身有没有被虚拟化重定向（`location(room)`）。

路径比对前先规范化：对最近的已存在祖先调用 `realPathNative()`，再接上不存在的尾巴，所以联接点、符号链接、8.3 短名不会让界内写看起来越界，也不会让越界写看起来在界内；Windows 上不分大小写。

**不证明什么**：write-log 是房间**自报**的——`lib/guard.mjs` 每写一次记一行。绕过 guard 的写（直接调用 `fs`、子进程自己写的文件、被删掉的日志行）根本进不了日志，这个脚本看不到。独立的检查是进程级文件审计（ProcMon / ETW），方案把它排在 P3 必过、P0 抽查。它也不证明「房间对席位工作目录没有打开写句柄」或「没对真实目录调用 git」，那两件同样归 P3 ProcMon。

## control-run.mjs · 对照跑（#40b、#45b，#41 与 #43 的一部分）

**做什么**：不开任何 agent，在新目录里建一间房（`admin init`、两个 `add-seat`），把服务作为子进程起来（`room.mjs serve`），用脚本席位经 CLI 跑完一整场 A,B,A（A 开题、B 干活、A 审查、`admin close`）。在场次前、场次后、以及**再等同样时长的基线窗口**之后，对下列目标做条目级快照（相对路径 + 类型 + 大小 + 内容 sha256，**不含 mtime**），按组判定：

| 组 | 目标（不存在的记为 absent，出现即差异） |
|---|---|
| config | `~/.claude/settings.json`、`settings.local.json`、`.claude.json`，`~/.claude.json`（未设 `CLAUDE_CONFIG_DIR` 时），`$CODEX_HOME/config.toml`、`rules/` |
| instructions | `~/.claude/CLAUDE.md`、`agents/`、`commands/`、`skills/`，`$CODEX_HOME/AGENTS.md`、`AGENTS.override.md`、`agents/`、`prompts/`、`skills/` |
| hooks | `~/.claude/hooks/`，`$CODEX_HOME/hooks.json`、`hooks/`（Claude Code 的 hooks 写在 settings.json 里，归 config 组一起比） |
| memory | `~/.claude/memory/`、`~/.claude/projects/*/memory/`（开跑前展开一次），`$CODEX_HOME/memories/`、`memories_1.sqlite` |

`--dir` 换掉整张表，`--extra-dir` 往上加（比如某个真实项目的 `.claude/` 或 `AGENTS.md`）。

基线窗口：方案要求「会自己变的条目」白名单从同时长、不开房间的基线跑里求出，不手写。所以场次后再等同样时长、拍第三张快照，基线窗口里自己变了的条目被排除并逐条列出（INFO 行），其余差异才判 FAIL。

同一次运行还做：

- 两个席位工作目录的递归列举：除了 `.room-outbox/` 和脚本 agent 自己经 guard 写的文件（B 的 `hello.txt`），不应有别的条目（`control-run(workdir X)`，#43 的列举部分）；
- 进程比对（调用 `pids.mjs` 的函数，见下节），房间进程集合 = 服务 pid + 每个 CLI 子进程的 pid。

原始记录都在运行目录：`snapshot-before|after|baseline.json`、`pids-before|after|baseline.json`、`control-run-commands.log`（每条命令与输出）、`control-run-service.log`、`control-run-admin-log.txt`（`admin log` 的输出）、`control-run.json`（汇总，含全部差异与排除项）。

**会话存储为什么不比指纹**：`~/.claude/projects/*/*.jsonl`、`$CODEX_HOME/sessions/`、Codex 的 sqlite 状态库（`state_*.sqlite`、`logs_*.sqlite` 等）在对照跑期间会被本机其他线程持续追加——包括正在跑这个脚本的那个会话自己。对它们做条目差异，量到的是别人的活动，不是房间的；用基线窗口排除也不行，因为两个窗口里变的是不同的行。方案把这块交给 write-log（房间根本没有指向那些路径的写）和审计器的「打开文件集合 ⊆ 登记集合」（#44）。`projects/*/memory/` 是记忆不是会话，所以照比。

**不证明什么**：

- 只覆盖这一场「不开 agent、脚本席位」的对照跑；真实 agent 入席时的同类比对是 §12.3 的真实层，由维护者在本机另跑。
- 只覆盖表里的目标。`~/.codex/plugins/`、Claude 的 plugins 等没有默认列入（体量大、与契约条目不对应），需要时用 `--extra-dir`。
- 读不开的文件（被独占锁住）只比大小与类型，sha256 记为空。
- 条目快照是「前后各拍一张」：场次中途改了又改回去的内容看不到；工作目录列举也看不到「写了又删」。这些归 P3 的 ProcMon。
- 基线窗口排除的条目在本次运行里不作判定；如果房间恰好也改了同一条，就被掩盖了——所以排除项逐条列出，供人工判读。

## pids.mjs · 契约 2（#41）

**做什么**：会前会后对名字匹配 `codex|claude|node` 的进程拍快照（Windows 用 `Get-CimInstance Win32_Process`，同时得到完整父进程表；失败时退回 `tasklist /FO CSV`；其他平台 `ps`），比较 codex|claude 的 PID 集合：

- 集合不变 → PASS；
- 有新增：用**同一时刻**的父进程表沿父链往上找，若链上有房间进程（服务或 `room` CLI 子进程）→ FAIL；找不到该进程（无法归因）→ FAIL；链上都不是房间进程 → PASS，并写明「新增来自本机其他进程」与名单；
- 有消失 → FAIL（本方法无法归因终止者），附基线窗口里的 agent 进程起落次数作本机噪声参考，需人工判读；
- close 后房间服务 pid 已退出，命令行里找不到为该房间运行的 `room.mjs serve`，`service.lock` 已删除。

**不证明什么**：attach / 注入 / `OpenProcess` / 读写别的进程内存，以及「谁终止了消失的进程」，PID 集合与父进程表都看不到，方案留给 P3 的 ETW。在两张快照之间起来又退出的短命进程也看不到。node 进程只记录不判定（房间自己的子进程与本机其他会话混在一起）。

## env.mjs · 契约 3（#42）

**做什么**：给 6 个常见密钥变量名（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`CODEX_API_KEY`、`GITHUB_TOKEN`、`AWS_SECRET_ACCESS_KEY`、`ROOM_CANARY_SECRET`）各生成一个唯一的 canary 值，用这个被污染的环境跑房间自己的命令（`admin init`、`add-seat`、`serve --once`、席位 `status`、`wait`），然后：

1. `env(outputs)`：在房间目录、发件箱的全部文件（含 write-log 与 packets）和每个子进程的 stdout/stderr 里搜 canary **值**；
2. `env(seat-exit)`：用 `NODE_OPTIONS=--import=<探针>` 预载一个只打印**变量名**（不打印值）的探针，读席位进程启动时与退出时的环境。方案 §1.6 第 3 条要求 `room` 启动时清空 PATH、SystemRoot、TEMP 与房间自己变量之外的环境，所以退出时还带着 canary 变量名即 FAIL——即便席位命令不派生子进程、也没把它们写出去；
3. `env(spawnClean)`：从被污染的父进程经 `lib/spawn.mjs` 起一个探针子进程，断言它的环境只有白名单、显式传入的键，以及 Windows 上 libuv 自己补回的那组变量（`IMPLICIT_WIN32_VARS`，逐个列出）；
4. 源码观测：`lib/seat.mjs` 是否导入 `child_process` / `lib/spawn.mjs`（INFO）。

**不证明什么**：只搜种下的 canary 值，不在名单上的变量泄没泄看不到；不证明密钥没进过某个进程的内存；房间没起的进程不在范围内。被污染的环境是「pass-through 键 + canary」，不是某个真实 agent 的完整环境。

## memory-diff.mjs · 条目级快照与比对（#45b 的工具）

`control-run.mjs` 用它的函数；单独用时可以在真实会议前后各拍一张（`--save`），或拿现在和保存的比（`--against`），或比两张已存的（`--before/--after`）。条目 = 相对路径 + 类型 + 大小 + sha256，不含 mtime：别的工具常常只碰 mtime 不改内容，而契约关心的是内容。

**不证明什么**：同上——两张快照之间改了又改回的内容看不到；读不开的文件只比大小。

## 测试

`test/contract.test.mjs` 覆盖纯逻辑：快照差异、基线排除、路径包含（含同前缀兄弟目录、大小写、规范化）、write-log 检查器在合成日志上的每种违规（**含种下越界写必须被抓到的负对照**，以及 CLI 层面的负对照：种了越界写的合成房间必须退出 1）、PID 集合与父进程链判定（含「房间进程名下起了 agent」的负对照）、canary 搜索（种下的值必须被找到）、退出探针、报告渲染。
