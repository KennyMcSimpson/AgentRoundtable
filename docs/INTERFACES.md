# INTERFACES: Module & Storage Contracts

This document specifies the storage layout, event schema, CLI contracts, HTTP/SSE surfaces, and embedding interfaces for `AgentRoundtable` (`room-dev` v0.3.0). For design rationale and threat boundaries, see [`DESIGN.md`](DESIGN.md) and [`NON-INTERFERENCE.md`](NON-INTERFERENCE.md). If prose and contract ever diverge, this file is authoritative.

## Core Invariants (Non-Interference Rules)

1. **Scoped writes only**: The room service writes only inside `<roomDir>` (including `snapshots/`) and the application-level `adjudications.jsonl`; seat commands write only inside `<seat.cwd>/.room-outbox/<seatId>/`. Every write passes through `lib/guard.mjs`.
2. **No agent process ownership**: The room service never starts, kills, or attaches to any user-owned agent process. Its only outward actions are optional wake pushes to user-registered threads, snapshot-isolated disclosure commands, and built-in hosted Pi seats. (`node room.mjs drive` is an optional user-launched seat-side client outside the service; it communicates solely through the seat outbox and is never imported by `serve`.)
3. **Clean subprocesses**: Every child process (wake pushes, disclosure/acceptance execution, DPAPI helpers, hosted Pi workers, client drivers) launches via `lib/spawn.mjs` with an allowlisted environment, no shell interpolation, bounded output, and `AbortSignal` / POSIX process-group cleanup.
4. **Never run `git` on a seat's real directory**: All artifact hashing is read-only filesystem traversal. Disclosure and acceptance commands run only inside isolated snapshot copies with `git init` and pinned `GIT_DIR` / `GIT_WORK_TREE` / `GIT_CEILING_DIRECTORIES`.
5. **Read-only native-log auditing**: Agent logs are opened read-only with shared read/write/delete access, read incrementally via cursors, closed immediately, and strictly scoped to the registered thread/session and its linked subthreads.
6. **Honest audit language**: Never claim "read-only" or "zero writes" for an embedded seat; report only "not observed under method X".
7. **ASCII protocol tokens, English prose**: Status words, event names, structured markers, and error codes are ASCII. Packet templates (`lib/templates/*.md`), diagnostics, and the Web UI (`lib/i18n.mjs`, `ui/rt-i18n.js`) are English (`en`).
8. **Zero runtime dependencies**: Node.js >= 22, native ESM, built-in modules only. Optional built-in hosted Pi seats dynamically require `@earendil-works/pi-coding-agent` when used.
9. **Cross-platform core with Windows-first safety**: Pure logic modules, CLI, HTTP/SSE, and POSIX helpers (`room.sh`, `0o600` secret permissions, `ps` lock probing, macOS `/private/*` normalization) run across Windows, Linux, and macOS; Windows DPAPI and the optional Electron desktop shell are Windows-specific.

## 1. Directory & Storage Layout

### Room Directory

Default root: `~/room-dev/rooms/<id>` (`%USERPROFILE%\room-dev\rooms\<id>` on Windows, from `defaultRoomsRoot()` in `lib/common.mjs`). Override the base root (`~/room-dev`) with `ROOM_DEV_HOME`.

