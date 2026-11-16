# tlc-deck

Live progress for tlc-spec-driven runs. A CLI, a local server and a web dashboard that show
what a run (or any harness session) is doing right now: plan, tasks, milestones, blockers, usage.

## Install

From a clone (requires Node 22 and pnpm):

```sh
pnpm install
pnpm build
pnpm -C packages/cli link --global   # or: pnpm i -g ./packages/cli
tlc --version
```

Without installing: `npx ./packages/cli` (after `pnpm build`).

## Quick start

```sh
tlc serve                 # dashboard + API on http://127.0.0.1:7317
tlc plan                  # parse .specs/features/<feature>/tasks.md
tlc run --feature my-feat # headless run; events go to progress.ndjson
tlc watch                 # live terminal view of the latest run
tlc status --json         # folded state of the latest run
```

Feature detection: `--feature` wins; otherwise the only feature folder with a `tasks.md`, otherwise
the feature with the newest `progress.ndjson`.

Screenshots: _placeholder (dashboard, watch view)_.

## Commands

| Command                                                                                                       | Purpose                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tlc plan [--feature f] [--json]`                                                                             | Parse `tasks.md` (+ `spec.md`): tasks, `[P]`, dependencies, milestones, waves.                                                                               |
| `tlc emit <type> [json] [--run id] [--feature f] [--harness h] [--driver d] [--source s] [--name n]`          | Append one protocol event to `progress.ndjson` and POST it to the server (best effort, exits 0 when the server is down). Exit 2 on invalid input.            |
| `tlc emit --start [json] [--feature f]`                                                                       | Emit `RUN_STARTED` and print the new run id (`tlc_<ULID>`). `$TLC_RUN`, `$TLC_HARNESS`, `$TLC_DRIVER`, `$TLC_SOURCE` supply defaults.                        |
| `tlc status [--feature f] [--run id] [--json]`                                                                | Folded state of a run (latest by default).                                                                                                                   |
| `tlc watch [--feature f] [--run id]`                                                                          | Live terminal view; plain text when stdout is not a TTY.                                                                                                     |
| `tlc serve [--port 7317] [--repo path]... [--no-content]`                                                     | Local server: ingests `progress.ndjson` of registered repos, Claude Code hooks and OTLP, serves the dashboard. `--no-content` drops prompts and tool inputs. |
| `tlc run [--feature f] [--harness h] [--only T1,T2] [--retries n] [--no-commit] [--resume] [--concurrency n]` | Headless runner: implement, verify (reviewer), advise on failure, commit per task. Exit 130 when interrupted.                                                |
| `tlc install claude-code [--hooks] [--otel] [--workflow] [--panel] [--dry-run]`                               | Configure Claude Code integration.                                                                                                                           |
| `tlc uninstall claude-code [same flags]`                                                                      | Revert the above.                                                                                                                                            |
| `tlc --version`                                                                                               | Print the version.                                                                                                                                           |

Environment: `TLC_URL` (server base URL for `emit`, default `http://127.0.0.1:7317`, `off` disables),
`TLC_PORT`, `TLC_STATE_DIR` (server state, default under `$XDG_STATE_HOME/tlc-deck`).

Roles (orchestrator, implementer, reviewer, advisor) are configured in `~/.claude/tlc-execute.json`,
overridden by `<repo>/.specs/tlc-execute.json`.

## Claude Code setup

```sh
tlc install claude-code --hooks --otel --workflow --panel
```

- `--hooks`: HTTP hooks post session events to `/hooks` (sessions: working, waiting, idle, ended, subagents).
- `--otel`: points Claude Code's OTLP exporter at `/v1/*` for token/cost usage.
- `--workflow`: installs the tlc-execute workflow variant that emits protocol events.
- `--panel`: installs the in-session panel.

Use `--dry-run` to preview changes; `tlc uninstall claude-code` reverts them. Other harnesses
(Codex, Gemini, OpenCode, agy) are driven through `tlc run --harness <name>` or by calling
`tlc emit` from their own hooks.

## Agent live view

The dashboard shows what each agent is doing: a task view (`/runs/:run/tasks/:task`) with the spec
text and an agent chat (messages, collapsible tool calls and results, live updates), and the agents
of a Claude Code session (main, subagents, workflow agents). `tlc watch` can focus on one task. For
`tlc run`, agent logs are written to `.specs/features/<feature>/agents/<runId>/<agentId>.ndjson`.
Content is capped at 8 KB per field, secrets are redacted, items are kept 7 days, and
`tlc serve --no-content` stores no text or tool data. Details: [docs/protocol.md](docs/protocol.md#agents-agent-live).

## Protocol

See [docs/protocol.md](docs/protocol.md).

## Privacy

Everything is local. The server binds to `127.0.0.1` only and rejects non-loopback `Host` headers.
There is no telemetry and no outbound network traffic from tlc-deck itself. Data lives in your repos
(`progress.ndjson`) and in the local state directory. Prompts shown in the dashboard are truncated
to 200 characters; start the server with `--no-content` to store none.

## Development

```sh
pnpm install
pnpm check
```
