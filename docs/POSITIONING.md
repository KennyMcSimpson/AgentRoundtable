# Positioning & Prior Art

## Abstract

`AgentRoundtable` (`room-dev`) rests on one organizing design rule not covered as a unified architecture in prior multi-agent tooling: **governance without control**. Because the room owns no user agent process, configuration, or working directory, every governance mechanism is structured to *detect and attest* rather than *prevent*: staleness recomputation instead of file locks, declared-versus-observed native-log auditing instead of sandboxes, request-only snapshot disclosure instead of reviewer execution, and mandatory provenance banners instead of claiming prompt-injection immunity. The only invariants the room enforces directly are turn order and attempt validity.

A prior-art scan found that every individual mechanism exists in isolation (spotlighting, stale-approval dismissal, maker-checker workflows, native-log auditors, event-sourced agent buses), while the closest multi-agent orchestrators all assume some form of control over the agents. The contribution is therefore a **novel combination** — and it remains empirically unevaluated against manual forwarding. Below we state the core rule, nine incremental mechanisms, seven explicit non-innovations, and the evaluation gaps required to validate the claim.

> **Evidence standard**: "Verified" refers strictly to cells marked `Verified` in [`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md). Unit tests and scripted-seat simulations prove room logic, not live external agent behavior. When prior art is ambiguous, we classify conservatively as incremental or non-novel.

## 1. One-Sentence Positioning

**Add a detect-and-attest governance layer on top of heterogeneous coding agents you already run — without launching, reconfiguring, or controlling them.**

It is not a smarter agent, not a general message bus, and not a hosted multi-CLI launcher.

## 2. The Core Combination: Governance Without Control

Under the nine-clause [Non-Interference Contract](NON-INTERFERENCE.md), the room has no authority over user-owned agents. Each classic control therefore transforms into a non-invasive detect-and-attest mechanism:

| Control-Requiring Pattern | `AgentRoundtable` Detect-and-Attest Equivalent | Implementation |
|---|---|---|
| Lock workspace during review | Freeze declared files by SHA-256 + snapshot; recompute on live workspace at verdict time; mark changed verdicts `stale` and exclude from summary (`accept-stale` covers only the inspected diff). | `lib/workspace.mjs`, `lib/service.mjs` |
| Force reviewer into a managed read-only sandbox | Record `declaredTier` separately; audit the reviewer's native log read-only post-turn; mark `tainted` on observed writes or non-allowlisted commands (`audit_failed` on unknown shape). Always report "not observed", never "read-only". | `lib/audit.mjs` |
| Let reviewer run tests directly in executor repo | Reviewer requests a command + reason; after admin approval, the room runs it without a shell inside the frozen snapshot copy and records exit code + output hash. | `lib/supervision.mjs`, `lib/workspace.mjs` |
| Claim to block prompt injection | Wrap all relayed content in per-packet random nonce blocks (`authority=none`) with repeated header declarations and marker escaping; label provenance honestly without claiming defense. | `lib/packet.mjs` |
| Trust agent self-reported delivery/completion | Completion requires an accepted `submit`; delivery receipts come independently from native logs (`present_in_native` / `header_only` / `unknown`); "seen by model" stays `unknown`. | `lib/service.mjs`, `lib/audit.mjs` |

### Why Prior Art Leaves This Gap
- Detective vs. preventive controls are standard security concepts (NIST SP 800-53, COSO), not new in themselves.
- [skettleson/clauditor](https://github.com/skettleson/clauditor) performs non-invasive post-hoc native-log auditing of Claude Code, Codex, and Cursor, but for single sessions rather than a multi-agent governance protocol.
- The nearest multi-agent coordinators assume control or intentionally omit governance: [DhanushSantosh/AgentComms](https://github.com/DhanushSantosh/AgentComms) enforces leases and spawns/prompts Claude Code, Codex, and OpenCode directly; [ExaDev/agent-comms](https://github.com/ExaDev/agent-comms) rewrites host MCP/plugin/hook configs; [fujibee/agmsg](https://github.com/fujibee/agmsg) provides a cross-vendor local messaging floor (Bash/Git Bash + SQLite + optional daemon/Tauri PTY injector) that installs host hooks/shims and explicitly leaves turn-taking, loop cutoffs, and verification to user prompts; hosted roundtables (such as [bcraavi/ai_roundtable](https://github.com/bcraavi/ai_roundtable)) and [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) spawn their participating agents.

## 3. Nine Incremental Mechanisms

Each mechanism builds on named prior art with a narrow, concrete extension:

1. **Pull-based seat kits (`JOIN.md` + `room` CLI)** — *Prior art*: AgentComms, agent-talk, mcp_agent_mail. *Extension*: Single onboarding file, per-seat token, ASCII status words, exit-0 no-work semantics (`TURN_OVER`), zero edits to agent MCP/hooks/memory. (Not "zero-config": the user still approves the host's first permission prompt.)
2. **Asymmetric file transport** — *Prior art*: Maildir/spool patterns, file-based agent mailboxes. *Extension*: Sized to standard `workspace-write` sandboxes so no sandbox ever needs widening (`<roomDir>` read-only to agents; `<seat.cwd>/.room-outbox/<seatId>/` read-only to service).
3. **Always-on source banners** — *Prior art*: Microsoft *Spotlighting* (arXiv:2403.14720), azure-devops-mcp spotlighting. *Extension*: Non-optional between peer coding agents, `[ROOM:` escaping counted in manifests, header repetition against host output truncation, template linting.
4. **Fail-closed structured verdict parsing** — *Prior art*: LLM-as-judge retry patterns, reviewer-injection literature (arXiv:2509.09912). *Extension*: Strips all nonce-delimited forwarded blocks and Markdown/HTML/fenced quotes before extracting `<<ROOM:...>>` markers (unclosed blocks stripped to EOF), preventing quoted text from forging a verdict; one follow-up on malformed input, then `none` (never `pass`).
5. **Non-git artifact freeze & verdict-time recompute** — *Prior art*: GitHub stale-approval dismissal, Gerrit patch-set voting. *Extension*: File-hash walk without invoking `git` on the executor's repo; exact-diff scoping for `accept-stale` (`STALE_CHANGED_SINCE_ACCEPT`).
6. **Admin-approved snapshot disclosure** — *Prior art*: CI clean checkouts, human-in-the-loop tool approvals, hardened git configs (`CVE-2022-24765`). *Extension*: Executed by the room inside the frozen snapshot without a shell, rejecting arg drift post-approval, path traversal, `.cmd`/`.bat` shims, and dangerous git options.
7. **Attempt-bound native-log audit** — *Prior art*: clauditor, sessionscope, agent-session-facts. *Extension*: Bound directly to a review attempt's verdict (`tainted` blocks `verified`), scoped strictly to registered UUID/session files, with per-packet delivery receipts.
8. **Testable non-interference contract** — *Prior art*: Footprint tests, strace/ProcMon audits, baseline-vs-treatment evaluation. *Extension*: Nine explicit clauses paired with runnable CLI verification scripts (`contract/`) and strict "not observed under method X" reporting.
9. **Programmatic item tables & superseded notices** — *Prior art*: GitHub unresolved review threads, Gerrit unresolved counts, citation verification (arXiv:2605.06635). *Extension*: Lead-only marking with automatic `unanswered` flagging, versioned summaries pushing `superseded_notice` into subsequent packets, and hash-verified quotes failing on superseded `seq`s.

## 4. Seven Explicit Non-Innovations

These reflect careful engineering, not novel contributions:

| Mechanism | Why It Is Not Novel | Established Prior Art |
|---|---|---|
| Programmatic turn ordering, append-only event log, pure reducer, first-terminal-wins dedupe, epochs, crash reconciliation | Standard event sourcing and distributed state machines | AutoGen/AG2 GroupChat, ai_roundtable, fencing tokens, idempotency keys |
| Unidirectional supervision (single lead, acyclic review graph, authorized reviewer binding) | Standard separation of duties / maker-checker | Four-eyes principle, CODEOWNERS, AWS Agentic AI Lens |
| Reviewer rubber-stamp warning (`n >= 14`, `0` rejections) | Simple binomial heuristic | Rubber-stamp review metrics (minware, Code Climate) |
| Shared protocol across vendor agents | Widely implemented across modern agent standards | ACP, A2A, MCP, AgentComms |
| Fault-injection mutation switches (`ROOM_MUTATE`, 8 switches) | Standard mutation testing for test-suite assurance | DeMillo et al. (1978), Stryker, PIT, mutmut |
| Detecting Windows MSIX AppData virtualization via `realpathSync.native` | Documented platform behavior worth surfacing clearly | Microsoft Learn packaged-app docs, platformdirs, Claude Code issues |
| Whole-message deterministic budget trimming, CLI exit codes, DPAPI stdin piping, secret-redacting export | Good systems engineering hygiene | LangGraph trimming, PowerShell 4104 guidance, gitleaks/trufflehog |

## 5. Honest Evaluation Gaps

To move from a coherent design claim to an empirically validated contribution, the project still needs:
1. **Controlled comparison**: Running the same multi-agent coding tasks with manual copy-paste forwarding vs. `AgentRoundtable` to measure whether staleness detection, item tables, and auditing catch real failures manual forwarding misses.
2. **Independent live-agent governance trials**: Recording full freeze -> edit -> `stale` -> snapshot disclosure -> audit taint cycles on independent Codex Desktop, Claude Code, and other external sessions ([`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md)).
3. **Audit fragility bounds**: Native log formats are undocumented vendor internals; rejected writes leave no log entry, and cross-host coverage remains partial.
4. **Threat-model boundary**: Seat tokens currently live under `<roomDir>/seats/<id>/token`, readable by other local processes; turn enforcement guards against confused agents, not hostile local peers.
