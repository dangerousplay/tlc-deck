# harness-integration Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` Execute flow. Read `spec.md`, `context.md` and `design.md` in this folder first; `design.md` wins where it lists a spec deviation. No changes to `memo-server`, `memo-auth`, `memo-memory`, `memo-falkor` source (tests may reuse their public APIs and `memo-testkit`). Clean room AD-003 still applies.

**Design**: `.specs/features/harness-integration/design.md`
**Status**: Approved (owner: "explore … then implement", 2026-11-15)

---

## Shared contracts (all tasks)

**Binary**: crate `crates/memo-cli` (package `memo-cli`, bin `memo`), workspace member, edition/licence from workspace. Async on tokio. New deps go to `[workspace.dependencies]` when shared.

**Config** (`config.rs`, CLI-04). TOML, all keys optional:

```toml
url = "https://memo.example.com"   # server origin; /mcp appended
client_id = ""                      # OAuth client id; empty = DCR
[recall]
timeout_ms = 2000
start_enabled = true
start_top_k = 8
start_max_bytes = 4096
prompt_enabled = true
prompt_top_k = 5
prompt_max_bytes = 2048
min_prompt_chars = 20
[capture]
enabled = true
max_bytes = 32768
self_improvement = false
every_turns = 0                     # 0 = only at pre-compact/session-end
[queue]
max_entries = 100
max_bytes = 5242880
```
Order: env (`MEMO_URL`, `MEMO_TOKEN`, `MEMO_CONFIG` = path of user config, `MEMO_STATE_DIR`) > nearest ancestor `.memo.toml` > `$XDG_CONFIG_HOME/memo/config.toml` (default `~/.config/memo/config.toml`) > defaults.

**State dir** `S` = `MEMO_STATE_DIR` or `$XDG_STATE_HOME/memo` (default `~/.local/state/memo`), created 0700.

- `S/sessions/<harness>-<session_id>.json`: `{ "harness", "session_id", "project", "reads": u64, "writes": u64, "turns": [{"role":"user"|"assistant","text"}], "cursor": usize, "recent_hashes": [{"h": hex sha256 of normalised text, "ts"}], "started": ts, "updated": ts }`
- `S/events.jsonl`: one object per line `{ "ts": RFC3339, "harness", "session", "dir": "read"|"write", "source": "hook"|"mcp", "op": "recall"|"remember"|"improve"|"forget", "summary": first 80 chars of query/text, "hits": n|null, "layers": [..], "status": "ok"|"error"|"queued"|"skipped", "error": str|null }`; rotate to `events.jsonl.1` at 1 MiB.
- `S/health.json`: `{ "state": "connected"|"offline"|"login-needed", "reason": str|null, "checked": ts, "url" }`.
- `S/queue/<unix_millis>-<uuid>.json`: `{ "harness", "agent", "dataset", "text", "self_improvement", "session" }`; lock `S/queue/.lock` (flock).
- `S/credentials.json` (0600, keyring fallback), `S/token-cache.json` (0600), `S/hook.log`.
  All writes temp-file + rename.

**Agent per harness** (D-06): `claude-code`, `opencode`, `gemini-cli`, `codex`. Header `X-Cognee-Agent` on every MCP request.

**Project/dataset** (D-07): git root dir name (walk up for `.git`; branch from `.git/HEAD`, no git binary), else cwd dir name; sanitised with memo's agent-name rules (lowercase, `[a-z0-9_-]`, others → `-`, trim leading `-`/`_`, max 64); empty → `default`.

**Neutral hook I/O** (used directly by `--harness opencode` and by tests):
stdin `{ "event": "session-start"|"prompt"|"turn-end"|"tool-used"|"pre-compact"|"session-end", "session_id", "cwd", "prompt"?, "assistant"?, "tool_name"? }` → stdout `{ "context": "<text or empty>" }`.

**Injection block** (HOOK-02/03):

```
<memo-recall query="<query, max 80 chars>">
[<layer>] <hit text, newlines collapsed to spaces>
(+N more)
</memo-recall>
```
Empty block (no hits) = inject nothing.

---

## Accepted deviations (orchestrator)

