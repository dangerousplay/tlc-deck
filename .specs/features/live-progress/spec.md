# live-progress Specification

Decisions: `context.md` (D-01..D-08 + planner defaults). Project: `../../project/PROJECT.md`.

## Problem Statement

tlc-execute runs only inside Claude Code and reports progress only in that session's
`/workflows` view. When several sessions or runs are active there is no single place
to see which milestones are reached, which tasks are done, what is blocked and what it
costs, and no way to run the same plan from Codex CLI, Gemini CLI or OpenCode.

## Goals

- [ ] Every tlc run, from any supported harness, writes the same progress events, and every viewer is built only on those events.
- [ ] A user can open `http://127.0.0.1:7317` and see all live Claude Code sessions and all tlc runs, updated within 1 s of an event.
- [ ] A user can follow a run in the terminal (`tlc watch`) and beside the chat in Claude Code (pane).
- [ ] A tasks.md that runs with tlc-execute today runs unchanged with `tlc run --harness codex|gemini|opencode|claude`.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Remote access, auth, multi-machine | D-04 localhost only |
| Reading harness transcripts for sessions | D-06 hooks + OTel only |
| Live session monitoring for non-Claude harnesses outside tlc runs | D-02 |
| Steering agents, editing tasks, approving from the web | Read-only v1 |
| Windows | Linux + macOS first |

---

## User Stories

### P1: Progress protocol ⭐ MVP

**User Story**: As a tool author, I want one documented event format for tlc runs so that drivers and viewers never depend on each other.

**Acceptance Criteria**:

1. WHEN a driver records progress THEN it SHALL append one JSON object per line to `.specs/features/<feature>/progress.ndjson`, each with `v` (schema version), `type`, `ts`, `run_id`, and `seq` (monotonic per run).
2. Event types SHALL follow AG-UI naming: `RunStarted`, `RunFinished`, `RunError`, `StepStarted`, `StepFinished`, `StateSnapshot`, `StateDelta`, `Custom` (`name` ∈ `milestone`, `task`, `blocker`, `blocker_resolved`, `usage`, `log`).
3. WHEN events of one run are folded THEN a pure reducer SHALL produce run state: milestones (name, tasks, reached), tasks (id, title, milestone, depends_on, status ∈ pending | running | review | advising | done | blocked | failed | skipped, stage, attempts, commit, files, gate result), open and resolved blockers, usage per role and model (tokens, cost or null), timings.
4. WHEN a line is malformed, has an unknown `type`, or a newer minor `v` THEN readers SHALL skip or ignore unknown fields without failing.
5. WHEN `tlc emit <type> --run <id> [json]` is called THEN it SHALL validate and append the event (so any script or harness can report progress).

**Independent Test**: Fold a recorded fixture run (15 tasks, 1 blocker resolved by retry) and compare state to a golden.

**Requirement IDs**: PROTO-01..05

---

### P1: Claude Code driver ⭐ MVP

**User Story**: As a Claude Code user, I want tlc-execute to keep its features and report progress through the protocol.

**Acceptance Criteria**:

1. WHEN tlc-execute runs THEN it SHALL emit protocol events for run start/end, milestones, each task stage (implement, verify, advise, commit), blockers and per-agent usage, with `run_id` = the Workflow run id and `harness` = `claude-code`.
2. The driver SHALL keep: parallel `[P]` tasks, models per role (orchestrator, implementer, reviewer, advisor), the existing role config files, resume, one commit per task.
3. Because Workflow scripts cannot write files, events SHALL be written by the agents the script already runs (orchestrator writes through `tlc emit`), and the script result SHALL still list completed, failed and deviations.
4. WHEN `tlc` is not installed THEN tlc-execute SHALL still run and only skip events.

**Requirement IDs**: CCD-01..04

---

### P1: Dashboard server and run views ⭐ MVP

**User Story**: As a developer, I want a local web page showing every tlc run live.

**Acceptance Criteria**:

1. `tlc serve` SHALL listen on `127.0.0.1:7317` only (port configurable), serve the SPA, and push updates over SSE.
2. WHEN a `progress.ndjson` of a known repo grows or an event is POSTed to `/events` THEN the browser SHALL show it within 1 s.
3. Run list SHALL show per run: repo, feature, harness, status, milestone progress (`3/5`), tasks done/total, open blockers, elapsed, cost.
4. Run detail SHALL show: milestone timeline, task board by status with current stage, blocker cards (reason, advice, task), deviations, usage per role and model, and an event log.
5. WHEN the server restarts THEN runs SHALL be rebuilt from files and SQLite history (30 days).
6. The UI SHALL use shadcn/ui components, support light and dark, and stay usable at 1280 px and on a 390 px wide screen.