**Never place rooms or seat workspaces under Windows AppData (`%LOCALAPPDATA%` / `%APPDATA%`)**: processes launched from MSIX-packaged desktop apps (such as Claude Desktop) have writes to `%LOCALAPPDATA%` silently redirected into `AppData\Local\Packages\<pkg>\LocalCache\Local\...`, making the files invisible to independently launched agents. `virtualizationRedirect(dir)` compares `fs.realpathSync.native` against the literal path; `admin init` and `admin add-seat` refuse any path resolving into `\Packages\*\LocalCache\`, any symlink/junction redirection (with macOS `/private/tmp`, `/private/var`, `/private/etc` canonical prefixes handled cleanly), or any room placed inside a seat's working directory, git work tree, `CODEX_HOME`, or `CLAUDE_CONFIG_DIR`.

```text
<roomDir>/
  room.json                                 Room configuration (§2)
  events.jsonl                              Single-writer commit log (append + fsync)
  state.json                                Derived state reduced from events.jsonl (atomic write)
  packets/<packetId>.md                     Rendered turn packet bodies
  manifests/<packetId>.json                 Packet manifests (§6)
  artifacts/<seatId>/<manifestSha>.json     Frozen artifact manifests
  snapshots/<seatId>/<manifestSha>/         Isolated snapshot copies for disclosure/acceptance
  seats/<seatId>/
    JOIN.md                                 Seat onboarding packet
    token                                   One-time seat token (0o600 on POSIX)
    seat.json                               Seat metadata + recorded roomMjs / runtime
    room.cmd                                Windows wrapper script
    room.sh                                 POSIX wrapper script (0o755 on non-Windows)
  replies/<seatId>/<submissionId>.json      Service receipts for seat submissions
  admin.token                               User-only admin token (0o600 on POSIX)
  admin-queue/*.json                        Queued admin commands (moved to admin-queue/done/)
  private/<attemptId>/                      Private diagnostics (packet heads, raw outputs)
  private/audit/<seatId>.json               Incremental audit cursors & discovered subthreads
  write-log.jsonl                           Guard write audit log (who=service | who=admin)
  service.lock                              Single-instance lock {pid, image, startedAt, procStartedAt, heartbeatAt}
```

**Lock liveness (`lockHolderAlive` / `probeLockHolder`)**: A `service.lock` is stale if its PID is dead, its `heartbeatAt` (refreshed every 20 s) is older than 120 s, or OS probing (PowerShell UTF-8/base64 probe on Windows; `ps` on POSIX) shows a different image name or newer process start time. If liveness cannot be determined (`unknown`), startup refuses takeover with `SERVICE_RUNNING`.

### Seat Outbox

Located inside the seat's own working directory: `<seat.cwd>/.room-outbox/<seatId>/`. Created and written solely by the seat's own `room` command (`who=seat:<seatId>`). The room service reads it read-only.

```text
<seat.cwd>/.room-outbox/<seatId>/
  joined.json  leave.json  last-attempt.json  write-log.jsonl
  <submissionId>.md + <submissionId>.json   (submissionId = <attemptId>-s<hex>)
```

`<submissionId>.json` carries `meta.kind` in `speech | point | quote | mark | verdict | disclose | pass | misquoted | assign | artifacts`.

### Application-Level Files (Outside `<roomDir>`)

- `<appRoot>/adjudications.jsonl`: Cross-room reviewer verdict log (`lib/supervision.mjs`).
- `<appRoot>/secrets/pi-key.dpapi` + `secrets/write-log.jsonl`: Windows DPAPI CurrentUser ciphertext for hosted Pi API keys (never plaintext, never inside `<roomDir>`, see §9).
- `<roomsRoot>/.room-daemon-rooms.json` & `<roomsRoot>/.room-daemon.json`: Multi-room daemon registry and runtime metadata (`lib/daemon-store.mjs`). Stored at `<roomsRoot>`, never inside any `<roomDir>`, and never containing `adminToken`, `lobbyToken`, or seat tokens.
- `<appRoot>/test-runs/`: Ephemeral test scratch root (`testRunsRoot()`).

## 2. room.json Schema

```jsonc
{
  "schema_version": 2,
  "id": "demo",
  "createdAt": "2026-11-24T00:00:00.000Z",
  "lang": "en",                                              // default "en"
  "preset": "implement-review" | "discussion" | "report" | "cross-check" | "division" | "simplified",
  "wallClockSec": 2700,
  "workWallClockSec": 3600,
  "maxWorkConcurrent": 2,
  "budget": { "maxTokens": null, "packetMaxBytes": 200000 },
  "disclosureAllowlist": [["git", "diff"], ["git", "status"]], // argv prefixes; confirmed acceptance commands auto-added
  "templates": {
    "preamble": "<sha256>",
    "roles": { "executor": "<sha256>", "lead": "<sha256>", "participant": "<sha256>", "reviewer": "<sha256>" },
    "all": "<templateHash>"
  },
  "seats": [
    {
      "seatId": "A",
      "name": "Reviewer",
      "role": "lead" | "reviewer" | "executor" | "participant",
      "agent": "codex-desktop" | "codex-cli" | "claude-code" | "antigravity" | "opencode" | "gemini-cli" | "kimi" | "dsh" | "pi-user" | "generic",
      "waitMode": "background" | "turn_over" | "manual",
      "cwd": "...",
      "outbox": "...",
      "roomDir": "...",
      "createdAt": "...",
      "wallClockSec": 2700,
      "waitTimeoutSec": 110,
      "declaredTier": "discussion" | "readonly" | "workspace" | "full", // declared only; observed behavior is audited separately
      "wake": { "enabled": true, "kind": "codex-queue", "thread": "<uuid|name>", "maxPerTurn": 1 },
      "audit": null | { "kind": "codex" | "claude", "threadId": "<full-uuid>", "sessionId": "...", "cwd": "...", "knownTranscripts": [] },
      "hosted": null | { "kind": "pi", "tier": "discussion" | "exec" | "reviewer", "model": "..." },
      "surface": { "kind": "tool", "tool": "<model-visible-tool-name>" }, // present only for tool-surface seats (§5a)
      "reviews": ["B"]                                                    // acyclic review edges
    }
  ]
}
```

## 3. State Machine

Phases: `idle -> assign? -> work? -> meet -> summary -> done -> closed`. `assign` and `work` are included or skipped according to `preset`. Rooms without a `preset` run Meet-only rounds.

- **Assign**: Lead submits a draft via `room assign --file` (`task_drafted`). The user confirms via `admin confirm-task` (`task_confirmed`), transitioning to `work` (if executors exist) or `meet`.
- **Work**: Executors pull Work packets via `wait` (up to `maxWorkConcurrent` concurrent open attempts), declare outputs via `room artifacts --declare`, and report completion via `submit`. Exceeding `workWallClockSec` emits `work_partial`.
- **Meet**: Strictly serial turns following the round's `order` (lead first by convention).
- **Summary**: Single lead turn: `room mark` on each pending item, `room verdict` on each frozen artifact, plus `submit` for the summary text. Unmarked items are labeled `unanswered`. Summaries are versioned; publishing a new version schedules `superseded_notice` blocks in every seat's next packet.
- **Terminal attempt states** (exactly one per attempt, first terminal event wins): `submitted | failed(class) | canceled | expired | work_partial`.
- **Annotations** (attached to submissions/verdicts): `malformed | audit_failed | tainted | stale | accepted_stale | none`.
- **epoch bump**: triggered by `interrupt` (interrupt and reopen the current round), `reassign`, `reverse` (swap reviewer and executor roles), or choosing void for a pending attempt during crash recovery.
- **User interjections**: `admin say --text` appends `user_message_queued` (delivered at the next round boundary by default); `admin interrupt` reopens the current round immediately.
- **Timeout awaiting decision** (governed presets): When a non-follow-up attempt in `assign`, `meet`, or `summary` expires, the room emits `attempt_expired {hold: true}`, sets `state.awaitingDecision = {seatId, attemptId, phase, roundId, epoch}`, and halts packet issuance until the user runs `admin retry` (fresh attempt for the same seat; fails with `NO_DECISION_PENDING` if idle), `admin skip` (emits `seat_skipped` and marks the seat absent in summaries), or `admin reassign`.
- **Governance decisions**: `admin approve-disclose <id>`, `admin deny-disclose <id> --reason <text>` (reason required), and `admin accept-stale <manifestSha>` (requires an active stale recomputation, else `NOT_STALE`; if `changed` is supplied it must match the latest recomputation, else `CHANGED_MISMATCH`). Hosted Pi tool approvals arrive via `/api/admin` command `pi-permission {seatId, id, decision}`.
- **Acceptance command validation**: Draft acceptance commands must resolve without a shell. Missing executables (`COMMAND_NOT_FOUND`) or `.cmd`/`.bat` shims (`BATCH_SHIM_UNSUPPORTED`, e.g., `npm` on Windows) mark the draft malformed (`acceptance_unresolvable`, one follow-up) and cause `admin confirm-task` to fail with `ACCEPTANCE_BATCH_SHIM` or `ACCEPTANCE_UNRESOLVABLE`.

## 4. Event Log Schema (events.jsonl)

Every line in `events.jsonl` is a JSON object `{seq, ts, type, ...}` written solely by the room service (`append + fsync`).

Existing: `seat_joined seat_left task_set round_started packet_issued submission_accepted submission_rejected attempt_canceled attempt_expired seat_skipped epoch_bumped round_done room_closed wake_pushed`

Structured & governance events:

```text
room_created {id, preset, lang, schema_version}
task_drafted {seatId, attemptId, draft:{assignments:[{seatId, text, acceptance:[argv]}], text}}
task_confirmed {by:'admin', assignments}
phase_changed {from, to, roundId}
work_started {roundId, seats:[...]}
work_partial {roundId, seatId, attemptId}
artifacts_frozen {seatId, roundId, manifestSha, baseline, fileCount, bytes, excluded:[...], copyTorn:bool, attemptId, snapshotDir, manifestPath, empty, snapshotStale:bool, snapshotChanged:[...], refused?:[{path, reason:'reserved'|'symlink'|'outside'}]}
artifacts_recomputed {seatId, manifestSha, changed:[{path, from, to}], stale:bool, error?}
stale_accepted {manifestSha, by:'admin', changed:[...], error?, recomputedTs?}
work_no_artifact {seatId, attemptId, roundId, reason:'none_declared'|'empty', manifestSha}
point_added {itemId, seatId, attemptId, aboutSeq, text}
quote_submitted {seatId, attemptId, quotedSeq, text, verified:bool, reason}
item_marked {itemId, by, status:'accepted'|'rejected'|'deferred', text, phase}
misquoted_declared {seatId, aboutSeq, text}
verdict_recorded {seatId, attemptId, artifactSha, verdict:'pass'|'reject'|'disclose'|'none', annotation, annotations:[...], entersSummary, authorized:bool, tainted:bool, producer, evidence?:{reason, changed, recomputeError?, audit, text, source}}
disclose_requested {id, seatId, attemptId, argv, reason, manifestSha, allowed, matched?, matchKind?:'exact'|'prefix'}
disclose_approved {id, by}
disclose_denied {id, by:'admin'|'room', reason, message?}
disclose_executed {id, manifestSha, exitCode, outputSha256, truncated, privatePath}
summary_published {version, seatId, attemptId, unanswered:[itemId], supersedes:version|null, verdicts:[Entry], excluded:[Entry], verified:[{artifactSha, producer, verified, reason, by}], absent:[{seatId, phase, by, attemptId}], noArtifact:[{seatId, attemptId, reason, manifestSha}]}
superseded_notice {forSeat, oldVersion, newVersion, packetId}
direction_reversed {epoch, before:{reviewer, executor}, after:{reviewer, executor}}
needs_reconcile {attemptId, seatId}
reconciled {attemptId, action:'replay'|'void', receipt?:'sent'|'unknown'|'room'}
packet_resent {seatId, attemptId, packetId, path, manifestPath, sha256, bytes, resend:n, reason:'receipt_unknown'}
user_message_queued {msgSeq, text, sha256, deliverFromRound, immediate?}
round_reopened {epoch, supersededSeqs:[...], phase, phases}
attempt_expired {seatId, attemptId, hold?:true}
wake_pushed {seatId, attemptId, thread, threadId?, by, roundId, turnKey, command_ok, detail, refused?:'THREAD_BUSY'|'IDLE_UNKNOWN'|'CODEX_GATE_BLOCKED', turn_observed}
seat_failed {seatId, attemptId, class:'rate_limited'|'quota_exhausted'|'auth_expired'|'crashed'|'denied'|'other', detail}
usage_reported {seatId, attemptId, input, output, cached, source:'hosted'|'declared'|'audit'}
farewell_issued {packetId, seats:[...]}
audit_observed {seatId, attemptId, status:'present_in_native'|'header_only'|'unknown', writes:[...], unknownCommands:[...], tainted:bool}
structured_received {seatId, attemptId, kind, submissionId}
```

Notes on reduction and semantics:
- `reduce(state, ev)` (`lib/reducer.mjs`) is a pure function; `rebuild(roomDir)` replays `events.jsonl` from scratch (ignoring a torn trailing line after a crash).
- `snapshotStale: true` means declared files changed between hashing and snapshot copy; disclosure is refused with `SNAPSHOT_STALE`. `disclose_denied` by `room` uses ASCII codes: `NOT_IN_ALLOWLIST`, `ARG_NOT_ALLOWED`, `NO_SNAPSHOT`, `SNAPSHOT_STALE`, `BATCH_SHIM_UNSUPPORTED`, `COMMAND_NOT_FOUND`, `ARGV_CHANGED`.
- Only the authorized reviewer for a given artifact produces a binding verdict; non-reviewer verdicts are moved to `summary_published.excluded` with `annotation: 'not_reviewer'`.
- `stale_accepted` covers only the exact `changed` diff snapshot inspected by the user; any subsequent edit marks the verdict `stale` again (`STALE_CHANGED_SINCE_ACCEPT`).
- `point_added` from a voided/expired/reopened attempt is marked `voided` and excluded from the item table. `quote_submitted` against a superseded `seq` yields `verified: false, reason: 'superseded'`.
- `user_message_queued.msgSeq` is the user-message sequence number (distinct from the event envelope `seq`).
- `wake_pushed` with `refused: 'THREAD_BUSY' | 'IDLE_UNKNOWN' | 'CODEX_GATE_BLOCKED'` indicates nothing was sent and does not count toward the per-turn wake budget `W`.
- On service restart, any open attempt enters `needs_reconcile`; the seat receives `NEEDS_RECONCILE` until the user runs `admin reconcile <attemptId> replay|void`. On `replay`, if the seat outbox's `last-attempt.json` never recorded taking the attempt (`receipt: 'unknown'`), the service emits `packet_resent` with an idempotency note; otherwise it returns the original packet path.
- Late submissions for a seat's own canceled/expired/voided/skipped attempt return `REJECTED STALE_ATTEMPT`; submissions for another seat's attempt return `NOT_YOUR_TURN`. Work reports with no frozen files carry `annotation: 'no_artifact'`; marks from non-lead seats carry `notes: [{code: 'mark_not_permitted', items}]`.

## 5. Seat Commands & CLI Contracts (lib/seat.mjs, lib/driver.mjs)

Seat commands import only `lib/seat.mjs` (never `lib/service.mjs`) and strip inherited environment variables down to a minimal allowlist on startup. Common flag: `--seat <seatDir>`; turn-scoped commands require `--attempt <id>`. The first ASCII status token on stdout is the machine contract. Exit codes: `0` expected outcome (including `TURN_OVER`, `NOT_YOUR_TURN`, `ROOM_CLOSED`, `LEFT`), `2` `REJECTED`, `8` `PENDING` / `NO_SERVICE`, `9` usage or fatal error.

```text
wait [--timeout S] [--once]                                        -> TURN | TURN_OVER | NOT_YOUR_TURN | NOTICE ... | NEEDS_RECONCILE | ROOM_CLOSED | LEFT
submit --file <path|->                                             -> ACCEPTED [MALFORMED <reason>] | REJECTED <reason>
status [--log] [--whoami]                                          -> STATUS ... (--whoami prints registered audit source & thread/session id)
leave                                                              -> LEFT
artifacts --declare <path>... [--baseline none|whole|<sha>] [--exclude <glob>] -> FROZEN manifest=<sha> files=<n>
point --seq N --text "..."                                         -> ACCEPTED item=<id>
quote --seq N --text "..."                                         -> ACCEPTED verified=true|false|unknown
mark --item <id> --status accepted|rejected|deferred --text "..."  -> ACCEPTED kind=mark
verdict pass|reject|disclose --artifact <sha> --text "..."         -> ACCEPTED kind=verdict (disclose requires matching disclose request)
disclose --arg git --arg diff --reason "..."                       -> REQUESTED id=<id> (also accepts --argv-file <json> or legacy --argv)
pass                                                               -> ACCEPTED kind=pass
misquoted --seq N --text "..."                                     -> ACCEPTED kind=misquoted
assign --file <draft.md>                                           -> DRAFTED assignments=<n>
```

**Incremental wait (`cmdWait`)**: Uses byte-offset incremental reading of `events.jsonl`, `stat`-cached `state.json` reads, torn-tail resilience, and `fs.watch` wakeup with fallback polling so idle waits avoid repeated full-file scans.

**ASCII text-marker fallback** (inside `submit` body):
`<<ROOM:VERDICT pass artifact=sha>>`, `<<ROOM:DISCLOSE argv=[...]>>`, `<<ROOM:POINT seq=N>>...`, `<<ROOM:QUOTE seq=N>>...<<ROOM:END>>`, `<<ROOM:MARK item=id status=accepted>>`, `<<ROOM:MISQUOTED seq=N>>`, `<<ROOM:ASSIGN>>...<<ROOM:END>>`, `<<ROOM:PASS>>`.
Parser rule (`lib/structured.mjs`): strip all nonce-delimited forwarded blocks and Markdown/HTML/fenced quote spans first, then select the last marker in the turn. Conflicting, missing, malformed, or translated markers trigger `malformed` and one follow-up; a second failure records `verdict: none` (never defaults to `pass`).

**Optional seat-side driver (`lib/driver.mjs`, `node room.mjs drive`)**: Launched manually by the user outside the room service; never imports `lib/service.mjs` and never writes `<roomDir>`. Supports `--runner codex-cli` with required `--model <id>` and `--effort <level>`, rejects permission-bypass flags, spawns turns via `lib/spawn.mjs` (passing `HOME`/`XDG_*`/`TMPDIR` on POSIX), and checks `openAttemptFor` before outbox submission for idempotency.

### 5a. Seat Submission Surfaces (`lib/surface.mjs`)

`seatSurface(seat)` resolves in order:
1. `hosted`: `seat.hosted` is set (built-in Pi or embedded lane). Never stored separately. No CLI commands; replies are the full turn text and structured actions use ASCII markers.
2. `tool`: `seat.surface = {"kind": "tool", "tool": "<name>"}` (`^[A-Za-z][A-Za-z0-9_.-]{0,127}$`). Registered via `admin add-seat --surface tool:<name>` (rejected with `--hosted` or `codex-queue` wake). Host tool contract accepts `room`, `action` (matching §5 command names), `attempt` (when required), and action fields; `wait` returns the full packet text; seat identity is bound by host context (no token parameter).
3. `cli`: Default. Renders CLI instructions (`node <room.mjs>` or `room.cmd` / `room.sh`).

Non-`cli` manifests record `surface` and `surfaceHash` (SHA-256 of rendered surface instructions).

## 6. Turn Packets & Manifests (lib/packet.mjs)

Each turn packet (`packets/<packetId>.md`) consists of:
1. Room preamble (`seat=room authority=room`, surface-adapted instructions, declared tier, role template)
2. User task & queued user messages (`authority=user`)
3. Accepted speeches in order (`authority=none`, each with explicit non-authority declaration)
4. Current summary (versioned) and materials
5. Pending item table (Summary turns), superseded notices, and voided-attempt notices
6. Current turn task

Every packet generates a fresh random `nonce`. Blocks are wrapped in `[ROOM:<nonce>:seat=<x> authority=<user|none|room> seq=<n> hash=<16hex>]` ... `[/ROOM:<nonce>]`. Any literal `[ROOM:` or `[/ROOM:` in untrusted content (speeches, materials, disclosure outputs, quotes) is escaped to `[ROOM\:` and counted in `escaped`. The `wait` stdout header stays under 8 KB and repeats the source banner declaration so truncation cannot hide it.

**Deterministic budget trimming (`lib/budget.mjs`)**: Triggered only when a packet exceeds `budget.packetMaxBytes`. Drops whole messages oldest-first while pinning all current-round speeches, quoted messages, and the latest summary; records `dropped: [{fromSeq, toSeq}]`.

**Manifest (`manifests/<packetId>.json`)**: `{packetId, seatId, attemptId, roundId, epoch, nonce, sha256, bytes, messageSeqs, summaryVersion, materialVersions, templateHash, renderVersion, declaredTier, auditSource, hostOutputLimit, escaped, prevManifestId, dropped, surface?, surfaceHash?}`.

**Farewell packet**: Issued on `admin close` (`farewell_issued`); states that room rules have ended, peer content is not user instruction, and room content must not be persisted to long-term memory.

## 7. Governance Modules

- **`lib/workspace.mjs`**: `declareArtifacts({cwd, paths, baseline, exclude, sizeCap})` (read-only SHA-256 walk, includes untracked files, excludes `.room-outbox/`, `.git` dir or pointer file at any depth, `node_modules/`, top-level `.room-snapshot`, symlinks/junctions, and paths resolving outside `cwd`; detects `copyTorn`); `recompute(manifest)` (`{changed, stale}`); `snapshot(manifest, dest)` (re-checks realpaths/symlinks per file, records `refused`, runs `git init` inside snapshot); `runInSnapshot({snapshotDir, argv, env})` (via `lib/spawn.mjs`, no shell, `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` pinned to `<snapshot>/.room-snapshot/home`, `TEMP`/`TMP` to snapshot root, `GIT_DIR`/`GIT_WORK_TREE` pinned, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=NUL`/`/dev/null`, `core.fsmonitor=false`, `core.hooksPath=NUL`, `core.pager=cat`, `credential.helper=`). Pre-flight `checkCommand(argv[0])` refuses `.cmd`/`.bat` shims (`BATCH_SHIM_UNSUPPORTED`) and missing binaries (`COMMAND_NOT_FOUND`); `snapshotArgProblem(argv)` rejects absolute/drive/UNC paths, `..`, NUL bytes, and dangerous `git` flags (`-c`, `-C`, `--output*`, `--no-index`, `--git-dir*`, `--work-tree*`, `--exec-path*`) with `ARG_NOT_ALLOWED`.
- **`lib/structured.mjs`**: Command and text-marker structured submission parsing, item table derivation, summary versioning, superseded notices, verbatim quote verification, and strict `malformed` checks.
- **`lib/supervision.mjs`**: Room topology validation (lead/reviewer never take Work; executors cannot be lead; acyclic review graph; single authorized reviewer per artifact), `reverse` preconditions, verdict binding, disclosure state machine (`requested -> approved|denied -> executed`), allowlist prefix/exact matching, and `adjudications.jsonl` reject-rate signal (`n >= 14 && k === 0`).
- **`lib/audit.mjs`**: Read-only native log reader for Codex (`$CODEX_HOME/sessions/` and `archived_sessions/`, exact full UUID filename match + `SubAgentActivity` child threads) and Claude Code (`$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`, session-scoped baseline + `tool-results/` + `subagents/`). Classifies `apply_patch`/`FileChange` as `writes`, non-allowlisted `exec_command`/`CommandExecution` as `unknownCommands` (excluding `room` commands). During review turns, `tainted = writes.length > 0 || unknownCommands.length > 0`. Persists cursors and discovered subthreads in `private/audit/<seatId>.json`.
- **`lib/spawn.mjs`**: `spawnClean(file, args, {cwd, env, timeoutMs, maxOutputBytes, input, signal})` with allowlisted environment, `stdin`-only secret channel (`input` omitted from result), `AbortSignal` cancellation, and POSIX process-group cleanup (`detached: true` + `process.kill(-pid, 'SIGKILL')`).
- **`lib/budget.mjs`** & **`lib/usage.mjs`**: Pure deterministic packet trimming, token accounting (`hosted`/`declared`/`audit`; unreporting seats remain `unknown`, never `0`), and `maxTokens` pause detection.

## 8. Room Service, HTTP Surface, SSE & Multi-Room Daemon

### Service API (`lib/service.mjs`)

```js
export function createRoomService({ roomDir, now = () => Date.now(), log, spawn = spawnClean, codexExe, lang, ... })
  // -> { tick(), state(), view(), emit(ev), admin({cmd, ...params}), close(), ... }
export async function serve({ roomDir, tickMs, port, once, piApiKey })
```

Injectable hooks (`now`, `spawn`, `idleCheck`, `snapshot`, `checkCommand`, `codexEnv`, `piKeyUnprotect`, `savedPiKey: false`) enable deterministic in-process simulation.

### Room HTTP & SSE Surface (`lib/http.mjs`, `ui/mock-server.mjs`)

Binds `127.0.0.1` only. Every request passes `checkHostOrigin(headers, port, {method, path})`:
- `Host` must exactly match `127.0.0.1:<port>` or `localhost:<port>`.
- `Origin` (when present) must match `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- `Sec-Fetch-Site` (when present) must be `same-origin` or `none`, except `pageNavigation`: a `same-site` top-level `GET`/`HEAD` document navigation to `/` or `/index.html` (allowing the Lobby on another loopback port to open a room window; page HTML carries no secret and sets `X-Frame-Options: DENY` and `Content-Security-Policy: ... frame-ancestors 'none'`).
- Tokens are **never** accepted in query strings or HTTP headers (`TOKEN_IN_URL` 400); admin tokens travel only in the initial URL `#fragment` (scrubbed via `history.replaceState`) and JSON `POST` bodies (`application/json`, <= 64 KiB).

Routes:
- `GET /`, `/index.html`, `/app.js`, `/app.css`, `/rt-*.js`, `/rt-*.css`: Static top-level files from `ui/` (never `.mjs` or `fixtures/`).
- `GET /api/state`: `{state, room}` derived service view.
- `GET /api/events?since=N`: `{events: [seq > N], lastSeq}`.
- `GET /api/stream?since=N`: Read-only Server-Sent Events stream (zero-token URL, only `since` query param allowed, `Last-Event-ID` header resume, max 32 concurrent clients -> `503 TOO_MANY_STREAMS`, 20 s `: ping` heartbeat). Emits `event: snapshot`, `event: room_event` (with `id: <seq>`), and batched `event: state`.
- `POST /api/admin`: `{token, cmd, ...params}` executing room service admin actions (seat tokens rejected with `401 SEAT_TOKEN` and logged).
- `POST /seat/<cmd>`: Optional loopback seat transport `{seatId, token, attemptId?, text?, payload?}`.

### Multi-Room Lobby & Persistent Daemon (`lib/lobby.mjs`, `lib/daemon-store.mjs`)

- `node room.mjs lobby [--port N] [--rooms-root <dir>] [--resume] [--lang en] [--open]`: Loopback control plane (default port `7380`, falls back to ephemeral port if busy).
- `node room.mjs daemon [--port N] [--rooms-root <dir>] [--no-resume] [--lang en] [--open]`: Persistent multi-room daemon mode (`persistRegistry: true`, auto-resumes live non-closed rooms in active round phases on startup).
- `node room.mjs daemon status [--rooms-root <dir>]`: Prints daemon PID, liveness, URL, rooms root, and tracked rooms.

Lobby/Daemon routes (same loopback `checkHostOrigin` gate):
- `GET /lobby/api/meta`: Presets, roles, agent kinds, wait modes, hosted tiers, supported languages, rooms root, daemon status.
- `GET /lobby/api/rooms`: Room directory listing (no admin tokens returned).
- `GET /lobby/api/seat-defaults?id=&seat=`: Suggested seat working directory (`<ROOM_DEV_HOME or ~>/room-seats/<id>-<seat>`).
- `GET /lobby/api/health`: `{ok: true, roomsRoot, ...daemonInfo}`.
- `GET /lobby/api/stream`: Read-only SSE stream pushing `event: rooms` updates (zero-token URL, 32-client cap -> `503 TOO_MANY_CLIENTS`).
- `POST /lobby/api/folder` (`{token, path}`): Token-authenticated read-only check `{exists, isDir}` for an absolute path.
- `POST /lobby/api/create`, `/open`, `/stop`, `/task`, `/start`: Token-authenticated room lifecycle operations. `create` rolls back all newly created directories if any seat fails validation; `task` and `start` refuse to overwrite an in-progress round (`ROUND_IN_PROGRESS`, `NEEDS_RECONCILE`, `AWAITING_DECISION`).

**Daemon Registry (`lib/daemon-store.mjs`)**: Persists `<roomsRoot>/.room-daemon-rooms.json` and `.room-daemon.json` via atomic write-and-rename with Windows retry backoff (`EBUSY`/`EPERM`/`EACCES`). Unreadable files are never clobbered; corrupt JSON is backed up to `.room-daemon-rooms.json.<sha12>.bak` before resetting.

## 9. Hosted Seats (lib/hosted/pi.mjs, lib/hosted/dpapi.mjs)

```js
export function createPiSeat({ tier, apiKey, model, cwd, sessionDir, onEvent, provider? })
  // -> { prompt(packetText, {signal}) -> {text, stopReason:'end_turn'|'cancelled'|'error', usage, failureClass?}, cancel(), dispose() }
```

- **Tiers**: `discussion` (`noTools`), `reviewer` (read-only tools), `exec` (read/write tools with high-risk operations intercepted as `permission_pending` for admin approval).
- **API key handling**: Plaintext keys live in memory only and never enter `<roomDir>`, `events.jsonl`, `state.json`, or logs (`state.json` records only `piKey: 'present'|'absent'` and `piKeySource: 'option'|'env'|'admin'|'saved'|null`). Supply keys via:
  1. `ROOM_PI_API_KEY` environment variable when starting `serve` / `daemon`
  2. `room.mjs serve --pi-key-stdin` (reads first non-empty stdin line; refuses TTY)
  3. `admin pi-key --dir <room> --port <n> [--seat <id>]` (sends over loopback `POST /api/admin`)
  4. Windows DPAPI saved ciphertext (`admin pi-key --save | --status | --forget`)
- **Windows DPAPI (`lib/hosted/dpapi.mjs`)**: Encrypts/decrypts via `WindowsPowerShell\v1.0\powershell.exe` (`ProtectedData`, `CurrentUser` scope, fixed app entropy) invoked through `spawnClean`. Keys travel strictly as base64 over `stdin` (`input`), never in argv, env, or script body (verified absent from PowerShell Event Log 4104). Stored at `<appRoot>/secrets/pi-key.dpapi` through a dedicated guard after `virtualizationRedirect` verification. Errors use ASCII codes `DPAPI_UNAVAILABLE` and `DPAPI_FAILED` without echoing output. Non-Windows platforms return `isAvailable() === false`.
- **Failure classification**: `rate_limited | quota_exhausted | auth_expired | crashed | denied | other` (based strictly on exit/error codes and ASCII identifiers). Missing `@earendil-works/pi-coding-agent` throws `PI_NOT_INSTALLED`; tests inject a fake `provider`.

## 10. Web UI & Optional Desktop Shell (ui/, app/)

- **Static zero-build Web UI (`ui/`)**: Served by `lib/http.mjs` (room view) and `lib/lobby.mjs` (lobby/daemon view). Features unified Group-Chat conversation view (`ui/rt-chat.js`, `ui/rt-chat.css`), Arena side-by-side round comparison, sticky Approval Inbox, hardened display protocol parser (`ui/rt-protocol.js`), zero-`innerHTML` safe Markdown renderer (`ui/rt-markdown.js`), Light / Dark theme toggle (`ui/rt-i18n.js`), and inspection views (`stream`, `seats`, `packets`, `task`, `items`, `verdicts`, `receipts`, `usage`, `recovery`, `merge`, `contract`). Connects via `EventSource` to `/api/stream` (and `/lobby/api/stream`) with automatic fallback to polling.
- **Optional Windows Electron Desktop Shell (`app/`, `dist/build-app.mjs`)**: Runs `room.mjs lobby --port 0` in an isolated `utilityProcess`, pins Electron `userData`/`sessionData`/`logs` under `<appRoot>/app-data` (never AppData), enforces single-instance locking, disables reload hotkeys (preserving in-memory tokens), gates navigation to announced loopback room ports, and exposes a minimal sandboxed `window.roomApp` bridge (`isApp`, `pickFolder`, `copyText`, `saveEvidence`). Supports `--smoke` / `--smoke-room` self-tests. When `node` is absent from `PATH`, seats fall back to `room.cmd` invoking the bundled runtime via `ELECTRON_RUN_AS_NODE=1`.

## 11. Simulation, Mutation & Contract Verification (sim/, test/, contract/, evidence/)

- **`sim/driver.mjs`**: In-process deterministic service harness with fake clocks and scripted seats (`test/cases/*.test.mjs`).
- **Mutation tests (`test/mutations/*.test.mjs`)**: `ROOM_MUTATE` supports 8 deliberate fault switches (`no-dedupe`, `no-attempt-check`, `no-recompute`, `no-audit`, `no-escape`, `no-unanswered`, `no-disclose-gate`, `no-marker-strict`); every invariant test must turn red when its corresponding switch is active.
- **Contract checks (`contract/`, `evidence/`)**: Independent CLI-driven non-interference checks (`check-writes.mjs`, `control-run.mjs`, `pids.mjs`, `env.mjs`, `memory-diff.mjs`) aggregated by `evidence/collect.mjs` into local `evidence/REPORT.md` (gitignored).
- **CI (`.github/workflows/ci.yml`)**: Runs `node --test` across `windows-latest`, `ubuntu-latest`, and `macos-latest`.

## 12. Packaging, Public Export & In-Process Embedding API (dist/, lib/api.mjs)

- **Packaging (`dist/`)**:
  - `dist/build-app.mjs` (`npm run app`): Offline Windows desktop bundle from cached Electron zip + `rcedit`, emitting `BUILD.json` with per-file SHA-256 checksums and `THIRD-PARTY.md`.
  - `dist/build.mjs`: Developer Windows ZIP with verified Node runtime and `THIRD-PARTY.md`.
  - `lib/export.mjs` (`dist/export.mjs`): Exports public room layers only; fails on secret patterns or personal absolute paths unless `--redact` is passed. `lib/` never imports `dist/` (enforced by `test/lib-selfcontained.test.mjs`).
  - `dist/public-scan.mjs` & `dist/export-public.mjs`: Clean public export scanner supporting external `--deny-file` rules.
- **In-process embedding (`lib/api.mjs`, `lib/api.d.mts`)**:
  - `createRoom(params)`, `addSeat(params)`, `admin(sub, params, positional)`: Route through the exact same handlers as the CLI without printing or calling `process.exit`; return `{code, status, fields, lines, error?}`.
  - `openRoom({roomDir, tickMs, port, hostedProviders, wakers, piApiKey, log})`: Runs `createRoomService` in-process with lock heartbeat and optional loopback HTTP/SSE; returns `{view(), events(since), admin(cmd, params), subscribe(fn), url, adminToken, close()}`.
  - `seatClient({roomDir, seatId})`: Programmatic seat client writing solely to `<seat.cwd>/.room-outbox/<seatId>/`.
  - **Custom host lanes & wakers**: Hosts can register `hosted: 'lane:<name>[:<tier>]'` (with optional `model` for hosted seats only) backed by `hostedProviders`, `surface: 'tool:<toolName>'` for host-native chat sessions, and custom `wake-kind` adapters via `openRoom({wakers})`.
