# solo-conductor Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` Execute flow. Read `spec.md`, `context.md`, `design.md` in this folder first. Work only inside this repo; never edit files under `~/.claude` or `~/.config` (installer and daemon tests use a temp `HOME`, temp state dir and a free port). Do not run real harness prompts. Gate for every task: `pnpm check` at repo root.

**Design**: `.specs/features/solo-conductor/design.md`
**Status**: Approved (owner, 2026-11-21)

## Execution Plan

```
T1 → T2 → T3 → T4 → T6 → T7
T1 → T5 [P after T1]
```

---

### T1: Task helpers in core

**Milestone**: Conductor
**What**: DD-01: `taskBlock`, `resolveGate`, `commitMessage` in `core/tasks.ts`; runner switches to `taskBlock`.
**Where**: `packages/core/src/tasks.ts`, `packages/runner/src/runner.ts`, tests
**Depends on**: none
**Requirement**: SOLO-03, SOLO-05

**Done when**:
- [ ] Gate resolution tests (table name, inline command, none); commit message goldens for the memo fixture plan
- [ ] Gate passes

---

### T2: Driver session resume

**Milestone**: Conductor
**What**: DD-02 for all drivers + fake executables honouring resume flags (fake keeps per-session state in a temp dir so tests can assert reuse) and reporting per-turn input tokens.
**Where**: `packages/runner/src/drivers/**`, `fixtures/bin/*`
**Depends on**: T1
**Requirement**: SOLO-02, SOLO-06

**Done when**:
- [ ] Argv goldens with and without `resumeSessionId`; gemini reports `resume: none`
- [ ] Gate passes

---

### T3: Solo conductor

**Milestone**: Conductor
**What**: DD-03/DD-04: `mode` option/config/flag (default solo), conductor loop, gate, reviewer, fix turns, deterministic commit, rotation with handoff, events (`tasks` on AgentInfo, `gate` stage). Crew unchanged.
**Where**: `packages/runner/src/conductor.ts`, `packages/runner/src/prompts/solo-*.md`, `packages/runner/src/runner.ts`, `packages/protocol/src/*`, `packages/cli/src/commands/run.ts`
**Depends on**: T2
**Requirement**: SOLO-01..07

**Done when**:
- [ ] Fake-driver tests: one session across 3 tasks; gate fail → fix → pass; review reject → fix; rotation on tokens and on `resume: none`; commits with trailer; dependents of a failed task skipped
- [ ] Token comparison test: solo uses ≤ 50 % of crew input tokens on the fixture plan
- [ ] Gate passes

---

### T4: Helper commands

**Milestone**: Claude Code
**What**: DD-05: `tlc next`, `tlc gate`, `tlc review`, `tlc commit` sharing conductor functions.
**Where**: `packages/cli/src/commands/{next,gate,review,commit}.ts`, `packages/cli/src/main.ts`
**Depends on**: T3
**Requirement**: HLP-01..05

**Done when**:
- [ ] Temp-repo flow test: next → gate (fail then pass) → review (fake reviewer) → commit → next returns the following task → `{"done": true}` at the end; events fold to the expected state
- [ ] Gate passes

---

### T5: Single daemon [P]

**Milestone**: Daemon
**What**: DD-07/DD-08: `/api/health`, `tlc daemon start|stop|status|ensure|restart`, single-instance `serve` (`--force`), ensure from `run`/`watch`/`next` (`--no-daemon`, `daemon.autoStart`), installer SessionStart hook + ensure, `--systemd` option (tested with a fake `systemctl` on PATH).
**Where**: `packages/cli/src/daemon.ts`, `packages/cli/src/commands/serve.ts`, `packages/cli/src/install/**`, `packages/server/src/server.ts`
**Depends on**: T1
**Requirement**: DMN-01..05

**Done when**:
- [ ] Tests: ensure starts one daemon; second ensure reuses (same pid); two concurrent ensures → one pid; serve refuses a second instance; stop kills only our pid; installer golden with the SessionStart hook, uninstall restores bytes
- [ ] Gate passes

---

### T6: Workflow solo mode

**Milestone**: Claude Code
**What**: DD-06 in `integrations/claude-code/workflow/tlc-execute.js`: mode resolution, `tlc` availability check, single worker agent loop prompt, crew fallback; meta description/whenToUse mention `mode`.
**Where**: `integrations/claude-code/workflow/*`, `packages/cli/test/workflow.test.ts`
**Depends on**: T4
**Requirement**: CCW-01..03

**Done when**:
- [ ] Stub runs: solo issues exactly one worker `agent()` call (plus Load) and returns the result shape; crew path unchanged; no `tlc` → crew
- [ ] Gate passes

---

### T7: End-to-end and docs

**Milestone**: Release
**What**: E2E: `tlc run` solo with fake claude on the fixture plan while the daemon (ensure) runs → SSE shows one worker agent spanning tasks, gate/review steps, commits; README sections for modes, helpers, daemon; `docs/protocol.md` for `gate` stage and `AgentInfo.tasks`.
**Where**: `packages/cli/test/e2e-solo.test.ts`, `README.md`, `docs/*`
**Depends on**: T3, T5, T6
**Requirement**: all

**Done when**:
- [ ] E2E passes; docs updated
- [ ] Gate passes
