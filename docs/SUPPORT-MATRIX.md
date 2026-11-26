# Support & Verification Matrix (v0.3.0)

*Last updated: 2026-11-26*

Every cell uses one of three strict values:
- **Verified**: Exercised end-to-end with recorded evidence in the stated scope.
- **Unverified**: Designed and/or unit-tested, but not yet verified in an independent live session on that target.
- **Unsupported**: Out of scope by design or not applicable to that seat form.

**Evidence discipline**: Passing unit tests or scripted simulations proves room logic only — it does **not** upgrade a real-agent row to **Verified**.

## 1. Automated & Browser Verification Baseline (v0.3.0)

Before reading the live-agent tables below, here is what is verified automatically on every build:

- **Scripted-seat E2E & unit/mutation suite (Verified)**: `node test/e2e.mjs` (79/79 assertions) and `node --test "test/**/*.test.mjs"` verify the full governance loop (`Work`/`Meet`/`Summary`, artifact freeze, `stale` recomputation, `accept-stale`, authorized vs. non-reviewer verdicts, snapshot-isolated disclosure, malformed follow-up, pending item tables, superseded notices, `needs_reconcile` recovery, farewell packets), audit taint on unknown commands (`unknownCommands.length > 0`), `spawnClean` `AbortSignal` & POSIX process-group teardown, incremental `cmdWait` + `fs.watch`, POSIX `0o600` token files, English packet templates, SSE streaming (`/api/stream`, `/lobby/api/stream`), multi-room daemon auto-resume and `.bak` registry recovery, Windows npm vendor `codex.exe` resolution + `>= 0.157.0` queue version gate with candidate fallback, strictly read-only `room doctor`, `room demo`, `submit --file -` stdin piping, and all 8 `ROOM_MUTATE` fault-injection switches.
- **Real browser UI smoke verification (Verified)**: Group-chat message rendering, Arena side-by-side mode, clickable `#seq` quote jumps, sticky Approval Inbox, Light / Dark theme toggle, SSE live updates, and negative XSS / forged-marker controls verified in a live browser against the room UI.
- **Multi-agent live discussion trials (Partial — governance loop still Unverified)**: Real multi-seat discussion turns across Antigravity, Claude Code, and Codex CLI have been exercised on Windows 11. The full independent live-agent governance cycle (freeze -> external edit -> `stale` -> snapshot disclosure -> audit taint), long-running Claude Code background wait endurance, Codex Desktop interactive wake pushes, cross-restart live-agent daemon resume, and clean macOS/Linux host runs remain **Unverified**.

## 2. Per-Agent Matrix

| Seat Type | Form | Transport | Wait Mode | Wake Push & Cap (`W`) | Done Signal | Cancel (Void / True) | Read-Only Audit Source | Permission Prompts | Declared Tier | Usage Reporting | Structured Channels | Host Output Cap | Verified Host Combo |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Scripted Seat (Sim / CI)** | Verified[^ss-1] | Verified[^ss-1] | Verified[^ss-1] | Unsupported | Verified[^ss-1] | Verified[^ss-2] | Unsupported | Unsupported | Unsupported | Unsupported | Verified[^ss-1] | Unsupported | Verified (Win11 / Linux / macOS CI)[^ss-1] |
| **Codex (`codex exec` child, same package context)** | Verified[^cx-1] | Verified[^cx-2] | Verified[^cx-3] | Unverified[^cx-4] | Verified[^cx-1] | Unverified | Verified[^cx-5] | Unverified | Unverified | Unverified | Unverified | Verified[^cx-6] | Verified (Win11, narrow scope)[^cx-1] |
| **Codex Desktop (interactive thread)** | Unverified[^dt-1] | Unverified | Unverified | Unverified[^cx-4] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| **Codex CLI (interactive)** | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| **Claude Code** | Unverified[^cc-1] | Unverified | Unverified[^cc-2] | Unsupported[^cc-3] | Unverified | Unverified | Unverified[^cc-4] | Unverified[^cc-5] | Unverified | Unverified | Unverified | Unverified | Unverified |
| **Antigravity / OpenCode / Gemini CLI / Kimi / DSH / User Pi** | Unverified[^other] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified[^other] | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| **Built-in Hosted Pi (`discussion`)** | Unverified[^pi-1] | Unverified | Unverified | Unsupported | Unverified | Unverified | Unsupported[^pi-2] | Unsupported | Unverified | Unverified | Unverified | Unsupported | Unverified |
| **Built-in Hosted Pi (`exec`)** | Unverified[^pi-1] | Unverified | Unverified | Unsupported | Unverified | Unverified | Unsupported[^pi-2] | Unverified[^pi-3] | Unverified | Unverified | Unverified | Unsupported | Unverified |
| **Built-in Hosted Pi (`reviewer`)** | Unverified[^pi-1] | Unverified | Unverified | Unsupported | Unverified | Unverified | Unsupported[^pi-2] | Unsupported | Unverified | Unverified | Unverified | Unsupported | Unverified |

