# solo-conductor Design

Spec: `spec.md` (SOLO, HLP, CCW, DMN). Decisions: `context.md`.

## Design decisions

| ID | Decision |
| --- | --- |
| DD-01 | `core/tasks.ts`: `taskBlock(tasksMd, id)` (exported, replaces the runner's private `taskBlocks`), `resolveGate(tasksMd, id) → {name, command} | null` (task `**Gate**` value → row of the "Gate Check Commands" table by name, case-insensitive; else first backticked command in the value), `commitMessage(task, plan, trailer)` → `<type>(<scope>): <title> (<T>)` where type = `test` if title starts with "test"/"e2e", `docs` for docs-only Where, else `feat`; scope = first path segment after `packages/`/`apps/`/`crates/`/`integrations/` of the first Where path |
| DD-02 | Driver capability `resume: "id" | "none"` and `run({..., resumeSessionId?})`. claude: `-r <id>`; codex: `codex exec resume <id>`; agy: `--conversation <id>`; opencode: `-s <id>`; gemini: `none` (index-based `-r` is unreliable). Each driver returns `sessionId` and per-turn `usage.input` |
| DD-03 | `runner/conductor.ts` (solo mode): loop tasks in dependency order (skip done, skip tasks whose deps failed); turn prompts from `runner/prompts/solo-{first,task,fix,handoff}.md`; worker status schema reused (`statusOutputJsonSchema`); gate via `core/exec` with 20 min timeout, output tail 4 KB; reviewer = existing reviewer prompt + `git diff HEAD -- <files>` (capped 32 KB) through a fresh driver call with `allowedTools` read-only; commit via `git.ts` + DD-01 message; rotation per context default (150k) |
| DD-04 | Events: worker gets one `AgentInfo` per session `{id: <runId>-worker-<n>, role: "worker", tasks: [..]}` (new optional `tasks` array; `task` = current); STEP names unchanged (`T3:implement`, `T3:gate`, `T3:review`, `T3:fix`, `T3:commit`) — `gate` is a new stage value |
| DD-05 | CLI helpers in `packages/cli/src/commands/{next,gate,review,commit}.ts` share the conductor's functions (`runGate`, `runReview`, `commitTask`) so behaviour is identical in and out of Claude Code. Run selection: newest active run of the feature, else `RUN_STARTED` with `input.mode = "solo-session"` and `driver: "workflow"` |
| DD-06 | Workflow solo mode: script resolves `mode` (args > project > user config > "solo"); Load agent checks `command -v tlc` and returns `tlc_available`; solo = one `agent()` with role `implementer` and a fixed loop prompt (`integrations/claude-code/workflow/solo-prompt.md` inlined at build time as a string constant) returning `{completed, failed, blocked, deviations}`; crew = existing code path untouched |
| DD-07 | Daemon: `cli/src/daemon.ts`. Pidfile `<state>/daemon.json` `{pid, port, version, startedAt}`; lock `<state>/daemon.lock` (O_EXCL create, stale after 10 s); `ensure` = GET `/api/health` (300 ms) → healthy & `app == "tlc-deck"` → reuse; else take lock, spawn `process.execPath <cli> serve --port P` detached (`stdio` → daemon.log, `unref`), poll health up to 3 s. `stop` = SIGTERM pid from pidfile if health says same pid. `serve` checks health first (DMN-03) |
| DD-08 | Install: SessionStart command hook `{"type":"command","command":"tlc daemon ensure --quiet","timeout":5}` with the existing marker so uninstall removes it; `--systemd` writes `~/.config/systemd/user/tlc-deck.service` (ExecStart `node <cli> serve`) and runs `systemctl --user enable --now`, else `ensure` |

## Testing

- core: gate resolution (table name, inline command, missing), commit message goldens on the memo fixture plan.
- runner: fake drivers with resume (assert one worker session id reused across tasks, rotation on token threshold and on `resume: none`), gate fail → fix turn → pass, reviewer reject → fix, deterministic commits in a temp repo; token comparison test crew vs solo on the same fixture plan using fake usage numbers proportional to prompt size.
- cli: helpers in a temp repo (next/gate/review/commit flow with fake reviewer driver); daemon start/ensure/stop with a temp state dir and port 0→free port; two concurrent ensure → one pid.
- workflow: stub-run harness (existing) for solo and crew paths.
- Gate: `pnpm check`.
