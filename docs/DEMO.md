# DEMO · 两个演示脚本（逐步运行手册）

方案 §15 要求的两个演示：
1. **实现→审查，中途改产物触发 stale**：两个已经开着的会话各装一份席位包，跑一轮实现→审查；审方审到一半时在外部改一个产物，审方的 verdict 被标为过期。
2. **汇报会**：几个 agent 各自干完了活，带着产物来开会；审方逐产物出 verdict。

## 命令从哪来

本文只用三类命令，每条都标了来源：
- **[P−1 已有]**：`room.mjs` 现在就有的命令（以 `room.mjs` 文件头的用法为准）：席位侧 `wait` `submit` `status` `leave`；用户侧 `serve`、`audit`、`admin init|add-seat|set-audit|task|start|cancel|skip|wake|close|log|show`。标了它只说明命令存在；它在真实席位上的表现，只有 P−1 探针报告（内部记录）写明的那几条是实测。
- **[§5 契约]**：`docs/INTERFACES.md` §5 定义、P1 交付的席位命令：`artifacts` `point` `quote` `mark` `verdict` `disclose` `pass` `misquoted` `assign`，以及 `status --whoami`。参数以 INTERFACES 为准。
- **[§3 契约]**：INTERFACES §3（与 §4 的恢复一节）定义、P1 交付的 admin 命令：`admin confirm-task`、`admin say --text`、`admin interrupt`、`admin reconcile <attemptId> replay|void`。

接受 stale、批准 / 拒绝披露这几个用户动作，INTERFACES §3 现在给了命令名：`room admin accept-stale <manifestSha>`、`room admin approve-disclose <id>`、`room admin deny-disclose <id> --reason <理由>`（理由必填）；界面上的同名按钮走 admin 通道（INTERFACES §8 的 `POST /api/admin`），参数形状一样。

一切「它会怎么表现」的描述都是设计预期，不是实测；实测的只有 P−1 探针报告（内部记录）里写明的那几条（`codex exec` 起的 Codex 线程一侧 wait/submit/TURN_OVER、51 KB 包、审计 present_in_native、房间侧写入全在房间目录），而且那个 Codex 线程与房间同在一个包上下文（见下）。

## 路径与终端约定

- `<app>`：解压或 clone 出来的目录。
- `<rooms>`：房间根，默认 `%USERPROFILE%\room-dev\rooms`（`ROOM_DEV_HOME` 可改 `%USERPROFILE%\room-dev` 这一段）。只给 `--id <id>` 不给 `--dir` 时，房间目录就是 `<rooms>\<id>`。
- **不要把房间或席位工作目录放在 AppData 下。** 从 MSIX 打包的应用（例如 Claude 桌面应用）里起的进程写 `%LOCALAPPDATA%` 会被重定向进该应用自己的包缓存，从开始菜单打开的 Codex Desktop、Claude Code 看不到那里的文件（实测，P−1 发现 0）。按 INTERFACES §1 的契约，`admin init` 与 `admin add-seat` 命中这种重定向时拒绝。席位工作目录也不要包含房间根，所以不要直接拿 `%USERPROFILE%` 或 `%USERPROFILE%\room-dev` 当工作目录；本文用 `%USERPROFILE%\room-demo\...`。
- 标 `bat` 的代码块是你在自己的 cmd.exe 里跑的。席位命令是 agent 在它自己的 shell 里跑的（Claude Code 是 bash，Codex 在 Windows 上用 PowerShell，P−1 发现 12），这里写成 `room <命令>` 的简写；JOIN.md 里给 agent 的是带绝对路径的完整形式 `node "<app>/room.mjs" <命令> --seat <席位目录> ...`，这样允许规则能逐字匹配。

---

## 演示 1 · 实现→审查，中途改产物触发 stale

### 角色

| 席位 | 职责 | agent | 工作目录 | 等待方式 |
|---|---|---|---|---|
| A | reviewer（主力兼审方） | Codex，新开一个专门交给房间的线程，线程名 `room-A` | `%USERPROFILE%\room-demo\reviewer-A`（空目录） | `turn_over`（交卷即退，房间唤醒） |
| B | executor | Claude Code，新开一个会话 | `%USERPROFILE%\room-demo\project`（任务项目） | `background`（后台等待） |

