# harness-integration Specification

Decisions: `context.md` (D-01..D-12). Server: `agent-memory-server` (REST `/api/v1/*`, MCP `/mcp`). Design deviations (MCP instead of REST, payload capture, opt-in status line wrap): `design.md` § Spec deviations.

## Problem Statement

memo serves memory over REST and MCP, but coding harnesses only use it when the
model decides to call an MCP tool. Context is not recalled at session start or per
prompt, sessions are never captured, setup is manual per harness, and the user
cannot see whether memo is connected or what was read and written.

## Goals

- [ ] One `memo` binary gives Claude Code, OpenCode, Gemini CLI and Codex CLI automatic recall and capture through each harness's own hook/plugin mechanism.
- [ ] `memo install <harness>` makes a harness memo-ready (hooks + MCP) in one command, reversible.
- [ ] Claude Code shows connection state and per-session read/write counts at a glance, plus a panel of recent memory events.
- [ ] A memo outage or expired login never blocks or slows a harness by more than the configured timeout.

## Out of Scope

| Feature                                          | Reason                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Server-side changes to memo-server               | Integration is client-side; uses existing REST/MCP                                  |
| Visual indicators in OpenCode, Gemini CLI, Codex | Owner asked for Claude Code; others get `memo status` only                          |
| Client-side LLM summarisation of sessions        | D-09: excerpt only; cognify extracts server-side                                    |
| Device-code / headless login                     | D-05: PKCE loopback only (P1); static `MEMO_TOKEN` env is the headless escape hatch |
| Cursor, Copilot and other harnesses              | D-01                                                                                |
| Windows support                                  | Linux + macOS first; Windows untested                                               |
| Tenant/global auto-capture                       | D-07: agent layer only                                                              |

---

## User Stories

### P1: Core CLI, config and login ⭐ MVP

**User Story**: As a developer, I want a `memo` CLI that logs me in once and talks to my memo server so that every harness adapter can reuse it.

**Acceptance Criteria**:

1. CLI-01: WHEN `memo login` runs THEN it SHALL perform OIDC authorization code + PKCE (S256) with a loopback redirect on `127.0.0.1:<ephemeral port>`, open the browser (print the URL if no browser), and store the refresh token in the OS keyring, falling back to `$XDG_STATE_HOME/memo/credentials` with mode 0600.
2. CLI-02: WHEN any command needs a token and the cached access token expires within 60 s THEN the CLI SHALL refresh it; IF refresh fails THEN it SHALL report state `login-needed` (no interactive prompt from hooks).
3. CLI-03: WHEN `MEMO_TOKEN` is set THEN the CLI SHALL use it as the bearer token and skip the keyring.
4. CLI-04: Config SHALL resolve in order: env (`MEMO_URL`, `MEMO_*`) > project `.memo.toml` (nearest ancestor of cwd) > `~/.config/memo/config.toml` > defaults; `memo config show` SHALL print the effective config with secrets redacted.
5. CLI-05: WHEN `memo logout` runs THEN it SHALL delete stored credentials from keyring and file.
6. CLI-06: Every REST call SHALL send `X-Cognee-Agent: <harness agent>` (D-06) when invoked for a harness, and SHALL never log tokens.
7. CLI-07: `memo recall <query>` and `memo remember <text>` SHALL work standalone (same layer/dataset rules as hooks) for manual use and testing.

**Independent Test**: Against a memo test stack with the fake OIDC issuer: `memo login` (driven headless in test), `memo remember "X=1"`, `memo recall X` returns the hit tagged with its layer; expired token is refreshed; `logout` clears it.

---

### P1: Harness-neutral hook engine ⭐ MVP

**User Story**: As a developer, I want each harness hook to call one command that recalls and captures memory, so behavior is identical across harnesses.

**Acceptance Criteria**:

