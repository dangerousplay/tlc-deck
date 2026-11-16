# agent-live - Context (owner decisions, 2026-11-15)

| ID | Gray area | Decision |
| --- | --- | --- |
| D-01 | Source of live chat | Hooks stay the trigger; the server tails only transcript files named by hook payloads (`transcript_path`, `agent_transcript_path`) and that session's `subagents/` folder (incl. workflow agents). Replaces live-progress D-06 "no transcript watching" for announced sessions only |
| D-02 | Harnesses | Claude Code sessions/subagents/workflow agents + headless `tlc run` (drivers stream harness output into per-agent logs) |
| D-03 | Content | Full text and tool I/O, capped 8 KB per item, secrets redacted, kept 7 days; `--no-content` disables |
| D-04 | Task view | Spec block from tasks.md + stage timeline with each stage's agent and its live chat |
| D-05 | Not chosen | "Outcome" (files/diffstat, gate output, reviewer findings) |