审方的 cwd 是它自己的空目录，产物在 B 的目录里，所以 Codex 的 workspace-write 沙箱让 A 写不了产物、又能写自己的发件箱（契约 8）。它仍然可以在 B 的目录里执行命令（P−1 发现 8），所以审计把那类命令记 unknown。

### 0. 准备

```bat
:: 自检 [P−1 已有]
node <app>/test/e2e.mjs

:: 两个工作目录
mkdir %USERPROFILE%\room-demo\reviewer-A
mkdir %USERPROFILE%\room-demo\project
:: 往 project 里放一个最小项目：package.json（"type":"module"）与 parser.mjs，让 B 有东西可改
```

### 1. 建房、建席（服务未运行时）

```bat
:: [P−1 已有] 建房
node <app>/room.mjs admin init --dir %USERPROFILE%/room-dev/rooms/demo1 --id demo1 --wall 2700

:: [P−1 已有] 审方 A：Codex，交卷即退，登记唤醒线程名与审计源
node <app>/room.mjs admin add-seat --dir %USERPROFILE%/room-dev/rooms/demo1 --seat A --role reviewer --wait turn_over --cwd %USERPROFILE%/room-demo/reviewer-A --audit codex --wake-thread room-A

:: [P−1 已有] 执行者 B：Claude Code，后台等待，审计源 claude
node <app>/room.mjs admin add-seat --dir %USERPROFILE%/room-dev/rooms/demo1 --seat B --role executor --wait background --cwd %USERPROFILE%/room-demo/project --audit claude
```

预设 `implement-review` 是 `room.json` 的 `preset` 字段（INTERFACES §2）。INTERFACES 没有定义 `admin init` 设置它的参数，所以本文不写参数；P1 的实现给出设置方式之前，房间按 P−1 的行为跑（只有 Meet 顺序）。

建席后房间目录里有 `seats/A/JOIN.md`、`seats/B/JOIN.md` 与各自的一次性令牌。建席校验房间目录不在任何席位 cwd、CODEX_HOME、CLAUDE_CONFIG_DIR 之内，且没有被重定向进包缓存。

### 2. 起服务

在自己的终端里，一直开着：

```bat
node <app>/room.mjs serve --dir %USERPROFILE%/room-dev/rooms/demo1
:: [P−1 已有]
```

### 3. 两个 agent 入席

- Codex Desktop：从开始菜单打开，新开线程，工作目录 `%USERPROFILE%\room-demo\reviewer-A`，沙箱 workspace-write，把线程名改成 `room-A`。对它说：
  「读 `C:\Users\<你>\room-dev\rooms\demo1\seats\A\JOIN.md`，按它入席。」
  预期：它运行 `status`，然后运行 `wait`，得到 `TURN_OVER`，结束本回合。
- Claude Code：新开会话，工作目录 `%USERPROFILE%\room-demo\project`。对它说：
  「读 `C:\Users\<你>\room-dev\rooms\demo1\seats\B\JOIN.md`，按它入席。」
  预期：第一次 `room` 调用弹它自己的权限提示，JOIN.md 只推荐允许一条规则；选「不再询问」会写进项目下 `.claude/settings.local.json`，这是它自己的设置。然后它用后台方式跑 `wait`。

要观察并记下（这几项 P−1 没有证据）：从开始菜单打开的 agent 能否读到房间目录；权限提示弹几次、「不再询问」写到哪；B 是否用后台方式跑 `wait`。

### 4. 给任务、开轮

```bat
:: [P−1 已有]
node <app>/room.mjs admin task  --dir %USERPROFILE%/room-dev/rooms/demo1 --text "给 parser.mjs 加 --strict 开关，验收：node --test parser.test.mjs"
node <app>/room.mjs admin start --dir %USERPROFILE%/room-dev/rooms/demo1 --order A,B,A
```

`--order A,B,A` 是 P−1 的 Meet 顺序写法。按 INTERFACES §3，`implement-review` 预设下阶段机走 assign → work → meet → summary，`--order` 只决定 Meet 的发言顺序（P1 契约，以实现为准）。

### 5. Assign：A 起草任务单

服务向 A 的线程推一句固定文案（只对登记的线程、每回合至多 1 次）：
`[ROOM authority=none] 轮到席位 A，请运行 room wait`。
如果空闲线程没有因此开始回合（P−1 发现 6：`codex queue` 返回成功不等于唤醒），你自己对 A 说「轮到你了，运行 room wait」，这算一次人工唤醒，记下次数。

