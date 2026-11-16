# live-progress Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` Execute flow. Read `spec.md`, `context.md` and `design.md` in this folder first; `design.md` wins where it lists a spec deviation. Work only inside this repo; never edit files under `~/.claude` (installers are tested against a temp `HOME`). Do not install harness CLIs. Do not run real harness prompts (they cost tokens) except where a task says so.

**Design**: `.specs/features/live-progress/design.md`
**Status**: Approved (owner, 2026-11-15)

---

## Shared contracts

- Package manager pnpm, Node ≥ 22.13, ESM, TypeScript strict (`"module": "NodeNext"`), zod 4, Vitest, Biome. Packages named `@tlc-deck/<name>`; bin `tlc` from `packages/cli`.
- Event envelope, Custom event names and payloads, RunState shape: design.md § Event protocol. The zod schemas in `packages/protocol` are the single source; other packages import them.
- Paths: progress file `.specs/features/<feature>/progress.ndjson` (lock `progress.ndjson.lock`); state dir `$XDG_STATE_HOME/tlc-deck` (default `~/.local/state/tlc-deck`, env `TLC_STATE_DIR`); config `$XDG_CONFIG_HOME/tlc/config.json` (env `TLC_CONFIG`); server `127.0.0.1:7317` (env `TLC_PORT`, `TLC_URL`).
- Fixtures: `fixtures/plans/` (copy memo's harness-integration `tasks.md` + `spec.md` from the memo project (`.specs/features/harness-integration/`) as a real-world plan), `fixtures/runs/*.ndjson`, `fixtures/bin/<harness>` fake CLIs, `fixtures/hooks/*.json`, `fixtures/otel/*`.

## Test Coverage Matrix

| Code Layer | Test Type | Location | Run |
| --- | --- | --- | --- |
| protocol, core | unit + golden | `packages/{protocol,core}/test` | `pnpm -r test` |
| cli, runner | integration (temp git repo, fake bins) | `packages/{cli,runner}/test` | `pnpm -r test` |
| server | integration (HTTP on port 0, temp state dir) | `packages/server/test` | `pnpm -r test` |
| web | unit (Testing Library) + build | `apps/web/src/**/*.test.tsx` | `pnpm --filter @tlc-deck/web test && pnpm --filter @tlc-deck/web build` |
| pane mod | `claude plugin validate` / `claude plugin test` | `integrations/claude-code/tlc-deck-panel` | T16 |

## Gate Check Commands

| Gate | Command |
| --- | --- |
| Quick | `pnpm -r test` |
| Full | `pnpm check` (= `biome check . && pnpm -r typecheck && pnpm -r test && pnpm --filter @tlc-deck/web build`) |

---

## Execution Plan

```
Foundation:  T1 → T2 → T3, T4 [P] → T5
P1 drivers:  T5 → T6 (Claude Code Workflow)
P1 views:    T5 → T7 (server) → T8 (web shell + runs) → T9 (run detail)
             T5 → T10 (tlc watch) [P with T7]
P2:          T5 → T11 (runner core) → T12 (drivers)
             T7 → T13 (hooks + install) → T14 (OTel) ; T13 + T8 → T15 (web sessions)
             T5 → T16 (pane)
Finish:      all → T17
```

---

### T1: Monorepo scaffold

**Status**: Done
**Milestone**: Foundation
**What**: pnpm workspace with `packages/{protocol,core,server,cli,runner}`, `apps/web` (empty Vite React TS app placeholder), shared `tsconfig.base.json`, Biome config, Vitest workspace, root scripts `test`, `typecheck`, `check`, `build`. `README.md` skeleton, `LICENSE` (MIT), `.gitignore`, `.nvmrc` (22). Each package builds with `tsc -b` to `dist/`.
**Where**: repo root, `packages/*/package.json`, `packages/*/src/index.ts`
**Depends on**: none
**Requirement**: (infra)

**Done when**:
- [x] `pnpm install && pnpm check` passes with one trivial test per package
- [x] `node packages/cli/dist/index.js --version` prints the version

**Tests**: unit · **Gate**: full

---

### T2: Protocol package

**Status**: Done
**Milestone**: Foundation
**What**: `@tlc-deck/protocol`: depend on `@ag-ui/core` 1.0.x and reuse its event schemas (verify exact export names in its `.d.ts`); define the envelope schema (`metadata` v, seq, runId, threadId, harness, driver, source), Custom payload schemas (`tlc.plan`, `tlc.task`, `tlc.blocker`, `tlc.blocker_resolved`, `tlc.milestone`, `tlc.usage`, `tlc.log`), `parseLine(line) → {ok, event} | {ok:false, reason}` that ignores unknown types and extra fields, `TaskStatus`, `BlockerKind`, `RunState` types. Export JSON Schema of the status/reviewer/advisor role outputs (used by drivers).
**Where**: `packages/protocol/src/*.ts`, `packages/protocol/test/*.test.ts`
**Depends on**: T1
**Requirement**: PROTO-01, PROTO-02, PROTO-04

**Done when**:
- [x] Valid/invalid fixtures per event; unknown type skipped; newer `v` with extra fields accepted
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T3: Plan parser

**Milestone**: Foundation
**What**: `@tlc-deck/core` `plan.ts`: parse tasks.md (+ optional spec.md) per design.md § Plan parser: tasks, `[P]`, depends, requirement, explicit `**Milestone**`, done flags (`**Status**: Done` or all Done-when boxes checked), milestone resolution field → priority → wave, waves (topological; cycle → error naming the tasks).
**Where**: `packages/core/src/plan.ts`, `packages/core/test/plan.test.ts`, `fixtures/plans/`
**Depends on**: T2
**Requirement**: PROTO-03 (milestones), RUN-01

**Done when**:
- [x] Golden for memo harness-integration plan (15 tasks, priority milestones) and for a synthetic plan using `**Milestone**` fields and one with neither (waves)
- [x] Cycle and missing-dependency errors tested
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T4: NDJSON io and reducer [P]

**Status**: Done
**Milestone**: Foundation
**What**: `core/ndjson.ts`: `appendEvent(file, event)` (lock file, assigns `seq`, atomic line append), `readEvents(file)`, `tail(file, onEvent, {signal})` per DD-05. `core/reduce.ts`: `fold(events) → RunState` per design.md (status, milestones, tasks, blockers, usage per role/model, timings, stale after 15 min). `core/runs.ts`: list runs in a file/repo, newest active run.
**Where**: `packages/core/src/{ndjson,reduce,runs}.ts`, tests, `fixtures/runs/`
**Depends on**: T2
**Requirement**: PROTO-01, PROTO-03, PROTO-04

**Done when**:
- [x] Golden: 15-task run with a blocker resolved by retry, one failed task, usage from 3 models
- [x] Concurrent appends from 4 processes keep unique increasing `seq` and whole lines
- [x] Tail survives partial lines, truncation and file replacement
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T5: CLI base: plan, emit, status, config

**Status**: Done
**Milestone**: Foundation
**What**: `tlc` CLI (commander or citty) with `plan`, `emit` (incl. `--start` printing a new `tlc_<ulid>` run id, best-effort POST to `$TLC_URL/events` with 300 ms timeout), `status [--json]`, `--version`. Feature auto-detect: the only feature folder with tasks.md, else the newest progress file, else error listing features. Config loader (user < repo `.specs/tlc-execute.json` < flags) with roles normalisation as design.md. Repo registry update in `repos.json`.
**Where**: `packages/cli/src/**`, `packages/core/src/config.ts`
**Depends on**: T3, T4
**Requirement**: PROTO-05, CCD-04 (exit codes), PANE-02 (status json)

**Done when**:
- [x] Temp git repo test: `tlc emit --start` → id; `tlc emit CUSTOM ...`; `tlc status --json` equals fold of file
- [x] `emit` exits 0 with server down in < 500 ms; exit 2 on invalid JSON
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T6: Claude Code driver (Workflow)

**Status**: Done
**Milestone**: Claude Code driver
**What**: `integrations/claude-code/workflow/tlc-execute.js`: start from the current `~/.claude/workflows/tlc-execute.js` (read only; copy into the repo) and add progress events per DD-06: Load agent runs `tlc plan --json` when available (else parses as today) and `tlc emit --start` (returns runId in its schema), emits `tlc.plan`; each stage agent's prompt gets one instruction to run `tlc emit STEP_STARTED/STEP_FINISHED/CUSTOM ...` with the given runId at start and end (skipping silently if `tlc` is missing); blockers on Blocked/Partial/rejected; commit agent emits `tlc.task` done with commit sha; run end emits `RUN_FINISHED`. Keep all current features (roles, config files, advisor, resume, waves). Also record any env vars visible to agents that identify the workflow run (DD-12) in `RUN_STARTED.input.env` (names only for anything not starting with `CLAUDE_`/`WORKFLOW`). Add `node --check` + a stub-run test harness (mock `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()` globals) asserting the emitted command sequence.
**Where**: `integrations/claude-code/workflow/*`, `packages/cli/test/workflow.test.ts`
**Depends on**: T5
**Requirement**: CCD-01..04

**Done when**:
- [x] Stub run of a 3-task plan (one rejected then fixed) produces prompts containing the expected `tlc emit` commands and returns the same result shape as today
- [x] `node --check` passes; no `Date.now`/`Math.random`/fs/env use in the script
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T7: Server core

**Status**: Done
**Milestone**: Dashboard
**What**: `@tlc-deck/server` + `tlc serve`: Hono app on 127.0.0.1 (reject non-loopback Host), `Store` over `node:sqlite` (tables per design, migrations, 30-day purge), repo registry + file tailers for `progress.ndjson`, `POST /events` (dedupe runId+seq), SSE `/api/stream` (snapshot on connect, then events; heartbeat 15 s), REST `/api/runs`, `/api/runs/:id`, static SPA serving with fallback (serves a placeholder if `apps/web/dist` missing). Rebuild runs from files on start.
**Where**: `packages/server/src/**`, `packages/cli/src/commands/serve.ts`
**Depends on**: T5
**Requirement**: SRV-01..05

**Done when**:
- [x] Integration: append to a watched file → SSE client receives event < 1 s; POST duplicate ignored; restart rebuilds runs
- [x] Non-loopback Host → 403
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T8: Web shell and runs list

**Status**: Done
**Milestone**: Dashboard
**What**: `apps/web`: Vite 8 + React 19 + Tailwind 4 + shadcn/ui init (components.json in `apps/web`), app shell (sidebar: Overview, Runs, Sessions; theme toggle light/dark/system), SSE client store (zustand) with reconnect, Overview page with Runs table (design.md § Web) and an empty Sessions section placeholder. Dev proxy to `127.0.0.1:7317`. Production build served by T7.
**Where**: `apps/web/**`
**Depends on**: T7
**Requirement**: WEB-01, WEB-03, SRV-03

**Done when**:
- [x] Component tests: runs table renders fixture state (status badge, milestones `3/5`, blockers count, cost)
- [x] `vite build` passes; `tlc serve` serves the built app
- [x] Full gate passes

**Tests**: unit + build · **Gate**: full

---

### T9: Run detail view

**Status**: Done
**Milestone**: Dashboard
**What**: `/runs/:id`: header, milestone stepper, task board columns with cards (stage, attempt, commit link text, gate), blockers panel (reason, advice, kind), usage by role and model (shadcn chart), deviations list, virtualised event log; live updates from the store; 390 px layout single column.
**Where**: `apps/web/src/routes/run/*`
**Depends on**: T8
**Requirement**: SRV-04, WEB-02, WEB-03

**Done when**:
- [x] Component tests with the T4 golden run: board columns counts, open blocker shown, resolved hidden, milestone reached states
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T10: `tlc watch` TUI [P]

**Status**: Done
**Milestone**: Terminal
**What**: Ink 8 view per design.md § TUI, reading the NDJSON via `tail`; default newest active run in repo; non-TTY line mode; exit summary and code.
**Where**: `packages/cli/src/watch/**`
**Depends on**: T5
**Requirement**: TUI-01..04

**Done when**:
- [x] `ink-testing-library` frame tests for running/blocked/finished; non-TTY output golden; exit code 1 when failed tasks
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T11: Headless runner core

**Status**: Done
**Milestone**: Any harness
**What**: `@tlc-deck/runner` + `tlc run`: scheduler (waves, `[P]` concurrency cap, dependents of failures not started), stage machine implement → verify → advise → fix → commit, retries, role prompts (`runner/prompts/*.md`), status/review/advice schemas from protocol, git commit with trailer from config, `--only`, `--no-commit`, `--resume`, SIGINT → `RUN_ERROR` + clean exit. `Driver` interface + `FakeDriver` for tests.
**Where**: `packages/runner/src/**`, `packages/cli/src/commands/run.ts`
**Depends on**: T5
**Requirement**: RUN-01, RUN-03..06

**Done when**:
- [x] Fake-driver runs in a temp git repo: happy path (one commit per task), reviewer reject → advise → fix, Blocked → advised retry, failure blocks dependents only, resume skips Done, SIGINT
- [x] Events fold to the expected RunState
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T12: Harness drivers

**Status**: Done
**Milestone**: Any harness
**What**: Drivers `claude`, `codex`, `agy`, `gemini`, `opencode` per design.md table: argv builder, availability check (`command -v`), output parsing (status object, final text, usage, cost, session id), timeout, error → blocker `error`. Fake executables in `fixtures/bin/` replaying recorded/synthesised outputs from the documented formats (claude json with `structured_output`, codex JSONL + `-o` file, agy json envelope, gemini json `response`, opencode JSONL with/without `step_finish`). `driver.<h>.extraArgs` from config.
**Where**: `packages/runner/src/drivers/*.ts`, `fixtures/bin/*`
**Depends on**: T11
**Requirement**: RUN-02, RUN-04, RUN-05

**Done when**:
- [x] Each driver: argv golden, parse success, malformed output → blocker, missing binary → blocker, usage mapping
- [x] Optional smoke (orchestrator, costs tokens; passed 2026-11-15, $0.02 haiku): `tlc run` on a 1-task toy plan with `--harness claude --no-commit`
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T13: Claude Code hooks ingest and installer

**Status**: Done
**Milestone**: Live sessions
**What**: Server `POST /hooks` → session model per design.md § Sessions (states, current tool, subagents, prompt truncation, `--no-content`, idle timer), store + SSE `CUSTOM tlc.session` deltas + REST `/api/sessions[/:id]`. `tlc install|uninstall claude-code` with `--hooks` (HTTP hooks for the SESS-01 events, timeout 2 s, into `~/.claude/settings.json` under a marker so uninstall restores bytes), `--workflow` (copy T6 script to `~/.claude/workflows/`, backing up an existing file), `--panel` (marketplace + plugin add via `claude plugin` if on PATH, else print the commands), `--dry-run`. Tests use temp `HOME` only.
**Where**: `packages/server/src/sessions/**`, `packages/cli/src/install/**`
**Depends on**: T7
**Requirement**: SESS-01..05, CCD-02 (install)

**Done when**:
- [x] Hook fixtures (`fixtures/hooks/*.json` built from the documented fields) drive a session through working → waiting → idle → ended with subagents
- [x] Installer golden in temp HOME; idempotent; uninstall byte-identical
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T14: OTel receiver

**Status**: Done
**Milestone**: Live sessions
**What**: `/v1/metrics`, `/v1/logs`, `/v1/traces` accepting `application/json` and `application/x-protobuf` (protobufjs + vendored opentelemetry-proto, gzip); map `claude_code.cost.usage`, `claude_code.token.usage`, `claude_code.api_request` to session and workflow usage (DD-11/12, run linking heuristic); traces accepted and ignored except span counts. `tlc install claude-code --otel` writes the env block.
**Where**: `packages/server/src/otel/**`, `vendor/opentelemetry-proto/`
**Depends on**: T13
**Requirement**: OTEL-01..04

**Done when**:
- [x] JSON and protobuf fixtures (encode protobuf fixtures in-test from the same JSON) produce identical usage
- [x] Unknown metrics ignored; gzip accepted
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T15: Web sessions views

**Status**: Done
**Milestone**: Live sessions
**What**: Sessions grid on Overview and `/sessions` (cards per design.md), `/sessions/:id` timeline and usage, linked run badge → run detail.
**Where**: `apps/web/src/routes/sessions/*`
**Depends on**: T13, T8
**Requirement**: SESS-02, SESS-03, WEB-03

**Done when**:
- [x] Component tests from session fixtures (states, current tool, subagents)
- [x] Full gate passes

**Tests**: unit · **Gate**: full

---

### T16: Claude Code pane

**Status**: Done
**Milestone**: Terminal
**What**: Mod `tlc-deck-panel` (plugin.json, hooks/hooks.json modules, register.tsx) per design.md; marketplace at repo root `.claude-plugin/marketplace.json`; follow the bundled plugin-authoring skill rules (no passing `$` to helpers).
**Where**: `integrations/claude-code/tlc-deck-panel/**`, `.claude-plugin/marketplace.json`
**Depends on**: T5
**Requirement**: PANE-01, PANE-02

**Done when**:
- [x] `claude plugin validate integrations/claude-code/tlc-deck-panel` and `claude plugin validate .` pass
- [x] `claude plugin test` with stubbed `$.process.run` (running, blocked, none) asserts status text and pane rows

**Tests**: plugin test · **Gate**: quick + plugin validate

---

### T17: End-to-end and docs

**Status**: Done
**Milestone**: Release
**What**: E2E test: temp repo with fixture plan → `tlc run` with fake claude driver while `tlc serve` runs → SSE client sees RUN_STARTED … RUN_FINISHED, `tlc status --json` matches, hooks fixture creates a session linked to the run. README: install (`pnpm i -g` from repo / `npx`), quick start per harness, Claude Code setup (`tlc install claude-code --hooks --otel --workflow --panel`), screenshots placeholder, protocol doc `docs/protocol.md`, privacy note (localhost, no telemetry).
**Where**: `packages/cli/test/e2e.test.ts`, `README.md`, `docs/*`
**Depends on**: T6, T9, T10, T12, T14, T15, T16
**Requirement**: all

**Done when**:
- [x] E2E passes; Full gate passes
- [x] README and docs/protocol.md cover every command and event

**Tests**: e2e · **Gate**: full

---

## Accepted deviations (orchestrator)

- Protocol: `RUN_STARTED.input` validated as a plain object; direct zod dependency (`zod/v4`); TaskStatus = pending|running|done|failed|blocked|skipped.
- CLI: `node:util` parseArgs; `TLC_URL=off` disables event POSTs; SIGINT exit 130.
- Workflow driver: extra orchestrator agents `report <id>` (no-commit tasks) and `finish run` emit the closing events; script excluded from biome (top-level return).
- Runner: Done tasks in tasks.md always skipped; `--retries` default 2 = fix rounds; advisor off only via `RunOptions.advisor`; `--only` treats outside deps as satisfied.
- Drivers: fake CLIs synthesised from documented formats (`FAKE_MODE`); claude reviewer/advisor get read-only `--allowedTools`.
- Server: rebuild without broadcast; OTel usage prefers api_request logs over metrics; run linking via logs only; protobuf protos trimmed to decoded fields.
- Installer: byte restore via sidecar `settings.json.tlc-deck` (+ `-otel`); default install = hooks + workflow; `--panel`, `--otel` opt-in.
- Web (pre-polish): Vite 7 (vitest 3 limit); no TanStack Router; hand-written shadcn components and div bar charts. Polish pass replaces these with real shadcn/ui + charts.
- Orchestrator fixes after the run: T3 commit lacked `plan.ts` + fixtures (c2517c9); `tlc run` used a placeholder driver factory and claude rejected zod's `$schema` (1a32421); run list lacked repo/feature/harness (bc26a18).
