# solo-conductor Specification

Decisions: `context.md`. Builds on `live-progress` and `agent-live`.

## Problem Statement

tlc-execute and `tlc run` start fresh agents for every stage of every task (implement,
verify, advise, fix, commit). Each one re-reads the specs and the code, so a 15-task
feature spends millions of tokens, much of it on repeated context. The dashboard also
has to be started by hand and can end up running twice.

## Goals

- [ ] Default runs use one worker agent per run whose context carries over between tasks, with a conductor doing scheduling, gates and commits in code.
- [ ] Token use for the same plan drops substantially versus crew mode (target ≥ 50 % on the e2e fixture, measured from usage events).
- [ ] Installing tlc-deck leaves exactly one dashboard daemon running, started automatically when missing.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Parallel tasks in solo mode | One worker = sequential |
| Removing crew mode | D-01 keeps it |
| Remote daemon | Localhost only (live-progress D-04) |

---

## User Stories

### P1: Conductor + single worker (`tlc run`) ⭐ MVP

**Acceptance Criteria**:

1. `tlc run` SHALL default to `mode: "solo"` (config `mode`, flag `--mode solo|crew`); crew keeps today's behaviour.
2. In solo mode the conductor SHALL send each task, in dependency order, as a new turn to the same worker session (first turn: rules + spec/design/context paths; later turns: the task block only), resuming the harness session by id.
3. After the worker reports, the conductor SHALL run the task's gate command (resolved from the task's `**Gate**` value via the tasks.md "Gate Check Commands" table, or an inline backticked command); on failure it SHALL send the failing output (last 4 KB) to the same session as a fix turn, up to `retries` times.
4. After the gate passes, a reviewer (default `{harness: claude, model: haiku}`, fresh context, read-only) SHALL check Done-when against the task block and `git diff`; a rejection SHALL become a fix turn in the worker session, then gate + review again.
5. The conductor SHALL commit each passing task itself (deterministic message + `commitTrailer`, staging the worker's reported files plus new/modified files under the task's Where paths).
6. WHEN a harness cannot resume, or the last turn reported more than `rotateAfterTokens` (default 150 000) input tokens, THEN the conductor SHALL start a fresh worker session primed with a handoff summary (done tasks, key decisions reported, files touched).
7. Events: one `tlc.agent` per worker session and reviewer call, `STEP_*` per stage, usage per turn; the dashboard shows the worker as one agent spanning several tasks.

**Requirement IDs**: SOLO-01..07

### P1: Helper commands for in-session agents ⭐ MVP

**Acceptance Criteria**:

1. `tlc next [--feature f] [--json]` SHALL print the next runnable task (not done, deps done) with its full block and the run id (starting a run if none is active), or `{"done": true}`.
2. `tlc gate <T>` SHALL resolve and run the task's gate command, print a summary and the failing tail, emit STEP events and exit with the command's status.
3. `tlc review <T> [--harness h --model m]` SHALL run the reviewer (as in SOLO-04) and print `{verdict, findings}`; exit 0 on pass, 1 on reject.
4. `tlc commit <T>` SHALL make the deterministic commit (SOLO-05), mark the task done (event) and print the sha.
5. Every helper SHALL work without the daemon and SHALL record events in progress.ndjson.

**Requirement IDs**: HLP-01..05

### P1: Claude Code workflow solo mode ⭐ MVP

**Acceptance Criteria**:

1. tlc-execute SHALL default to solo mode when `tlc` is on PATH: one worker agent (implementer role model) loops `tlc next` → implement → `tlc gate` (fix until pass, max retries) → `tlc review` (fix on reject) → `tlc commit`, until done or blocked, and returns the usual result shape.
2. `args.mode: "crew"` (or config `mode`) SHALL run today's multi-agent flow; without `tlc` on PATH the workflow SHALL fall back to crew.
3. The worker SHALL report blockers with `tlc emit` and stop a task after `retries` failed fix rounds, moving on to independent tasks.

**Requirement IDs**: CCW-01..03

### P1: Single dashboard daemon ⭐ MVP

**Acceptance Criteria**:

1. `tlc daemon start|stop|status|ensure|restart` SHALL manage one detached `tlc serve` per user: pidfile + lock in the state dir, log at `<state>/daemon.log`, health check `GET /api/health` → `{app:"tlc-deck", version, pid}`.
2. `ensure` SHALL reuse a healthy daemon on the configured port and start one only if none answers (concurrent `ensure` calls start at most one); it SHALL return within 3 s.
3. `tlc serve` SHALL refuse to start a second instance when a healthy tlc-deck answers on the port (exit 0 with a message), unless `--force`.
4. `tlc install claude-code` SHALL run `ensure` and add a SessionStart command hook `tlc daemon ensure --quiet`; `tlc run`, `tlc watch` and `tlc next` SHALL ensure it unless disabled (`--no-daemon`, `daemon.autoStart: false`). `--systemd` writes and enables a user unit instead.
5. The daemon serves all registered repos (registry) without `--repo` flags.

**Requirement IDs**: DMN-01..05

## Traceability

| Req | Story | Priority |
| --- | --- | --- |
| SOLO-01..07 | Conductor + worker | P1 |
| HLP-01..05 | Helpers | P1 |
| CCW-01..03 | Claude Code workflow | P1 |
| DMN-01..05 | Daemon | P1 |