### Column Definitions

- **Form**: Embedded (user-owned process) vs. Hosted (room-owned process).
- **Transport**: Asymmetric file-based (`<roomDir>` read-only, `<seat.cwd>/.room-outbox/<seatId>/` write-only); loopback HTTP optional.
- **Wait Mode**: `background` (agent background command), `turn_over` (submit then end turn; rely on wake push), `manual` (user prompts next turn), or polling (scripted seats).
- **Wake Push & Cap (`W`)**: Optional fixed-text wake notice pushed to a registered thread when idle, capped at `W` per turn (default `1`).
- **Done Signal**: Only an `ACCEPTED` `submit` completes a turn.
- **Cancel**: Void = room voids attempt and notifies seat on next command; True = room aborts an in-flight hosted worker turn.
- **Read-Only Audit Source**: Registered native log checked for packet delivery (`present_in_native` / `header_only` / `unknown`) and review-turn writes/unknown commands (`tainted`).

## 3. Built-in Pi Key Storage (Windows DPAPI)

Verified via `test/dpapi.test.mjs` (13/13 passed, 0 skipped on Windows 11 Pro 10.0.26200, Windows PowerShell 5.1, Node v24.11.1) using real DPAPI, real `room.mjs admin pi-key` CLI subprocesses, and an in-process room service with a fake hosted provider. Non-Windows platforms: **Unsupported** (`isAvailable() === false`, returns `DPAPI_UNAVAILABLE`).

| Capability | Status | Evidence / Scope |
|---|---|---|
| Save (`--save`), status (`--status`), delete (`--forget`) | Verified | Real CLI + DPAPI round-trip (ASCII, Unicode, 200-char keys); plaintext absent from ciphertext; `--save <value>` rejected without echo. |
| Tamper detection | Verified | Mutated/truncated/invalid blobs fail with `DPAPI_FAILED` and never echo key material. |
| Stdin-only key channel & Event Log 4104 check | Verified | Key passed solely as base64 over `stdin`; verified absent from PowerShell 4104 script-block log entries. |
| Scoped storage & `write-log.jsonl` | Verified | Stored at `<ROOM_DEV_HOME>/secrets/pi-key.dpapi` with `who=admin:pi-key`. |
| Service startup decryption & corrupt-key fallback | Verified | In-process service decrypts saved key (`piKeySource: 'saved'`), warns and degrades to `PI_NO_KEY` if tampered. |
| Live MSIX AppData redirect refusal | Unverified | Covered via injected `redirect` unit tests only; not tested on a live redirected path. |
| Different Windows user/machine, Constrained Language Mode, live Pi turn | Unverified | Designed (`DPAPI_FAILED` / `DPAPI_UNAVAILABLE`); live Pi SDK not exercised. |

## 4. Optional Windows Desktop Shell (`AgentRoundtable.exe`)

Built offline with `npm run app` (`node dist/build-app.mjs`) from a local cached Electron zip (verified with Electron 43.6.0 / bundled Node 24.20.0).

| Capability | Status | Evidence / Scope |
|---|---|---|
| Launch, Lobby load, temp room open in dedicated window, single-instance focus, graceful shutdown removing `service.lock` | Verified (smoke) | `--smoke` and `--smoke-room` live runs (`problems: []`, `serviceLockRemoved: true`) + `test/app.test.mjs`. |
| Reject relative `ROOM_DEV_HOME`; keep `userData` under `<appRoot>/app-data` | Verified | Unit tests and `--smoke` run. |
| Interactive folder picker, context menu, external HTTPS confirm dialog, reload block, Save Evidence dialog | Unverified | Static and mock tests only; not manually clicked end-to-end. |
| No-Node machine fallback (`room.cmd` + `ELECTRON_RUN_AS_NODE=1`) | Unverified | Both branches unit-tested; not run on a host without `node` on `PATH`. |
| Chromium disk footprint audit (ProcMon) | Unverified | Top-level AppData spot-checked only; no ProcMon trace yet. |

