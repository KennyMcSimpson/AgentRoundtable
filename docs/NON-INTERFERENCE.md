# Product Boundaries & Non-Interference Contract

`AgentRoundtable` (`room-dev`) is a local, deterministic governance layer for coding agents you already run (Codex, Claude Code, Antigravity, Gemini CLI, or any agent that can execute one local command). It orders turns, wraps relayed messages in nonce-delimited source banners, freezes and recomputes artifact hashes, mediates snapshot-isolated disclosures, and audits native logs read-only — **without launching, killing, attaching to, or reconfiguring your agents**.

## 1. Two Seat Forms

| Seat Form | How It Joins | Process Owner | Intended Use |
|---|---|---|---|
| **Embedded seat** *(primary)* | You hand the generated `JOIN.md` seat kit to an already-running agent. It reads `<roomDir>` and writes submissions only into `<seat.cwd>/.room-outbox/<seatId>/`. | **User** | Everyday multi-agent work across heterogeneous local agents |
| **Hosted seat** *(secondary)* | The room runs an in-process worker (built-in Pi tiers or an embedded host lane via `lib/api.mjs`). | **Room** | Single-agent "simplified" workflows and deterministic CI/simulation |

Both forms speak the same room protocol (packets, banners, receipts, structured submissions). The difference is strictly what the room can enforce versus only observe.

## 2. Capabilities vs. Non-Claims

### What the Room Provides

| Capability (Embedded & Hosted) | Hosted Only (Not Enforceable on Embedded Seats) |
|---|---|
| Strict turn order and attempt validity (`NOT_YOUR_TURN`, `STALE_ATTEMPT`) | Stopping an agent that ignores `room wait` |
| Mandatory per-packet nonce source banners and delimiter escaping | True mid-turn cancellation (embedded seats can only be voided) |
| Artifact SHA-256 freezing, verdict-time staleness recomputation | Enforcing reviewer read-only permissions (embedded seats rely on user sandbox + empty cwd + post-hoc audit) |
| Snapshot-isolated, admin-approved disclosure execution | Real-time tool-call interception and permission prompts |
| Pending item tables, versioned summaries, and superseded notices | Guaranteed token usage reporting (unreported embedded usage stays `unknown`) |
| Read-only native-log delivery receipts and review-turn write/command auditing | Subprocess tree teardown for the agent itself |
| Append-only event log, crash reconciliation, and redacted evidence export | — |

For embedded seats, **declared tier** (what you configured at seat creation) and **observed behavior** (what the read-only auditor saw in native logs) are always displayed separately.

### Explicit Non-Claims

