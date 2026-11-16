# STATE

## Decisions

See `features/live-progress/context.md` (D-01..D-08).

## Handoff

- **Feature**: live-progress
- **Phase**: Execute done (T1-T17, 2026-11-15; pnpm check green, 158 tests); real `tlc run --harness claude` smoke passed; web polish pass in progress
- **Next**: owner UAT: `tlc install claude-code --hooks --otel --workflow --panel`, `tlc serve`, open http://127.0.0.1:7317. Untested for real: codex/agy/gemini/opencode drivers (CLIs not installed), plugin pane in a live session, OTel from a live Claude Code