## 5. In-Process Host Embedding (`lib/api.mjs`)

| Embedded Seat Pattern | Registration | Live Host App | Unit / In-Process Coverage |
|---|---|---|---|
| Host-native chat session (`tool` surface) | `--agent pi-user --wait turn_over --surface tool:<name>` + custom `wake-kind` | Unverified | Covered by `test/api.test.mjs`, `test/surface.test.mjs`, `test/service.test.mjs`. |
| Host execution lane (`lane:<name>[:<tier>]`) | `--hosted lane:<name>:discussion` + `hostedProviders` factory | Unverified | Covered with fake lane factories and failure-class mapping tests; always reported as unaudited (`discussion` tier only). |

## Footnotes

[^ss-1]: Scripted test processes driving real CLI/service paths (`test/e2e.mjs`, `test/cases/*.test.mjs`, GitHub Actions CI across Windows/Ubuntu/macOS).
[^ss-2]: Covers voiding, expiry, crash recovery (`needs_reconcile`), and stale-attempt rejection. True cancellation does not apply to scripted seats.
[^cx-1]: Verified in an early Windows 11 probe where a `codex exec` child thread ran 3 full turns (`status -> wait -> read packet -> submit -> TURN_OVER`) under `workspace-write` + empty cwd. **Scope caveat**: that probe ran inside the same MSIX package context as the room (before the default root moved out of AppData to `~/room-dev/rooms`). Independent Start-menu launches under `~/room-dev/rooms` remain unverified.
[^cx-2]: File transport succeeded; `apply_patch` failed creating new files directly inside `.room-outbox/`, so `JOIN.md` directs agents to draft in their workspace root and let `room submit` copy into the outbox.
[^cx-3]: `TURN_OVER` exits `0` because non-zero exits were flagged as failed tool calls by the host. Turn 2 resume was simulated via `codex exec resume`, not a wake push.
[^cx-4]: `codex queue --thread <id>` returns exit `0` even on finished `exec` threads without starting a turn; `wake_pushed` therefore separates `command_ok` from audited `turn_observed`. Interactive Desktop thread waking is unverified.
[^cx-5]: Read-only rollout audit located all delivered packets (`present_in_native`) and observed commands/reads. Review-turn write/command `tainted` classification is verified in unit/simulation tests, not yet in a live Codex review turn.
[^cx-6]: A 51 KB packet was truncated on first read by the host tool; the agent detected truncation, read the file in chunks, and accurately answered a mid-packet marker, validating the "<8 KB header + packet file" design.
[^dt-1]: Evidence from `codex exec` is not extrapolated to Codex Desktop interactive threads or Windows interactive Codex CLI.
[^cc-1]: Bundled desktop `claude.exe -p` headless mode was unauthenticated; independent new-session Claude Code onboarding via `JOIN.md` has not been formally recorded end-to-end.
[^cc-2]: Designed for Bash `run_in_background` (zero model calls while waiting) with foreground `wait --timeout 110` fallback; multi-hour idle cost and wakeup reliability are unverified.
[^cc-3]: Claude Code uses background `wait` by default (no wake push required); native cross-session socket waking is not shipped until verified against a live Claude Code session.
[^cc-4]: Session-scoped transcript locator (`$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`) ran against real transcript files (opening only 27 session files, skipping an active 42 MB sibling session), but has not been verified on an independent fresh session.
[^cc-5]: Designed to trigger one permission prompt per `JOIN.md`'s single recommended `Bash(node <app>/room.mjs:*)` rule saved in `.claude/settings.local.json`.
[^other]: Supported in seat kit generation (`JOIN.md`), but not yet verified in live end-to-end sessions. Note: DSH uploads session logs by default; `JOIN.md` discloses this limitation.
[^pi-1]: Built-in worker (`lib/hosted/pi.mjs`) dynamically loads optional `@earendil-works/pi-coding-agent`; verified only with fake providers in `test/hosted-pi.test.mjs`.
[^pi-2]: Hosted seats emit tool events directly (`onEvent`) rather than requiring external native-log auditing.
[^pi-3]: High-risk tool calls (writes outside `cwd`, network, deletions) intercept into `permission_pending` for admin approval via the UI.