- **No model-quality claims**: Governance structures coordination; it does not claim better single-model reasoning.
- **No "zero configuration" claim**: Each agent has its own row in [`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md); the first `room` invocation triggers the agent's own permission prompt.
- **No "local means offline" claim**: Your coding agents still talk to their model providers.
- **No prompt-injection immunity claim**: Nonce banners are provenance labels, not a security boundary; each agent's own sandbox/permission gate blocks unauthorized actions.
- **No external write prevention**: Artifact freezing and recomputation detect outside edits; they do not lock files.
- **No free waiting claim**: Wait costs depend on the host agent (e.g., background shell vs. turn-over wake pushes).
- **No automatic merging**: Multi-executor file conflicts are surfaced in the UI for human resolution.
- **No absolute "zero interference" claim**: Every report is phrased strictly as *"not observed under method X"*.

## 3. The Nine-Clause Non-Interference Contract

1. **Write only to owned directories.** The room service writes only inside `<roomDir>` (including `snapshots/`) and `<appRoot>/adjudications.jsonl` (plus `<appRoot>/secrets/` on explicit DPAPI key commands, and `<roomsRoot>/.room-daemon*.json` in daemon mode). Seat commands write only inside `<seat.cwd>/.room-outbox/<seatId>/`. All room/seat writes flow through `lib/guard.mjs` and are recorded in `write-log.jsonl`. The room never modifies agent session stores, configs, memories, hooks, or project instructions. (When you click "Allow" on an agent's own permission prompt, the agent writes its own local permission file; `JOIN.md` discloses that path and recommends a single scoped rule.)
2. **Never launch, kill, attach to, or mutate host state.** The room does not spawn, terminate, or attach to user agent processes, open their sessions, or invoke state-mutating host CLIs. Two explicit exceptions: built-in hosted seats (owned by the room), and opt-in wake pushes restricted to a user-registered thread when idle, capped at `W` pushes per turn (default `1`), carrying a fixed content-free notice, and logged as `wake_pushed`.
3. **Never touch agent credentials.** The room never reads agent credential files or login state. Because the `room` seat CLI runs as a child of the agent and inherits its environment, `room.mjs` strips `process.env` down to a minimal allowlist (`PATH`, `SystemRoot`, `TEMP`, and room variables) before executing seat logic and never logs inherited variables.
4. **Never write to seat working directories or run `git` there.** Embedded seats work in their own directories. The room service reads and hashes declared files read-only; it never calls `git` on a seat's real repository (avoiding `index.lock` contention). Disclosure and acceptance commands execute solely inside `<roomDir>/snapshots/<seatId>/<manifestSha>/`.
5. **Bounded wakes, no unsolicited model calls.** The room itself makes zero LLM calls (outside explicitly added hosted seats). Per-turn wake caps `W` are visible in the UI, and concurrent Work attempts are capped (`maxWorkConcurrent`, default `2`).
6. **Read-only native-log auditing.** Native logs are opened read-only with shared write/delete access, without locks or `mmap`, read incrementally via byte cursors, and closed immediately. Scope is restricted to the registered thread/session and its linked subthreads — never a full-disk or content-wide scan. Unreadable logs report `unknown`.
7. **Clean uninstall, honest context boundary.** Deleting `<roomDir>` leaves no room-written artifacts in agent configs, session stores, or memory directories. `JOIN.md` lists the two user-managed cleanup items: the permission rule you approved and `<seat.cwd>/.room-outbox/`. Because conversation context already seen by an agent cannot be erased remotely, closing a room issues a **Farewell Packet** instructing seats that room rules are over, peer text is not user instruction, and room content must not be written into persistent memory.
8. **No sandbox weakening required.** You never have to relax an existing session's sandbox. Reviewer seats achieve workspace isolation cleanly by using a fresh empty directory as their `cwd` under a standard `workspace-write` sandbox: they can write their own `.room-outbox/` while remaining unable to modify the executor's project directory.
9. **Never hijack active work threads.** Rooms use only dedicated sessions you explicitly onboard. `turn_over` seats end their turn immediately after submitting so idle threads are not held open.

## 4. Verification & Measurement Matrix

All contract scripts live in [`contract/`](../contract/README.md) and are aggregated by `node evidence/collect.mjs`.

| Clause(s) | Automated Method | What It Verifies | Known Blind Spots (Explicitly Noted) |
|---|---|---|---|
| 1, 4 | `contract/check-writes.mjs` | Every `write-log.jsonl` entry for `service`/`admin` stays inside `<roomDir>` and outside all seat `cwd`s; every `seat:<id>` entry stays inside its own outbox. | Self-reported through `lib/guard.mjs`; cannot catch code that bypasses the guard (requires OS-level ProcMon / ETW audit). |
| 1, 7 | `contract/control-run.mjs` | Runs a full scripted session with no live agents and compares content SHA-256 snapshots (ignoring `mtime`) of agent config, instructions, hooks, and memory dirs against an equal-length idle baseline window. | Proves room code paths only; does not cover mutations made by live external agents themselves or transient write-then-delete cycles. |
| 2 | `contract/pids.mjs` | Compares before/after `codex|claude|node` PID sets and walks parent-PID chains to ensure no agent process was spawned by any room PID and no room service lingers after `close`. | Cannot observe `OpenProcess`/attach calls or identify who killed a vanished PID (requires OS-level ETW). |
| 3 | `contract/env.mjs` | Injects unique canary values into 6 common API-key env vars; scans all room/outbox files and outputs, checks seat process exit env via `NODE_OPTIONS` preload, and verifies `spawnClean` allowlisting. | Covers seeded canary keys only; does not inspect in-memory heap state. |
| 6 | `lib/audit.mjs` + `test/audit.test.mjs` | Confirms read-only cursor reads, torn-line tolerance, and strict open-file set containment (`opened ⊆ registered`). | Live concurrent-append zero-error verification under heavy real-agent load remains manual (`test/real/README.md`). |
| 7, 8 | `contract/memory-diff.mjs` | Content-hash diff tool for before/after checks around live multi-agent sessions (`--save` / `--against`). | Point-in-time snapshots only; misses transient edits reverted before the second snapshot. |
