# CLI Reference & Developer Guide

This guide covers local installation, CLI commands, multi-room daemon mode, repository layout, test suites, contract verification, and optional Windows desktop packaging for `AgentRoundtable` (`room-dev`).

## 1. Requirements & Storage Roots

- **Node.js >= 22** (native ESM, **zero runtime npm dependencies** — no `npm install` needed).
- **Optional `git` on `PATH`**: Used inside isolated snapshot copies (`snapshots/`) for `git diff`/`git status` disclosures. Never invoked on a seat's real repository.
- **Optional `@earendil-works/pi-coding-agent`**: Only required if using `--hosted pi:*` seats.
- **Default root**: `~/room-dev` (`%USERPROFILE%\room-dev` on Windows). Override with `ROOM_DEV_HOME=<abs-path>`.
  - Rooms: `<root>/rooms/<id>`
  - Cross-room adjudications: `<root>/adjudications.jsonl`
  - Daemon registry: `<roomsRoot>/.room-daemon-rooms.json` & `.room-daemon.json`
  - Windows DPAPI hosted Pi key: `<root>/secrets/pi-key.dpapi`
  - Ephemeral test runs: `<root>/test-runs/`
- **Windows MSIX / AppData warning**: Never place `ROOM_DEV_HOME`, room directories, or seat working directories under `%LOCALAPPDATA%` or `%APPDATA%`. Processes launched inside MSIX-packaged apps (e.g., Claude Desktop) redirect AppData writes into per-package caches invisible to other agents; `admin init` and `admin add-seat` refuse redirected paths.

## 2. Quick Verification

```bash
npm test                     # Full unit, UI, simulation, contract, and mutation suites
npm run e2e                  # End-to-end CLI + service governance tests
npm run evidence             # Runs tests, e2e, and all non-interference contract checks -> evidence/REPORT.md
```

## 3. CLI Reference

All commands run via `node room.mjs <command> ...` (or `agent-roundtable` / `room-dev` when linked). Exit codes: `0` expected outcome, `2` `REJECTED`, `8` `PENDING` / `NO_SERVICE`, `9` usage or fatal error.

### Multi-Room Daemon, Lobby & Single-Room Service

| Command | Purpose |
|---|---|
| `node room.mjs daemon [--port N] [--rooms-root <dir>] [--no-resume] [--lang en] [--open]` | Persistent multi-room host + Lobby UI + SSE (`/lobby/api/stream`, `/lobby/api/health`) + atomic registry outside `<roomDir>` + auto-resume of active rooms on restart. |
| `node room.mjs daemon status [--rooms-root <dir>]` | Print live daemon PID, status, URL, rooms root, and tracked rooms. |
| `node room.mjs lobby [--port N] [--rooms-root <dir>] [--resume] [--lang en] [--open]` | Loopback Lobby UI (default port `7380`, fallback to free port) to create rooms, copy onboarding prompts, open room UIs, and dispatch tasks. |
| `node room.mjs serve --dir <roomDir> [--tick ms] [--once] [--port N] [--pi-key-stdin]` | Single-room service (sole writer of `events.jsonl`). `--port 0` opens the loopback Room UI + SSE (`/api/stream`) with the admin token in `#fragment` only. |

### Admin Commands (User Terminal; `--dir <roomDir>` or `--id <roomId>`)

| Command | Purpose |
|---|---|
| `admin init --id <id> [--dir <dir>] [--preset <name>] [--lang en] [--wall s] [--work-wall s] [--max-work n] [--max-tokens n] [--packet-max-bytes n]` | Initialize room (`implement-review`, `discussion`, `report`, `cross-check`, `division`, `simplified`). |
| `admin add-seat --seat <id> --role lead\|reviewer\|executor\|participant --cwd <dir> [--agent <kind>] [--wait background\|turn_over\|manual] [--tier discussion\|readonly\|workspace\|full] [--reviews A,B] [--hosted pi:discussion\|pi:exec\|pi:reviewer\|lane:<name>[:<tier>]] [--model <id>] [--surface cli\|tool:<name>] [--wake-thread <uuid\|name>] [--wake-max n] [--audit codex\|claude --thread-id <uuid> --session-id <id>]` | Register a seat while the service is stopped and generate `seats/<id>/JOIN.md`, `room.cmd`, and `room.sh`. |
| `admin set-audit --seat <id> --kind codex\|claude [--thread-id <uuid>] [--session-id <id>]` | Attach or update a seat's read-only audit source. |
| `admin task\|say --text "..." \| --file <path>` | Set the room task or queue a user interjection for the next round boundary. |
| `admin start --order A,B[,A]` | Start a round with the specified Meet speaking order. |
| `admin confirm-task [--file <draft.md>]` | Confirm a lead's Assign draft and promote its acceptance commands to the disclosure allowlist. |
| `admin interrupt [--text "..."]` / `admin reassign --seat <from> --to <seat>` / `admin reverse` | Interrupt & reopen round / reassign current turn / swap reviewer-executor direction (each bumps `epoch`). |
| `admin retry [--seat <id>]` / `admin skip` / `admin cancel` / `admin wake --seat <id>` / `admin close` | Resolve timed-out turns, skip an absent seat, void the active attempt, push an opt-in wake, or close the room (issuing a Farewell Packet). |
| `admin reconcile <attemptId> replay\|void` | Resolve an open attempt left pending across a service crash/restart. |
| `admin approve-disclose <id>` / `admin deny-disclose <id> --reason "..."` / `admin accept-stale <manifestSha>` | Execute or deny a snapshot disclosure request; explicitly accept an inspected stale diff. |
| `admin pi-key --port <n> [--seat <id>]` | Send a hosted Pi API key (from `stdin` or `ROOM_PI_API_KEY`) over loopback into service memory only. |
| `admin pi-key --save \| --status \| --forget` | Windows-only CurrentUser DPAPI ciphertext management at `<ROOM_DEV_HOME>/secrets/pi-key.dpapi` (no `--dir`). |
| `admin export [--out <zip>] [--redact]` / `admin log` / `admin show` | Export public room layers (fails on secret patterns unless `--redact`); inspect event log or room summary. |

