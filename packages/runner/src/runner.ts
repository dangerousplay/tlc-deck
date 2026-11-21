import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  appendEvent,
  capItem,
  foldRuns,
  loadConfig,
  type NewEvent,
  type Plan,
  type PlanTask,
  PROGRESS_FILE,
  parsePlan,
  readEvents,
  taskBlock,
} from "@tlc-deck/core";
import {
  AdvisorOutputSchema,
  type AgentItem,
  advisorOutputJsonSchema,
  type BlockerKind,
  PROTOCOL_V,
  ReviewerOutputSchema,
  reviewerOutputJsonSchema,
  type Stage,
  StatusOutputSchema,
  statusOutputJsonSchema,
  type TaskValue,
} from "@tlc-deck/protocol";
import {
  type ConductorCtx,
  DEFAULT_ROTATE_AFTER_TOKENS,
  Interrupted,
  runSolo,
  TaskFailed,
  waves,
} from "./conductor.js";
import type { Driver, DriverFactory, DriverResult, Role } from "./driver.js";
import { createDriverFactory, type DriverConfig } from "./drivers/index.js";
import { commitFiles } from "./git.js";
import { renderPrompt } from "./prompts.js";
import type { StreamItem } from "./streams/types.js";

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}
type Out<S> = S extends Schema<infer T> ? T : never;
type StatusOutput = Out<typeof StatusOutputSchema>;

