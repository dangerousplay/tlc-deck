import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const MARKER = "tlcDeck";
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
] as const;
export const HOOK_TIMEOUT_S = 2;
export const ENSURE_HOOK_COMMAND = "tlc daemon ensure --quiet";
export const ENSURE_HOOK_TIMEOUT_S = 5;

export interface InstallOptions {
  hooks?: boolean;
  workflow?: boolean;
  panel?: boolean;
  otel?: boolean;
  /** CLI entry for the systemd unit ExecStart (tests). */
  cliPath?: string;
  /** Install a user systemd unit instead of ensuring the daemon directly. */
  systemd?: boolean;
  /** Start the daemon after install (undefined = do not). */
  ensure?: () => Promise<boolean>;
  dryRun?: boolean;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  /** Override the workflow script source (tests). */
  workflowSource?: string;
  /** Override the repo root holding .claude-plugin/marketplace.json (tests). */
  marketplaceDir?: string;
}

type Json = Record<string, unknown>;

const home = (env: InstallOptions["env"]) => env.HOME || homedir();
const claudeDir = (env: InstallOptions["env"]) => join(home(env), ".claude");
const settingsPath = (env: InstallOptions["env"]) => join(claudeDir(env), "settings.json");
const sidecarPath = (env: InstallOptions["env"]) => join(claudeDir(env), "settings.json.tlc-deck");
const workflowPath = (env: InstallOptions["env"]) =>
  join(claudeDir(env), "workflows", "tlc-execute.js");

function repoRootOfPackage(): string {
  // packages/cli/{src,dist}/install -> repo root
  return new URL("../../../../", import.meta.url).pathname;
}

export function hookUrl(env: InstallOptions["env"]): string {
  const port = env.TLC_PORT || "7317";
  return `http://127.0.0.1:${port}/hooks`;
}

function detectFormat(text: string): { indent: string | number; eol: string } {
  const m = /^[ \t]+(?=")/m.exec(text);
  return { indent: m ? m[0] : 2, eol: text.endsWith("\n") ? "\n" : "" };
}

function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown[] } | null)?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => (h as Json | null)?.[MARKER] === true);
}

/** Remove every marked hook entry; drop emptied containers. */
export function stripHooks(settings: Json): Json {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== "object") return settings;
  for (const ev of Object.keys(hooks)) {
    const list = hooks[ev];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !isOurs(e));
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

export function addHooks(settings: Json, url: string): Json {
  stripHooks(settings);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    list.push({ hooks: [{ type: "http", url, timeout: HOOK_TIMEOUT_S, [MARKER]: true }] });
    if (ev === "SessionStart") {
      list.push({
        hooks: [
          {
            type: "command",
            command: ENSURE_HOOK_COMMAND,
            timeout: ENSURE_HOOK_TIMEOUT_S,
            [MARKER]: true,
          },
        ],
      });
    }
    hooks[ev] = list;
  }
  settings.hooks = hooks;
  return settings;
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

interface Sidecar {
  /** Original settings.json bytes, or null when the file did not exist. */
  original: string | null;
  /** Bytes the installer wrote. */
  written: string;
}

export function otelEnv(env: InstallOptions["env"]): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${env.TLC_PORT || "7317"}`,
  };
}

const otelSidecarPath = (env: InstallOptions["env"]) =>
  join(claudeDir(env), "settings.json.tlc-deck-otel");

interface OtelSidecar {
  /** Previous value per key, null when the key was absent. */
  previous: Record<string, string | null>;
}

function readSettings(path: string): { settings: Json; current: string | undefined } {
  const current = readText(path);
  if (current === undefined || !current.trim()) return { settings: {}, current };
  try {
    return { settings: JSON.parse(current) as Json, current };
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function installOtel(o: InstallOptions): void {
  const path = settingsPath(o.env);
  const { settings, current } = readSettings(path);
  const env = (settings.env && typeof settings.env === "object" ? settings.env : {}) as Json;
  const want = otelEnv(o.env);
  const side = readText(otelSidecarPath(o.env));
  const previous: Record<string, string | null> = side
    ? (JSON.parse(side) as OtelSidecar).previous
    : {};
  let changed = false;
  for (const [k, v] of Object.entries(want)) {
    if (env[k] === v) continue;
    if (!(k in previous)) previous[k] = typeof env[k] === "string" ? (env[k] as string) : null;
    env[k] = v;
    changed = true;
  }
  if (!changed) {
    o.stdout(`otel: already installed in ${path}\n`);
    return;
  }
  settings.env = env;
  const fmt = current ? detectFormat(current) : { indent: 2, eol: "\n" };
  o.stdout(`otel: ${o.dryRun ? "would write" : "writing"} OTel env block to ${path}\n`);
  if (o.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, fmt.indent)}${fmt.eol}`);
  writeFileSync(otelSidecarPath(o.env), JSON.stringify({ previous } satisfies OtelSidecar));
}

