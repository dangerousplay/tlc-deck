# live-progress Design

Spec: `spec.md` (PROTO, CCD, SRV, WEB, TUI, RUN, SESS, OTEL, PANE). Decisions: `context.md`.
Research date: 2026-11-15. Local env: Node 26.13, pnpm 12.20, `claude` 2.1.325; `codex`, `gemini`, `agy`, `opencode` not installed.

## Overview

```
 tasks.md / spec.md ──► tlc plan ──► plan (tasks, milestones, waves)
                                        │
   Claude Code: tlc-execute Workflow ───┤ (agents call `tlc emit`)
   Other harnesses: tlc run + drivers ──┘
                                        ▼
               .specs/features/<f>/progress.ndjson   (source of truth, AG-UI events)
                     │ tail                     │ POST /events (best effort)
                     ▼                          ▼
   tlc watch (TUI)   tlc status --json    tlc serve (Hono, 127.0.0.1:7317)
   Claude pane ◄─────┘                    ├─ /hooks      ◄── Claude Code HTTP hooks
                                          ├─ /v1/{metrics,logs,traces} ◄── Claude Code OTel
                                          ├─ SQLite ~/.local/state/tlc-deck/deck.db
                                          └─ /api/stream (SSE) ──► web SPA (Vite/React/shadcn)
```

## Design decisions

| ID | Decision | Why |
| --- | --- | --- |
| DD-01 | pnpm monorepo: `packages/protocol`, `packages/core` (plan parser, reducer, ndjson io, config), `packages/server`, `packages/cli` (bin `tlc`), `packages/runner`, `apps/web`, `integrations/claude-code/{workflow,tlc-deck-panel}` | Viewers and drivers share only `protocol` + `core` |
| DD-02 | Events are `@ag-ui/core` 1.0.x events (validated with its zod schemas) plus our envelope in `metadata` | Reuse the spec and validators; unknown events ignored by AG-UI rule |
| DD-03 | Node ≥ 22.13, ESM only, TypeScript strict, zod 4, Vitest, Biome (lint+format) | Ink 8 and nanoid/chokidar need Node 22+; local Node 26 |
| DD-04 | SQLite via `node:sqlite` (`DatabaseSync`) behind `Store` interface | No native build; swap to better-sqlite3 if `node:sqlite` breaks |
| DD-05 | NDJSON tail: `fs.watch` + 250 ms stat poll, byte offset, partial-line buffer, reset on truncation/inode change | Reliable on Linux and macOS without chokidar |
| DD-06 | Claude Code driver = updated tlc-execute Workflow; deterministic parsing by `tlc plan --json` run by the Load agent; every stage agent runs `tlc emit` at start/end (one Bash call each). Without `tlc` on PATH the agents skip emits | Workflow scripts have no fs/shell/env; agents do |
| DD-07 | Headless runner commits with `git` itself (no LLM commit agent); orchestrator role unused in the runner | Deterministic, cheaper |
| DD-08 | Runner drivers return a status object via native schema output where available (`claude --json-schema`, `codex --output-schema`, `agy --json-schema`), else prompt for one JSON object and parse the last message (`gemini`, `opencode`) | Research: only these three have schema flags |
| DD-09 | Add an Antigravity (`agy`) driver | Replaced Gemini CLI for free users 2026-06-18; best headless mode in that family |
| DD-10 | Claude Code session ingest via HTTP hooks written by `tlc install claude-code` into `~/.claude/settings.json` (marker key, reversible), not plugin hooks | Plugin `type:"http"` hooks unverified; user settings are verified |
| DD-11 | OTel: `tlc install claude-code --otel` writes `env` in `~/.claude/settings.json` with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, endpoint `http://127.0.0.1:7317`. Receiver decodes JSON; protobuf decoded with `protobufjs` + vendored opentelemetry-proto `.proto` files; gzip via zlib | OTel env only honoured in user/managed settings or shell; default protocol is protobuf |
| DD-12 | Link a Claude Code tlc run to OTel usage: the Load agent records `$CLAUDE_*`/`WORKFLOW*` env if present (T6 verifies what exists); fallback heuristic: OTel `workflow.name` contains `tlc-execute`, same session, `workflow.run_id` first seen within 120 s after `RunStarted` | Workflow run id is not visible to the script |

## Event protocol (`packages/protocol`)

Every NDJSON line = one AG-UI event + envelope:

```json
{"type":"CUSTOM","timestamp":1763200000000,"name":"tlc.task","value":{...},
 "metadata":{"v":1,"seq":12,"runId":"tlc_01J...","threadId":"<repo>#<feature>","harness":"claude-code","driver":"workflow","source":"implementer"}}
```

`RunStarted.runId` = `metadata.runId`; `threadId` = `<repo-name>#<feature>`. `seq` increases per run (writer takes a lock on `progress.ndjson.lock`).

