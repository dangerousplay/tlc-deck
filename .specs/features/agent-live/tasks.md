# agent-live Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` Execute flow. Read `spec.md`, `context.md` and `design.md` in this folder first (and `../live-progress/design.md` for the base architecture); `design.md` wins where it differs. Work only inside this repo; never edit files under `~/.claude` (you MAY read local transcripts under `~/.claude/projects/` only to build anonymised fixtures: replace paths, usernames, ids and any secrets). Do not run real harness prompts. Gate for every task: `pnpm check` at repo root.

**Design**: `.specs/features/agent-live/design.md`
**Status**: Approved (owner, 2026-11-15)

## Execution Plan

```
T1 → T2 → T4 → T5 → T7
T1 → T3 [P with T2]
T1 → T6 → T8 [P after T5]
T4, T7, T8 → T9
```

---

### T1: Agent protocol types and content handling

**Status**: Done
**Milestone**: Agent data
**What**: In `@tlc-deck/protocol`: zod schemas + types `AgentItem`, `AgentInfo` (design DD-01), Custom event `tlc.agent` payload (AgentInfo partial upsert), optional `RUN_STARTED.input.repoPath`. In `@tlc-deck/core`: `content.ts` with `cap()` and `redact()` per DD-03, `capItem(item)` applying both to text/input/output.
**Where**: `packages/protocol/src/*`, `packages/core/src/content.ts`, tests
**Depends on**: none
**Requirement**: CT-01, AL-02

**Done when**:
- [x] Schema tests; redaction table test (each pattern, no false positive on ordinary code); cap marks `truncated` + `fullLength`; JSON input stays valid JSON when possible
- [x] Gate passes

---

### T2: Claude Code transcript parser

**Status**: Done
**Milestone**: Agent data
**What**: `core/transcripts/claude.ts` per DD-02: `parseClaudeLine(line, state) → {items, usage?, model?}`; prompt text from first user string; assistant text/tool_use; user tool_result (string or block array content, `is_error`); skip thinking/attachment/api-request*/system/summary. Fixtures from real local transcripts (one session main, one subagent, one workflow agent), anonymised.
**Where**: `packages/core/src/transcripts/claude.ts`, `fixtures/transcripts/claude/`
**Depends on**: T1
**Requirement**: AL-04

**Done when**:
- [x] Golden item lists for the 3 fixtures; usage and model extracted; malformed lines skipped
- [x] Gate passes

---

### T3: Task details parser and endpoint [P]

**Status**: Done
**Milestone**: Task details
**What**: `parseTaskDetails` per DD-08 in `core/plan.ts`; `tlc emit --start`, the runner and the repo workflow script set `RUN_STARTED.input.repoPath`; server `GET /api/runs/:id/tasks/:task` returns `{details|null, notice?, state}` (state = task from fold + stage history derived from STEP events with start/end/duration/attempt).
**Where**: `packages/core/src/plan.ts`, `packages/server/src/server.ts`, `packages/cli/src/**`, `packages/runner/src/runner.ts`, `integrations/claude-code/workflow/tlc-execute.js`
**Depends on**: T1
**Requirement**: TD-01..03

**Done when**:
- [x] Golden details for the memo harness-integration fixture plan (requirement text resolved from spec.md, checkboxes)
- [x] Endpoint test incl. missing repo → notice; stage history from the golden run
- [x] Gate passes

---

### T4: Server agent watcher and store

**Status**: Done
**Milestone**: Live agents
**What**: `packages/server/src/agents/`: registry + watchers per DD-04 (registered from hook bodies), workflow meta/journal reading, task/stage mapping and run linking per DD-05, store tables + purge per DD-06, `--no-content`, API + SSE per DD-07 (`tlc.agent` on global stream; per-agent stream endpoint with backlog then live).
**Where**: `packages/server/src/agents/**`, `packages/server/src/store.ts`, `packages/server/src/sessions/index.ts`
**Depends on**: T2
**Requirement**: AL-01..03, AL-05, CT-02

**Done when**:
- [x] Integration with a temp fake projects tree: hooks register session; main, subagent and workflow agents listed with task/stage; appended lines reach a per-agent SSE client < 1 s; workflow linked to run by `tlc_` id and by time fallback
- [x] Purge and `--no-content` tested; nothing outside the announced session dir is read (test asserts)
- [x] Gate passes

---

### T5: Runner agent logs and streaming drivers