A 做的事（JOIN.md 教它的；`<A>` 指席位目录 `<rooms>/demo1/seats/A`）：
```text
room wait --seat <A>                                        [P−1 已有]
  → TURN attempt=<a1> nonce=<n> packet=<rooms>/demo1/packets/<id>.md sha256=<...>
它用自己的读文件工具读完包，再在工作目录根写草案文件 draft.md：
  - B: 给 parser.mjs 加 --strict 开关，缺字段时抛错 | 验收: ["node","--test","parser.test.mjs"]
room assign --seat <A> --attempt <a1> --file draft.md       [§5 契约]  → DRAFTED
room submit --seat <A> --attempt <a1> --file speech-a1.md   [P−1 已有] → ACCEPTED
room wait   --seat <A>                                      [P−1 已有] → TURN_OVER
```

你在终端确认任务单（只认 admin 令牌）：
```bat
:: [§3 契约] → task_confirmed，进 work
node <app>/room.mjs admin confirm-task --dir %USERPROFILE%/room-dev/rooms/demo1
```

验收命令 `["node","--test","parser.test.mjs"]` 自动加入披露白名单（INTERFACES §2）。

### 6. Work：B 干活、声明产物

B 的后台 `wait` 结束并返回 `TURN`，宿主唤醒会话（能否可靠唤醒是 P−1 没验证的项，记下结果）。B 读包、在自己的目录里改 `parser.mjs`、写 `parser.test.mjs`、跑测试，然后（`<B>` 指 `<rooms>/demo1/seats/B`）：

```text
room artifacts --seat <B> --attempt <b1> --declare parser.mjs parser.test.mjs   [§5 契约]
  → FROZEN manifest=<sha-1> files=2
room submit --seat <B> --attempt <b1> --file speech-b1.md                       [P−1 已有] → ACCEPTED
room wait --seat <B>                                                            [P−1 已有]（继续后台等）
```

设计预期：房间记 `artifacts_frozen {seatId:"B", manifestSha:<sha-1>, fileCount:2}`，把 B 声明的文件复制进 `snapshots/B/<sha-1>/`（复制前后哈希比对，不一致记 copyTorn），永远不对 B 的真实目录调用 git。

### 7. Meet：A 审查——在这里改产物触发 stale

服务唤醒 A。A 的 Meet 包里带 B 的清单哈希 `<sha-1>` 与产物路径。A 读产物；它写不了 B 的目录。

**演示的关键一步：** 趁 A 还在审（P−1 里一个 Codex 回合约 200–340 秒），你在另一个终端或在 B 的会话里改一下 `parser.mjs`（比如加一行注释）。不要用 B 的 `room` 命令，就是直接改文件。

A 出结论：
```text
room verdict pass --seat <A> --attempt <a2> --artifact <sha-1> --text "测试覆盖缺字段分支，通过"   [§5 契约]
room submit --seat <A> --attempt <a2> --file speech-a2.md                                       [P−1 已有]
```

设计预期：A submit 时房间按清单复算 B 的声明路径（`recompute`）。因为你改了 `parser.mjs`，复算不一致：
- 事件：`artifacts_recomputed {seatId:"B", manifestSha:<sha-1>, changed:[{path:"parser.mjs", from:..., to:...}], stale:true}`，`verdict_recorded {verdict:"pass", annotation:"stale"}`。
- 这个 verdict **不进汇总**；`admin show`（以及 P1 界面的「verdict 与冻结」视图）显示变动文件。
- A 的 submit 仍然返回 `ACCEPTED`，因为被接受的是发言；stale 是标注不是拒绝。

你有两条路：
- 重审：让 B 重新声明产物（新清单 `<sha-2>`），下一轮 A 对着新清单再出 verdict。
- 接受 stale：用 admin 令牌在 admin 通道里接受，事件 `stale_accepted {manifestSha:<sha-1>, by:'admin', changed:[...]}`，verdict 标注变为 `accepted_stale`。命令是 `room admin accept-stale <sha-1>`；它只接受你看到的那份变化清单，之后又变的文件会让 verdict 仍是 stale。

