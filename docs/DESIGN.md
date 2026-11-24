# Architecture & Governance Design

This document explains *why* `AgentRoundtable` (`room-dev`) is shaped the way it is. For exact file layouts, event schemas, and CLI/HTTP contracts, see [`INTERFACES.md`](INTERFACES.md). For explicit capabilities, non-claims, and verification methods, see [`NON-INTERFERENCE.md`](NON-INTERFERENCE.md) and [`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md).

## 1. Design Principle: Governance Without Control

Most multi-agent orchestrators assume ownership of the agents: they spawn CLI subprocesses, rewrite MCP/hook configs, or control session sandboxes. `AgentRoundtable` takes the opposite constraint: **the room owns no user agent process, configuration, or working directory**.

Because the room cannot control embedded agents, every governance mechanism is designed to *detect and attest* rather than *prevent*:
- **Only turn order and attempt validity are enforced** (`NOT_YOUR_TURN`, `STALE_ATTEMPT`, `BAD_PROOF`).
- **Provenance** uses mandatory per-packet nonce delimiters and escaping instead of claiming prompt-injection immunity.
- **Artifact integrity** uses SHA-256 freezing and verdict-time staleness recomputation instead of file locks.
- **Supervision** separates declared permissions from read-only native-log observation and runs disclosure commands in isolated snapshot copies.
- **Accountability** derives pending item tables programmatically and injects superseded notices when summaries are revised.

## 2. System Topology

```text
User's Codex thread ────────┐                 ┌── Web UI (loopback HTTP + SSE) / room admin CLI
User's Claude Code session ─┤  Seat Kit:      │   or Multi-Room Daemon / Optional Desktop Shell
User's other coding agents ─┤  JOIN.md + room │
   read <roomDir>           ▼                 ▼
   write own outbox    <roomDir> (default ~/room-dev/rooms/<id>; never under AppData)
                       ├─ events.jsonl        Room Service (deterministic Node >= 22, no LLM calls)
                       ├─ state.json          ├─ State machine & pure reducer     lib/service.mjs, lib/reducer.mjs
                       ├─ packets/ manifests/ ├─ Four governance pillars          lib/packet.mjs, lib/workspace.mjs,
                       ├─ artifacts/          │                                   lib/supervision.mjs, lib/structured.mjs
                       ├─ snapshots/          ├─ Read-only native-log auditor     lib/audit.mjs
                       ├─ seats/<id>/         ├─ Guarded fs + write-log           lib/guard.mjs
                       └─ private/            ├─ Clean subprocesses & waker       lib/spawn.mjs, lib/codex.mjs
                                              └─ Optional hosted Pi worker        lib/hosted/pi.mjs
```

Because the room service is a plain deterministic process, crashing or restarting it never disrupts any running agent. Restarting replays `events.jsonl`, flags open attempts for human reconciliation (`needs_reconcile`), and resumes seamlessly.

## 3. Seat Kits & Asymmetric File Transport

### Seat Kits (`lib/join.mjs`)
Adding a seat generates `<roomDir>/seats/<seatId>/` containing `JOIN.md`, a one-time `token`, `seat.json`, `room.cmd` (Windows), and `room.sh` (POSIX). You onboard an already-running agent with one sentence pointing to `JOIN.md`.

`room.mjs` imports only `lib/seat.mjs` for seat subcommands (structurally unable to write `<roomDir>`) and strips inherited `process.env` down to a minimal allowlist before running. Output begins with an ASCII status word (`TURN`, `TURN_OVER`, `ACCEPTED`, `REJECTED`, etc.); expected no-work outcomes like `TURN_OVER` exit `0` so host agents do not misclassify them as failed tool calls. Packet headers stay under 8 KB while full packet text lives in `packets/<id>.md`, letting each agent read large packets with its own file reader without hitting tool-output truncation limits.

### Asymmetric File Transport (Default)
- **Room directory (`<roomDir>`)**: Read-only to agents.
- **Seat outbox (`<seat.cwd>/.room-outbox/<seatId>/`)**: Written exclusively by the seat's own `room` command (permitted under standard `workspace-write` sandboxes); read-only to the room service.
- **Optional loopback HTTP (`lib/http.mjs`)**: Available on `127.0.0.1` behind strict `Host` / `Origin` / `Sec-Fetch-Site` checks for agents with loopback access.

### The Windows MSIX / AppData Pitfall
Processes started inside MSIX-packaged Windows apps (such as Claude Desktop) have `%LOCALAPPDATA%` writes silently virtualized into `AppData\Local\Packages\<pkg>\LocalCache\Local\...`. Independent agents launched from the Start menu cannot see files written there. `AgentRoundtable` therefore defaults to `~/room-dev/rooms` (configurable via `ROOM_DEV_HOME`) and checks `virtualizationRedirect()` using `fs.realpathSync.native` on both `<roomDir>` and every seat `cwd`, refusing any redirected path or symlink before creating files.

### Wait Modes & Opt-In Waking
| Wait Mode | Mechanism | Cost Profile | Typical Agents |
|---|---|---|---|
| `background` | Agent runs `room wait` in a background shell; host wakes session on exit | Zero model calls while idle | Claude Code |
| `turn_over` | `wait` returns `TURN_OVER` immediately; agent ends turn; room pushes one fixed notice when its turn arrives | One wake continuation per turn (`W=1` default) | Codex Desktop / CLI |
| `manual` | User tells the agent when to run `room wait` | User-paced | Any agent |

Wake pushes are opt-in, scoped to a dedicated user-registered thread, gated by a read-only idle check, capped at `W` pushes per turn, carry a fixed content-free banner (`[ROOM authority=none] ...`), and record `command_ok` separately from audited `turn_observed`.

## 4. Room Model & Round Lifecycle

Rounds progress through `idle -> assign? -> work? -> meet -> summary -> done -> closed` according to `room.json`'s `preset`:
- `implement-review`: `Work -> Meet -> Summary` (optional `Assign`).
- `division`: `Assign` (lead drafts assignments + acceptance commands, user runs `admin confirm-task`) -> `Work` -> `Meet` -> `Summary`.
- `report`: Pre-existing work declared via `--baseline whole` -> `Meet -> Summary`.
- `discussion` / `cross-check`: `Meet -> Summary`.
- `simplified`: One user agent paired with an in-process hosted Pi seat.

**Role separation (`lib/supervision.mjs`)**: Leads and reviewers never take Work tasks; executors cannot be lead; review edges (`seat.reviews`) must be acyclic with exactly one authorized reviewer per artifact. Roles can only swap cleanly via a whole-room `admin reverse` (`direction_reversed` + epoch bump) when no Work or open attempt is active.

## 5. Four Always-On Governance Pillars

### 5.1 Mandatory Source Banners (`lib/packet.mjs`)
Peer speeches, materials, and disclosure outputs enter packets wrapped in per-packet random nonce delimiters:
`[ROOM:<nonce>:seat=B authority=none seq=17 hash=...] ... [/ROOM:<nonce>]`
with an explicit non-authority declaration repeated in the `wait` header. Any literal `[ROOM:` or `[/ROOM:` inside untrusted text is escaped to `[ROOM\:` and counted in the packet manifest.

### 5.2 Artifact Hash Freezing & Staleness Detection (`lib/workspace.mjs`)
Executors declare outputs with `room artifacts --declare <paths> [--baseline none|whole|<sha>]`. The room performs a read-only filesystem walk (excluding `.room-outbox/`, `.git`, `node_modules/`, symlinks, and outside paths), hashes every file with SHA-256, writes an immutable manifest, and copies files into `snapshots/<seatId>/<manifestSha>/` (detecting mid-copy drift as `copyTorn` / `snapshotStale`).

When a reviewer submits a verdict, the room recomputes hashes against the executor's live workspace. If any file changed, the verdict is annotated `stale`, excluded from the summary, and surfaced with the exact changed-file list. The user may either request a fresh review or explicitly run `admin accept-stale <manifestSha>`, which covers only the inspected diff — any later change marks the verdict `stale` again (`STALE_CHANGED_SINCE_ACCEPT`).

### 5.3 One-Directional Supervision, Fail-Closed Verdicts & Isolated Disclosure
- **Fail-closed parsing (`lib/structured.mjs`)**: Structured actions arrive via `room` subcommands or ASCII markers (`<<ROOM:VERDICT ...>>`). Before parsing markers from speech text, all nonce-delimited forwarded blocks and Markdown/HTML/fenced quotes are stripped so quoted text cannot forge a verdict. Conflicting, missing, or malformed markers trigger one follow-up; a second failure records `verdict: none` (never `pass`).
- **Authorized reviewer binding**: Only the artifact's designated reviewer emits a binding verdict; other seats' verdicts are moved to `excluded` (`not_reviewer`).
- **Snapshot-isolated disclosure (`lib/supervision.mjs`, `lib/workspace.mjs`)**: Reviewers cannot execute tests directly on the executor's repo cleanly without tainting review isolation. Instead, they submit `room disclose --arg ... --reason ...`. After explicit `admin approve-disclose`, the room executes the allowlisted command (`git diff`, `git status`, or a task-confirmed acceptance command) **without a shell**, inside the frozen snapshot copy with pinned `GIT_DIR`/`GIT_WORK_TREE`, empty sandbox `HOME`, disabled git hooks/fsmonitor/pagers, and strict argument validation (rejecting `..`, absolute/UNC paths, `.cmd`/`.bat` shims, and unsafe git flags). Note: acceptance commands can run arbitrary code and network is not firewalled in v0.2.
- **Rubber-stamp signal**: Every verdict appends to `<appRoot>/adjudications.jsonl`; once `n >= 14` with `0` rejections for a `(reviewerAgent, preset)` pair, the UI flags a review-health warning.

### 5.4 Pending Item Tables & Superseded Notices
Every `room point` (or unsplit speech) becomes a tracked item. In `Summary`, the lead must mark each item (`accepted`, `rejected`, `deferred`); omitted items stay highlighted as `unanswered`. Revising a summary increments its `version` and automatically injects a `superseded_notice` into every seat's next packet. Verbatim quotes (`room quote`) are hash-verified against the target `seq` and fail verification if the target was superseded.

## 6. Crash Recovery, Audit & Streaming

- **Single commit point**: `events.jsonl` (`append + fsync`) is the sole source of truth; `state.json` is an atomic derived projection from pure `reduce(state, ev)`. Torn trailing lines are ignored on replay. Open attempts after a crash enter `needs_reconcile` for explicit user `replay` or `void`.
- **Read-only native-log audit (`lib/audit.mjs`)**: Locates only registered Codex rollouts (exact full UUID + linked `SubAgentActivity` child threads) or Claude transcripts (post-baseline session match). Produces per-packet delivery receipts (`present_in_native` / `header_only` / `unknown`; "read by model" is always `unknown`) and flags review-turn writes (`apply_patch`/`FileChange`) or non-allowlisted commands (`unknownCommands.length > 0`) as `tainted: true`.
- **Real-time UI & Daemon (`lib/http.mjs`, `lib/lobby.mjs`, `lib/daemon-store.mjs`)**: Loopback SSE streams (`/api/stream`, `/lobby/api/stream`) push live events with `Last-Event-ID` resume and polling fallback. `daemon` mode persists an atomic room registry outside `<roomDir>` with `.bak` recovery and automatically resumes active rooms on restart.

## 7. Code Map

| Concern | Files |
|---|---|
| CLI entry & seat isolation | `room.mjs`, `lib/seat.mjs`, `lib/join.mjs`, `lib/driver.mjs` |
| Room service, reducer & HTTP/SSE | `lib/service.mjs`, `lib/reducer.mjs`, `lib/http.mjs` |
| Lobby & multi-room daemon | `lib/lobby.mjs`, `lib/daemon-store.mjs`, `lib/api.mjs` |
| Packets, banners, surfaces, i18n, budget | `lib/packet.mjs`, `lib/surface.mjs`, `lib/i18n.mjs`, `lib/budget.mjs`, `lib/templates/` |
| Artifact freeze, recompute & snapshots | `lib/workspace.mjs` |
| Structured parsing & supervision | `lib/structured.mjs`, `lib/supervision.mjs`, `lib/usage.mjs` |
| Read-only auditor & fixtures | `lib/audit.mjs`, `test/fixtures/audit/` |
| Write guard & clean spawning | `lib/guard.mjs`, `lib/spawn.mjs`, `lib/common.mjs` |
| Optional hosted Pi & Windows DPAPI | `lib/hosted/pi.mjs`, `lib/hosted/dpapi.mjs` |
| Zero-build Web UI & Desktop Shell | `ui/*`, `app/*`, `dist/*` |
| Simulation, mutations & contract tools | `sim/*`, `test/cases/*`, `test/mutations/*`, `contract/*`, `evidence/*` |
