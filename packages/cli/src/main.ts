import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  appendEvent,
  findProgressFiles,
  foldRuns,
  loadConfig,
  type NewEvent,
  PlanError,
  PROGRESS_FILE,
  parsePlan,
  readEvents,
  registerRepo,
} from "@tlc-deck/core";
import { PROTOCOL_V, parseLine } from "@tlc-deck/protocol";
import type { DriverFactory } from "@tlc-deck/runner";

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  version: string;
  /** Whether stdout is a terminal (watch live view). Default false. */
  isTTY?: boolean;
  signal?: AbortSignal;
  /** Test hook: override the runner's harness drivers. */
  driverFactory?: DriverFactory;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const usage = `usage: tlc <command> [options]

  plan   [--feature f] [--json]
  emit   <type> [json] [--run id] [--feature f] [--harness h] [--driver d] [--source s] [--name n]
  emit   --start [json] [--feature f]            print a new run id
  status [--feature f] [--run id] [--json]
  watch  [--feature f] [--run id]
  serve  [--port 7317] [--repo path]... [--no-content] [--force]
  daemon start|stop|status|ensure|restart [--quiet]
  install   claude-code [--hooks] [--workflow] [--panel] [--otel] [--systemd] [--no-daemon] [--dry-run]
  uninstall claude-code [--hooks] [--workflow] [--panel] [--otel] [--dry-run]
  run    [--feature f] [--harness h] [--only T1,T2] [--retries n] [--no-commit] [--resume] [--concurrency n] [--no-daemon]
  --version`;

const OPTIONS = {
  feature: { type: "string" },
  run: { type: "string" },
  json: { type: "boolean" },
  start: { type: "boolean" },
  harness: { type: "string" },
  driver: { type: "string" },
  source: { type: "string" },
  name: { type: "string" },
  port: { type: "string" },
  only: { type: "string" },
  retries: { type: "string" },
  concurrency: { type: "string" },
  "no-commit": { type: "boolean" },
  "no-content": { type: "boolean" },
  hooks: { type: "boolean" },
  workflow: { type: "boolean" },
  panel: { type: "boolean" },
  otel: { type: "boolean" },
  "dry-run": { type: "boolean" },
  resume: { type: "boolean" },
  force: { type: "boolean" },
  quiet: { type: "boolean" },
  systemd: { type: "boolean" },
  "no-daemon": { type: "boolean" },
  repo: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(rnd[i] as number) % 32];
  return time + rand;
}

function repoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(cwd);
  }
}

function featuresDir(repo: string): string {
  return join(repo, ".specs", "features");
}