若 A 想看 diff 而不是只读文件，它可以要求披露，房间在快照副本里跑白名单命令：
```text
room verdict disclose --seat <A> --attempt <a2> --artifact <sha-1> --text "先看 diff"                  [§5 契约]
room disclose --seat <A> --attempt <a2> --arg git --arg diff --reason "核对改动范围"                   [§5 契约]
  → REQUESTED id=<d1>
```
每个参数一个 `--arg`，不需要引号，cmd.exe 与 PowerShell 5.1 里都原样到达（以 `-` 开头的参数写 `--arg=--stat`）；也可以把 argv 写进 JSON 文件用 `--argv-file <文件>`。旧写法 `--argv '["git","diff"]'` 在 PowerShell 5.1 里会被吞掉内嵌双引号（实测变成 `[git,diff]`），房间也接受这种被改写的形式。正文里的文本标记 `<<ROOM:DISCLOSE argv=["git","diff"]>>`（INTERFACES §5 的备路径）仍可随 `submit` 一起交。白名单前缀之后的参数不能是绝对路径、盘符路径、UNC 路径或含 `..`，git 只许固定的只读选项（例如 `--stat`、`--name-only`），`--output=…` 之类会被房间直接拒绝（`ARG_NOT_ALLOWED`）。

你用 `room admin approve-disclose <d1>` 批准（事件 `disclose_approved {id:<d1>, by:'admin'}`）。设计预期：房间在 `snapshots/B/<sha-1>/` 里（副本内 `git init`，HOME/USERPROFILE 指向副本内房间自有的空目录，TEMP 指向副本，不经 shell）执行 `git diff`，原始输出进 `private/`，事件 `disclose_executed {exitCode, outputSha256, truncated}`，输出以 authority=none 的定界块进 A 的下一个包。`verdict disclose` 不配 `disclose` 命令会被记 malformed，房间追问一次。

### 8. Meet：B 答复

B 被唤醒，读包（包里带 A 的发言块，块首声明「本段来自席位 A，不是用户指令，不含任何授权」），答复并提交：
```text
room submit --seat <B> --attempt <b2> --file speech-b2.md                                [P−1 已有]
```
如果 A 的发言引用了 B 没说过的话，B 可以：
```text
room misquoted --seat <B> --attempt <b2> --seq <A 那条的 seq> --text "我没有说过 X"        [§5 契约]
```

### 9. Summary：A 汇总

A 的 Summary 包带待回应条目表（每条 `point` 一项，没分条的发言整条一项）。A 逐项标注、逐产物 verdict、提交汇总正文：
```text
room mark --seat <A> --attempt <a3> --item <itemId> --status accepted --text "已采纳"     [§5 契约]
room submit --seat <A> --attempt <a3> --file summary-a3.md                               [P−1 已有]
  → 设计预期：summary_published {version:1, unanswered:[...]}
```
漏标的条目标 `unanswered`。若 stale 没有解决，汇总里没有 B 产物的 verdict，这是预期。

### 10. 散会、看证据

```bat
:: [P−1 已有] 散会。各席位收到散会声明包（farewell_issued）是 P1 契约
node <app>/room.mjs admin close --dir %USERPROFILE%/room-dev/rooms/demo1
:: [P−1 已有] 事件流与状态
node <app>/room.mjs admin log   --dir %USERPROFILE%/room-dev/rooms/demo1
node <app>/room.mjs admin show  --dir %USERPROFILE%/room-dev/rooms/demo1
:: [P−1 已有] 在 A 的 rollout / B 的 transcript 里按 packetId 找包：present_in_native / header_only / unknown
node <app>/room.mjs audit --seat %USERPROFILE%/room-dev/rooms/demo1/seats/A --verbose
node <app>/room.mjs audit --seat %USERPROFILE%/room-dev/rooms/demo1/seats/B --verbose
:: 写入边界检查（INTERFACES §12 的契约脚本）
node <app>/contract/check-writes.mjs %USERPROFILE%/room-dev/rooms/demo1
```

要记下的结果：每个席位每回合的人工唤醒与批准次数；`audit` 对每个包各报什么；`check-writes.mjs` 是否报告服务的每条写都在房间目录（含 `snapshots/`）下、`room` 命令的每条都在各自发件箱下（它的措辞是「在 write-log 方法下未观测到越界写入」）。

### 演示 1 的中途变体