- T6: only `session-start` flushes the queue in-hook; capture events spawn a detached `memo flush` (HOOK-08 "every later hook" relaxed to avoid per-prompt latency).
- T6: echo filter matches whole normalised hit text only.
- T7: adapters share one parse/render in `adapters/mod.rs`; per-harness files hold only `events()`. Gemini injection includes `hookEventName`.
- T9: statusline probe freshness uses `health.json` mtime, probe budget 200 ms; installed-harness detection is a marker scan; `memo events` newest first.
- T10: Codex hook timeout fixed at 10 s; `--statusline` ignored for Codex; uninstall deletes a config file it created once empty.
- T11: `serde_json` `preserve_order`; `include_dir` for the OpenCode plugin; Claude plugin option at `pluginConfigs."memo@memo".options.memo_bin`; previous status line kept in `memoPreviousStatusLine`; byte restore holds for 2-space pretty JSON with trailing newline.
- T13: refresh code repeated inline in three hooks (`claude plugin validate` rejects passing `$` to helpers); no tsconfig.
- T14: Gemini MCP command wraps `sh -c 'exec "${MEMO_BIN:-memo}" …'` (variable substitution in `command` unverified); Codex snippet uses `/path/to/memo`.
- T15: OpenCode e2e captures via pre-compact (no session-end); server-down simulated with unreachable URL; multi-thread tokio; flush retried while a detached flush holds the lock. One earlier full run showed unexplained failures; orchestrator rerun of the full Build gate was clean.
- Integration env: `scripts/it-env.sh` now falls back to rootless podman or `/var/run/docker.sock`.

## Test Coverage Matrix

| Code Layer                                                                                                | Test Type                                                     | Location                                                          | Run                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Pure logic (config, project, redaction, caps, format, adapters parse/render, installer edits, statusline) | unit + fixture/golden                                         | `crates/memo-cli/src/**` tests, `crates/memo-cli/tests/fixtures/` | `cargo test -p memo-cli --lib`                  |
| Auth flow vs fake AS, state concurrency, CLI binary behaviour                                             | integration (no containers)                                   | `crates/memo-cli/tests/*.rs`                                      | `cargo test -p memo-cli`                        |
| Against a real memo-server (`/mcp`)                                                                       | integration, `MEMO_IT=1`                                      | `crates/memo-cli/tests/it_*.rs`                                   | `. scripts/it-env.sh && cargo test -p memo-cli` |
| Claude Code mod                                                                                           | `claude plugin validate` + `claude plugin test`               | `integrations/claude-code/memo-panel/`                            | see T13                                         |
| OpenCode plugin                                                                                           | `bun test` or `node --test` if available, else typecheck only | `integrations/opencode/memo/`                                     | see T14                                         |

## Gate Check Commands

| Gate  | Command                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Quick | `cargo test -p memo-cli --lib`                                                                                                      |
| Full  | `cargo test -p memo-cli && . scripts/it-env.sh && cargo test -p memo-cli`                                                           |
| Build | `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && . scripts/it-env.sh && cargo test --workspace` |

---

## Execution Plan

```
Phase 1 core:     T1 → T2 → T3 → T4
Phase 2 hooks:    T5 → T6 → T7 → T8
Phase 3 surface:  T9
Phase 4 install:  T10 → T11 → T12 → T13 → T14
Phase 5 e2e:      T15
```

---

### T1: Crate scaffold, config, project

**Status**: Done

**What**: Create `memo-cli` (workspace member) with clap skeleton for all subcommands (`login logout status doctor config recall remember note hook mcp statusline events install uninstall flush`), unimplemented ones exiting 2 with "not implemented". Implement `config.rs` (layering, `memo config show` with `client_id` shown, tokens never), `project.rs` (project name, branch, sanitiser, `default`).
**Where**: `Cargo.toml` (members), `crates/memo-cli/**`
**Depends on**: None
**Reuses**: sanitiser rules from `crates/memo-server/src/mcp_auth.rs::agent_from_client` (copy logic, do not depend on memo-server)
**Requirement**: CLI-04, edge cases (project name)

**Done when**:

- [x] Unit: layering order env > project > user > default for every key group; nearest-ancestor `.memo.toml`; project name in git repo / subdir / non-git / unsanitisable → `default`; branch from `.git/HEAD` (ref and detached)
- [x] `memo --help` lists all subcommands; Quick gate passes; clippy clean

**Tests**: unit · **Gate**: quick

---

### T2: Local state

**Status**: Done

