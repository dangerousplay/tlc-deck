# tlc-deck

**Vision:** Run tlc-spec-driven task plans from any coding harness and watch every run, and every live Claude Code session, as it happens: in the terminal, beside the chat and in a local web dashboard.
**For:** Developers who plan with tlc-spec-driven and execute with agents (Claude Code, Codex CLI, Gemini CLI, OpenCode), often several sessions at once.
**Solves:** tlc-execute only runs inside Claude Code, and its progress is only visible in `/workflows` of the session that started it. There is no shared view of milestones, finished tasks, blockers and cost across runs and sessions.

## Goals

- One progress protocol: any harness that executes a `tasks.md` emits the same versioned events, and every viewer reads only those events.
- `tlc run` executes a tasks.md headless with Codex CLI, Gemini CLI, OpenCode or `claude -p`; inside Claude Code the Workflow driver keeps parallel agents, models per role and resume.
- A local dashboard at `http://127.0.0.1:<port>` shows all live Claude Code sessions and all tlc runs, updating within 1 s of an event.
- `tlc watch` and a Claude Code pane show the same run state in the terminal.

## Tech Stack

**Core:**

- Language: TypeScript 5.x, Node.js 22 LTS
- Monorepo: pnpm workspaces
- Server: Hono on Node, SSE to the browser, SQLite (better-sqlite3) for session history
- Web: Vite + React 19 + Tailwind CSS v4 + shadcn/ui
- TUI: Ink (React for terminals)

**Key dependencies:** Hono, better-sqlite3, @opentelemetry/otlp-transformer (OTLP/HTTP JSON + protobuf decode), zod (event schemas), Ink, shadcn/ui.

## Scope

**v1 includes:**

- `@tlc-deck/protocol`: AG-UI-shaped NDJSON event schema with zod validators and a reducer to run state.
- `tlc` CLI: `run` (headless drivers per harness), `watch` (TUI), `serve` (dashboard), `emit` (append an event from any script), `install claude-code`.
- Claude Code integration: tlc-execute Workflow driver that writes the protocol events, HTTP hooks for live session state, OTLP export settings, a pane mod.
- Dashboard: sessions grid, session detail (status, current tool, subagents, tokens/cost), run list, run detail (milestones, task board, blockers, cost per role/model).

**Explicitly out of scope:**

- Remote / multi-machine access, auth (localhost only; SSH tunnel for remote viewing).
- Reading harness transcripts (`~/.claude/projects/*.jsonl`) for session discovery.
- Live monitoring of non-Claude sessions outside tlc runs.
- Editing tasks or steering agents from the dashboard (read-only v1).

## Constraints

- Localhost only: server binds 127.0.0.1, no auth.
- Nothing is sent off the machine; no telemetry.
- Harness CLIs are optional at runtime; a missing one disables only its driver.
- The tlc-spec-driven `tasks.md` format is the input contract; no changes required to existing tasks files.