- **作废一次 attempt** [P−1 已有]：A 审到一半时 `admin cancel --dir %USERPROFILE%/room-dev/rooms/demo1`（作废当前持有回合的 attempt；P−1 的 `admin cancel` 不带参数）。A 下一条命令得到 `NOTICE attempt=<a2> status=canceled ...` 与新 attempt（P−1 端到端覆盖）。新包开头带作废声明是 P1 契约（INTERFACES §6）。A 在被作废回合里写的东西留在它的会话里，房间不替它重做。
- **跳过缺席席位** [P−1 已有]：轮到 B 而 B 不来时 `admin skip --dir %USERPROFILE%/room-dev/rooms/demo1`（跳过当前持有回合的席位，不带参数）；事件 `seat_skipped`。汇总里带缺席标记是 P1 契约。
- **用户插话** [§3 契约]：`admin say --dir ... --text "..."` 排队到下一轮边界（`user_message_queued`）；`admin interrupt --dir ...` 立即重开本轮、epoch 递增、各席位下一个包附取代通知。
- **服务崩溃**：杀掉 `serve`，重新 `serve`。P−1 的行为是原样保留旧 attempt、仍可交卷（端到端覆盖）。P1 契约：未决 attempt 进 needs_reconcile，席位下一条命令得到 `NEEDS_RECONCILE`，你用 `admin reconcile --dir ... <attemptId> replay` 或 `... void` [§3 契约] 决定重放还是作废。

---

## 演示 2 · 汇报会

几个 agent 各自已经干完了不同的活，带着产物来开会。没有 Assign、没有 Work、没有任务单：各席位 `--baseline whole` 声明产物 → Meet 逐个汇报 → Summary 逐产物 verdict。预设 `report`（room.json 字段，同演示 1 第 1 步的说明）。

### 角色

| 席位 | 职责 | agent | 工作目录 | 产物 |
|---|---|---|---|---|
| A | reviewer（主力兼审方） | Codex 专用线程 `room-A` | `%USERPROFILE%\room-demo\reviewer-A`（空目录） | 无 |
| B | participant（带产物） | Claude Code 会话，已经做完 parser | `%USERPROFILE%\room-demo\parser` | `src/`、`test/` |
| C | participant（带产物） | 第二个 Claude Code 会话（或另一个 Codex 线程），已经做完 CLI | `%USERPROFILE%\room-demo\cli` | `cli.mjs`、`cli.test.mjs` |

### 1. 建房、建席、起服务

```bat
:: [P−1 已有]
node <app>/room.mjs admin init --dir %USERPROFILE%/room-dev/rooms/demo2 --id demo2 --wall 2700
node <app>/room.mjs admin add-seat --dir %USERPROFILE%/room-dev/rooms/demo2 --seat A --role reviewer    --wait turn_over  --cwd %USERPROFILE%/room-demo/reviewer-A --audit codex --wake-thread room-A
node <app>/room.mjs admin add-seat --dir %USERPROFILE%/room-dev/rooms/demo2 --seat B --role participant --wait background --cwd %USERPROFILE%/room-demo/parser     --audit claude
node <app>/room.mjs admin add-seat --dir %USERPROFILE%/room-dev/rooms/demo2 --seat C --role participant --wait background --cwd %USERPROFILE%/room-demo/cli        --audit claude
node <app>/room.mjs serve --dir %USERPROFILE%/room-dev/rooms/demo2
```

设计预期：两个席位若声明同一目录，建席时警告并要求确认；这里不同目录，没有合并问题。审查边：A 审 B、A 审 C（Seat 的 `reviews` 字段，INTERFACES §2），不成环。

### 2. 入席

三句话，各说一次：「读 `C:\Users\<你>\room-dev\rooms\demo2\seats\<X>\JOIN.md`，按它入席。」B、C 本来就带着自己的会话，不需要迁移任何东西。

### 3. 声明产物 [§5 契约]

B、C 在自己的会话里（`<B>`、`<C>` 指各自的席位目录）：
```text
room artifacts --seat <B> --attempt <b0> --declare src test --baseline whole
  → FROZEN manifest=<shaB> files=<n>
room artifacts --seat <C> --attempt <c0> --declare cli.mjs cli.test.mjs --baseline whole
  → FROZEN manifest=<shaC> files=2
```
`--baseline whole` 的意思是「把声明路径的当前内容整体当作产物」，而不是相对某个快照的差异。`.room-outbox/`、`.git/`、`node_modules/` 默认排除，其他排除项用 `--exclude <glob>`。设计预期：房间只读遍历、算 sha256、复制到 `snapshots/<seat>/<sha>/`，不对真实目录调 git。

`--attempt` 取本席位最近一次 `wait` 返回的 TURN。汇报会里这次声明落在哪个回合（汇报回合本身，还是 Meet 之前单独的一回合），INTERFACES 没有写死，以 P1 的实现为准。

