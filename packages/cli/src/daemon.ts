import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

export const HEALTH_TIMEOUT_MS = 300;
export const ENSURE_BUDGET_MS = 3000;
export const LOCK_STALE_MS = 10_000;

export interface Health {
  app: string;
  version: string;
  pid: number;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
}

export function stateDir(env: Env): string {
  if (env.TLC_STATE_DIR) return env.TLC_STATE_DIR;
  const base = env.XDG_STATE_HOME || join(env.HOME || "", ".local", "state");
  return join(base, "tlc-deck");
}

export const pidfilePath = (env: Env) => join(stateDir(env), "daemon.json");
const lockPath = (env: Env) => join(stateDir(env), "daemon.lock");
export const logPath = (env: Env) => join(stateDir(env), "daemon.log");

export function daemonPort(env: Env): number {
  const n = Number(env.TLC_PORT);
  return Number.isInteger(n) && n > 0 ? n : 7317;
}

/** GET /api/health; a tlc-deck answer or undefined. */
export async function health(
  port: number,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<Health>;
    if (body.app !== "tlc-deck" || typeof body.pid !== "number") return undefined;
    return body as Health;
  } catch {
    return undefined;
  }
}

export function readPidfile(env: Env): DaemonInfo | undefined {
  try {
    const j = JSON.parse(readFileSync(pidfilePath(env), "utf8")) as Partial<DaemonInfo>;
    if (typeof j.pid !== "number" || typeof j.port !== "number") return undefined;
    return j as DaemonInfo;
  } catch {
    return undefined;
  }
}

export function writePidfile(env: Env, info: DaemonInfo): void {
  mkdirSync(stateDir(env), { recursive: true });
  writeFileSync(pidfilePath(env), JSON.stringify(info));
}

/** Remove the pidfile only when it still names `pid`. */
export function removePidfile(env: Env, pid: number): void {
  if (readPidfile(env)?.pid === pid) rmSync(pidfilePath(env), { force: true });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function takeLock(env: Env): boolean {
  mkdirSync(stateDir(env), { recursive: true });
  const path = lockPath(env);
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {
        // lock vanished; retry
        continue;
      }
      return false;
    }
  }
  return false;
}

export interface EnsureOptions {
  env: Env;
  /** CLI entry to run as `node <cli> serve --port P`. Default: this package's index.js. */
  cliPath?: string;
  budgetMs?: number;
}

export interface EnsureResult {
  ok: boolean;
  /** True when this call spawned the daemon. */
  started: boolean;
  pid?: number;
  port: number;
}

/** DD-07: reuse a healthy daemon, else start exactly one (lock-guarded). */
export async function ensureDaemon(opts: EnsureOptions): Promise<EnsureResult> {
  const { env } = opts;
  const port = daemonPort(env);
  const deadline = Date.now() + (opts.budgetMs ?? ENSURE_BUDGET_MS);
  const found = await health(port);
  if (found) return { ok: true, started: false, pid: found.pid, port };

  let started = false;
  while (Date.now() < deadline) {
    if (takeLock(env)) {
      try {
        const again = await health(port);
        if (again) return { ok: true, started: false, pid: again.pid, port };
        spawnDaemon(opts, port);
        started = true;
        while (Date.now() < deadline) {
          const h = await health(port);
          if (h) return { ok: true, started, pid: h.pid, port };
          await sleep(50);
        }
        return { ok: false, started, port };
      } finally {
        rmSync(lockPath(env), { force: true });
      }
    }
    const h = await health(port);
    if (h) return { ok: true, started: false, pid: h.pid, port };
    await sleep(50);
  }
  return { ok: false, started, port };
}

function spawnDaemon(opts: EnsureOptions, port: number): void {
  const cli = opts.cliPath ?? fileURLToPath(new URL("./index.js", import.meta.url));
  mkdirSync(stateDir(opts.env), { recursive: true });
  const log = openSync(logPath(opts.env), "a");
  const child = spawn(process.execPath, [cli, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: opts.env as NodeJS.ProcessEnv,
  });
  child.on("error", () => {});
  child.unref();
  closeSync(log);
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

/** SIGTERM the pidfile pid, only when /api/health on its port reports that same pid. */
export async function stopDaemon(env: Env, waitMs = 2000): Promise<StopResult> {
  const info = readPidfile(env);
  if (!info) return { stopped: false, reason: "no pidfile" };
  const h = await health(info.port);
  if (!h) {
    removePidfile(env, info.pid);
    return { stopped: false, reason: "not running" };
  }
  if (h.pid !== info.pid)
    return { stopped: false, reason: "pidfile does not match the running server" };
  try {
    process.kill(info.pid, "SIGTERM");
  } catch (err) {
    return { stopped: false, reason: (err as Error).message };
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (!(await health(info.port))) break;
    await sleep(50);
  }
  removePidfile(env, info.pid);
  return { stopped: true, pid: info.pid };
}

export interface DaemonCommandOptions extends EnsureOptions {
  action: string;
  quiet?: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** `tlc daemon start|stop|status|ensure|restart`. */
export async function runDaemon(o: DaemonCommandOptions): Promise<number> {
  const say = (t: string) => {
    if (!o.quiet) o.stdout(t);
  };
  const port = daemonPort(o.env);
  switch (o.action) {
    case "status": {
      const h = await health(port);
      if (!h) {
        o.stdout("tlc daemon: not running\n");
        return 1;
      }
      o.stdout(`tlc daemon: running pid ${h.pid} port ${port} version ${h.version}\n`);
      return 0;
    }
    case "start":
    case "ensure": {
      const r = await ensureDaemon(o);
      if (!r.ok) {
        if (!o.quiet)
          o.stderr(`tlc daemon: failed to start on port ${port} (see ${logPath(o.env)})\n`);
        return 1;
      }
      say(`tlc daemon: ${r.started ? "started" : "running"} pid ${r.pid} port ${port}\n`);
      return 0;
    }
    case "stop": {
      const r = await stopDaemon(o.env);
      say(
        r.stopped
          ? `tlc daemon: stopped pid ${r.pid}\n`
          : `tlc daemon: not stopped (${r.reason})\n`,
      );
      return r.stopped || r.reason === "not running" || r.reason === "no pidfile" ? 0 : 1;
    }
    case "restart": {
      await stopDaemon(o.env);
      const r = await ensureDaemon(o);
      if (!r.ok) {
        o.stderr(`tlc daemon: failed to start on port ${port}\n`);
        return 1;
      }
      say(`tlc daemon: started pid ${r.pid} port ${port}\n`);
      return 0;
    }
    default:
      o.stderr("tlc: daemon: expected start|stop|status|ensure|restart\n");
      return 2;
  }
}