| AG-UI type | Use |
| --- | --- |
| RUN_STARTED | `input` = `{feature, tasksPath, roles, only?, harness}` |
| RUN_FINISHED | `result` = `{completed[], failed[], notStarted[], deviations[]}` |
| RUN_ERROR | interrupted or fatal |
| STEP_STARTED / STEP_FINISHED | `stepName` = `<task>:<stage>`; stage ∈ implement, verify, advise, fix, commit |
| CUSTOM `tlc.plan` | `{tasks:[{id,title,milestone,dependsOn,parallel,requirement}], milestones:[{name,source:"field"|"priority"|"wave",tasks[]}]}` |
| CUSTOM `tlc.task` | `{id, status, stage?, attempt?, commit?, files?, gate?:{pass,summary}, deviations?}` |
| CUSTOM `tlc.blocker` | `{id, task, kind:"blocked"|"partial"|"rejected"|"gate"|"error", reason, advice?}` |
| CUSTOM `tlc.blocker_resolved` | `{id}` |
| CUSTOM `tlc.milestone` | `{name}` reached |
| CUSTOM `tlc.usage` | `{task?, role, harness, model, input, output, cacheRead, cacheWrite, costUsd|null}` |
| CUSTOM `tlc.log` | `{level, message}` |

Reducer `fold(events) → RunState` (pure, in `core`): tasks by id with status; milestones reached when all tasks done (also accepts explicit `tlc.milestone`); blockers open until `blocker_resolved` or the task becomes `done`; usage summed per role and per model; `status` = running | finished | failed | interrupted | stale (no event 15 min, not finished).

## Plan parser (`core/plan`)

Input: `tasks.md` (+ `spec.md` for priority). Tasks = `### T<n>: <title>` blocks; fields `**Depends on**`, `**Requirement**`, `**Milestone**` (new, optional), `[P]` in title, `**Status**: Done`. Milestone resolution (owner decision): field → priority of the user story whose `**Requirement IDs**` contain the task's first requirement → wave `Wave <k>`. Waves = topological layers. Output JSON identical to `tlc.plan` value + `done` flags. `tlc plan --feature f --json` prints it.

## CLI `tlc` (`packages/cli`)

| Command | Behaviour |
| --- | --- |
| `tlc plan [--feature f] [--json]` | Parse plan |
| `tlc emit <type> --run <id> [--feature f] [json]` | Validate + append; `--start` creates a run and prints its id; POSTs to server (300 ms, ignore failure); exit 0 even when the server is down, exit 2 on invalid event |
| `tlc status [--feature f] [--run id] [--json]` | Folded state of newest run in the repo |
| `tlc watch [...]` | Ink TUI (TUI-01..04) |
| `tlc serve [--port 7317] [--repo path]...` | Server + SPA |
| `tlc run --feature f [--harness h] [--only] [--retries n] [--no-commit] [--resume] [--concurrency 3]` | Headless runner |
| `tlc install claude-code [--otel] [--hooks] [--workflow] [--panel] [--dry-run]` / `tlc uninstall claude-code` | Settings edits (marker `tlcDeck`), copy workflow to `~/.claude/workflows/tlc-execute.js` (backup existing), marketplace for the pane |

Config: `~/.config/tlc/config.json` < `<repo>/.specs/tlc-execute.json` < flags. `roles.<role>` = alias | `{harness, model, effort}`. `~/.claude/tlc-execute.json` read by the Workflow only.
Repo registry: `~/.local/state/tlc-deck/repos.json`, updated by `emit`, `run`, `serve --repo`, and hook events' `cwd` (git root).

## Server (`packages/server`)

- Hono 4 + `@hono/node-server`, `hostname: '127.0.0.1'`; refuses non-loopback `Host` (DNS rebinding).
- Ingest: file tailers per registered repo's `.specs/features/*/progress.ndjson` (scan every 5 s for new files); `POST /events` (dedupe by `runId+seq`); `POST /hooks`; `POST /v1/metrics|logs|traces`.
- Store tables: `runs`, `events`, `sessions`, `session_events`, `usage`; retention 30 days (daily purge).
- SSE `GET /api/stream`: AG-UI events for runs (`RUN_*`, `CUSTOM`, plus `STATE_SNAPSHOT` of folded state on connect) and `CUSTOM tlc.session` deltas. REST: `GET /api/runs`, `/api/runs/:id`, `/api/sessions`, `/api/sessions/:id`.
- Static SPA from `apps/web/dist`, SPA fallback.

### Sessions (SESS)

Hook body → session upsert by `session_id`: `cwd`, project (git root name), `model` (SessionStart), `state` (UserPromptSubmit/PreToolUse → working; Notification `permission_prompt`/`idle_prompt` → waiting; Stop → idle; SessionEnd → ended; 10 min silence → idle), `currentTool` (PreToolUse until PostToolUse), last prompt ≤ 200 chars (unless `--no-content`), subagents from SubagentStart/Stop (`agent_id`, `agent_type`). Hook response: empty 200 immediately. Hook timeout written: 2 s. Linked run: session `cwd` repo + run running in it.

### OTel (OTEL)

