import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RoleConfig {
  harness?: string;
  model?: string;
  effort?: string;
}

export const ROLE_NAMES = ["orchestrator", "implementer", "reviewer", "advisor"] as const;

export interface TlcConfig {
  roles: Record<string, RoleConfig>;
  [key: string]: unknown;
}

type Env = Record<string, string | undefined>;

/** `roles.<role>` = alias string | `{harness, model, effort}`; `false`/null entries are dropped. */
export function normalizeRole(value: unknown): RoleConfig | undefined {
  if (typeof value === "string") return value ? { model: value } : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: RoleConfig = {};
  for (const k of ["harness", "model", "effort"] as const) {
    if (typeof v[k] === "string" && v[k]) out[k] = v[k] as string;
  }
  return out;
}

export function normalizeRoles(value: unknown): Record<string, RoleConfig> {
  const out: Record<string, RoleConfig> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [name, raw] of Object.entries(value)) {
    const r = normalizeRole(raw);
    if (r) out[name] = r;
  }
  return out;
}

export function userConfigPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "tlc", "config.json");
}

export function repoConfigPath(repoDir: string): string {
  return join(repoDir, ".specs", "tlc-execute.json");
}

export function registryPath(env: Env = process.env): string {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "tlc-deck", "repos.json");
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export interface LoadConfigOptions {
  repoDir: string;
  /** Highest precedence (CLI flags). `roles` may use the alias form. */
  flags?: Record<string, unknown>;
  env?: Env;
}

/** Layer user < repo < flags. Roles merge per role and per field; other keys are replaced. */
export function loadConfig(opts: LoadConfigOptions): TlcConfig {
  const layers = [
    readJsonObject(userConfigPath(opts.env)),
    readJsonObject(repoConfigPath(opts.repoDir)),
    opts.flags ?? {},
  ];
  const out: TlcConfig = { roles: {} };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (k === "roles") {
        for (const [name, role] of Object.entries(normalizeRoles(v))) {
          out.roles[name] = { ...out.roles[name], ...role };
        }
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
  }
  return out;
}

export interface RepoEntry {
  path: string;
  lastSeen: number;
}

export function readRegistry(env: Env = process.env): RepoEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(env), "utf8")) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return [];
    return parsed.repos.filter(
      (r): r is RepoEntry =>
        typeof r === "object" && r !== null && typeof (r as RepoEntry).path === "string",
    );
  } catch {
    return [];
  }
}

/** Add or refresh a repo in `repos.json` (atomic write). */
export function registerRepo(repoDir: string, env: Env = process.env, now = Date.now()): void {
  const file = registryPath(env);
  const repos = readRegistry(env).filter((r) => r.path !== repoDir);
  repos.push({ path: repoDir, lastSeen: now });
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ repos }, null, 2)}\n`);
  renameSync(tmp, file);
}