**Requirement IDs**: SRV-01..05, WEB-01..03

---

### P1: Terminal watch ⭐ MVP

**User Story**: As a terminal user, I want `tlc watch` to show the run I care about live.

**Acceptance Criteria**:

1. `tlc watch [--feature f] [--run id]` SHALL render milestones, tasks by status with stage, open blockers and cost, refreshing on each new event; default = newest active run in the current repo.
2. It SHALL read the NDJSON file directly (works without `tlc serve`).
3. WHEN the run finishes THEN it SHALL print a final summary and exit 0 (exit 1 if failed tasks).
4. WHEN stdout is not a TTY THEN it SHALL print one line per event instead of the live view.

**Requirement IDs**: TUI-01..04

---

### P2: Headless runner for other harnesses

**User Story**: As a Codex/Gemini/OpenCode user, I want to execute a tasks.md with the same flow.

**Acceptance Criteria**:

1. `tlc run --feature f [--harness codex|gemini|opencode|claude] [--only T1,T2] [--retries n] [--no-commit]` SHALL parse tasks.md, compute waves, and run implement → verify → (advise) → commit per task, `[P]` tasks concurrently (max configurable, default 3).
2. Each role SHALL run as a headless harness call (`codex exec`, `agy -p`, `gemini -p`, `opencode run`, `claude -p`; `agy` added per design DD-09) with the role's model and a prompt built from the task definition and referenced spec/design paths, and return structured status (Complete | Blocked | Partial, files, gate, deviations).
3. Roles MAY use different harnesses (e.g. implementer codex, reviewer claude).
4. WHEN a harness CLI is missing or fails THEN the task SHALL get a blocker of kind `error` and the run SHALL continue with independent tasks.
5. The runner SHALL emit the same protocol events, with tokens/cost when the harness reports them.
6. WHEN interrupted (Ctrl-C) THEN it SHALL emit `RunError` and `tlc run --resume` SHALL skip tasks already Done.

**Requirement IDs**: RUN-01..06

---

### P2: Live Claude Code sessions

**User Story**: As a user with several Claude Code sessions, I want to see them all at once.

**Acceptance Criteria**:

1. `tlc install claude-code` SHALL add HTTP hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStart/Stop, SessionEnd) posting to `http://127.0.0.1:7317/hooks`, idempotently and reversibly; hooks SHALL time out fast and never block the session.
2. Sessions grid SHALL show per session: project, cwd, model, state (working | waiting for input | idle | ended), current tool, last prompt (truncated), running subagents, tokens and cost, linked tlc run.
3. Session detail SHALL show a timeline of prompts, tool calls and subagents.
4. WHEN no event arrives for 10 min THEN the session SHALL show idle; after SessionEnd, ended.
5. Prompts and tool inputs SHALL be stored truncated (≤ 200 chars) and can be disabled (`--no-content`).

**Requirement IDs**: SESS-01..05

---

### P2: OpenTelemetry receiver

**User Story**: As a user, I want accurate tokens and cost per session from Claude Code's own telemetry.

**Acceptance Criteria**:

1. The server SHALL accept OTLP/HTTP (JSON and protobuf) on `/v1/metrics`, `/v1/logs`, `/v1/traces`.
2. `tlc install claude-code --otel` SHALL set the Claude Code env settings to export to it.
3. Cost and token metrics/events SHALL be attributed to sessions by `session.id` and to workflow runs by `workflow.run_id` when present, overriding hook-derived estimates.
4. Unknown metrics and attributes SHALL be ignored.

**Requirement IDs**: OTEL-01..04

---

### P2: Claude Code pane

**User Story**: As a Claude Code user, I want the run board beside the chat.

**Acceptance Criteria**:

1. A `tlc-deck` mod SHALL add `/tlc` opening a pane with the active run of the current repo: milestones, tasks by status, open blockers, cost; and a status entry `tlc 9/15 ▲1`.
2. It SHALL read state through `tlc status --json` (works without the server) and refresh at most every 3 s.

**Requirement IDs**: PANE-01..02

## Traceability

| Req | Story | Priority |
| --- | --- | --- |
| PROTO-01..05 | Progress protocol | P1 |
| CCD-01..04 | Claude Code driver | P1 |
| SRV-01..05, WEB-01..03 | Dashboard | P1 |
| TUI-01..04 | Terminal watch | P1 |
| RUN-01..06 | Headless runner | P2 |
| SESS-01..05 | Live sessions | P2 |
| OTEL-01..04 | OTel receiver | P2 |
| PANE-01..02 | Pane | P2 |
