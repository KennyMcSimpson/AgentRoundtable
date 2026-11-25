# Changelog

All notable changes to `AgentRoundtable` (`room-dev`) are documented here.

## [0.2.1] - 2026-11-25

### Changed & Polished
- **100% Pure-English Open-Source Edition**:
  - Consolidated all 188 tracked files to clean, idiomatic English (0 CJK characters, 0 UTF-8 BOM, `PUBLIC_SCAN_OK`), promoted English packet templates directly to `lib/templates/*.md`, added [`docs/NON-INTERFERENCE.md`](docs/NON-INTERFERENCE.md), and renamed the optional Windows desktop shell to `AgentRoundtable.exe`.
- **Studio Web UI Redesign & UX Decluttering**:
  - Redesigned the Room Workspace (`ui/index.html`, `ui/app.css`, `ui/rt-chat.css`, `ui/app.js`, `ui/rt-chat.js`) and Multi-Room Daemon Lobby (`ui/lobby.html`, `ui/lobby.css`, `ui/lobby.js`) in a calm Linear / Claude Desktop aesthetic with adaptive dark & light themes (`#btn-theme`, zero `localStorage`, zero `innerHTML`).
  - Eliminated nested box-in-box bubble clutter with slim left-bar inline quotes, borderless dashed-left speaker claims, hairline authoritative footers, collapsible sidebar Diagnostics, single-line collapsible Objective bar, and collapsible Round Controls.
  - Auto-folded completed directives (`Assignment Draft · Confirmed`, recorded `pass`/`disclose` claims, executed/denied disclosures, resolved points) into compact 1-line summaries while keeping pending directives expanded, and adapted the top phase stepper (`#hdr-stepper`) to hide `Assign`/`Work` in discussion-only rooms.
- **Flagship README & Visual Assets**:
  - Added adaptive dark/light vector SVG hero banners (`docs/assets/hero-{dark,light}.svg`), 16:10 dark/light Studio UI screenshots across Group Chat, Arena Compare, and Multi-Room Lobby, Mermaid architecture diagram, and governance matrix.

### Fixed
- **Cross-Platform 3-OS CI All Green (`windows-latest`, `ubuntu-latest`, `macos-latest`)**:
  - Exported `WAKE_ENV_KEYS` from `lib/service.mjs` for POSIX/Windows wake env checks (`test/service.test.mjs`).
  - Exported `IMPLICIT_DARWIN_VARS` (`__CF_USER_TEXT_ENCODING`) from `lib/spawn.mjs` for macOS environment isolation tests (`test/spawn.test.mjs`, `contract/env.mjs`).
  - Updated `test/app.test.mjs` to assert `room.sh` on POSIX and `room.cmd` on Windows.
  - Upgraded `.github/workflows/ci.yml` to `actions/checkout@v7` and `actions/setup-node@v7` (native Node 24 runner support).

## [0.2.0] - 2026-11-24

### Added
- **Unified Group-Chat & Arena Web UI**:
  - Group-chat conversation view (`ui/rt-chat.js`, `ui/rt-chat.css`) with round dividers, seat-family avatars and colors, right-aligned lead bubbles with a crown badge, collapsible long messages, clickable `#seq` quote jumps with highlight, and clear visual separation between dashed speaker-claim cards and solid host-authoritative mark/verdict chips.
  - **Arena side-by-side mode**: compare every seat's responses per round in responsive columns with one-click jump back to the chat thread.
  - **Sticky Approval Inbox**: surfaces pending task-draft confirmations, timed-out turn decisions (`retry` / `skip`), crash-recovery reconciliations (`replay` / `void`), and disclosure requests (`approve` / `deny`) at the top of the room UI.
  - Hardened display protocol parser (`ui/rt-protocol.js`, 60k surrogate-safe clamping, 128-entry LRU cache, 5 protected spans, prototype-pollution immunity) and zero-`innerHTML` safe Markdown renderer (`ui/rt-markdown.js`, `http`/`https`/`mailto` allowlist, no raw HTML or auto-loading `<img>`).
  - IME-safe bottom composer (`Enter` inserts a newline, `Ctrl/Cmd+Enter` submits, clickable seat-order chips).
- **Real-Time SSE & Multi-Room Auto-Resume Daemon**:
  - Added `GET /api/stream` (`lib/http.mjs`, `ui/mock-server.mjs`) and `GET /lobby/api/stream` + `GET /lobby/api/health` (`lib/lobby.mjs`) with same-origin gating, zero-token URLs, `Last-Event-ID` resume, 32-client cap, and automatic fallback to polling.
  - Added `node room.mjs daemon` and `node room.mjs daemon status` (`lib/daemon-store.mjs`) with atomic registry persistence outside `<roomDir>`, `.bak` corruption recovery, mid-round task-overwrite protection, and automatic resumption of active rooms on restart.
- **Pure-English Protocol, Templates & Light/Dark Theme**:
  - Consolidated all 13 packet templates (`lib/templates/*.md`), room protocol copy (`lib/i18n.mjs`), and the Web UI dictionary (`ui/rt-i18n.js`) into clean, idiomatic English (`en`) with a Light / Dark UI theme toggle.
- **Cross-Platform Support**:
  - Added POSIX `room.sh` generation (`0o755`), `0o600` secret file permissions on non-Windows, macOS `/private/tmp`/`/private/var`/`/private/etc` redirect awareness, POSIX `ps` lock-holder probing, `HOME`/`XDG_*`/`TMPDIR` driver env keys, and `macos-latest` in GitHub Actions CI.

### Fixed
- **Audit taint on unknown commands**: reviewer turns executing non-allowlisted commands (`unknownCommands.length > 0`) now consistently set `tainted: true` across `lib/audit.mjs`, `lib/service.mjs`, and `ui/app.js`.
- **`spawnClean` cancellation & POSIX process-group cleanup**: added `AbortSignal` support and POSIX process-group teardown (`detached: true` + `process.kill(-pid, 'SIGKILL')`) in `lib/spawn.mjs` and `lib/hosted/pi.mjs`.
- **Incremental `cmdWait` reader & `fs.watch`**: replaced full-file re-reads on every poll tick with byte-offset incremental `events.jsonl` reading, `state.json` stat caching, torn-tail handling, and `fs.watch` fast wakeup in `lib/seat.mjs`.
- **Lobby `/lobby/api/folder` auth**: converted from unauthenticated `GET` to token-authenticated `POST` in `lib/lobby.mjs` and `ui/lobby.js`.
- **Public export redaction & cleanliness**: removed personal regexes from `dist/public-scan.mjs` (added regex support to external `--deny-file`), trimmed host-specific internal plugins from public exports, and cleaned private environment leftovers across `lib/`, `dist/`, `docs/`, and `test/`.

## [0.1.0] - 2026-10-05

- Initial public snapshot of `AgentRoundtable` (`room-dev`): core seat/admin/service loop, Work/Meet/Summary governance phases, artifact freeze & recompute, snapshot-isolated disclosure, Codex/Claude native-log audit, Windows DPAPI hosted Pi key storage, loopback Web UI & Lobby, and Windows desktop shell (`AgentRoundtable.exe`).
