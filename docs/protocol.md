# tlc-deck protocol (v1)

Events follow the [AG-UI](https://docs.ag-ui.com) event model, one JSON object per line in
`.specs/features/<feature>/progress.ndjson`. The same objects are accepted by `POST /events` and
streamed over SSE at `/api/stream`.

## Envelope

Every event carries `type`, `timestamp` (ms) and `metadata`:

| Field                                    | Meaning                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `metadata.v`                             | Protocol version (currently 1). Newer versions with extra fields are accepted. |
| `metadata.seq`                           | Per-run sequence number, assigned on append. Duplicates are dropped.           |
| `metadata.runId`                         | `tlc_<ULID>`                                                                   |
| `metadata.threadId`                      | `<repo>#<feature>`                                                             |
| `metadata.harness` / `driver` / `source` | Where the event came from (`claude`, `runner`, `cli`, ...).                    |

Unknown event types and unknown fields are ignored by readers.

## Standard events

| Type                             | Use                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RUN_STARTED`                    | Run begins; `input` holds `feature`, `tasksPath`, `roles`, `harness` and optionally `repoPath`. |
| `RUN_FINISHED`                   | Run ended normally (failed tasks are reported through task and blocker events).                 |
| `RUN_ERROR`                      | Run aborted; `code: "interrupted"` for SIGINT/SIGTERM.                                          |
| `STEP_STARTED` / `STEP_FINISHED` | `stepName` is `<task>:<stage>`; stage is `implement`, `verify`, `advise`, `fix` or `commit`.    |
| `STATE_SNAPSHOT`                 | First SSE message: `{runs, sessions}`.                                                          |

## Custom events (`type: "CUSTOM"`, `name`, `value`)

| Name                   | Value                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tlc.plan`             | `{tasks: [{id, title, milestone, dependsOn, parallel, requirement?}], milestones: [{name, source: field\|priority\|wave, tasks}]}`                  |
| `tlc.task`             | `{id, status, stage?, attempt?, commit?, files?, gate?: {pass, summary}, deviations?}`. `status`: see `TASK_STATUSES` in `@tlc-deck/protocol`.      |
| `tlc.blocker`          | `{id, task, kind: blocked\|partial\|rejected\|gate\|error, reason, advice?}`                                                                        |
| `tlc.blocker_resolved` | `{id}`                                                                                                                                              |
| `tlc.milestone`        | `{name}` (milestone reached)                                                                                                                        |
| `tlc.usage`            | `{task?, role, harness, model, input, output, cacheRead, cacheWrite, costUsd\|null}`                                                                |
| `tlc.log`              | `{level: debug\|info\|warn\|error, message}`                                                                                                        |
| `tlc.agent`            | Partial upsert of an `AgentInfo` (see below): `{id, source, status, startedAt?, endedAt?, task?, stage?, role?, harness?, model?, runId?, usage?}`. |
| `tlc.session`          | Server-only, SSE: session state deltas derived from hooks.                                                                                          |

## Run state

`tlc status --json` and `GET /api/runs/:id` return the fold of a run's events: `status`
(`running`, `finished`, `failed`, `interrupted`, `stale`), `tasks` by id, `blockers`, `milestones`,
and usage totals. A run with no events for a while is reported `stale`.

## HTTP API (127.0.0.1)

| Route                                        | Description                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /events`                               | Ingest one event (400 on invalid). Response `{ok, duplicate}`.                        |
| `POST /hooks`                                | Claude Code hook bodies; always answers an empty 200.                                 |
| `POST /v1/metrics`, `/v1/logs`, `/v1/traces` | OTLP/HTTP JSON ingest for usage.                                                      |
| `GET /api/runs`, `/api/runs/:id`             | Run states (detail includes events and OTEL usage).                                   |
| `GET /api/sessions`, `/api/sessions/:id`     | Harness sessions; `linkedRun` is set while a run of the same project is running.      |
| `GET /api/stream`                            | SSE: `STATE_SNAPSHOT` then every event; `: heartbeat` comments.                       |
| `GET /api/runs/:id/tasks/:task`              | Task details (spec text, requirements, done-when) read from the repo at request time. |
| `GET /api/agents?run=&task=&session=`        | `AgentInfo[]`, optionally filtered.                                                   |
| `GET /api/agents/:id/items?after=&limit=`    | `AgentItem[]` after sequence `after` (default limit 500).                             |
| `GET /api/agents/:id/stream`                 | Per-agent SSE: backlog, then live items. Item deltas are not on `/api/stream`.        |
| `GET /api/otel`                              | OTLP span counts.                                                                     |

## Role outputs

Drivers request structured output for the implementer (`status`: Complete\|Blocked\|Partial, files,
gate, deviations, issues), reviewer (`verdict`: pass\|reject, findings) and advisor (`diagnosis`,
`environmental`, `steps`). JSON Schemas are exported by `@tlc-deck/protocol`
(`statusOutputJsonSchema`, `reviewerOutputJsonSchema`, `advisorOutputJsonSchema`).

## Agents (agent-live)

`AgentInfo`: `{id, source: claude-code|tlc-run, sessionId?, workflowId?, runId?, task?, stage?, role?,
label?, harness, model?, status: running|done|error, startedAt, endedAt?, usage?}`.

`AgentItem`: `{agentId, seq, ts, kind: prompt|text|tool_call|tool_result|error|status, text?, tool?,
toolUseId?, input?, output?, isError?, truncated?, fullLength?}`. Tool results are paired with calls
by `toolUseId` in the UI.

### Sources and files

- Claude Code sessions: a hook announces `transcript_path`; the server then tails only that session's
  transcript, `<session>/subagents/agent-<id>.jsonl` and
  `<session>/subagents/workflows/<wf>/agent-<id>.jsonl` (with `.meta.json` and `journal.jsonl`).
  It never scans `~/.claude` broadly. Workflow agents are linked to a `tlc run` by the `tlc_<ULID>` in
  the `parse tasks.md` agent output, or by a run starting in the same repo shortly after.
- `tlc run`: each role call has agent id `<runId>-<task>-<stage>-<attempt>` and writes AgentItem lines
  to `.specs/features/<feature>/agents/<runId>/<agentId>.ndjson`; `tlc.agent` events mark start and end.

### Privacy

- Read: only transcripts announced by hooks and run agent logs of known runs. Thinking blocks and
  non-message lines are skipped.
- Caps: text, tool input and output are capped at 8192 characters (`truncated`, `fullLength` set).
- Redaction: API keys (`sk-`, `ghp_`, `xox*-`, `AKIA`), `Bearer` tokens, private key blocks and
  `password|secret|token|api_key = value` pairs are replaced before storing or serving.
- `tlc serve --no-content` stores items without `text`, `input` and `output`.
- Retention: items 7 days, agent metadata 30 days (follows runs). Everything stays local.
