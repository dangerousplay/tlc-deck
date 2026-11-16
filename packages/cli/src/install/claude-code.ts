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

export interface InstallOptions {
  hooks?: boolean;
  workflow?: boolean;
  panel?: boolean;
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

/** With no component flag, `--hooks` and `--workflow` are installed. */
function selected(o: InstallOptions) {
  const any = o.hooks || o.workflow || o.panel;
  return { hooks: any ? !!o.hooks : true, workflow: any ? !!o.workflow : true, panel: !!o.panel };
}

export function installClaudeCode(o: InstallOptions): void {
  const s = selected(o);
  if (s.hooks) installHooks(o);
  if (s.workflow) installWorkflow(o);
  if (s.panel) installPanel(o, false);
}

export function uninstallClaudeCode(o: InstallOptions): void {
  const s = selected(o);
  if (s.hooks) uninstallHooks(o);
  if (s.workflow) uninstallWorkflow(o);
  if (s.panel) installPanel(o, true);
}
