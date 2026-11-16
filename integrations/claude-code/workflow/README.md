# tlc-execute workflow

Claude Code Workflow script. Copy to `~/.claude/workflows/tlc-execute.js` (or run `tlc install claude-code --workflow`).
It reports progress through `tlc emit` (run by the agents it spawns) and silently skips reporting when `tlc` is not on PATH.