function uninstallOtel(o: InstallOptions): void {
  const path = settingsPath(o.env);
  const side = readText(otelSidecarPath(o.env));
  if (!existsSync(path) || !side) {
    o.stdout("otel: nothing to remove\n");
    return;
  }
  const { previous } = JSON.parse(side) as OtelSidecar;
  const { settings, current } = readSettings(path);
  const env = (settings.env && typeof settings.env === "object" ? settings.env : {}) as Json;
  for (const k of Object.keys(previous)) {
    if (!(k in env)) continue;
    const prev = previous[k];
    if (prev === null || prev === undefined) delete env[k];
    else env[k] = prev;
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  o.stdout(`otel: ${o.dryRun ? "would remove" : "removing"} OTel env block from ${path}\n`);
  if (o.dryRun) return;
  const fmt = detectFormat(current ?? "");
  writeFileSync(path, `${JSON.stringify(settings, null, fmt.indent)}${fmt.eol}`);
  rmSync(otelSidecarPath(o.env), { force: true });
}

function installHooks(o: InstallOptions): void {
  const path = settingsPath(o.env);
  const current = readText(path);
  let settings: Json = {};
  if (current !== undefined && current.trim()) {
    try {
      settings = JSON.parse(current) as Json;
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const fmt = current ? detectFormat(current) : { indent: 2, eol: "\n" };
  const next = `${JSON.stringify(addHooks(settings, hookUrl(o.env)), null, fmt.indent)}${fmt.eol}`;
  if (next === current) {
    o.stdout(`hooks: already installed in ${path}\n`);
    return;
  }
  o.stdout(
    `hooks: ${o.dryRun ? "would write" : "writing"} ${HOOK_EVENTS.length} HTTP hooks to ${path}\n`,
  );
  if (o.dryRun) return;
  // Keep the pristine original across re-installs.
  const prev = readText(sidecarPath(o.env));
  let original: string | null = current ?? null;
  if (prev) {
    const side = JSON.parse(prev) as Sidecar;
    if (current === side.written) original = side.original;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  writeFileSync(sidecarPath(o.env), JSON.stringify({ original, written: next } satisfies Sidecar));
}

function uninstallHooks(o: InstallOptions): void {
  const path = settingsPath(o.env);
  const current = readText(path);
  const side = readText(sidecarPath(o.env));
  if (current === undefined) {
    o.stdout("hooks: nothing to remove\n");
    return;
  }
  let sidecar: Sidecar | undefined;
  if (side) {
    try {
      sidecar = JSON.parse(side) as Sidecar;
    } catch {
      sidecar = undefined;
    }
  }
  let result: string | null;
  if (sidecar && current === sidecar.written) {
    result = sidecar.original;
  } else {
    let settings: Json;
    try {
      settings = JSON.parse(current) as Json;
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
    const had = JSON.stringify(settings.hooks ?? null);
    stripHooks(settings);
    if (had === JSON.stringify(settings.hooks ?? null)) {
      o.stdout("hooks: nothing to remove\n");
      return;
    }
    const fmt = detectFormat(current);
    result = `${JSON.stringify(settings, null, fmt.indent)}${fmt.eol}`;
  }
  o.stdout(`hooks: ${o.dryRun ? "would remove" : "removing"} tlc-deck hooks from ${path}\n`);
  if (o.dryRun) return;
  if (result === null) rmSync(path, { force: true });
  else writeFileSync(path, result);
  rmSync(sidecarPath(o.env), { force: true });
}

function workflowSource(o: InstallOptions): string {
  return (
    o.workflowSource ??
    join(repoRootOfPackage(), "integrations", "claude-code", "workflow", "tlc-execute.js")
  );
}

function installWorkflow(o: InstallOptions): void {
  const dest = workflowPath(o.env);
  const src = workflowSource(o);
  if (!existsSync(src)) throw new Error(`workflow script not found: ${src}`);
  const want = readFileSync(src);
  const have = existsSync(dest) ? readFileSync(dest) : undefined;
  if (have?.equals(want)) {
    o.stdout(`workflow: already installed at ${dest}\n`);
    return;
  }
  const backup = `${dest}.bak`;
  o.stdout(`workflow: ${o.dryRun ? "would copy" : "copying"} to ${dest}\n`);
  if (have)
    o.stdout(`workflow: ${o.dryRun ? "would back up" : "backing up"} existing file to ${backup}\n`);
  if (o.dryRun) return;
  mkdirSync(dirname(dest), { recursive: true });
  if (have) copyFileSync(dest, backup);
  writeFileSync(dest, want);
}

function uninstallWorkflow(o: InstallOptions): void {
  const dest = workflowPath(o.env);
  const src = workflowSource(o);
  if (!existsSync(dest)) {
    o.stdout("workflow: nothing to remove\n");
    return;
  }
  if (existsSync(src) && !readFileSync(dest).equals(readFileSync(src))) {
    o.stdout(`workflow: ${dest} was modified, leaving it\n`);
    return;
  }
  const backup = `${dest}.bak`;
  o.stdout(`workflow: ${o.dryRun ? "would remove" : "removing"} ${dest}\n`);
  if (o.dryRun) return;
  if (existsSync(backup)) {
    copyFileSync(backup, dest);
    unlinkSync(backup);
  } else unlinkSync(dest);
}

function onPath(bin: string, env: InstallOptions["env"]): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

function installPanel(o: InstallOptions, remove: boolean): void {
  const dir = (o.marketplaceDir ?? repoRootOfPackage()).replace(/\/$/, "");
  const cmds = remove
    ? [
        ["plugin", "uninstall", "tlc-deck-panel@tlc-deck"],
        ["plugin", "marketplace", "remove", "tlc-deck"],
      ]
    : [
        ["plugin", "marketplace", "add", dir],
        ["plugin", "install", "tlc-deck-panel@tlc-deck"],
      ];
  if (o.dryRun || !onPath("claude", o.env)) {
    o.stdout(
      o.dryRun
        ? "panel: would run:\n"
        : "panel: `claude` not found on PATH; run these commands manually:\n",
    );
    for (const c of cmds) o.stdout(`  claude ${c.join(" ")}\n`);
    return;
  }
  for (const c of cmds) {
    o.stdout(`panel: claude ${c.join(" ")}\n`);
    const r = spawnSync("claude", c, { env: o.env as NodeJS.ProcessEnv, encoding: "utf8" });
    if (r.status !== 0)
      o.stdout(`panel: exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}\n`);
  }
}

const UNIT_NAME = "tlc-deck.service";
const unitPath = (env: InstallOptions["env"]) =>
  join(home(env), ".config", "systemd", "user", UNIT_NAME);

export function systemdUnit(cliPath: string, nodePath = process.execPath): string {
  return `[Unit]
Description=tlc-deck dashboard daemon

[Service]
ExecStart=${nodePath} ${cliPath} serve
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

function systemctl(o: InstallOptions, args: string[]): void {
  const r = spawnSync("systemctl", ["--user", ...args], {
    env: o.env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) {
    o.stdout(
      `systemd: systemctl --user ${args.join(" ")} failed: ${(r.error?.message ?? (r.stderr || r.stdout || `exit ${r.status}`)).trim()}\n`,
    );
  }
}

function installSystemd(o: InstallOptions): void {
  const path = unitPath(o.env);
  const cli = join(repoRootOfPackage(), "packages", "cli", "dist", "index.js");
  o.stdout(`systemd: ${o.dryRun ? "would write" : "writing"} ${path}\n`);
  if (o.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, systemdUnit(o.cliPath ?? cli));
  systemctl(o, ["enable", "--now", UNIT_NAME]);
}

function uninstallSystemd(o: InstallOptions): void {
  const path = unitPath(o.env);
  if (!existsSync(path)) {
    o.stdout("systemd: nothing to remove\n");
    return;
  }
  o.stdout(`systemd: ${o.dryRun ? "would remove" : "removing"} ${path}\n`);
  if (o.dryRun) return;
  systemctl(o, ["disable", "--now", UNIT_NAME]);
  rmSync(path, { force: true });
}

/** With no component flag, `--hooks` and `--workflow` are installed. */
function selected(o: InstallOptions) {
  const any = o.hooks || o.workflow || o.panel || o.otel;
  return {
    hooks: any ? !!o.hooks : true,
    workflow: any ? !!o.workflow : true,
    panel: !!o.panel,
    otel: !!o.otel,
    systemd: !!o.systemd,
  };
}

export async function installClaudeCode(o: InstallOptions): Promise<void> {
  const s = selected(o);
  if (s.hooks) installHooks(o);
  if (s.workflow) installWorkflow(o);
  if (s.panel) installPanel(o, false);
  if (s.otel) installOtel(o);
  if (s.systemd) installSystemd(o);
  else if (o.ensure && !o.dryRun) {
    o.stdout(
      `daemon: ${(await o.ensure()) ? "running" : "could not start (run `tlc daemon ensure`)"}\n`,
    );
  }
}

export function uninstallClaudeCode(o: InstallOptions): void {
  const s = selected(o);
  if (s.hooks) uninstallHooks(o);
  if (s.workflow) uninstallWorkflow(o);
  if (s.panel) installPanel(o, true);
  if (s.otel) uninstallOtel(o);
  if (s.systemd) uninstallSystemd(o);
}
