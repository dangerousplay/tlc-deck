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

| Type                             | Use                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `RUN_STARTED`                    | Run begins; `input` holds `feature`, `tasksPath`, `roles`, `harness`.                        |
| `RUN_FINISHED`                   | Run ended normally (failed tasks are reported through task and blocker events).              |
| `RUN_ERROR`                      | Run aborted; `code: "interrupted"` for SIGINT/SIGTERM.                                       |
| `STEP_STARTED` / `STEP_FINISHED` | `stepName` is `<task>:<stage>`; stage is `implement`, `verify`, `advise`, `fix` or `commit`. |
| `STATE_SNAPSHOT`                 | First SSE message: `{runs, sessions}`.                                                       |

## Custom events (`type: "CUSTOM"`, `name`, `value`)

| Name                   | Value                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tlc.plan`             | `{tasks: [{id, title, milestone, dependsOn, parallel, requirement?}], milestones: [{name, source: field\|priority\|wave, tasks}]}`             |
| `tlc.task`             | `{id, status, stage?, attempt?, commit?, files?, gate?: {pass, summary}, deviations?}`. `status`: see `TASK_STATUSES` in `@tlc-deck/protocol`. |
| `tlc.blocker`          | `{id, task, kind: blocked\|partial\|rejected\|gate\|error, reason, advice?}`                                                                   |
| `tlc.blocker_resolved` | `{id}`                                                                                                                                         |
| `tlc.milestone`        | `{name}` (milestone reached)                                                                                                                   |
| `tlc.usage`            | `{task?, role, harness, model, input, output, cacheRead, cacheWrite, costUsd\|null}`                                                           |
| `tlc.log`              | `{level: debug\|info\|warn\|error, message}`                                                                                                   |
| `tlc.session`          | Server-only, SSE: session state deltas derived from hooks.                                                                                     |

## Run state

`tlc status --json` and `GET /api/runs/:id` return the fold of a run's events: `status`
(`running`, `finished`, `failed`, `interrupted`, `stale`), `tasks` by id, `blockers`, `milestones`,
and usage totals. A run with no events for a while is reported `stale`.

## HTTP API (127.0.0.1)

| Route                                        | Description                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /events`                               | Ingest one event (400 on invalid). Response `{ok, duplicate}`.                   |
| `POST /hooks`                                | Claude Code hook bodies; always answers an empty 200.                            |
| `POST /v1/metrics`, `/v1/logs`, `/v1/traces` | OTLP/HTTP JSON ingest for usage.                                                 |
| `GET /api/runs`, `/api/runs/:id`             | Run states (detail includes events and OTEL usage).                              |
| `GET /api/sessions`, `/api/sessions/:id`     | Harness sessions; `linkedRun` is set while a run of the same project is running. |
| `GET /api/stream`                            | SSE: `STATE_SNAPSHOT` then every event; `: heartbeat` comments.                  |
| `GET /api/otel`                              | OTLP span counts.                                                                |

## Role outputs

Drivers request structured output for the implementer (`status`: Complete\|Blocked\|Partial, files,
gate, deviations, issues), reviewer (`verdict`: pass\|reject, findings) and advisor (`diagnosis`,
`environmental`, `steps`). JSON Schemas are exported by `@tlc-deck/protocol`
(`statusOutputJsonSchema`, `reviewerOutputJsonSchema`, `advisorOutputJsonSchema`).
