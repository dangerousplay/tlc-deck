# agent-live Specification

Decisions: `context.md` (D-01..D-05). Builds on `live-progress` (protocol, server, web, runner).

## Problem Statement

The dashboard shows task status, milestones and blockers, but not what a task asks for
or what the agents working on it are doing. To follow or debug a run the user must open
transcripts by hand, and there is no way to watch an agent's conversation and tool calls
while it works.

## Goals

- [ ] From any run, open a task and read its full definition (spec block) and the timeline of stages with the agent behind each.
- [ ] Watch any agent live: its prompt, assistant messages and tool calls with inputs and results, updated within 1 s.
- [ ] Works for Claude Code sessions (main agent, subagents, tlc-execute workflow agents) and for `tlc run` on every harness.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Thinking blocks | Not shown (privacy, size) |
| Sending messages to agents / steering | Read-only |
| Files changed, diffstat, gate output view | Owner did not select "Outcome" (D-05) |
| Live chat for non-tlc sessions of other harnesses | live-progress D-02 |

---

## User Stories

### P1: Task details ⭐ MVP

**User Story**: As a user following a run, I want to open a task and see what it must do and how far it got.

**Acceptance Criteria**:

1. WHEN I click a task card (board or list) THEN a task view SHALL open at `/runs/:run/tasks/:task` showing the task block from tasks.md: title, What, Where, Depends on (linked tasks), Requirement IDs with the matching acceptance-criteria text from spec.md, Done-when checklist with checked state, Tests and Gate.
2. The task view SHALL show a stage timeline (implement → verify → advise → fix → commit) with start/end, duration, attempt, status and the agent of each stage (role, harness, model, tokens, cost, live/finished).
3. WHEN tasks.md is not readable (repo moved) THEN the view SHALL show the event-derived data and a notice.

**Requirement IDs**: TD-01..03

---

### P1: Live agent view (Claude Code) ⭐ MVP

**User Story**: As a Claude Code user, I want to watch any agent of a session or a tlc-execute run live.

**Acceptance Criteria**:

1. WHEN a hook arrives with `transcript_path` or `agent_transcript_path` THEN the server SHALL tail that file, and SHALL watch that session's `subagents/` folder (including `workflows/wf_*/`) for agent transcripts. No other part of `~/.claude` is read.
2. Each agent SHALL be listed with id, kind (main | subagent | workflow), label, role/stage and task (from workflow `meta.json` description, e.g. `impl T3`), model, status (running | done | error), started/ended, tokens/cost when known.
3. A tlc-execute workflow run SHALL be linked to its tlc run, so the task view lists the workflow agents of that task.
4. The agent view SHALL show items in order: user/prompt text, assistant text (markdown), tool calls (name, input) paired with their results (output, error flag), with timestamps; tool items collapsed by default with a one-line summary.
5. WHEN new lines are appended THEN the open agent view SHALL update within 1 s and auto-scroll unless the user scrolled up.

**Requirement IDs**: AL-01..05

---

### P2: Live agent view (`tlc run`)

**User Story**: As a user of Codex, Antigravity, Gemini or OpenCode, I want the same live view for headless runs.

**Acceptance Criteria**:

1. Each driver call SHALL stream the harness's machine-readable output (claude stream-json, codex `--json`, agy stream-json, gemini stream-json, opencode `--format json`) into an agent log normalised to the same item shape, at `.specs/features/<f>/agents/<runId>/<agentId>.ndjson`, while still returning the structured status.
2. The runner SHALL emit `tlc.agent` start/end events (agentId, task, stage, role, harness, model, usage) into progress.ndjson.
3. The server SHALL tail agent logs of known runs and serve them like Claude Code agents.

**Requirement IDs**: AL-06..08

---

### P1: Content handling ⭐ MVP

**Acceptance Criteria**:

1. Stored text and tool inputs/results SHALL be capped at 8 KB per item (marked truncated, full length recorded) and passed through secret redaction (API keys, tokens, `Authorization` headers, private keys, `password=` pairs).
2. Agent items SHALL be purged after 7 days; `tlc serve --no-content` SHALL store and stream metadata only.

**Requirement IDs**: CT-01..02

## Traceability

| Req | Story | Priority |
| --- | --- | --- |
| TD-01..03 | Task details | P1 |
| AL-01..05 | Live agents, Claude Code | P1 |
| AL-06..08 | Live agents, tlc run | P2 |
| CT-01..02 | Content handling | P1 |