### Seat Commands, Audit & Optional Client Driver

- **Seat commands** (`--seat <seatDir>`, turn commands add `--attempt <id>`): `wait`, `submit`, `status [--log] [--whoami]`, `leave`, `artifacts --declare <paths>... [--baseline none|whole|<sha>] [--exclude <glob>]`, `point`, `quote`, `mark`, `verdict pass|reject|disclose`, `disclose --arg <v>... --reason "..."`, `pass`, `misquoted`, `assign --file <draft.md>`.
- **Audit**: `node room.mjs audit --seat <seatDir> [--packet <id>] [--verbose]` — read-only native-log verification.
- **Optional seat-side driver**: `node room.mjs drive --seat <seatDir> [--runner codex-cli] --model <id> --effort <level> [--codex-exe <path>] [--max-turns <n>]` — runs outside the room service, never imports `lib/service.mjs`, writes only to the seat's outbox.

## 4. Repository Layout

```text
room.mjs                CLI entrypoint (seat commands strip env & load only lib/seat.mjs)
lib/                    Zero-dependency ESM core (service, reducer, http, lobby, daemon-store,
                        seat, admin, join, driver, packet, surface, i18n, budget, usage,
                        structured, supervision, workspace, audit, spawn, guard, codex, api,
                        export, zip, hosted/{pi,dpapi}, templates/*.md)
ui/                     Zero-build Web UI (Group-Chat & Arena room view, lobby, mock-server, fixtures)
app/                    Optional Windows Electron desktop shell (main, main-helpers, preload, icon)
sim/                    Deterministic in-process simulation driver & scripted seats
test/                   Unit tests, test/cases/*, test/mutations/*, test/e2e.mjs, test/real/README.md
contract/ & evidence/   Non-interference contract verifiers & evidence aggregator
dist/                   Offline desktop packager, ZIP packager, public-export scanner, THIRD-PARTY.md
docs/                   INTERFACES, DESIGN, NON-INTERFERENCE, SUPPORT-MATRIX, POSITIONING, DEMO, DEVELOPER
```

## 5. Testing, Mutations & Contract Checks

- Run targeted suites: `node --test test/ui.test.mjs`, `node --test "test/cases/*.test.mjs"`, `node --test "test/mutations/*.test.mjs"`.
- Mutation switches (`ROOM_MUTATE`): `no-dedupe`, `no-attempt-check`, `no-recompute`, `no-audit`, `no-escape`, `no-unanswered`, `no-disclose-gate`, `no-marker-strict`.
- Preview the Web UI against fixture data without a live room: `node ui/mock-server.mjs --port 0`.
- Non-interference contract scripts: see [`contract/README.md`](../contract/README.md). Manual real-agent acceptance checklist: see [`test/real/README.md`](../test/real/README.md).

## 6. Optional Windows Desktop Shell & Packaging

- **Build desktop shell offline**: `npm run app` (`node dist/build-app.mjs [--electron-zip <zip>] [--rcedit <exe>] [--out <dir>] [--zip] [--dry-run]`). Uses only locally cached Electron runtime zips and `rcedit` (never downloads anything) to assemble `AgentRoundtable.exe` (or localized build output), `BUILD.json`, and `THIRD-PARTY.md`.
- **Desktop self-check**: run with `--smoke` or `--smoke-room` and `ROOM_APP_SMOKE_OUT=<path-under-appRoot>`.
- **Developer Windows ZIP**: `node dist/build.mjs [--no-download]` produces a portable archive with a `launch.cmd` launcher and `THIRD-PARTY.md`.
- **Clean public export check**: `npm run public-scan` / `node dist/export-public.mjs <outDir> [--deny-file <file>]`.