**Status**: Done
**Milestone**: Live agents (tlc run)
**What**: DD-09 in the runner (agent ids, `tlc.agent` events, per-agent log files written through `capItem`), switch drivers to streaming output, stream parsers per DD-10 in `runner/src/streams/`, final structured status extraction per harness; update fake executables (`fixtures/bin`) to emit streaming formats. Server tails `agents/<runId>/*.ndjson` of known runs and serves them through the T4 API.
**Where**: `packages/runner/src/**`, `fixtures/bin/*`, `fixtures/streams/*`, `packages/server/src/agents/**`
**Depends on**: T4
**Requirement**: AL-06..08

**Done when**:
- [x] Parser goldens per harness; fake-driver run produces agent logs + `tlc.agent` events; server lists those agents with items
- [x] Existing runner tests still pass (structured status unchanged)
- [x] Gate passes

---

### T6: Web task view

**Status**: Done
**Milestone**: Task details
**What**: Route `/runs/:run/tasks/:task` + sheet from board/list click (DD-11): spec block (What/Where markdown, depends links, requirements with text, done-when checklist, tests/gate), stage timeline (stepper with durations, attempts, status), agents per stage (placeholder list until T7 provides the chat).
**Where**: `apps/web/src/routes/task/**`, `apps/web/src/routes/run/run-detail.tsx`, `apps/web/src/app.tsx`
**Depends on**: T3
**Requirement**: TD-01..03

**Done when**:
- [x] Component tests with the golden details/state; mobile full-page layout
- [x] Gate passes

---

### T7: Web agent chat

**Status**: Done
**Milestone**: Live agents
**What**: `AgentChat` per DD-11 using the per-agent stream: items in order, markdown text, collapsible tool call cards paired with results (error styling, truncated notice), sticky auto-scroll with "jump to latest", live indicator; agent header (label, role, model, status, tokens/cost). Wire into the task view (agents per stage; click → chat) and session detail (agent list: main, subagents, workflows grouped by phase).
**Where**: `apps/web/src/components/agent-chat/**`, `apps/web/src/routes/task/**`, `apps/web/src/routes/sessions/session-detail.tsx`
**Depends on**: T4, T6
**Requirement**: AL-04, AL-05

**Done when**:
- [x] Component tests: pairing, collapse, truncation, auto-scroll pause; store test for backlog + live merge
- [x] Screenshot check (playwright-core, headless shell under `~/.cache/ms-playwright/`) of task view and session agents in light/dark
- [x] Gate passes

---

### T8: `tlc watch` task focus [P]

**Status**: Done
**Milestone**: Task details
**What**: In the TUI, `↑/↓` select a task, `enter` shows its details (from `parseTaskDetails`) and stage history, `esc` back.
**Where**: `packages/cli/src/watch/**`
**Depends on**: T3
**Requirement**: TD-01, TD-02

**Done when**:
- [x] ink-testing-library frame tests for select/detail/back
- [x] Gate passes

---

### T9: End-to-end and docs

**Status**: Done
**Milestone**: Release
**What**: E2E: fake projects tree + hooks + workflow agent transcript growing → per-agent SSE; `tlc run` with fake claude streaming → agent logs visible through the API. README + `docs/protocol.md` (AgentItem, `tlc.agent`, agent log files, privacy: what is read, caps, redaction, retention).
**Where**: `packages/cli/test/e2e-agents.test.ts`, `README.md`, `docs/*`
**Depends on**: T5, T7, T8
**Requirement**: all

**Done when**:
- [x] E2E passes; docs cover new endpoints, files and privacy
- [x] Gate passes

---

## Accepted deviations (orchestrator)

- T1: Bearer redaction needs a ≥ 8 char token; key/value redaction stops at quotes, commas, semicolons and `}` to keep JSON valid.
- T2: Claude transcript fixtures are synthetic in the real line format (reading ~/.claude transcripts was denied to the agent); verified afterwards against this session's real transcripts through the running server (145 agents, workflow run linked).
- T4: polling every 200 ms (re-listing `subagents/` and `subagents/workflows/*/`) instead of fs.watch; own byte-offset reader; run id searched in all workflow agents; time fallback uses the journal file's birth/mtime; per-agent SSE event name `item`.
- T5: stream fixtures generated from the fake executables; agy stream shape assumed from docs; server upserts runner `tlc.agent` events into the agents store.
- T6: small in-repo MiniMarkdown for the spec block; board cards open a sheet (desktop) or the full page (mobile/modifier-click).
- Orchestrator fixes: requirement text for positional criteria (`AL-01..05` → numbered criteria) and one-line tool summaries on collapsed tool cards. Some task commits still carry the Haiku trailer (T2, T3, T5) and T9 the wrong `memo-cli` scope.