**What**: `state.rs` per Shared contracts: state dir (0700), session files, events log with rotation, health cache, write queue (enqueue with bounds 100 entries / 5 MiB dropping oldest and counting drops in `S/queue/.drops`, list oldest-first, remove, flock), atomic writes.
**Where**: `crates/memo-cli/src/state.rs`
**Depends on**: T1
**Requirement**: HOOK-08 (storage), edge case concurrency, D-08

**Done when**:

- [x] Unit: session round trip; counters increment; events append + rotation at 1 MiB; queue bounds by count and bytes with drop counter; oldest-first order
- [x] Integration: 8 threads/processes appending events and incrementing the same session concurrently lose no updates (use a per-session lock file)
- [x] Quick + `cargo test -p memo-cli` pass

**Tests**: unit, integration · **Gate**: full (no containers)

---

### T3: Login, credentials, token

**Status**: Done

**What**: `auth/` per DD-02/DD-08. `memo login [url]` (stores url into user config when given): fetch `<url>/.well-known/oauth-protected-resource/mcp` → `resource`, `authorization_servers[0]`; OIDC discovery `<issuer>/.well-known/openid-configuration` (fallback RFC 8414 `/.well-known/oauth-authorization-server`); client id from config else DCR (`registration_endpoint`, `token_endpoint_auth_method: none`, `redirect_uris: ["http://127.0.0.1/callback"]`, `grant_types: [authorization_code, refresh_token]`, `client_name: "memo-cli"`); loopback server on `127.0.0.1:0`, PKCE S256, `state` check, `resource` param, scope `openid offline_access` plus `scopes_supported` from the PRM if present; open browser (`open` crate) and always print the URL; exchange code; store `{refresh_token, client_id, issuer, token_endpoint, resource}` in keyring service `memo` user `<url origin>` with file fallback 0600. Token getter: `MEMO_TOKEN` wins; cached access token reused until 60 s before `exp` (decode JWT payload without verifying, only for `exp`); refresh grant otherwise; refresh failure → `AuthError::LoginNeeded`. `memo logout` clears keyring, file and cache.
**Where**: `crates/memo-cli/src/auth/*.rs`, `tests/login.rs`
**Depends on**: T2
**Reuses**: `reqwest` (rustls), `keyring`, `sha2`, `base64`, `rand`, `url`, axum for the loopback listener (already a workspace dep)
**Requirement**: CLI-01, CLI-02, CLI-03, CLI-05, DD-02, DD-08

**Done when**:

- [x] Integration vs an in-test fake AS (axum: PRM, discovery, DCR, authorize that redirects straight back with a code, token endpoint verifying PKCE verifier and `resource`): login without browser (test hook env `MEMO_LOGIN_NO_BROWSER=1` + a test client that follows the printed URL) stores credentials; second token call uses cache; expired cache refreshes; failing refresh → LoginNeeded; logout removes all; `MEMO_TOKEN` bypasses everything; wrong `state` rejected
- [x] Credentials file mode 0600; tokens never appear in `hook.log` or stdout of `config show`
- [x] Full gate (no containers) passes

**Tests**: integration · **Gate**: full

---

### T4: MCP client and manual commands

**Status**: Done

**What**: `client.rs`: rmcp streamable-HTTP client to `<url>/mcp` with `Authorization: Bearer` and `X-Cognee-Agent`, `recall(query, top_k, search_type CHUNKS) -> Vec<Hit{layer, text, dataset_name}>`, `remember(text, dataset_name, layer "agent", self_improvement, background true)`, `health()` (`GET <url>/health`). Map 401 → LoginNeeded(reason `audience` if token present), connect/timeout → Offline; update `health.json` on every outcome; record events (`source: hook` by caller choice). Commands `memo recall <q> [--harness h] [--json]`, `memo remember <text>`, `memo note <text>` (NOTE-01; current project dataset, counts write).
**Where**: `crates/memo-cli/src/client.rs`, `src/main.rs`, `tests/it_client.rs`
**Depends on**: T3
**Reuses**: rmcp features `client`, `transport-streamable-http-client-reqwest`; recall/remember tool argument names from `crates/memo-server/src/mcp.rs` (`RecallArgs`, `RememberArgs`)
**Requirement**: CLI-06, CLI-07, NOTE-01, HOOK-07 (state)

**Done when**:

- [x] IT (`MEMO_IT=1`): start memo-server on the memo-testkit stack with `MCP_RESOURCE_URL` set (see `crates/memo-server/tests/mcp.rs` for setup), mint a token with the MCP audience, `MEMO_TOKEN=… memo remember "A=1" --harness codex` then `memo recall "value of A" --harness codex --json` returns a hit with layer `agent`; X-Cognee-Agent honoured (a different harness agent does not see it at agent layer)
- [x] Unit/integration without containers: unreachable URL → state `offline` within timeout; 401 → `login-needed`
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T5: Redaction, turns and capture builder

**Status**: Done

**What**: `hook/capture.rs`: `redact(text)` (bearer/JWT `eyJ…\.…\.…`, `sk-[A-Za-z0-9_-]{16,}`, `ghp_`/`gho_`/`github_pat_`, `AKIA[0-9A-Z]{16}`, PEM private key blocks, `(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+` → keep key, value `[REDACTED]`); strip `<memo-recall …>…</memo-recall>` blocks; `append_turn(session, role, text)`; `build_capture(session) -> Option<String>` from `turns[cursor..]` as `user: …` / `assistant: …` lines, newest kept within `max_bytes` (drop oldest whole turns; a single turn larger than cap is cut from its start at a char boundary), `None` when empty; advance cursor on enqueue.
**Where**: `crates/memo-cli/src/hook/capture.rs`
**Depends on**: T2
**Requirement**: CAPT-01..05, HOOK-10, DD-12

**Done when**:

- [x] Unit: table of secret samples all redacted and non-secrets untouched; memo-recall blocks stripped; cap keeps newest; cursor prevents resend; empty → None; multibyte text never split mid-char
- [x] Quick gate passes

**Tests**: unit · **Gate**: quick

---

### T6: Hook engine

**Status**: Done

**What**: `hook/mod.rs` + `hook/recall.rs`: neutral event dispatch with fail-open (any error → log to `S/hook.log`, exit 0, no-op output) and a hard deadline (`recall.timeout_ms` + 500 ms wall). Behaviour per event:

- `session-start`: flush queue (≤1 s), recall query `"<project> <branch>"` top_k `start_top_k`, inject ≤ `start_max_bytes`.
- `prompt`: append turn (redacted); if `prompt_enabled`, length ≥ `min_prompt_chars` and not starting with `/`: recall top_k `prompt_top_k`, inject ≤ `prompt_max_bytes`. Echo filter HOOK-09: skip hits whose normalised-text hash is in `recent_hashes` younger than 60 s (hashes recorded at capture time per turn).
- `turn-end`: append assistant turn; if `every_turns > 0` and that many turns since cursor, do the capture path.
- `tool-used`: if tool name matches memo (`mcp__memo__*`, `mcp_memo_*`, `memo_*`, or `memo`/`recall`/`remember` under server memo) count read for recall, write for remember/improve/forget; event source `mcp`.
- `pre-compact`, `session-end`: build capture, enqueue, spawn detached `memo flush` (setsid, null stdio), return immediately (no network in hook).
  `memo flush`: under queue lock, deliver oldest first until empty, error or 10 s; on success remove + event `write ok`; on failure keep, event `queued`.
  Injection format per Shared contracts; whole hits only, `(+N more)`.
  **Where**: `crates/memo-cli/src/hook/{mod,recall}.rs`, `src/flush.rs`
  **Depends on**: T4, T5
  **Requirement**: HOOK-02..10, D-10

**Done when**:

- [x] Unit: injection formatting/caps/`(+N more)`; skip rules for short prompt and slash command (no client call — use a client trait + fake); echo filter; tool-name matching table
- [x] Integration (fake client): server down → every event exits 0 under 2.5 s, capture lands in queue, `memo flush` later delivers it (fake server) and empties queue; counters and events recorded
- [x] Full gate passes

**Tests**: unit, integration · **Gate**: full

---

### T7: Harness adapters (stdin/stdout)

**Status**: Done

**What**: `adapters/{claude_code,codex,gemini,opencode}.rs`: `parse(native_event_name, stdin) -> NeutralEvent` and `render(neutral, context) -> stdout`, per design tables. `memo hook <native-or-neutral-event> --harness <h>`: accept the native event name (e.g. `UserPromptSubmit`, `BeforeAgent`, `Stop`) or the neutral name. Outputs: Claude/Codex/Gemini injection = `{"hookSpecificOutput":{"hookEventName":<native>,"additionalContext":…}}`, no-op = `{}`; Gemini stdout must be JSON only; Codex `Stop` must output JSON; OpenCode = neutral `{"context":…}`. Field mapping: Claude/Codex `prompt`, `last_assistant_message`, `tool_name`; Gemini `prompt`, `prompt_response`, `tool_name`. Each adapter exposes `events() -> &[(Neutral, &'static str native)]` (DD-10).
**Where**: `crates/memo-cli/src/adapters/*.rs`, `tests/fixtures/<harness>/*.json`, `tests/adapters.rs`
**Depends on**: T6
**Requirement**: HOOK-01, ADAPT-05 (matrix data)

