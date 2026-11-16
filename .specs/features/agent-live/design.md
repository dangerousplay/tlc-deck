# agent-live Design

Spec: `spec.md` (TD, AL, CT). Decisions: `context.md`. Base: `../live-progress/design.md`.

## Facts (verified 2026-11-15 on local Claude Code 2.1.325 data)

- Hook common fields include `transcript_path`, `agent_id`, `agent_type`; SubagentStop adds `agent_transcript_path` (docs).
- Session dir = `transcript_path` without `.jsonl`. Subagents: `<session>/subagents/agent-<id>.jsonl`. Workflow agents: `<session>/subagents/workflows/<wf_id>/agent-<id>.jsonl` + `agent-<id>.meta.json` (`{agentType:"workflow-subagent", description:"impl T3", workflowPhase:"Implement", model:"sonnet", ...}`) + `journal.jsonl` (`{type:"started", agentId, label, phase}`, `{type:"result", agentId, result}`).
- Transcript lines: `{type, uuid, parentUuid, timestamp, isSidechain, agentId?, message:{role, model?, content, usage?}}`. Types seen: `user` (content string or blocks `text`/`tool_result{tool_use_id, content, is_error}`), `assistant` (blocks `text`, `tool_use{id,name,input}`, `thinking`), plus `attachment`, `api-request*`, `system`, `summary` (ignored). One API message may span several lines with the same `message.id` (one block each).
- tlc-execute labels: `impl Tn`, `impl Tn (advised)`, `verify Tn[ (retry k)]`, `advise Tn`, `fix Tn`, `commit Tn`, `report Tn`, `parse tasks.md`, `finish run`.

## Design decisions

| ID | Decision |
| --- | --- |
| DD-01 | Normalised item shape (protocol `AgentItem`): `{agentId, seq, ts, kind: "prompt"|"text"|"tool_call"|"tool_result"|"error"|"status", text?, tool?, toolUseId?, input?, output?, isError?, truncated?, fullLength?}`. Agent record `AgentInfo`: `{id, source:"claude-code"|"tlc-run", sessionId?, workflowId?, runId?, task?, stage?, role?, label?, harness, model?, status:"running"|"done"|"error", startedAt, endedAt?, usage?}` |
| DD-02 | `core/transcripts/claude.ts`: incremental parser (line → AgentItem[] + usage + model); skips thinking and non-message types; pairs results by `tool_use_id` in the UI, not the parser |
| DD-03 | `core/content.ts`: `cap(text, 8192)` + `redact()` regexes (`sk-[A-Za-z0-9_-]{20,}`, `ghp_…`, `xox[abp]-…`, `AKIA[0-9A-Z]{16}`, `Bearer \S+`, `-----BEGIN [A-Z ]*PRIVATE KEY-----…`, `(password|secret|token|api[_-]?key)\s*[=:]\s*\S+`); JSON inputs redacted after stringify, capped, re-parsed when still valid |
| DD-04 | Server `agents/` module: `TranscriptWatcher` registry keyed by file path, reusing `core` `tail()`. Registration only from hooks (session transcript, agent_transcript_path) → session dir → `fs.watch` of `subagents/` and `subagents/workflows/*/` (2 s rescan fallback). Never scans `~/.claude` broadly. Unregister 30 min after SessionEnd |
| DD-05 | Workflow → tlc run link: scan the workflow's `parse tasks.md` agent items for `tlc_[0-9A-HJKMNP-TV-Z]{26}` (output of `tlc emit --start`); fallback: run in the same repo whose `RUN_STARTED` is within 10 min after the workflow's first journal entry. Agent `task`/`stage` from `meta.description` / journal label (regex `^(impl|verify|advise|fix|commit|report) (T\d+)`; stage `impl`→implement, `fix`→fix, …) |
| DD-06 | Store: tables `agents`, `agent_items` (agentId, seq, ts, kind, json); purge items after 7 days (agents metadata follows runs, 30 days); `--no-content` stores items without `text/input/output` |
| DD-07 | API: `GET /api/agents?run=&task=&session=` → AgentInfo[]; `GET /api/agents/:id/items?after=<seq>&limit=500`; SSE: `CUSTOM tlc.agent` (upsert AgentInfo) for all clients, and item deltas only on `GET /api/agents/:id/stream` (per-agent SSE: backlog then live) to keep the global stream small |
| DD-08 | Task details: `core/plan.ts` gains `parseTaskDetails(tasksMd, specMd) → Record<id, {title, what, where, dependsOn, requirements:[{id, text}], doneWhen:[{text, checked}], tests, gate, milestone}>` (requirement text = acceptance-criteria lines of the story whose `Requirement IDs` include it). Server endpoint `GET /api/runs/:id/tasks/:task` resolves the repo path from `RUN_STARTED.input.repoPath` (new optional field; emit/runner/workflow set it) or the registry; reads files at request time |
| DD-09 | Runner: each driver call gets `agentId = <runId>-<task>-<stage>-<attempt>`; emits `CUSTOM tlc.agent` start/end; drivers switch to streaming output and pipe parsed items to `.specs/features/<f>/agents/<runId>/<agentId>.ndjson` (AgentItem lines). Final structured status: from the stream's result event (`structured_output` for claude/agy, `-o` file for codex), else parse JSON from the final text |
| DD-10 | Stream parsers in `runner/src/streams/<harness>.ts`: claude stream-json (`assistant`/`user` message lines, `result`), codex (`item.completed` agent_message / command_execution / file_change / mcp_tool_call, `turn.completed.usage`), agy (`step_update` text_delta + tool_name, `result`), gemini (`message`, `tool_use`, `tool_result`, `result`), opencode (`text`, `tool_use`, `step_finish`) |
| DD-11 | Web: task view route `/runs/:run/tasks/:task` (sheet on desktop board click → full page link; full page on mobile). Agent chat component `AgentChat` (markdown via `react-markdown` + `remark-gfm`, tool call/result collapsible cards with JSON viewer, sticky auto-scroll, live dot). Session detail lists agents (main, subagents, workflow runs grouped by workflow → phase) with the same chat |

## Testing

- Parsers: golden fixtures from real local transcripts, anonymised and trimmed (`fixtures/transcripts/claude/*.jsonl`, `fixtures/streams/<harness>/*.jsonl`).
- Server: temp fake `~/.claude/projects/<p>/<session>/…` tree; hooks POST → watcher picks up main + workflow agents; append lines → per-agent SSE delivers within 1 s; link to run via `tlc_` id.
- Web: component tests for AgentChat (pairing, collapse, truncation notice) and task view (spec block, timeline).
- Gate: `pnpm check`.