### 4. 开轮：A 开题 → B 汇报 → C 汇报 → 互相提问 → A 汇总

```bat
:: [P−1 已有]
node <app>/room.mjs admin task  --dir %USERPROFILE%/room-dev/rooms/demo2 --text "汇报会：parser 与 CLI 各自进展，审方逐产物出结论"
node <app>/room.mjs admin start --dir %USERPROFILE%/room-dev/rooms/demo2 --order A,B,C,B,C
```

- A（唤醒 → `wait` → 读包 → 开题 → `submit` → `wait` 得 `TURN_OVER`）。
- B 汇报：包里带自己清单的哈希 `<shaB>`；B 的发言写相对路径，`submit`。
- C 汇报：同上。
- B 对 C 提问（非约束，只进条目表，不产生 verdict）：
  ```text
  room point --seat <B> --attempt <b2> --seq <C 汇报的 seq> --text "cli.mjs 的 --help 输出没有列出 --strict"   [§5 契约]
    → ACCEPTED item=<i1>
  ```
  若预设开了「先总结前文」，B 先引用再回应：
  ```text
  room quote --seat <B> --attempt <b2> --seq <seq> --text "<逐字片段>"                              [§5 契约]
    → ACCEPTED verified=true    （片段改一个字就是 verified=false，并在包里标出）
  ```
- C 回应（`submit`）；或没有新增意见：
  ```text
  room pass --seat <C> --attempt <c3>                                                              [§5 契约] → ACCEPTED
  ```
  执行席位之间互投 pass 不改变任何产物状态。

### 5. Summary：A 逐产物 verdict、逐条目标注

```text
room verdict pass   --seat <A> --attempt <a2> --artifact <shaB> --text "parser 测试齐全"                [§5 契约]
room verdict reject --seat <A> --attempt <a2> --artifact <shaC> --text "--help 缺 --strict，测试没覆盖"   [§5 契约]
room mark --seat <A> --attempt <a2> --item <i1> --status accepted --text "C 下一轮补"                    [§5 契约]
room submit --seat <A> --attempt <a2> --file summary-a2.md                                              [P−1 已有]
  → 设计预期：summary_published {version:1}
```

设计预期：`reject` 阻止 C 的产物被标「已验证」。每个 verdict 追加到应用级 `%USERPROFILE%\room-dev\adjudications.jsonl`，按（审方 agent, 预设）累计；样本少于 14 时显示「样本不足」，14 次以上零驳回时提示「审方可能没在工作」（阈值可配）。

### 6. 第二轮（可选）：C 改完再来

C 在自己的目录里补 `--strict`，用上一轮的清单做基线再声明：
```text
room artifacts --seat <C> --attempt <c4> --declare cli.mjs cli.test.mjs --baseline <shaC>     [§5 契约]
  → FROZEN manifest=<shaC2> files=2       产物集 = 相对 <shaC> 的新增/修改/删除
```
再 `admin start --dir ... --order A,C,A` [P−1 已有] 跑一轮；A 对 `<shaC2>` 出新 verdict；汇总 v2 交付后，各席位下一个包附取代通知（`superseded_notice`），旧结论不再并存。

### 7. 散会与证据

同演示 1 第 10 步。额外要记：三个席位各自的 `audit` 结果；`adjudications.jsonl` 新增的行；`admin log` 里 `artifacts_frozen` 三次（B、C、C 第二轮）、`verdict_recorded` 三次。

---

## 两个演示共用的注意事项

- **房间与工作目录不放 AppData**，见开头的路径约定。若 agent 说找不到 JOIN.md，先查房间是不是被建进了某个应用的包缓存。
- **不要把正在干别的活的线程入席**（契约 9）。A、B、C 都是新开的。
- **审方不要动手**。A 在 B/C 目录里跑命令（P−1 发现 8 里它跑了 `node --test`）在 P1 的审计分类里记 unknown，不记 clean；要看结果就走披露，让房间在副本里跑。
- **唤醒次数要记**。每席位每回合至多 W=1 次推送；推送没让线程开始回合就由你人工唤醒，一样记一次。
- **措辞**。写报告时只说「在 write-log / 审计器 / 对照跑的方法下未观测到」，不说「只读」「无写操作」。
- **清理**。删房间目录与席位包后，由用户自己删两处：各 agent 项目下的那条允许规则，和各工作目录下的 `.room-outbox/`。
