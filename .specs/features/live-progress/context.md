# live-progress - Context (owner decisions, 2026-11-15)

| ID | Gray area | Decision |
| --- | --- | --- |
| D-01 | Harness agnosticism | Shared protocol + two drivers: Claude Code keeps a Workflow script (parallel agents, models per role, resume, `/workflows`); a standalone TS runner `tlc run` drives other harnesses headless (`codex exec`, `gemini -p`, `opencode run`, `claude -p`). Both emit the same events |
| D-02 | Dashboard scope | All live Claude Code sessions on the machine + every tlc run (from any harness) |
| D-03 | Web stack | Vite React SPA + small Node server (Hono), TypeScript, Tailwind v4, shadcn/ui; SSE to the browser |
| D-04 | Access | Localhost only, bind 127.0.0.1, no auth |
| D-05 | Repo | New repo `tlc-deck`, pnpm monorepo |
| D-06 | Session ingest | Claude Code HTTP hooks (`type: "http"`) POST to the server, plus an OTLP/HTTP receiver for Claude Code OpenTelemetry metrics/events (cost, tokens, `session.id`, `agent_id`, `workflow.run_id`). No transcript watching |
| D-07 | Progress format | AG-UI-shaped, versioned NDJSON events in `.specs/features/<feature>/progress.ndjson`; served to the browser as AG-UI events over SSE |
| D-08 | Terminal views | `tlc watch` TUI and a Claude Code pane mod. (Not chosen: status line segment, generated PROGRESS.md) |

## Defaults chosen by the planner (owner may override)

- **Milestone**: a task's optional `**Milestone**: <name>` field in tasks.md; without it, the user story priority of its requirement (P1, P2, …) from spec.md; without that, its dependency wave ("Wave 1", "Wave 2", …). A milestone is reached when all its tasks are Done.
- **Blocker**: an open condition that stops a task: implementer status Blocked or Partial, reviewer rejection after the last retry, failed gate, or harness/driver error. Carries `task`, `kind` (blocked | partial | rejected | gate | error), `reason`, `advice` (advisor diagnosis, if any) and is resolved by a later Done for the same task.
- **Run identity**: `run_id` = Workflow run id inside Claude Code, else `tlc_<ulid>`. A run belongs to `repo` (git root), `feature` and `harness`.
- **Run discovery**: the server watches `progress.ndjson` files of repos registered with `tlc serve --repo <path>` (default: the cwd and repos seen in hook events), and `tlc emit` / drivers also POST each event to a running server (fire-and-forget, 300 ms timeout). The file is the source of truth; the POST only lowers latency.
- **Roles**: same roles as the current tlc-execute (orchestrator, implementer, reviewer, advisor). Each role = `{harness?, model?, effort?}`; `harness` defaults to the driver's harness. Config: `~/.config/tlc/config.json` < `<repo>/.specs/tlc-execute.json` < CLI flags. The existing `~/.claude/tlc-execute.json` keeps working for the Claude Code driver.
- **Port**: one HTTP listener on `127.0.0.1:7317` serves the dashboard, `/hooks`, OTLP/HTTP (`/v1/metrics`, `/v1/logs`, `/v1/traces`) and `/events`. 4317/4318 are left free for a real OTel collector; OTLP gRPC is not supported (Claude Code is configured with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`).
- **History**: sessions and runs kept in SQLite at `~/.local/state/tlc-deck/deck.db`, 30 days.
- **Cost on other harnesses**: from the driver's structured output when the harness reports usage; otherwise tokens only, cost unknown.
