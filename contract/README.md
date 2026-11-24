# contract/ — Non-Interference Verification Tools

These scripts are **user-side measurement tools**, independent of the room service. They verify the clauses of [`docs/NON-INTERFERENCE.md`](../docs/NON-INTERFERENCE.md): write boundaries, untouched agent configs/memories/hooks, process isolation, and inherited credential stripping.

Every result uses the strict phrasing **"not observed under method X"**. `PASS` means the check observed no violation — never that an unobserved violation is impossible. Each section below notes its blind spots.

## Running the Checks

Run the full evidence bundle (unit tests, E2E, and all contract checks -> gitignored `evidence/REPORT.md`):

```bash
node evidence/collect.mjs [--run-dir <dir>] [--report <file>] [--skip-tests] [--skip-e2e] [--no-baseline]
```

Run individual contract checks:

```bash
node contract/control-run.mjs [<roomDir>] [--run-dir <dir>] [--dir <path>]... [--extra-dir <path>]... [--no-baseline]
node contract/check-writes.mjs <roomDir> [--outbox <dir>]...
node contract/env.mjs [--run-dir <dir>] [--room <roomDir> --seat <seatDir>]
node contract/pids.mjs snapshot [--out <file>] | compare <before.json> <after.json> [--service-pid N] [--room <roomDir>] [--room-pids 1,2] | services [--room <roomDir>]
node contract/memory-diff.mjs <target>... --save <file> | [<target>...] --against <file> | --before <a.json> --after <b.json>
```

### Common Conventions
- Output lines begin with `PASS`, `FAIL`, `SKIP`, `INFO`, or `RAW` (followed by absolute raw-record paths). Exit `0` when there are no `FAIL` lines; `1` otherwise (`SKIP` does not fail).
- Ephemeral run directories live strictly under `testRunsRoot()` (`~/room-dev/test-runs/`, honoring `ROOM_DEV_HOME`), never under Windows `%LOCALAPPDATA%`.
- Scripts drive rooms exclusively via the public CLI and contract files (`room.json`, `events.jsonl`, `write-log.jsonl`, `service.lock`), write through `lib/guard.mjs`, and spawn children via `lib/spawn.mjs` (shared helpers in `contract/harness.mjs`).

## Tools & Known Blind Spots

### `check-writes.mjs` (Clauses 1 & 4)
Reads `<roomDir>/write-log.jsonl` and each seat outbox's `write-log.jsonl`. Asserts that `who=service`/`admin` paths stay strictly inside `<roomDir>` and outside all seat `cwd`s, `who=seat:<id>` paths stay inside that seat's own outbox log, unknown authors or malformed lines fail, empty room logs fail, and `<roomDir>` has no virtualization redirect (comparing normalized `realPathNative` paths).
- **Blind spots**: `write-log.jsonl` is self-reported by `lib/guard.mjs`. Direct `fs` calls bypassing the guard or external child writes require OS-level file auditing (e.g., ProcMon / ETW).

### `control-run.mjs` (Clauses 1, 2, 4 & 7)
Runs a full scripted `A,B,A` session with **no live agents** (`admin init`, `add-seat`, `serve`, scripted turns, `close`). Takes content-hash snapshots (`path + type + size + sha256`, ignoring `mtime`) before the run, after the run, and after an equal-length idle **baseline window** across four target groups: `config`, `instructions`, `hooks`, and `memory` (for both `~/.claude` and `$CODEX_HOME`, customizable with `--dir` / `--extra-dir`). Items that change naturally during the idle baseline window are excluded and listed in `INFO` lines; all other diffs fail. Also verifies seat workspace listings and PID sets.
- **Why session transcripts are excluded from diffing**: Live transcripts (`~/.claude/projects/*/*.jsonl`, `$CODEX_HOME/sessions/`, Codex SQLite stores) are continuously appended by other sessions on the host; those paths are covered by `check-writes.mjs` and auditor open-file containment instead.
- **Blind spots**: Covers room code paths without live agents; transient write-then-revert edits between snapshots are invisible without OS-level tracing.

### `pids.mjs` (Clause 2)
Snapshots `codex|claude|node` processes with parent-PID chains (Windows `Win32_Process` / `tasklist`; POSIX `ps`). Passes if the agent PID set is unchanged or any new agent PID has no room PID anywhere in its ancestor chain; fails on unattributable spawns, vanished agent PIDs, or lingering `serve` processes / `service.lock` after `close`.
- **Blind spots**: Cannot detect `OpenProcess`/attach calls, short-lived processes between snapshots, or identify what terminated a vanished PID.

### `env.mjs` (Clause 3)
Seeds unique canary values into 6 credential env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `ROOM_CANARY_SECRET`), runs room and seat commands, then checks: (1) canary values never appear in room files, outboxes, or stdout/stderr; (2) a `NODE_OPTIONS=--import` preload confirms canary env keys are stripped before seat process exit; (3) `lib/spawn.mjs` passes only allowlisted keys (plus implicit Windows libuv vars).
- **Blind spots**: Checks seeded canary keys only; does not inspect process heap memory.

### `memory-diff.mjs` (Clauses 7 & 8)
Standalone content-hash snapshot/diff helper for manual before/after comparisons around live multi-agent sessions (`--save`, `--against`, `--before`/`--after`).

## Unit Tests
`test/contract.test.mjs` covers snapshot diffing, baseline exclusion, path-containment edge cases, negative controls (deliberate out-of-bounds write-log entries, room-spawned agent PIDs, and leaked canary values must fail), exit-env probing, and report rendering.