1. HOOK-01: `memo hook <event> --harness <h>` SHALL read the harness's native hook JSON on stdin, normalise it to a neutral event (`session-start`, `prompt`, `tool-used`, `pre-compact`, `session-end`), and write the harness's native response on stdout.
2. HOOK-02: WHEN `session-start` fires THEN memo SHALL recall with query `<project> <branch>` (top_k 8) and inject at most 4 KiB of context formatted as a fenced "memo recall" block listing each hit with its layer.
3. HOOK-03: WHEN `prompt` fires with a prompt ≥ 20 chars that is not a slash command THEN memo SHALL recall with the prompt as query (Chunks, top_k 5) and inject at most 2 KiB; shorter prompts and slash commands SHALL inject nothing and make no call.
4. HOOK-04: WHEN `pre-compact` or `session-end` fires THEN memo SHALL remember the capture (CAPT-*) into the agent layer, dataset = project name (D-07), with `self_improvement` per config.
5. HOOK-05: WHEN `tool-used` fires for a memo MCP tool THEN memo SHALL count `recall` as a read and `remember`/`improve`/`forget` as writes, without calling the server.
6. HOOK-06: Every hook SHALL exit 0 and emit a valid "no-op" native response on any error (fail open); recall SHALL time out after 2 s (configurable); total hook wall time SHALL stay under timeout + 500 ms.
7. HOOK-07: WHEN memo is unreachable or login is needed THEN the hook SHALL record that state for the indicator and inject nothing.
8. HOOK-08: WHEN a remember fails THEN its payload SHALL be appended to the local write queue; every later hook SHALL first try to flush the queue (bounded to 1 s), oldest first; queue bound 100 entries / 5 MiB, dropping oldest and counting drops.
9. HOOK-10: WHEN `turn-end` fires THEN memo SHALL append the redacted final assistant text to the session's turns (no network); WHEN `prompt` fires it SHALL append the redacted prompt likewise (DD-12).
10. HOOK-09: Recall injection SHALL never include hits whose text came from the current session's own capture within the last 60 s (avoid echo) — de-duplicated by text hash.

**Independent Test**: Feed recorded native stdin fixtures for each harness and event to `memo hook` against the test stack; assert native stdout shape, injected text, counters, and that with the server stopped every hook exits 0 within 2.5 s and queues the write.

---

### P1: Session capture ⭐ MVP

**User Story**: As a developer, I want my sessions captured automatically, without tool noise or secrets, so memo learns what we did.

**Acceptance Criteria**:

