# Walkthrough Demos (v0.2.0)

Two end-to-end walkthroughs illustrating core `AgentRoundtable` (`room-dev`) governance mechanics:
1. **Implement -> Review with Mid-Review Artifact Drift (`stale`) & Snapshot Disclosure**
2. **Report Meeting (`--preset report` with `--baseline whole`)**

> **Path reminder**: Rooms default to `~/room-dev/rooms/<id>` (override with `ROOM_DEV_HOME`). On Windows, never place rooms or seat working directories under `%LOCALAPPDATA%` / `%APPDATA%` (MSIX virtualization redirect). Commands below use `node room.mjs`; inside each seat, `JOIN.md` provides the exact absolute `room` command (`room.cmd` on Windows, `room.sh` on macOS/Linux, or `node <path>/room.mjs`).

---

## Demo 1: Implement -> Review & Stale-Verdict Detection

**Seats**:
- **Seat A** (`lead` / reviewer): Dedicated empty workspace `~/room-demo/reviewer-A` so a `workspace-write` sandbox keeps A unable to edit the project while still writing its own `.room-outbox/A/`.
- **Seat B** (`executor`): Project directory `~/room-demo/project` containing a small Node module (`package.json`, `parser.mjs`).

### 1. Create the Room and Seats

```bash
mkdir -p ~/room-demo/reviewer-A ~/room-demo/project

node room.mjs admin init --id demo1 --preset implement-review --lang en --wall 2700
node room.mjs admin add-seat --id demo1 --seat A --role lead --agent codex-desktop --wait turn_over \
  --cwd ~/room-demo/reviewer-A --audit codex --wake-thread room-demo1-A
node room.mjs admin add-seat --id demo1 --seat B --role executor --agent claude-code --wait background \
  --cwd ~/room-demo/project --audit claude
```

### 2. Start the Daemon (or Single-Room Service)

```bash
# Option A: Multi-room daemon + Lobby UI + SSE
node room.mjs daemon --open

# Option B: Single room + loopback Web UI + SSE
node room.mjs serve --dir ~/room-dev/rooms/demo1 --port 0
```

Open the printed `http://127.0.0.1:<port>/#<token>` URL in your browser to watch Group-Chat / Arena views and handle approvals from the sticky Approval Inbox.

### 3. Onboard Each Running Agent

Send one sentence to each already-running agent session (using expanded absolute paths):
- To Seat A: `Read <home>/room-dev/rooms/demo1/seats/A/JOIN.md and join the room following it.`
- To Seat B: `Read <home>/room-dev/rooms/demo1/seats/B/JOIN.md and join the room following it.`

### 4. Dispatch Task & Start Round

```bash
node room.mjs admin task  --id demo1 --text "Add a --strict flag to parser.mjs with unit tests in parser.test.mjs."
node room.mjs admin start --id demo1 --order A,B
```

### 5. Work Phase: Seat B Implements & Freezes Artifacts

Seat B wakes from `wait`, edits `parser.mjs` and `parser.test.mjs`, freezes its outputs, and submits:

```bash
room artifacts --seat <seatB> --attempt <b1> --declare parser.mjs parser.test.mjs
# -> FROZEN manifest=<sha1> files=2
room submit    --seat <seatB> --attempt <b1> --file speech-b1.md
# -> ACCEPTED
```

The room hashes both files read-only (never running `git` in Seat B's directory) and copies them into `snapshots/B/<sha1>/`.

### 6. Meet & Summary: Trigger `stale` Mid-Review + Snapshot Disclosure

1. Seat A pulls its review packet carrying `<sha1>`.
2. **Optional disclosure**: To inspect a diff without touching Seat B's directory, Seat A requests:
   ```bash
   room disclose --seat <seatA> --attempt <a1> --arg git --arg diff --reason "Inspect strict-mode diff"
   # -> REQUESTED id=<d1>
   ```
   Approve from the sticky Approval Inbox or CLI (`node room.mjs admin approve-disclose <d1> --id demo1`). The room executes `git diff` inside `snapshots/B/<sha1>/` without a shell and attaches the output as an `authority=none` block.
3. **Trigger `stale`**: While Seat A is still reviewing, manually edit one line of `~/room-demo/project/parser.mjs` outside the room.
4. Seat A submits a `pass` verdict against `<sha1>`:
   ```bash
   room verdict pass --seat <seatA> --attempt <a2> --artifact <sha1> --text "Strict mode tests look complete."
   room submit       --seat <seatA> --attempt <a2> --file summary-a2.md
   ```
5. The room recomputes hashes on Seat B's workspace, detects the edit to `parser.mjs`, emits `artifacts_recomputed {stale: true}` and `verdict_recorded {annotation: 'stale'}`, and excludes the verdict from the summary.
6. Resolve either by starting a fresh round after Seat B re-declares artifacts, or explicitly accepting the inspected diff:
   ```bash
   node room.mjs admin accept-stale <sha1> --id demo1
   ```

### 7. Close & Inspect Audit Evidence

```bash
node room.mjs admin close --id demo1
node room.mjs admin show  --id demo1
node room.mjs audit --seat ~/room-dev/rooms/demo1/seats/A --verbose
node contract/check-writes.mjs ~/room-dev/rooms/demo1
```

---

## Demo 2: Report Meeting (`--preset report`)

When multiple agents have already finished separate tasks, bring their existing sessions together without an Assign or Work phase:

```bash
node room.mjs admin init --id demo2 --preset report --lang en --wall 2700
node room.mjs admin add-seat --id demo2 --seat A --role lead --agent codex-desktop --wait turn_over \
  --cwd ~/room-demo/reviewer-A --reviews B,C --audit codex
node room.mjs admin add-seat --id demo2 --seat B --role participant --agent claude-code --wait background \
  --cwd ~/room-demo/parser --audit claude
node room.mjs admin add-seat --id demo2 --seat C --role participant --agent claude-code --wait background \
  --cwd ~/room-demo/cli --audit claude
```

1. Start `daemon` or `serve`, onboard A/B/C via `JOIN.md`, and run `admin task` + `admin start --id demo2 --order A,B,C,B,C`.
2. B and C declare their existing work with `--baseline whole`:
   ```bash
   room artifacts --seat <seatB> --declare src test --baseline whole
   room artifacts --seat <seatC> --declare cli.mjs cli.test.mjs --baseline whole
   ```
3. During Meet, seats can raise tracked items (`room point --seq N --text "..."`), submit hash-verified quotes (`room quote --seq N --text "..."`), or pass (`room pass`). Peer-to-peer comments never grant binding verdicts.
4. During Summary, Seat A marks every item (`room mark --item <id> --status accepted|rejected|deferred`) and issues per-artifact verdicts (`room verdict pass|reject --artifact <sha>`). If C revises files in Round 2 using `--baseline <shaC>`, publishing Summary v2 automatically injects a `superseded_notice` into every seat's next packet.