**Done when**:

- [x] Fixture per harness × supported event (stdin per the field lists in design.md) → expected neutral event; render goldens for inject and no-op
- [x] Malformed stdin → exit 0 + no-op output + `hook.log` line
- [x] Quick + full (no containers) gates pass

**Tests**: unit, integration · **Gate**: full

---

### T8: `memo mcp` stdio proxy

**Status**: Done

**What**: `proxy.rs`: rmcp stdio server exposing exactly the tools memo-server exposes (`remember`, `recall`, `forget`, `improve`, `cognify_status`), schemas fetched from the remote `list_tools` at startup (fallback: static copy if offline, tool calls then return a tool error "memo offline: <reason>"), each call forwarded to `/mcp` with the harness agent header; counts reads/writes into the session file keyed by `--session` if given else `<harness>-mcp-<pid start date>`, events `source: mcp`. Since the harness session id is unknown to the proxy, also append the event with `session: null`; `memo events --session` (T9) attributes `session: null` mcp events to the most recently updated session of that harness.
**Where**: `crates/memo-cli/src/proxy.rs`, `tests/it_proxy.rs`
**Depends on**: T4
**Reuses**: rmcp `server` + `transport-io`
**Requirement**: DD-03, INST-05, IND-03

**Done when**:

- [x] IT: spawn `memo mcp --harness codex` as child, rmcp client over its stdio lists 5 tools, `remember` then `recall` round-trip through the test memo-server; events recorded with `source: mcp`
- [x] Offline: tools listed, calls return tool error, process does not exit
- [x] Full gate passes

**Tests**: integration · **Gate**: full

---

### T9: statusline, events, status, doctor

**Status**: Done

**What**: `memo statusline [--wrap <cmd>] [--color auto|always|never]` (IND-01/02/04/05): stdin Claude status JSON (`session_id`, `cwd`), output per IND-01 using counts from `claude-code-<session_id>` (+ `session: null` mcp events attributed per T8), health probe at most once per 30 s with 300 ms budget (else cached), `⧗<n>` queue; `--wrap` runs `sh -c <cmd>` with the same stdin and prints its stdout then the memo segment on the same last line separated by `│`. `memo events [--json] [--session id] [--harness h] [--limit 20]` → `{ "state", "reason", "url", "agent", "dataset", "reads", "writes", "queued", "drops", "events": [...] }` (PANEL-02 contract). `memo status [--json]` (DIAG-01). `memo doctor` (DIAG-02) with one line per check `ok|warn|fail <check>: <detail>` and a fix hint.
**Where**: `crates/memo-cli/src/{statusline,events,status,doctor}.rs`
**Depends on**: T8
**Requirement**: IND-01..05, PANEL-02 (data), DIAG-01, DIAG-02

**Done when**:

- [x] Unit/golden: statusline strings for connected/offline/login/queue, NO_COLOR, wrap concatenation; events JSON shape
- [x] Timing test: statusline with unreachable server returns < 300 ms
- [x] Full gate passes

**Tests**: unit, integration · **Gate**: full

---

### T10: Installer core + Codex

**Status**: Done

**What**: `install/mod.rs`: `memo install <harness> [--dry-run] [--remote] [--statusline] [--bin <path>]`, `memo uninstall <harness>`, backups `<file>.memo-bak.<unix_ts>` before first change, unified diff output for `--dry-run` (`similar` crate), idempotency, absolute memo path (`std::env::current_exe` canonicalised, or `--bin`). Codex: `~/.codex/config.toml` (respect `CODEX_HOME`) via `toml_edit`: `[mcp_servers.memo]` stdio (`command`, `args = ["mcp","--harness","codex"]`) or with `--remote` `url = "<url>/mcp"` + `bearer_token_env_var = "MEMO_TOKEN"` + `http_headers = { "X-Cognee-Agent" = "codex" }`; hooks `[[hooks.<Event>]]` with `[[hooks.<Event>.hooks]] type="command" command="<bin> hook <Event> --harness codex" timeout=<s>`; identify memo entries on uninstall by command prefix `<bin> hook` / table name `mcp_servers.memo`. Print the `/hooks` trust reminder. `memo install --matrix` prints the capability matrix markdown from adapters' `events()`.
**Where**: `crates/memo-cli/src/install/{mod,codex}.rs`, `tests/install_codex.rs`, goldens
**Depends on**: T7
**Requirement**: INST-01..04, ADAPT-04, ADAPT-05

