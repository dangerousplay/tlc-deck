# solo-conductor - Context (owner decisions, 2026-11-21)

| ID | Gray area | Decision |
| --- | --- | --- |
| D-01 | Default execution | A conductor (plain code, no LLM) plus at most one worker agent that keeps its context across tasks, to cut token use. The current multi-agent flow stays as `mode: "crew"` |
| D-02 | Verification | Conductor runs the task's gate command; then a separate cheap reviewer (haiku, fresh context, read-only, sees the task block + diff) checks Done-when. Failures go back to the same worker session as a fix turn |
| D-03 | Claude Code | The tlc-execute workflow launches one agent that works through all tasks in its own context and calls deterministic helpers: `tlc next`, `tlc gate`, `tlc review`, `tlc commit`, `tlc emit` |
| D-04 | Daemon | Installing starts the dashboard daemon; every entry point reuses a running daemon and starts one only if none is running (single instance) |

## Defaults chosen by the planner (owner may override)

- Session rotation: the worker session is replaced by a fresh one (with a short handoff summary turn) when the harness reports more than 150k input tokens for the last turn, or the harness cannot resume.
- Solo mode ignores `[P]` (one worker = sequential), dependency order kept.
- Commits are made by `tlc commit` (deterministic message `<type>(<scope>): <title> (<T>)` + `commitTrailer`), never by an agent.
- Daemon autostart: `tlc install claude-code` adds a SessionStart command hook `tlc daemon ensure --quiet`; `tlc run`, `tlc watch` and `tlc emit --start` also ensure it. `--no-daemon` / config `daemon.autoStart: false` disables. systemd unit only with `--systemd`.
