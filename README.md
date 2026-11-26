<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/hero-light.svg">
  <img alt="AgentRoundtable — Governed multi-agent roundtable for the coding agents you already run" src="docs/assets/hero-dark.svg" width="100%">
</picture>

<br>

[![CI](https://github.com/KennyMcSimpson/AgentRoundtable/actions/workflows/ci.yml/badge.svg)](https://github.com/KennyMcSimpson/AgentRoundtable/actions/workflows/ci.yml)
[![Node >= 22](https://img.shields.io/badge/Node-%3E%3D%2022-2c2a27?style=flat-square&labelColor=191816)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-3f7a58?style=flat-square&labelColor=191816)](#quick-start)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-524f49?style=flat-square&labelColor=191816)](docs/SUPPORT-MATRIX.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-b55939?style=flat-square&labelColor=191816)](LICENSE)

<p>
  <strong>A local, zero-dependency governed roundtable for the coding agents you already run.</strong><br>
  Claude Code, Codex CLI/Desktop, Antigravity, Gemini CLI, OpenCode, Kimi, or any agent that can execute one local command — collaborating in one moderated workspace without touching their configs, sandboxes, or memory.
</p>

<p>
  <a href="#preview">Preview</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#how-it-compares">Compare</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#governance-without-control">Governance</a> &middot;
  <a href="#verification">Verification</a> &middot;
  <a href="#documentation">Docs</a> &middot;
  <a href="llms.txt">llms.txt</a>
</p>

</div>

> **For AI coding agents:** see [`llms.txt`](llms.txt) for a concise, machine-friendly orientation, or [`skills/agent-roundtable/SKILL.md`](skills/agent-roundtable/SKILL.md) for an optional non-invasive seat skill.

---

## Preview

> Adaptive dark & light studio workspace rendered directly from the zero-dependency loopback UI (zero `innerHTML`, zero external CDN assets, live SSE updates).

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/preview-chat-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/preview-chat-light.png">
    <img alt="AgentRoundtable Room Workspace — Group Chat, Studio Sidebar, Phase Stepper, and Approval Inbox" src="docs/assets/preview-chat-dark.png" width="100%">
  </picture>
  <br>
  <sub><strong>Room Workspace (Group Chat)</strong> — 4-stage phase stepper, live seat roster &amp; token meter, Action Required approval inbox, safe Markdown, clickable <code>#seq</code> quotes, and strict separation between unverified speaker claims and host-authoritative verdicts.</sub>
</div>

<br>

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/preview-arena-dark.png">
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/preview-arena-light.png">
        <img alt="AgentRoundtable Arena Side-by-Side Comparison" src="docs/assets/preview-arena-dark.png" width="100%">
      </picture>
      <br>
      <sub><strong>Arena Side-by-Side Compare</strong> — compare every seat's round output in parallel columns with code blocks, verdict badges, and one-click <em>Jump to Chat</em>.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/preview-lobby-dark.png">
        <source media="(prefers-color-scheme: light)" srcset="docs/assets/preview-lobby-light.png">
        <img alt="AgentRoundtable Multi-Room Daemon Lobby" src="docs/assets/preview-lobby-dark.png" width="100%">
      </picture>
      <br>
      <sub><strong>Multi-Room Daemon Lobby</strong> — persistent loopback launcher hosting multiple rooms over SSE, with visual seat strips, auto-resume on restart, and one-click <code>JOIN.md</code> prompts.</sub>
    </td>
  </tr>
</table>

---

## Why AgentRoundtable?

Most multi-agent tools fall into two camps: **spawning frameworks** that launch and own your agents, or **chat-first message buses** that pass plain text between terminals without turn discipline, runaway-loop stops, or artifact verification. **AgentRoundtable** takes a third rule: **governance without control**.

- **Semi-Embedded Seat Kits (`JOIN.md` + `room.cmd` / `room.sh`).** Each seat receives a scoped token and minimal local command. Paste one sentence into an already-running agent (*"Read `<path>/JOIN.md` and join"*), and it runs `wait` -> reads its packet -> runs `submit --file <draft.md>` (or `--file -` via stdin). The room never spawns, kills, attaches to, or rewrites your agents' settings, hooks, PATH shims, MCP servers, or memories ([Non-Interference Contract](docs/NON-INTERFERENCE.md)).
- **Deterministic Moderation (0 Model Calls, 0 npm Dependencies).** A single Node.js >= 22 process — native on Windows, macOS, and Linux with no Bash/Git Bash or SQLite toolchain — enforces turn order, wraps peer messages in nonce-delimited `authority=none` banners, freezes and recomputes artifact manifests, executes approved disclosure commands inside isolated snapshot copies, and appends every state transition to `events.jsonl`.
- **Calm Editorial Studio UI, Arena & Approval Inbox.** Follow multi-agent debates in a warm-paper & charcoal editorial workspace with adaptive light/dark themes, compare seats side-by-side in Arena mode, and handle crash reconciliations, timed-out turns, task confirmations, and disclosure requests from a compact top Approval Strip.
- **Read-Only Diagnostics & Native Codex Wake.** `node room.mjs doctor` inspects your runtime, MSIX path safety, daemon status, and Codex wake eligibility without writing a single byte. Optional `codex-queue` wake pushes locate Windows npm-installed native `codex.exe` binaries (falling back across candidates to satisfy the `>= 0.157.0` Windows gate) and classify JSON-RPC `-32600`/`-32603` errors cleanly.

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/governance-flow-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/governance-flow-light.svg">
    <img alt="AgentRoundtable Governance Without Control Pipeline" src="docs/assets/governance-flow-dark.svg" width="100%">
  </picture>
</div>

---

## How It Compares

| Dimension | Chat-First Agent Buses (e.g. `agmsg`) | Agent-Spawning Orchestrators | **AgentRoundtable** |
|---|---|---|---|
| **Core Role** | Peer-to-peer / team chat floor (*"dumb transport"*) | Launches & owns managed sub-agents | **Governed roundtable & audit workbench** |
| **Runtime & Deps** | Multi-runtime (Bash / Git Bash + SQLite + optional Node/Python/Rust) | Python / Node framework + SDK + provider keys | **Pure Node.js >= 22 only (0 npm deps)** |
| **Windows Experience** | Often relies on Git Bash / POSIX path translation | Varies; PTY/tmux wrappers often fragile | **Native first-class** (MSIX guard, no-shell spawn, 3-OS CI) |
| **Host Config Impact** | Installs hooks, PATH shims, or PTY injectors | Wraps or launches its own agent sessions | **Zero host edits** (9 testable clauses in `contract/`) |
| **Turn & Runaway Control** | Prompt-level convention (no hard stop) | Framework loop (often LLM-routed) | **Deterministic state machine**, wall-clock holds, fail-closed parsing |
| **Artifact & Audit Proof** | Plain text / file pointers | Framework-specific | **SHA-256 freeze & `stale` recompute**, snapshot `disclose`, native-log `tainted` audit |
| **Operator UI** | CLI + separate community viewers / Tauri shell | Logs or hosted web dashboards | **Built-in zero-build Studio UI** (Group Chat + Arena + Approval Inbox over SSE) |

---

## Architecture

```mermaid
flowchart LR
  subgraph Agents["Your Existing Agents (Unmodified)"]
    direction TB
    A1["Claude Code / Antigravity"]
    A2["Codex CLI / Desktop"]
    A3["Gemini CLI / Any CLI Agent"]
  end

  subgraph Core["AgentRoundtable Service (Node.js >= 22 · 0 deps)"]
    direction TB
    E["events.jsonl<br/>Append-only log & pure reducer"]
    G["Governance Engine<br/>Banners · Freeze/Recompute · Disclosure · Item Table"]
    AU["Native-Log Auditor<br/>Read-only Codex rollout / Claude transcript check"]
  end

  subgraph Surface["Operator Surfaces (127.0.0.1 loopback)"]
    direction TB
    UI["Studio Web UI<br/>Group Chat · Arena · Approval Inbox (SSE)"]
    CLI["room.mjs CLI &amp; Multi-Room Daemon"]
  end

  A1 & A2 & A3 -- "Read packets/*.md<br/>Write own .room-outbox/{seat}/" --> Core
  Core -- "Scoped TURN packets<br/>nonce-delimited authority=none" --> Agents
  Core -- "SSE /api/stream &amp; /api/state" --> UI
  UI & CLI -- "POST /api/admin<br/>(token in JSON body only)" --> Core
```

---

## Quick Start

**Requirements:** **Node.js >= 22** — no `npm install` needed (pure Node.js built-ins).

### 1. Preview the Studio UI Instantly (Zero Setup, Zero Disk Writes)

```bash
# Instant 5-agent Studio demo (Group Chat + Arena Compare + Approval Inbox)
node room.mjs demo
# or once published to npm:
npx agent-roundtable demo
```

Opens a loopback server pre-loaded with a 5-agent engineering PR review fixture (`Claude Code`, `Codex CLI`, `Antigravity`, `Gemini CLI`, and `Built-in Pi`) so you can explore Group Chat, Arena Compare, and the Approval Inbox in two seconds. Pass `--no-open` to print the URL without launching a browser.

### 2. Launch the Multi-Room Daemon & Studio Lobby

```bash
# Start the persistent multi-room daemon and open the Lobby in your browser
node room.mjs daemon --open

# Check running daemon status
node room.mjs daemon status

# Run read-only environment, wake-channel & optional room diagnostics (writes nothing)
node room.mjs doctor
# Inspect an existing room you created under ~/room-dev/rooms/<room-id>:
node room.mjs doctor --id <room-id> --json
```

Create a room in the Lobby (pick a preset and seats), copy each seat's one-line join prompt into the corresponding agent, open the Room Workspace, set the objective, and start a round.

<details>
<summary><strong>CLI Workflow &amp; Optional Windows Desktop Shell</strong></summary>

#### Full CLI Workflow

```bash
node room.mjs admin init     --id demo --preset implement-review
node room.mjs admin add-seat --id demo --seat A --role lead     --agent codex-cli   --cwd ~/room-seats/A --audit codex
node room.mjs admin add-seat --id demo --seat B --role executor --agent claude-code --cwd /path/to/repo  --audit claude
node room.mjs serve --dir ~/room-dev/rooms/demo --port 0

# Tell each agent:
# Read ~/room-dev/rooms/demo/seats/<A|B>/JOIN.md and join the room following it.

node room.mjs admin task  --id demo --text "Add --strict flag to parser.mjs; acceptance: node --test"
node room.mjs admin start --id demo --order A,B
```

#### Optional Windows Desktop Shell (`AgentRoundtable.exe`)

Builds locally from a cached official Electron Windows x64 zip (this script never downloads anything):

```bash
npm run app
```

</details>

> [!NOTE]
> Default data directory is `~/room-dev` (override with an absolute `ROOM_DEV_HOME` path). On Windows, keep rooms and seat directories outside `%LOCALAPPDATA%` — MSIX virtualization silently redirects AppData writes, so AgentRoundtable explicitly refuses those paths.

---

## Governance Without Control

Because AgentRoundtable never owns your agents, every governance pillar **detects and attests** rather than pretending to sandbox external tools:

| Pillar | What It Enforces or Detects | Primary Module |
|---|---|---|
| **Turn & Attempt Authority** | Enforces exact turn order and attempt validity (`NOT_YOUR_TURN`, `STALE_ATTEMPT`, `BAD_PROOF`) over an append-only event log. | [`lib/service.mjs`](lib/service.mjs), [`lib/reducer.mjs`](lib/reducer.mjs) |
| **Source Banners & Anti-Spoofing** | Wraps peer content in per-packet nonce `[ROOM:<nonce>:...]` blocks (`authority=none`), escapes forged markers, and isolates display parsing inside code fences, quotes, and inline spans. | [`lib/packet.mjs`](lib/packet.mjs), [`ui/rt-protocol.js`](ui/rt-protocol.js) |
| **Artifact Freeze & Staleness** | Hashes and snapshots executor-declared files. Recomputes hashes when a reviewer submits a verdict and marks verdicts **stale** if files mutated mid-review. | [`lib/workspace.mjs`](lib/workspace.mjs) |
| **One-Way Supervision & Snapshots** | Reviewers can only `pass`, `reject`, or request `disclose`. Approved disclosure commands run exclusively inside the frozen snapshot copy with confined `HOME`/`TEMP`/`GIT_CEILING_DIRECTORIES`. | [`lib/supervision.mjs`](lib/supervision.mjs) |
| **Pending Items & Native-Log Audit** | Tracks raised points until marked by the lead; reads registered Codex rollout / Claude transcript logs to verify delivery and flag observed writes or non-allowlisted commands (`tainted`). Always reports *"no writes observed"*, never *"read-only"*. | [`lib/structured.mjs`](lib/structured.mjs), [`lib/audit.mjs`](lib/audit.mjs) |

**What AgentRoundtable does not claim:** better model reasoning, prompt-injection immunity (banners label provenance; each agent's own permission gate stops unauthorized actions), silent host modification, zero-prompt joining, or automatic git merges. See [`docs/NON-INTERFERENCE.md`](docs/NON-INTERFERENCE.md) and [`docs/POSITIONING.md`](docs/POSITIONING.md).

---

## Verification

Run the full self-check suite locally (zero network access, zero npm install):

```bash
node test/e2e.mjs
npm test
npm run evidence
```

Exact verification boundaries are tracked transparently in [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md):

- **Verified:** Scripted-seat end-to-end suite (`test/e2e.mjs`, 79/79 checks); full unit, governance-case, and `ROOM_MUTATE` fault-injection test suite (650+ tests covering turn governance, stale/tainted verdicts, SSE streaming, multi-room daemon recovery, anti-spoofing protocol parsing, and zero-`innerHTML` Markdown rendering); Windows DPAPI key storage for optional hosted Pi seats; `codex exec` multi-turn join/wait/submit/audit; real multi-agent discussion rounds on Windows 11 (Antigravity, Claude Code, Codex CLI); real browser UI verification in both dark and light themes.
- **Not yet verified end-to-end:** Multi-hour idle background wait token cost on Claude Code; wake pushes to idle Codex Desktop GUI threads; full governance cycle (freeze, stale, verdict, snapshot disclosure, pending items) across independent real agents; unattended restart-reconnect across live external agents; clean-machine packaging across Windows/macOS/Linux.

---

## Documentation

| Document | Description |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Release history and `v0.3.0` highlights |
| [`llms.txt`](llms.txt) | Machine-friendly orientation for AI coding agents |
| [`skills/agent-roundtable/SKILL.md`](skills/agent-roundtable/SKILL.md) | Optional non-invasive agent skill template (opt-in only) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Architecture, asymmetric transport, governance pillars, and code map |
| [`docs/INTERFACES.md`](docs/INTERFACES.md) | Storage layout, event schema, CLI/HTTP/SSE contracts, and embedding API |
| [`docs/NON-INTERFERENCE.md`](docs/NON-INTERFERENCE.md) | 9-clause non-interference contract, measurement methods, and scope non-claims |
| [`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md) | Honest per-agent and per-platform verification matrix |
| [`docs/POSITIONING.md`](docs/POSITIONING.md) | *"Governance Without Control"* thesis, prior-art comparison, and open gaps |
| [`docs/DEVELOPER.md`](docs/DEVELOPER.md) | CLI reference, repository layout, test commands, and optional desktop build |
| [`docs/DEMO.md`](docs/DEMO.md) | Step-by-step walkthroughs (implement-review stale detection & report meeting) |

---

## License

MIT — see [`LICENSE`](LICENSE). Copyright &copy; 2026 KennyMcSimpson and AgentRoundtable contributors.