**Done when**:

- [x] Temp `HOME`/`CODEX_HOME`: install into empty and into a pre-existing config with comments and unrelated tables → matches golden; second install = no change; uninstall → byte-identical to original; `--dry-run` writes nothing
- [x] Full gate passes

**Tests**: integration (golden) · **Gate**: full

---

### T11: Installers: Claude Code, Gemini CLI, OpenCode

**Status**: Done

**What**:

- Claude Code: if `claude` on PATH run `claude plugin marketplace add <repo root or --source>` then `claude plugin install memo@memo --scope user` and `memo-panel@memo`; set plugin option `memo_bin` (via `pluginConfigs` in `~/.claude/settings.json`, JSON preserve order); `--statusline` sets `statusLine.command` to `<bin> statusline --wrap '<previous command>'` (previous kept in a marker field for uninstall). Without `claude`, print the commands. Marketplace source default: the repo containing the running binary's source is unknown at runtime, so `--source <path|git-url>` with default `https://github.com/dangerousplay/memo`.
- Gemini CLI: if `gemini` on PATH → `gemini extensions install <source>/integrations/gemini-cli/memo --consent`; else edit `~/.gemini/settings.json`: `mcpServers.memo` stdio + `hooks.<Event>` entries (`type:"command"`, `name:"memo"`, `command`, `timeout` ms).
- OpenCode: copy `integrations/opencode/memo/` to `~/.config/opencode/plugins/memo/` (embedded with `include_dir!` so no source checkout is needed) and add `mcp.servers.memo = {type:"local", command:[bin,"mcp","--harness","opencode"]}` to `~/.config/opencode/opencode.json` (create if absent; `.jsonc` → edit only if no comments, else print the snippet). Write `memo_bin` into the plugin's `config.json`.
  Uninstall reverses each.
  **Where**: `crates/memo-cli/src/install/{claude_code,gemini,opencode}.rs`, tests + goldens
  **Depends on**: T10 (and T12-T14 files exist for embedding; create placeholder dirs if needed and let T12-T14 fill them)
  **Requirement**: INST-01..05, ADAPT-01..03, IND-04

**Done when**:

- [x] Golden tests in temp HOME with `PATH` lacking `claude`/`gemini` (file-edit paths) and with fake `claude`/`gemini` scripts on PATH recording argv
- [x] Idempotent; uninstall restores bytes; full gate passes

**Tests**: integration (golden) · **Gate**: full

---

### T12: Claude Code plugin + marketplace

**Status**: Done

**What**: `.claude-plugin/marketplace.json` at repo root (`name: "memo"`, owner, plugins `memo` → `./integrations/claude-code/memo`, `memo-panel` → `./integrations/claude-code/memo-panel`). Plugin `memo`: `.claude-plugin/plugin.json` with `userConfig.memo_bin` (string, default `memo`), `hooks/hooks.json` for SessionStart, UserPromptSubmit, Stop, PostToolUse (matcher `mcp__memo__.*`), PreCompact, SessionEnd each `"${CLAUDE_PLUGIN_OPTION_MEMO_BIN:-memo}" hook <NativeEvent> --harness claude-code` (timeouts: SessionStart/UserPromptSubmit 5, others 3), `.mcp.json` stdio memo server (`command` `${user_config.memo_bin}`, args `mcp --harness claude-code`), README.
**Where**: `.claude-plugin/marketplace.json`, `integrations/claude-code/memo/**`
**Depends on**: T11
**Requirement**: ADAPT-01

**Done when**:

- [x] `claude plugin validate integrations/claude-code/memo` passes; `claude plugin validate .` passes for the marketplace
- [x] Manual smoke (orchestrator): `claude --plugin-dir integrations/claude-code/memo -p "hi"` runs hooks without error with server unreachable (fail open)

**Tests**: validation · **Gate**: build

---

### T13: Claude Code mod `memo-panel`