Metrics `claude_code.cost.usage`, `claude_code.token.usage` (`type` input|output|cacheRead|cacheCreation) by `session.id`; log events `claude_code.api_request` (`cost_usd`, tokens, `model`, `agent_id`, `workflow.run_id`, `workflow.name`) feed per-session and per-workflow usage. OTel values replace hook-side estimates when present.

## Web (`apps/web`)

Vite 8 + React 19 + Tailwind 4 (`@tailwindcss/vite`) + shadcn/ui (components.json in `apps/web`), TanStack Router (file-less, 4 routes), a small zustand store fed by `EventSource`. Charts: shadcn chart (Recharts 3).

| Route | Content |
| --- | --- |
| `/` | Two sections: Sessions grid (cards: project, state badge, current tool, model, tokens/cost, subagents, linked run) and Runs table (repo, feature, harness, status, milestones `3/5` progress, tasks done/total, blockers, elapsed, cost) |
| `/runs/:id` | Header (status, harness, roles), milestone timeline (stepper), task board (columns pending/running/review/blocked/done; card shows stage, attempt, commit), blockers panel (reason, advice), usage by role/model (bar chart), deviations, event log (virtualised) |
| `/sessions/:id` | Session header, timeline of prompts/tools/subagents, usage |
| Theme | light/dark via `class` + system default; responsive 390 px → single column |

## TUI (`tlc watch`)

Ink 8: header (feature, harness, status, elapsed, cost), milestone bar, task list grouped by status with stage + spinner, open blockers in red with advice, last 5 log lines. Non-TTY → one line per event. Exit summary + code (TUI-03).

## Runner (`packages/runner`)

- Schedule: waves from plan; within a wave `[P]` tasks run concurrently (cap `--concurrency`), others sequential; a task's dependents wait for Done; failure blocks dependents (`not_started`), independents continue.
- Per task: implement → verify (reviewer) → if rejected: advise (if enabled) → fix (retries) → commit. Implementer Blocked/Partial: advise → one advised re-implement.
- Prompts: role templates in `runner/prompts/*.md` (task block verbatim + paths of spec/design/context + rules: one task, no commits, report JSON). Status schema `{status, files, gate:{pass,summary}, deviations, issues}`; reviewer `{verdict: pass|reject, findings[]}`; advisor `{diagnosis, environmental, steps[]}`.
- Commit: `git add <files>` + `git commit -m "<type>(<scope>): <title> (<T>)"` + trailer from config `commitTrailer`.
- Resume: `--resume` reads the newest run's events; Done tasks skipped; tasks.md `**Status**: Done` honoured too.
- Drivers (`Driver.run({role, prompt, model, effort, cwd, schema}) → {data, text, usage, sessionId, exitCode}`):

| Driver | Command |
| --- | --- |
| claude | `claude -p <prompt> --output-format json --json-schema <s> --model m --effort e --permission-mode acceptEdits --allowedTools ...` → `structured_output`, `usage`, `total_cost_usd` |
| codex | `codex exec --json --output-schema <file> -o <out> -m m -C cwd --sandbox workspace-write <prompt>` → out file, usage from `turn.completed` |
| agy | `agy -p <prompt> --output-format json --json-schema <s> --model m --effort e --dangerously-skip-permissions` (opt-in flag `allowUnsafe`) → `structured_output`, `usage` |
| gemini | `gemini -p <prompt> -o json -m m --approval-mode auto_edit` → parse JSON from `response` |
| opencode | `opencode run --format json -m m <prompt>` → last `text` part; usage/cost from `step_finish` if present |

Auto-approve flags that skip all permissions are never default; `driver.<h>.extraArgs` in config lets the user add them. Each driver is tested against a fake executable replaying recorded fixtures.

## Claude Code pane (`integrations/claude-code/tlc-deck-panel`)

Mod (same pattern as memo-panel): `/tlc` command, pane, `$.ui.status("tlc 9/15 ▲1")`, refresh via `$.process.run(["tlc","status","--json"])` every 3 s.

## Testing

| Layer | Type | Run |
| --- | --- | --- |
| protocol, core (parser, reducer, ndjson tail, config) | Vitest unit + golden fixtures (`fixtures/runs/*.ndjson`, `fixtures/plans/*`) | `pnpm -r test` |
| server | Vitest with in-memory store + real HTTP on port 0 | `pnpm -r test` |
| cli/runner | Vitest + fake harness bins on PATH (`fixtures/bin/*`) + temp git repos | `pnpm -r test` |
| web | Vitest + Testing Library for reducers/components; `vite build` | `pnpm --filter web build` |
| pane mod | `claude plugin validate` + `claude plugin test` | see T16 |

Gates: Quick `pnpm -r test`; Full `pnpm check` = `biome check . && pnpm -r typecheck && pnpm -r test && pnpm --filter web build`.

## Spec deviations (orchestrator updates spec.md)

- RUN-02: harness list gains `agy` (DD-09).
- SESS-01: hooks are written into `~/.claude/settings.json` by the installer, not shipped by a plugin (DD-10).
- RUN-01 commit is done by the runner with git, not an agent (DD-07).