export interface RunOptions {
  /** Repository root (git toplevel). */
  repo: string;
  feature: string;
  /** Default harness for roles without `roles.<role>.harness`. Default "claude". */
  harness?: string;
  only?: string[];
  /** Fix rounds after a rejection or failed gate. Default 2. */
  retries?: number;
  noCommit?: boolean;
  resume?: boolean;
  /** Max concurrent `[P]` tasks. Default 3. */
  concurrency?: number;
  /** Set false to skip the advise stage. Default true. */
  advisor?: boolean;
  /** "solo" (default): conductor + one worker session; "crew": one agent per stage. */
  mode?: "solo" | "crew";
  /** Solo: start a fresh worker session after a turn above this many input tokens. Default 150000. */
  rotateAfterTokens?: number;
  env?: Record<string, string | undefined>;
  driverFactory?: DriverFactory;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface RunResult {
  code: number;
  runId: string;
  completed: string[];
  failed: string[];
  notStarted: string[];
  interrupted: boolean;
}

const ulidish = () => randomBytes(13).toString("hex").toUpperCase();

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

export async function runPlan(opts: RunOptions): Promise<RunResult> {
  const { repo, feature, signal } = opts;
  const env = opts.env ?? process.env;
  const dir = join(repo, ".specs", "features", feature);
  const tasksFile = join(dir, "tasks.md");
  const progress = join(dir, PROGRESS_FILE);
  const tasksMd = readFileSync(tasksFile, "utf8");
  const specFile = join(dir, "spec.md");
  const plan: Plan = parsePlan(tasksMd, existsSync(specFile) ? readFileSync(specFile, "utf8") : "");
  const config = loadConfig({ repoDir: repo, env });
  const factory =
    opts.driverFactory ??
    createDriverFactory(
      (typeof config.driver === "object" && config.driver !== null
        ? config.driver
        : {}) as DriverConfig,
    );
  const defaultHarness = opts.harness ?? "claude";
  const retries = opts.retries ?? 2;
  const mode: "solo" | "crew" =
    opts.mode ?? (config.mode === "crew" || config.mode === "solo" ? config.mode : "solo");
  const rotateAfterTokens =
    opts.rotateAfterTokens ??
    (typeof config.rotateAfterTokens === "number"
      ? config.rotateAfterTokens
      : DEFAULT_ROTATE_AFTER_TOKENS);
  const advisorOn = opts.advisor !== false;
  const log = opts.log ?? (() => {});
  const trailer = typeof config.commitTrailer === "string" ? config.commitTrailer : undefined;
  const refs = ["spec.md", "design.md", "context.md", "tasks.md"]
    .filter((f) => existsSync(join(dir, f)))
    .map((f) => `- ${join(".specs", "features", feature, f)}`)
    .join("\n");

  const runId = `tlc_${ulidish()}`;
  const threadId = `${basename(repo)}#${feature}`;
  const emit = (event: Record<string, unknown>, source = "runner", harness = defaultHarness) => {
    appendEvent(progress, {
      timestamp: Date.now(),
      ...event,
      metadata: { v: PROTOCOL_V, seq: 0, runId, threadId, harness, driver: "runner", source },
    } as unknown as NewEvent);
  };
  const custom = (name: string, value: unknown, source?: string, harness?: string) =>
    emit({ type: "CUSTOM", name, value }, source, harness);
  const taskEvent = (v: TaskValue) => custom("tlc.task", v);

  // resume: newest earlier run's Done tasks
  const resumed = new Set<string>();
  if (opts.resume) {
    const newest = foldRuns(readEvents(progress))[0];
    if (newest) {
      for (const t of Object.values(newest.tasks)) if (t.status === "done") resumed.add(t.id);
    }
  }

  const only = opts.only?.length ? new Set(opts.only) : undefined;
  const inScope = (id: string) => !only || only.has(id);

  emit({
    type: "RUN_STARTED",
    threadId,
    runId,
    input: {
      feature,
      tasksPath: join(".specs", "features", feature, "tasks.md"),
      roles: config.roles,
      harness: defaultHarness,
      mode,
      repoPath: resolve(repo),
      ...(only ? { only: [...only] } : {}),
    },
  });
  custom("tlc.plan", {
    tasks: plan.tasks.map(({ done: _d, ...t }) => t),
    milestones: plan.milestones,
  });

  const outcome = new Map<string, "done" | "failed" | "notStarted">();
  const deviations: string[] = [];
  const commitLock = new Mutex();
  const drivers = new Map<string, Driver>();
  const driverFor = (harness: string) => {
    let d = drivers.get(harness);
    if (!d) {
      d = factory(harness);
      drivers.set(harness, d);
    }
    return d;
  };
  const checkAbort = () => {
    if (signal?.aborted) throw new Interrupted();
  };

  let blockerSeq = 0;
  const blocker = (task: string, kind: BlockerKind, reason: string, advice?: string) =>
    custom("tlc.blocker", {
      id: `${task}-b${++blockerSeq}`,
      task,
      kind,
      reason,
      ...(advice ? { advice } : {}),
    });

  const agentsDir = join(dir, "agents", runId);
  const usedAgentIds = new Set<string>();
  const agentId = (task: string, stage: Stage, attempt: number) => {
    const base = `${runId}-${task}-${stage}-${attempt}`;
    let id = base;
    for (let n = 2; usedAgentIds.has(id); n++) id = `${base}-${n}`;
    usedAgentIds.add(id);
    return id;
  };
  /** DD-09: per-agent log of AgentItem lines, written through capItem. */
  const agentLog = (id: string) => {
    const file = join(agentsDir, `${id}.ndjson`);
    let seq = 0;
    try {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(file, "");
    } catch {}
    return (it: StreamItem) => {
      const item = capItem({
        ...it,
        ts: it.ts ?? Date.now(),
        agentId: id,
        seq: seq++,
      } as AgentItem);
      try {
        appendFileSync(file, `${JSON.stringify(item)}\n`);
      } catch {}
    };
  };

  /** One headless role call. Throws TaskFailed (after emitting an error blocker) on failure. */
  async function call<S extends Schema<unknown>>(
    taskId: string,
    role: Role,
    stage: Stage,
    attempt: number,
    prompt: string,
    schema: S,
    jsonSchema: unknown,
  ): Promise<Out<S>> {
    checkAbort();
    const rc = config.roles[role] ?? {};
    const harness = rc.harness ?? defaultHarness;
    const aid = agentId(taskId, stage, attempt);
    const write = agentLog(aid);
    const startedAt = Date.now();
    const agentBase = { id: aid, task: taskId, stage, role, harness, runId };
    custom(
      "tlc.agent",
      {
        ...agentBase,
        source: "tlc-run",
        ...(rc.model ? { model: rc.model } : {}),
        label: `${stage} ${taskId}`,
        status: "running",
        startedAt,
      },
      role,
      harness,
    );
    const endAgent = (status: "done" | "error", usage?: DriverResult["usage"]) =>
      custom(
        "tlc.agent",
        {
          id: aid,
          status,
          endedAt: Date.now(),
          ...(usage
            ? {
                ...(usage.model ? { model: usage.model } : {}),
                usage: {
                  input: usage.input,
                  output: usage.output,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  costUsd: usage.costUsd,
                },
              }
            : {}),
        },
        role,
        harness,
      );
    let res: DriverResult;
    try {
      res = await driverFor(harness).run({
        role,
        prompt,
        ...(rc.model ? { model: rc.model } : {}),
        ...(rc.effort ? { effort: rc.effort } : {}),
        cwd: repo,
        schema: jsonSchema,
        onItem: write,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      write({ kind: "error", text: (err as Error).message, isError: true });
      endAgent("error");
      checkAbort();
      blocker(taskId, "error", `${role} (${harness}) failed: ${(err as Error).message}`);
      throw new TaskFailed();
    }
    endAgent("done", res.usage);
    checkAbort();
    if (res.usage) {
      const u = res.usage;
      custom(
        "tlc.usage",
        {
          task: taskId,
          role,
          harness,
          model: rc.model ?? u.model ?? "default",
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          costUsd: u.costUsd,
        },
        role,
        harness,
      );
    }
    if (res.exitCode !== 0) {
      blocker(taskId, "error", `${role} (${harness}) exited with code ${res.exitCode}`);
      throw new TaskFailed();
    }
    const parsed = schema.safeParse(res.data);
    if (!parsed.success) {
      blocker(taskId, "error", `${role} (${harness}) returned invalid output`);
      throw new TaskFailed();
    }
    return parsed.data as Out<S>;
  }

  async function step<T>(task: string, stage: Stage, attempt: number, fn: () => Promise<T>) {
    custom("tlc.task", { id: task, status: "running", stage, attempt });
    emit({ type: "STEP_STARTED", stepName: `${task}:${stage}` });
    try {
      return await fn();
    } finally {
      emit({ type: "STEP_FINISHED", stepName: `${task}:${stage}` });
    }
  }

  async function execTask(t: PlanTask): Promise<void> {
    const id = t.id;
    const block = taskBlock(tasksMd, id) ?? `### ${id}: ${t.title}`;
    const base = { task: block, paths: refs };
    let attempt = 0;
    let files: string[] = [];
    const devs: string[] = [];
    const adviceText = (a: Out<typeof AdvisorOutputSchema>) =>
      `${a.diagnosis}${a.steps.length ? `\n${a.steps.map((s) => `- ${s}`).join("\n")}` : ""}`;
    const advise = async (problem: string): Promise<string | undefined> => {
      if (!advisorOn) return undefined;
      const a = await step(id, "advise", attempt, () =>
        call(
          id,
          "advisor",
          "advise",
          attempt,
          renderPrompt("advise", { ...base, problem }),
          AdvisorOutputSchema,
          advisorOutputJsonSchema,
        ),
      );
      return adviceText(a);
    };
    const absorb = (r: StatusOutput) => {
      files = [...new Set([...files, ...r.files])];
      for (const d of r.deviations) if (!devs.includes(d)) devs.push(d);
    };
    const adviceBlock = (a?: string) => (a ? `\n## Advice\n\n${a}\n` : "");

    taskEvent({ id, status: "running", attempt: 1 });
    const implement = (advice?: string) =>
      step(id, "implement", ++attempt, () =>
        call(
          id,
          "implementer",
          "implement",
          attempt,
          renderPrompt("implement", { ...base, advice: adviceBlock(advice) }),
          StatusOutputSchema,
          statusOutputJsonSchema,
        ),
      );

    let report = await implement();
    absorb(report);
    if (report.status !== "Complete") {
      const reason = report.issues.join("; ") || `implementer reported ${report.status}`;
      const advice = await advise(reason);
      blocker(id, report.status === "Blocked" ? "blocked" : "partial", reason, advice);
      if (!advice) throw new TaskFailed();
      report = await implement(advice);
      absorb(report);
      if (report.status !== "Complete") {
        blocker(
          id,
          report.status === "Blocked" ? "blocked" : "partial",
          report.issues.join("; ") || `implementer reported ${report.status} after advice`,
        );
        throw new TaskFailed();
      }
    }

    for (let round = 0; ; round++) {
      let problem: { kind: BlockerKind; findings: string[] } | undefined;
      if (!report.gate.pass) {
        problem = { kind: "gate", findings: [`Gate failed: ${report.gate.summary}`] };
      } else {
        const review = await step(id, "verify", attempt, () =>
          call(
            id,
            "reviewer",
            "verify",
            attempt,
            renderPrompt("review", { ...base, report: JSON.stringify(report, null, 2) }),
            ReviewerOutputSchema,
            reviewerOutputJsonSchema,
          ),
        );
        if (review.verdict === "reject") problem = { kind: "rejected", findings: review.findings };
      }
      if (!problem) break;
      const reason = problem.findings.join("; ") || "rejected";
      if (round >= retries) {
        blocker(id, problem.kind, `${reason} (retries exhausted)`);
        throw new TaskFailed();
      }
      const advice = await advise(reason);
      blocker(id, problem.kind, reason, advice);
      const fixed = await step(id, "fix", ++attempt, () =>
        call(
          id,
          "implementer",
          "fix",
          attempt,
          renderPrompt("fix", {
            ...base,
            findings: problem.findings.map((f) => `- ${f}`).join("\n"),
            advice: adviceBlock(advice),
          }),
          StatusOutputSchema,
          statusOutputJsonSchema,
        ),
      );
      absorb(fixed);
      if (fixed.status !== "Complete") {
        blocker(
          id,
          fixed.status === "Blocked" ? "blocked" : "partial",
          fixed.issues.join("; ") || `implementer reported ${fixed.status} during fix`,
        );
        throw new TaskFailed();
      }
      report = fixed;
    }

    let commit: string | undefined;
    if (!opts.noCommit) {
      try {
        commit = await step(id, "commit", attempt, () =>
          commitLock.run(() =>
            commitFiles({
              cwd: repo,
              files,
              message: `feat(${feature}): ${t.title} (${id})`,
              ...(trailer ? { trailer } : {}),
            }),
          ),
        );
      } catch (err) {
        blocker(id, "error", (err as Error).message);
        throw new TaskFailed();
      }
    }
    deviations.push(...devs.map((d) => `${id}: ${d}`));
    taskEvent({
      id,
      status: "done",
      stage: "commit",
      attempt,
      ...(commit ? { commit } : {}),
      files,
      gate: report.gate,
      ...(devs.length ? { deviations: devs } : {}),
    });
  }

  const runOne = async (t: PlanTask) => {
    if (signal?.aborted) return;
    try {
      await execTask(t);
      outcome.set(t.id, "done");
    } catch (err) {
      if (err instanceof Interrupted || signal?.aborted) return;
      outcome.set(t.id, "failed");
      if (!(err instanceof TaskFailed)) {
        blocker(t.id, "error", (err as Error).message);
      }
      taskEvent({ id: t.id, status: "failed" });
      log(`${t.id} failed`);
    }
  };

  if (mode === "solo") {
    const ctx: ConductorCtx = {
      repo,
      feature,
      runId,
      tasksMd,
      plan,
      refs,
      retries,
      noCommit: opts.noCommit === true,
      ...(trailer ? { trailer } : {}),
      rotateAfterTokens,
      defaultHarness,
      workerRole: config.roles.implementer ?? {},
      ...(signal ? { signal } : {}),
      inScope,
      resumed,
      outcome,
      deviations,
      driverFor,
      call,
      step,
      blocker,
      custom,
      taskEvent,
      agentLog,
      log,
    };
    await runSolo(ctx);
  }

  for (const wave of mode === "solo" ? [] : waves(plan.tasks)) {
    if (signal?.aborted) break;
    const runnable: PlanTask[] = [];
    for (const t of wave) {
      if (!inScope(t.id)) continue;
      if (t.done || resumed.has(t.id)) {
        outcome.set(t.id, "done");
        taskEvent({ id: t.id, status: "done" });
        log(`${t.id} already done, skipped`);
        continue;
      }
      const bad = t.dependsOn.filter((d) => {
        const o = outcome.get(d);
        return o === "failed" || o === "notStarted";
      });
      if (bad.length) {
        outcome.set(t.id, "notStarted");
        taskEvent({ id: t.id, status: "skipped" });
        custom("tlc.log", {
          level: "warn",
          message: `${t.id} not started: dependency ${bad.join(", ")} did not complete`,
        });
        continue;
      }
      runnable.push(t);
    }
    await pool(
      runnable.filter((t) => t.parallel),
      opts.concurrency ?? 3,
      runOne,
    );
    for (const t of runnable.filter((x) => !x.parallel)) await runOne(t);
  }

  const ids = plan.tasks.map((t) => t.id).filter(inScope);
  const completed = ids.filter((i) => outcome.get(i) === "done");
  const failed = ids.filter((i) => outcome.get(i) === "failed");
  const notStarted = ids.filter((i) => !completed.includes(i) && !failed.includes(i));

  if (signal?.aborted) {
    emit({ type: "RUN_ERROR", message: "interrupted", code: "interrupted" });
    return { code: 130, runId, completed, failed, notStarted, interrupted: true };
  }
  emit({
    type: "RUN_FINISHED",
    threadId,
    runId,
    result: { completed, failed, notStarted, deviations },
  });
  return { code: failed.length ? 1 : 0, runId, completed, failed, notStarted, interrupted: false };
}