1. CAPT-01: The capture SHALL contain user prompts and final assistant text replies since the last successful capture of that session (cursor kept in local state), in order, labelled `user:` / `assistant:`.
2. CAPT-02: Tool calls, tool results, thinking blocks and system/hook-injected text (including memo's own recall blocks) SHALL be excluded.
3. CAPT-03: Text matching secret patterns (bearer/JWT tokens, `sk-…`/`ghp_…`/AWS keys, PEM private keys, `password=`/`secret=` assignments) SHALL be replaced with `[REDACTED]` before leaving the machine.
4. CAPT-04: The capture SHALL be capped at 32 KiB, keeping the most recent content; empty captures SHALL not be sent.
5. CAPT-05: Capture SHALL be built from hook payloads accumulated per session (prompt text, final assistant text), never from transcript files (DD-12).

**Independent Test**: Golden transcripts per harness → `memo capture --dry-run` output equals golden excerpt; seeded secrets are redacted; cursor prevents resending.

---

### P1: Harness adapters and installer ⭐ MVP

**User Story**: As a developer, I want `memo install <harness>` to wire hooks and MCP for my harness so setup is one command.

**Acceptance Criteria**:

1. INST-01: `memo install <claude-code|opencode|gemini-cli|codex>` SHALL register the memo MCP server (`<MEMO_URL>/mcp`) and the hooks for every neutral event the harness supports, in the harness's user-level config.
2. INST-02: Install SHALL be idempotent (second run = no diff), SHALL back up each file it changes to `<file>.memo-bak.<timestamp>` before the first change, and SHALL preserve unrelated user config (comments preserved where the format allows).
3. INST-03: `memo uninstall <harness>` SHALL remove exactly the entries memo added, leaving other config untouched.
4. INST-04: `memo install --dry-run` SHALL print the diff without writing.
5. INST-05: The MCP client name each harness sends SHALL sanitize to the same agent name the hooks use (D-06); IF a harness's client name differs THEN the installer SHALL configure an `X-Cognee-Agent` header on the MCP entry where the harness supports headers.
6. ADAPT-01 (Claude Code): ship a plugin in `integrations/claude-code/` inside a repo marketplace (`.claude-plugin/marketplace.json`) with hooks for SessionStart, UserPromptSubmit, PostToolUse (memo MCP tools), PreCompact, SessionEnd, the MCP server entry, and the indicator (IND-*); `memo install claude-code` SHALL install via that plugin.
7. ADAPT-02 (OpenCode): ship a JS/TS plugin in `integrations/opencode/` that maps OpenCode events to `memo hook … --harness opencode`, plus MCP config.
8. ADAPT-03 (Gemini CLI): ship an extension in `integrations/gemini-cli/` (hooks + MCP).
9. ADAPT-04 (Codex CLI): ship config for Codex hooks + MCP in `integrations/codex/`; events Codex lacks SHALL be listed in its README with the degraded behavior.
10. ADAPT-05: A capability matrix (harness × neutral event → native event or "unsupported") SHALL live in `integrations/README.md` and be the single source used by the installer.

**Independent Test**: For each harness, `memo install` into a temp `$HOME` matches a golden config; re-run yields no diff; uninstall restores the original byte-for-byte except backups.

---

### P1: Claude Code status line indicator ⭐ MVP

**User Story**: As a Claude Code user, I want to see at a glance whether memo is connected and how many memories were read and written this session.

**Acceptance Criteria**:

1. IND-01: `memo statusline` SHALL read Claude Code's status line JSON on stdin (session id) and print one line: `● memo ↓<reads> ↑<writes>` when connected, `○ memo offline`, `○ memo login` when login is needed, plus `⧗<n>` when the write queue is non-empty.
2. IND-02: Connection state SHALL come from the last hook/statusline probe result in local state; `memo statusline` SHALL make at most one `/health` probe per 30 s (cached) and SHALL return within 300 ms.
3. IND-03: Counters SHALL be per Claude Code session id (D-08) and include hook recalls/remembers and memo MCP tool calls.
4. IND-04: `memo statusline --wrap '<cmd>'` SHALL run an existing status line command (e.g. usage-bar) with the same stdin and print its output followed by the memo segment, so the user's current status line is kept; the installer SHALL configure this wrap when a status line already exists.
5. IND-05: Colors SHALL use ANSI only when stdout is a TTY or `--color=always`; `NO_COLOR` disables them.

**Independent Test**: Simulated session: two prompts with recall, one MCP remember → `memo statusline` prints `● memo ↓2 ↑1` (plus session-start recall → `↓3`); stop server → `○ memo offline` within one probe interval.

---

### P2: Claude Code memory panel

**User Story**: As a Claude Code user, I want a panel that lists recent memory reads and writes so I can see what memo injected and stored.

**Acceptance Criteria**:

1. PANEL-01: A Claude Code mod in the plugin SHALL show a live panel with connection state, server URL, agent, dataset, and the last 20 events (time, ↓/↑, source hook|mcp, query or first 80 chars, hit count/layers, status).
2. PANEL-02: The panel SHALL read the same local event log as the status line (`memo events --json --session <id>`), never calling memo-server itself.
3. PANEL-03: WHEN state is offline or login-needed THEN the panel SHALL show the reason and the fix command (`memo login`).

**Independent Test**: With the plugin loaded, trigger recall + remember; panel shows both events within 2 s.

---

### P2: Diagnostics

1. DIAG-01: `memo status [--json]` SHALL show URL, login state (user, expiry), health, agent per harness, queue size/drops, installed harnesses.
2. DIAG-02: `memo doctor` SHALL check binary on PATH, config, login, server health, MCP audience reachability (`/.well-known/oauth-protected-resource/mcp`), and each installed harness's config, printing fixes.

---

### P3: Manual notes

1. NOTE-01: `memo note <text>` SHALL remember into the current project dataset/agent layer, counted as a write.

---

## Edge Cases

- WHEN two harness sessions run concurrently THEN state files SHALL be per session id and writes atomic (temp + rename); the queue SHALL use a file lock.
- WHEN cwd is not inside a git repo THEN project = cwd directory name; WHEN the name sanitizes to empty THEN dataset = `default`.
- WHEN the injected recall would exceed the byte cap THEN whole hits SHALL be dropped from the end (never cut mid-hit), and the block notes `(+N more)`.
- WHEN the harness sends malformed stdin THEN the hook SHALL exit 0 with a no-op response and log to `$XDG_STATE_HOME/memo/hook.log`.
- WHEN the transcript file is missing or unreadable THEN capture SHALL be skipped, counted as an error in state.
- WHEN the access token's audience is not accepted by REST (401) THEN state SHALL be `login-needed` with reason `audience`.
- WHEN `memo` is not on PATH for the harness THEN installed configs SHALL use the absolute binary path recorded at install time.

---

## Requirement Traceability

| Requirement ID | Story           | Phase    | Status                                                  |
| -------------- | --------------- | -------- | ------------------------------------------------------- |
| CLI-01..07     | P1: Core CLI    | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| HOOK-01..10    | P1: Hook engine | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| CAPT-01..05    | P1: Capture     | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| INST-01..05    | P1: Installer   | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| ADAPT-01..05   | P1: Adapters    | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| IND-01..05     | P1: Status line | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| PANEL-01..03   | P2: Panel       | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| DIAG-01..02    | P2: Diagnostics | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |
| NOTE-01        | P3: Notes       | Verified | Done (T1-T15; e2e in `crates/memo-cli/tests/it_e2e.rs`) |

**Coverage:** 45 total, 45 mapped to tasks (T1-T15).

---

## Success Criteria

- [ ] In each of the four harnesses, after `memo install`, a fact stated in session 1 is recalled automatically (injected) in session 2 without the user asking.
- [ ] With memo-server stopped, no harness hook delays a prompt by more than 2.5 s, and the queued capture is delivered after restart.
- [ ] Claude Code status line shows `● memo ↓n ↑m` matching the real number of recall/remember operations in the session, alongside the existing usage-bar output.
- [ ] `memo install` + `memo uninstall` leaves harness config byte-identical to before (excluding backups).
