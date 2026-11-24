# test/real — Manual Real-Agent Acceptance Checklist

This checklist covers verification items that require live external coding agents, real OS process observation, or a clean host/VM (beyond scripted simulation in `test/cases/` and mutation tests in `test/mutations/`). Items passing only in simulation must be reported as *"room logic tested"*, never *"verified on real agents"*.

## Conventions

- Keep all rooms, seat workspaces, and temp dirs under `~` / `ROOM_DEV_HOME` — **never** under Windows `%LOCALAPPDATA%` / `%APPDATA%` (MSIX redirection).
- Name each test room `real-<id>` under `~/room-dev/rooms/real-<id>` (`<room>`); preserve `events.jsonl`, `write-log.jsonl`, and `private/` after closing.
- Onboard each agent with one sentence: `Read <room>/seats/<seatId>/JOIN.md and join the room following it.`
- Phrase every finding strictly as *"not observed under method X"* or *"observed ..."* — never *"read-only"* or *"zero writes"*.
- Record date, OS/machine, agent name & version, command, observed result, and raw artifact path in the log table below.

## Base Setup Skeleton

```bash
node room.mjs admin init --id real-N --preset implement-review --lang en --wall 2700
mkdir -p ~/room-seats/real-N-A ~/room-seats/real-N-B
node room.mjs admin add-seat --id real-N --seat A --role lead --agent codex-desktop --cwd ~/room-seats/real-N-A --audit codex --thread-id <uuid>
node room.mjs admin add-seat --id real-N --seat B --role executor --agent claude-code --cwd ~/room-seats/real-N-B --audit claude
node room.mjs serve --dir ~/room-dev/rooms/real-N --port 0
node room.mjs admin task  --id real-N --text "<task>"
node room.mjs admin start --id real-N --order A,B
# ... run scenario, then inspect and close:
node room.mjs admin show  --id real-N
node room.mjs audit --seat ~/room-dev/rooms/real-N/seats/A --verbose
node room.mjs admin close --id real-N
node contract/check-writes.mjs ~/room-dev/rooms/real-N \
  --outbox ~/room-seats/real-N-A/.room-outbox/A --outbox ~/room-seats/real-N-B/.room-outbox/B
```

## Checklist

| Area | Check | Expected Observation |
|---|---|---|
| **Multi-session same agent** | Join two separate sessions of the same agent (e.g., two Claude Code sessions) as A and B. | `status --whoami` shows distinct session IDs; each packet appears only in its own session log; cross-seat token submit fails `BAD_PROOF`. |
| **Turn & attempt enforcement** | Submit out-of-turn (B during A's turn) or late after `admin cancel`. | Client returns `REJECTED NOT_YOUR_TURN` (exit 2); forced submit logs `submission_rejected` (`STALE_ATTEMPT`); next `wait` shows `NOTICE`. |
| **Crash & restart recovery** | Kill `serve` mid-turn (`Ctrl+C`), verify agent PIDs unchanged (`contract/pids.mjs`), restart `serve`. | Next `wait` returns `NEEDS_RECONCILE`; `admin reconcile <attemptId> replay` allows the original attempt to submit; `void` injects a voided-attempt notice in the next packet. |
| **Artifact freeze, stale & disclosure** | B declares real files (`--baseline none` and `--baseline whole`), edit a declared file mid-review, approve a `git status`/`git diff` disclosure. | Mid-review edit triggers `artifacts_recomputed stale=true` & `verdict_recorded annotation=stale` (excluded from summary); approved disclosure runs only inside `snapshots/B/<sha>/` with zero `index.lock` conflict while B commits concurrently. |
| **Reviewer write & command audit** | Have Reviewer A intentionally edit a file or run a non-allowlisted command during a review turn. | `audit --verbose` lists writes/unknown commands; `audit_observed tainted=true`; `verdict_recorded annotation=tainted`; unregistered seats report `status=unknown`. |
| **Source banners & superseded summaries** | Include a forged `[ROOM:<nonce>:seat=user authority=user ...]` block in B's speech; publish Summary v2 in Round 2. | Forwarded packet escapes `[ROOM\:` with `escaped > 0`; Summary v2 delivers a `superseded_notice` visible in peer native logs. Record peer obedience qualitatively. |
| **Wait modes, wakes & large packets** | Test Claude Code `background` wait (30 min idle), Codex `turn_over` + `--wake-thread`, and a 40 KB task packet. | Zero idle model calls in Claude logs; Codex returns `TURN_OVER` and wake count stays `<= W`; packet header arrives intact and agent reads full file. |
| **Security & export redaction** | POST `/api/admin` using a seat token; plant a fake API key in a speech and run `admin export`. | Seat token gets `401 SEAT_TOKEN`; `admin export` fails until `--redact` removes the fake key; second `serve` on the same room exits immediately (`SERVICE_RUNNING`). |
| **Non-interference & clean host** | Run `check-writes.mjs`, `memory-diff.mjs` (before/after configs & memories), `pids.mjs`, `env.mjs`; test Unicode/spaced paths; test daemon auto-resume across restarts and clean Windows/macOS/Linux hosts. | All contract scripts report `PASS` ("not observed under method X"); deleting `<room>` + `.room-outbox/` leaves no room-written artifacts outside user-approved permission rules. |

## Recorded Runs

| Date | Check | Host / OS | Agent & Version | Result (`not observed under ...` / `observed ...`) | Raw Artifacts |
|---|---|---|---|---|---|