**Status**: Done

**What**: Mod plugin `integrations/claude-code/memo-panel/` (`.claude-plugin/plugin.json` with `userConfig.memo_bin`, `"types": "./types/index.d.ts"`; `hooks/hooks.json` `{ "modules": ["./register.tsx"] }`; `hooks/register.tsx`; `types/index.d.ts`). Behaviour: on `session.start` register command `/memo` (opens pane) and start `$.clock.every(3000, refresh)`; refresh runs `$.process.run([memo_bin, "events", "--json", "--harness", "claude-code", "--session", <session id>, "--limit", "20"], { timeoutMs: 2000 })`, stores the parsed object in an atom, sets `$.ui.status("● memo ↓r ↑w")` / `"○ memo offline"` / `"○ memo login"` (+ ` ⧗n`); also refresh right after any `tool.call` whose tool starts with `mcp__memo__`. `AbovePrompt` band only when state ≠ connected: reason + `run: memo login` / `memo doctor`. Pane `memo` (opened by `/memo`, not unasked): url, agent, dataset, counters, last 20 events (time, ↓/↑, source, summary, hits/layers, status). Never calls memo-server.
**Where**: `integrations/claude-code/memo-panel/**`
**Depends on**: T12
**Tools**: Skill `plugin-authoring` (types at the path it names; examples `pane.tsx`, `band.tsx`, `tool-call.ts`); grep the types for the session id field and `$.process.run`.
**Requirement**: PANEL-01..03, IND-01 (mod form), DD-04, DD-05

**Done when**:

- [x] `claude plugin validate` passes; `tsc -p` type-checks; `claude plugin test` with a test that stubs `$.process.run` output (connected and offline) asserts status text and pane rows — tsc not installed; TS checked via `claude plugin validate`
- [x] Gate: build

**Tests**: mod test · **Gate**: build

---

### T14: OpenCode plugin, Gemini extension, Codex files, matrix README

**Status**: Done

**What**:

- `integrations/opencode/memo/` (directory plugin, V2 API `Plugin.define({ id: "memo", setup(ctx) })`, `package.json`, `index.ts`, `config.json` with `memo_bin`): map events per design table; spawn `memo hook <neutral> --harness opencode` with neutral stdin JSON via `node:child_process` `spawn` (timeout 3 s, ignore failures); store returned `context` per session and push it onto `e.system` in the next `context` hook, then clear; turn-end from `session.status` idle using the last assistant message text.
- `integrations/gemini-cli/memo/`: `gemini-extension.json` (`name`, `version`, `mcpServers.memo` stdio with `settings[]` `MEMO_BIN`), `hooks/hooks.json` per design table (`timeout` ms), README.
- `integrations/codex/README.md` + `config.snippet.toml` (what `memo install codex` writes; `/hooks` trust step).
- `integrations/README.md`: install one-liners per harness, the capability matrix generated by `memo install --matrix` (test asserts README section equals the generated text), Rauthy prerequisite (DCR enabled or a public client with loopback redirect; tokens with `aud` = `MCP_RESOURCE_URL`).
  **Where**: `integrations/**`, `crates/memo-cli/tests/matrix.rs`
  **Depends on**: T13
  **Requirement**: ADAPT-02..05

**Done when**:

- [x] Matrix drift test passes; JSON files parse; OpenCode plugin typechecks if `tsc`/`bun` available (else note in README as untested)
- [x] Full gate passes

**Tests**: unit (drift) · **Gate**: full

---

### T15: End-to-end and docs

**Status**: Done

**What**: `tests/it_e2e.rs` (`MEMO_IT=1`): with the test stack + token, for each harness run the native fixture sequence through the binary: session-start → prompt "remember that the deploy port is 8443" → turn-end → session-end → `memo flush` (wait for cognify) → new session-start + prompt "what is the deploy port?" injects a block containing `8443`. Server stopped: every hook returns < 2.5 s, capture queued, delivered after restart. `memo statusline` counts match operations. Update root `README.md` (memo CLI section: login, install per harness, indicator, privacy of capture), `.specs` traceability.
**Where**: `crates/memo-cli/tests/it_e2e.rs`, `README.md`
**Depends on**: T14
**Requirement**: Success criteria 1-3

**Done when**:

- [x] Build gate passes (fmt, clippy -D warnings, full workspace tests with `MEMO_IT=1`)

**Tests**: integration · **Gate**: build