function listFeatures(repo: string): string[] {
  const dir = featuresDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** The only feature folder with tasks.md, else the newest progress file's feature, else error. */
export function detectFeature(repo: string, flag?: string): string {
  if (flag) return flag;
  const all = listFeatures(repo);
  const withTasks = all.filter((f) => existsSync(join(featuresDir(repo), f, "tasks.md")));
  if (withTasks.length === 1) return withTasks[0] as string;
  const newest = findProgressFiles(repo)
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (newest) return basename(join(newest.f, ".."));
  const list = all.length ? all.join(", ") : "(none)";
  throw new CliError(`cannot detect feature; pass --feature. Features: ${list}`, 2);
}

function progressFile(repo: string, feature: string): string {
  return join(featuresDir(repo), feature, PROGRESS_FILE);
}

function cmdPlan(repo: string, feature: string, json: boolean, io: Io): number {
  const dir = join(featuresDir(repo), feature);
  const tasksFile = join(dir, "tasks.md");
  if (!existsSync(tasksFile)) throw new CliError(`${tasksFile} not found`, 1);
  const specFile = join(dir, "spec.md");
  const plan = parsePlan(
    readFileSync(tasksFile, "utf8"),
    existsSync(specFile) ? readFileSync(specFile, "utf8") : undefined,
  );
  if (json) {
    io.stdout(`${JSON.stringify(plan)}\n`);
    return 0;
  }
  const byTask = new Map(plan.milestones.flatMap((m) => m.tasks.map((t) => [t, m.name] as const)));
  for (const t of plan.tasks) {
    const dep = t.dependsOn.length ? ` <- ${t.dependsOn.join(",")}` : "";
    io.stdout(
      `${t.done ? "[x]" : "[ ]"} ${t.id}${t.parallel ? " [P]" : ""} ${t.title} (${byTask.get(t.id) ?? t.milestone})${dep}\n`,
    );
  }
  return 0;
}

async function postEvent(event: unknown, env: Io["env"]): Promise<void> {
  const base = env.TLC_URL === undefined ? "http://127.0.0.1:7317" : env.TLC_URL;
  if (!base || base === "off") return;
  try {
    await fetch(`${base.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(300),
    });
  } catch {
    // best effort: server may be down
  }
}

async function cmdEmit(
  repo: string,
  feature: string,
  positionals: string[],
  values: Record<string, string | boolean | string[] | undefined>,
  io: Io,
): Promise<number> {
  const start = values.start === true;
  const pos = [...positionals];
  let type = start && !(pos[0] && !pos[0].trim().startsWith("{")) ? "RUN_STARTED" : pos.shift();
  if (start && type === undefined) type = "RUN_STARTED";
  if (!type) throw new CliError("emit: missing event type", 2);
  const rawBody = pos.shift();
  let body: Record<string, unknown> = {};
  if (rawBody !== undefined) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      throw new CliError(`emit: invalid JSON: ${(err as Error).message}`, 2);
    }
  }
  const runId = start
    ? `tlc_${ulid()}`
    : ((values.run as string | undefined) ?? io.env.TLC_RUN ?? "");
  if (!runId) throw new CliError("emit: --run <id> (or $TLC_RUN) is required", 2);

  const threadId = `${basename(repo)}#${feature}`;
  const harness = (values.harness as string) ?? io.env.TLC_HARNESS ?? "cli";
  const driver = (values.driver as string) ?? io.env.TLC_DRIVER ?? "cli";
  const source = (values.source as string) ?? io.env.TLC_SOURCE ?? "cli";

  let fields = body;
  if (type === "RUN_STARTED" && start) {
    const config = loadConfig({ repoDir: repo, env: io.env });
    fields = {
      input: {
        feature,
        tasksPath: join(".specs", "features", feature, "tasks.md"),
        roles: config.roles,
        harness,
        repoPath: resolve(repo),
        ...((body.input as object | undefined) ?? body),
      },
    };
  }
  const event: Record<string, unknown> = {
    type,
    timestamp: Date.now(),
    ...(type.startsWith("RUN_") ? { threadId, runId } : {}),
    ...fields,
  };
  if (typeof values.name === "string") event.name = values.name;
  event.metadata = { v: PROTOCOL_V, seq: 0, runId, threadId, harness, driver, source };

  const checked = parseLine(JSON.stringify(event));
  if (!checked.ok) throw new CliError(`emit: invalid event: ${checked.reason}`, 2);

  const written = appendEvent(progressFile(repo, feature), event as unknown as NewEvent);
  try {
    registerRepo(repo, io.env);
  } catch {
    // registry is best effort
  }
  await postEvent(written, io.env);
  if (start) io.stdout(`${runId}\n`);
  return 0;
}

function cmdStatus(
  repo: string,
  feature: string,
  runFlag: string | undefined,
  json: boolean,
  io: Io,
) {
  const events = readEvents(progressFile(repo, feature));
  const runs = foldRuns(events);
  const run = runFlag ? runs.find((r) => r.runId === runFlag) : runs[0];
  if (!run) throw new CliError(runFlag ? `run ${runFlag} not found` : "no runs found", 1);
  if (json) {
    io.stdout(`${JSON.stringify(run)}\n`);
    return 0;
  }
  const tasks = Object.values(run.tasks);
  const done = tasks.filter((t) => t.status === "done").length;
  const open = run.blockers.length;
  io.stdout(`${run.runId} ${run.status} tasks ${done}/${tasks.length} blockers ${open}\n`);
  for (const m of run.milestones)
    io.stdout(`  milestone ${m.name}: ${m.reached ? "reached" : "pending"}\n`);
  return 0;
}

function userAutoStartOff(io: Io, repo?: string): boolean {
  const cfg = loadConfig({ repoDir: repo ?? io.cwd, env: io.env }).daemon as
    | { autoStart?: unknown }
    | undefined;
  return cfg?.autoStart === false;
}

/** DMN-04: make sure the dashboard daemon runs, unless disabled. Never fails the command. */
async function autoEnsure(repo: string, disabled: boolean, io: Io): Promise<void> {
  // TLC_URL points at a custom (or disabled) server: not ours to start.
  if (disabled || io.env.TLC_URL !== undefined || userAutoStartOff(io, repo)) return;
  try {
    const { ensureDaemon } = await import("./daemon.js");
    await ensureDaemon({ env: io.env });
  } catch {
    // best effort
  }
}

/** Run the CLI. Returns the process exit code (never calls process.exit). */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (values.version) {
      io.stdout(`${io.version}\n`);
      return 0;
    }
    const [command, ...rest] = positionals;
    if (values.help || !command) {
      (values.help ? io.stdout : io.stderr)(`${usage}\n`);
      return values.help ? 0 : 2;
    }
    if (
      ![
        "plan",
        "emit",
        "status",
        "watch",
        "serve",
        "run",
        "install",
        "uninstall",
        "daemon",
      ].includes(command)
    ) {
      throw new CliError(`unknown command: ${command}\n${usage}`, 2);
    }
    if (command === "install" || command === "uninstall") {
      if (rest[0] !== "claude-code") {
        throw new CliError(`${command}: expected target "claude-code"`, 2);
      }
      const inst = await import("./install/claude-code.js");
      const opts = {
        hooks: values.hooks,
        workflow: values.workflow,
        panel: values.panel,
        otel: values.otel,
        systemd: values.systemd,
        dryRun: values["dry-run"],
        env: io.env,
        stdout: io.stdout,
        ensure:
          values["no-daemon"] || userAutoStartOff(io) || io.env.TLC_URL !== undefined
            ? undefined
            : async () => {
                const { ensureDaemon } = await import("./daemon.js");
                return (await ensureDaemon({ env: io.env })).ok;
              },
      };
      if (command === "install") await inst.installClaudeCode(opts);
      else inst.uninstallClaudeCode(opts);
      return 0;
    }
    if (command === "daemon") {
      const { runDaemon } = await import("./daemon.js");
      return await runDaemon({
        action: rest[0] ?? "",
        quiet: values.quiet === true,
        env: io.env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
    }
    if (command === "serve") {
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && !Number.isInteger(port)) {
        throw new CliError(`invalid --port: ${values.port}`, 2);
      }
      const { runServe } = await import("./commands/serve.js");
      return await runServe({
        port,
        repos: values.repo ?? [],
        noContent: values["no-content"] === true,
        force: values.force === true,
        env: io.env,
        stdout: io.stdout,
        signal: io.signal,
      });
    }
    const repo = repoRoot(io.cwd);
    const feature = detectFeature(repo, values.feature);
    if (command === "run" || command === "watch") {
      await autoEnsure(repo, values["no-daemon"] === true, io);
    }
    if (command === "run") {
      const num = (name: "retries" | "concurrency") => {
        const raw = values[name];
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < (name === "retries" ? 0 : 1)) {
          throw new CliError(`invalid --${name}: ${raw}`, 2);
        }
        return n;
      };
      const { runRun } = await import("./commands/run.js");
      return await runRun({
        repo,
        feature,
        harness: values.harness,
        only: values.only
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        retries: num("retries"),
        concurrency: num("concurrency"),
        noCommit: values["no-commit"] === true,
        resume: values.resume === true,
        env: io.env,
        stdout: io.stdout,
        signal: io.signal,
        driverFactory: io.driverFactory,
      });
    }
    if (command === "plan") return cmdPlan(repo, feature, values.json === true, io);
    if (command === "watch") {
      const { runWatch } = await import("./watch/index.js");
      return await runWatch({
        file: progressFile(repo, feature),
        run: values.run,
        tty: io.isTTY === true,
        stdout: io.stdout,
        signal: io.signal,
      });
    }
    if (command === "status") return cmdStatus(repo, feature, values.run, values.json === true, io);
    return await cmdEmit(repo, feature, rest, values, io);
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`tlc: ${err.message}\n`);
      return err.code;
    }
    if (err instanceof PlanError) {
      io.stderr(`tlc: ${err.message}\n`);
      return 1;
    }
    if ((err as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`tlc: ${(err as Error).message}\n${usage}\n`);
      return 2;
    }
    io.stderr(`tlc: ${(err as Error).message}\n`);
    return 1;
  }
}
