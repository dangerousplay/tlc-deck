import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commitMessage, type Plan, type PlanTask, resolveGate, taskBlock } from "@tlc-deck/core";
import {
  type BlockerKind,
  ReviewerOutputSchema,
  reviewerOutputJsonSchema,
  type Stage,
  StatusOutputSchema,
  statusOutputJsonSchema,
  type TaskValue,
} from "@tlc-deck/protocol";
import type { Driver, DriverResult, Role } from "./driver.js";
import { commitFiles, git } from "./git.js";
import { renderPrompt } from "./prompts.js";
import type { StreamItem } from "./streams/types.js";

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}
type Out<S> = S extends Schema<infer T> ? T : never;
type StatusOutput = Out<typeof StatusOutputSchema>;

export const GATE_TIMEOUT_MS = 20 * 60 * 1000;
export const GATE_TAIL_BYTES = 4096;
export const DIFF_CAP_BYTES = 32 * 1024;
export const DEFAULT_ROTATE_AFTER_TOKENS = 150_000;

/** Tasks grouped by dependency layer (parsePlan already rejects cycles). */
export function waves(tasks: PlanTask[]): PlanTask[][] {
  const layer = new Map<string, number>();
  let rest = tasks.slice();
  const out: PlanTask[][] = [];
  while (rest.length) {
    const ready = rest.filter((t) => t.dependsOn.every((d) => layer.has(d)));
    if (!ready.length) break;
    for (const t of ready) layer.set(t.id, out.length);
    out.push(ready);
    rest = rest.filter((t) => !layer.has(t.id));
  }
  return out;
}

const tail = (text: string, max: number) =>
  text.length > max ? `...${text.slice(text.length - max)}` : text;

export interface GateResult {
  pass: boolean;
  code: number;
  command: string;
  /** Last 4 KB of combined output. */
  tail: string;
}

/** Run a gate command through the shell (DD-03). */
export function runGate(
  cwd: string,
  command: string,
  timeoutMs = GATE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GateResult> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : 1
          : 0;
        resolve({
          pass: code === 0,
          code,
          command,
          tail: tail(`${stdout}${stderr}`.trim(), GATE_TAIL_BYTES),
        });
      },
    );
  });
}

/** Backticked paths of the task's `**Where**` line. */
export function wherePaths(block: string): string[] {
  const m = /^[ \t]*\*\*Where\*\*:[ \t]*(.*)$/im.exec(block);
  const value = m?.[1] ?? "";
  const ticks = [...value.matchAll(/`([^`]+)`/g)].map((t) => t[1] as string);
  return (ticks.length ? ticks : value.split(",")).map((p) => p.trim()).filter(Boolean);
}

/** Diff of the task's files against HEAD (plus untracked content), capped. */
export async function taskDiff(cwd: string, files: string[]): Promise<string> {
  if (files.length === 0) return "(no files reported)";
  let out = "";
  try {
    out = await git(cwd, ["diff", "HEAD", "--", ...files]);
    const untracked = (
      await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...files])
    )
      .split("\n")
      .filter(Boolean);
    for (const f of untracked) {
      let body = "";
      try {
        body = readFileSync(join(cwd, f), "utf8");
      } catch {}
      out += `\n--- new file: ${f}\n${body}\n`;
    }
  } catch (err) {
    out += `\n(diff failed: ${(err as Error).message})`;
  }
  return out.length > DIFF_CAP_BYTES ? `${out.slice(0, DIFF_CAP_BYTES)}\n...(diff truncated)` : out;
}

export type CallFn = <S extends Schema<unknown>>(
  taskId: string,
  role: Role,
  stage: Stage,
  attempt: number,
  prompt: string,
  schema: S,
  jsonSchema: unknown,
) => Promise<Out<S>>;

/** Everything the conductor needs from `runPlan`. */
export interface ConductorCtx {
  repo: string;
  feature: string;
  runId: string;
  tasksMd: string;
  plan: Plan;
  /** Newline list of `- <path>` references for the prompts. */
  refs: string;
  retries: number;
  noCommit: boolean;
  trailer?: string;
  rotateAfterTokens: number;
  defaultHarness: string;
  workerRole: { harness?: string; model?: string; effort?: string };
  signal?: AbortSignal;
  inScope: (id: string) => boolean;
  resumed: Set<string>;
  outcome: Map<string, "done" | "failed" | "notStarted">;
  deviations: string[];
  driverFor: (harness: string) => Driver;
  call: CallFn;
  step: <T>(task: string, stage: Stage, attempt: number, fn: () => Promise<T>) => Promise<T>;
  blocker: (task: string, kind: BlockerKind, reason: string, advice?: string) => void;
  custom: (name: string, value: unknown, source?: string, harness?: string) => void;
  taskEvent: (v: TaskValue) => void;
  agentLog: (id: string) => (it: StreamItem) => void;
  log: (line: string) => void;
}

interface Session {
  aid: string;
  harness: string;
  sessionId?: string;
  tasks: string[];
  lastInput: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number | null;
  };
  write: (it: StreamItem) => void;
}

interface DoneEntry {
  id: string;
  title: string;
  files: string[];
  deviations: string[];
}

export class Interrupted extends Error {}
export class TaskFailed extends Error {}
const Failed = TaskFailed;

/** DD-03 solo mode: one worker session across tasks; gate, review and commit run in code. */
export async function runSolo(ctx: ConductorCtx): Promise<void> {
  const { signal } = ctx;
  const harness = ctx.workerRole.harness ?? ctx.defaultHarness;
  const driver = ctx.driverFor(harness);
  const canResume = driver.resume === "id";
  let session: Session | undefined;
  let sessionSeq = 0;
  const done: DoneEntry[] = [];
  const aborted = () => {
    if (signal?.aborted) throw new Interrupted();
  };

  const endSession = (status: "done" | "error" = "done") => {
    if (!session) return;
    ctx.custom(
      "tlc.agent",
      {
        id: session.aid,
        status,
        endedAt: Date.now(),
        tasks: session.tasks,
        usage: { ...session.usage },
      },
      "implementer",
      harness,
    );
    session = undefined;
  };

  const handoff = () => {
    if (done.length === 0) return "";
    const lines = done.map((d) => `- ${d.id}: ${d.title}`);
    const decisions = done.flatMap((d) => d.deviations.map((x) => `- ${d.id}: ${x}`));
    const files = [...new Set(done.flatMap((d) => d.files))];
    const summary = [
      "Done tasks:",
      ...lines,
      ...(decisions.length ? ["", "Key decisions and deviations reported:", ...decisions] : []),
      ...(files.length ? ["", `Files touched: ${files.join(", ")}`] : []),
    ].join("\n");
    return renderPrompt("solo-handoff", { summary });
  };

  const startSession = (taskId: string): Session => {
    const aid = `${ctx.runId}-worker-${++sessionSeq}`;
    const s: Session = {
      aid,
      harness,
      tasks: [taskId],
      lastInput: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      write: ctx.agentLog(aid),
    };
    ctx.custom(
      "tlc.agent",
      {
        id: aid,
        task: taskId,
        tasks: s.tasks,
        role: "worker",
        harness,
        runId: ctx.runId,
        source: "tlc-run",
        ...(ctx.workerRole.model ? { model: ctx.workerRole.model } : {}),
        label: "worker",
        status: "running",
        startedAt: Date.now(),
      },
      "implementer",
      harness,
    );
    session = s;
    return s;
  };

  /** One turn of the worker; starts or rotates the session when needed. */
  const turn = async (t: PlanTask, kind: "task" | "fix", findings = ""): Promise<StatusOutput> => {
    aborted();
    const block = taskBlock(ctx.tasksMd, t.id) ?? `### ${t.id}: ${t.title}`;
    const rotate =
      session !== undefined &&
      (!canResume || !session.sessionId || session.lastInput > ctx.rotateAfterTokens);
    if (rotate) endSession();
    const fresh = session === undefined;
    const s = session ?? startSession(t.id);
    if (!fresh && !s.tasks.includes(t.id)) {
      s.tasks.push(t.id);
      ctx.custom("tlc.agent", { id: s.aid, task: t.id, tasks: s.tasks }, "implementer", harness);
    } else if (!fresh) {
      ctx.custom("tlc.agent", { id: s.aid, task: t.id }, "implementer", harness);
    }
    let prompt: string;
    if (fresh) {
      prompt = renderPrompt("solo-first", { handoff: handoff(), paths: ctx.refs, task: block });
      if (kind === "fix") prompt += `\n${renderPrompt("solo-fix", { findings })}`;
    } else {
      prompt =
        kind === "fix"
          ? renderPrompt("solo-fix", { findings })
          : renderPrompt("solo-task", { task: block });
    }
    let res: DriverResult;
    try {
      res = await driver.run({
        role: "implementer",
        prompt,
        ...(ctx.workerRole.model ? { model: ctx.workerRole.model } : {}),
        ...(ctx.workerRole.effort ? { effort: ctx.workerRole.effort } : {}),
        cwd: ctx.repo,
        schema: statusOutputJsonSchema,
        onItem: s.write as (it: StreamItem) => void,
        ...(!fresh && s.sessionId ? { resumeSessionId: s.sessionId } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      s.write({ kind: "error", text: (err as Error).message, isError: true } as StreamItem);
      endSession("error");
      aborted();
      ctx.blocker(t.id, "error", `worker (${harness}) failed: ${(err as Error).message}`);
      throw new Failed();
    }
    if (res.sessionId) s.sessionId = res.sessionId;
    if (res.usage) {
      const u = res.usage;
      s.lastInput = u.input;
      s.usage.input += u.input;
      s.usage.output += u.output;
      s.usage.cacheRead += u.cacheRead;
      s.usage.cacheWrite += u.cacheWrite;
      s.usage.costUsd =
        s.usage.costUsd === null || u.costUsd === null ? null : s.usage.costUsd + u.costUsd;
      ctx.custom(
        "tlc.agent",
        { id: s.aid, usage: { ...s.usage }, ...(u.model ? { model: u.model } : {}) },
        "implementer",
        harness,
      );
      ctx.custom(
        "tlc.usage",
        {
          task: t.id,
          role: "implementer",
          harness,
          model: ctx.workerRole.model ?? u.model ?? "default",
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          costUsd: u.costUsd,
        },
        "implementer",
        harness,
      );
    } else {
      s.lastInput = 0;
    }
    aborted();
    if (res.exitCode !== 0) {
      ctx.blocker(t.id, "error", `worker (${harness}) exited with code ${res.exitCode}`);
      throw new Failed();
    }
    const parsed = StatusOutputSchema.safeParse(res.data);
    if (!parsed.success) {
      ctx.blocker(t.id, "error", `worker (${harness}) returned invalid output`);
      throw new Failed();
    }
    return parsed.data;
  };

  const execTask = async (t: PlanTask): Promise<void> => {
    const id = t.id;
    const block = taskBlock(ctx.tasksMd, id) ?? `### ${id}: ${t.title}`;
    const gate = resolveGate(ctx.tasksMd, id);
    let attempt = 0;
    let files: string[] = [];
    const devs: string[] = [];
    const absorb = (r: StatusOutput) => {
      files = [...new Set([...files, ...r.files])];
      for (const d of r.deviations) if (!devs.includes(d)) devs.push(d);
    };
    const complete = (r: StatusOutput, what: string) => {
      if (r.status === "Complete") return;
      ctx.blocker(
        id,
        r.status === "Blocked" ? "blocked" : "partial",
        r.issues.join("; ") || `worker reported ${r.status}${what}`,
      );
      throw new Failed();
    };

    ctx.taskEvent({ id, status: "running", attempt: 1 });
    let report = await ctx.step(id, "implement", ++attempt, () => turn(t, "task"));
    absorb(report);
    complete(report, "");

    let gateSummary = report.gate;
    for (let round = 0; ; round++) {
      let problem: { kind: BlockerKind; findings: string[] } | undefined;
      const g = gate
        ? await ctx.step(id, "gate", attempt, () =>
            runGate(ctx.repo, gate.command, GATE_TIMEOUT_MS, signal),
          )
        : undefined;
      aborted();
      if (g)
        gateSummary = { pass: g.pass, summary: g.pass ? `${gate?.name} passed` : `exit ${g.code}` };
      else gateSummary = report.gate;
      if (g ? !g.pass : !report.gate.pass) {
        problem = {
          kind: "gate",
          findings: [
            g
              ? `Gate \`${g.command}\` failed (exit ${g.code}). Last output:\n${g.tail}`
              : `Gate failed: ${report.gate.summary}`,
          ],
        };
      } else {
        const diff = await taskDiff(ctx.repo, changedFiles(files, block));
        const review = await ctx.step(id, "verify", attempt, () =>
          ctx.call(
            id,
            "reviewer",
            "verify",
            attempt,
            renderPrompt("solo-review", { task: block, diff }),
            ReviewerOutputSchema,
            reviewerOutputJsonSchema,
          ),
        );
        if (review.verdict === "reject") problem = { kind: "rejected", findings: review.findings };
      }
      if (!problem) break;
      const reason = problem.findings.join("; ") || "rejected";
      if (round >= ctx.retries) {
        ctx.blocker(id, problem.kind, `${reason} (retries exhausted)`);
        throw new Failed();
      }
      ctx.blocker(id, problem.kind, reason);
      const fixed = await ctx.step(id, "fix", ++attempt, () =>
        turn(t, "fix", problem.findings.map((f) => `- ${f}`).join("\n")),
      );
      absorb(fixed);
      complete(fixed, " during fix");
      report = fixed;
    }

    let commit: string | undefined;
    if (!ctx.noCommit) {
      try {
        commit = await ctx.step(id, "commit", attempt, () =>
          commitFiles({
            cwd: ctx.repo,
            files: changedFiles(files, block),
            message: commitMessage(ctx.tasksMd, id, ctx.trailer, ctx.plan),
          }),
        );
      } catch (err) {
        ctx.blocker(id, "error", (err as Error).message);
        throw new Failed();
      }
    }
    ctx.deviations.push(...devs.map((d) => `${id}: ${d}`));
    done.push({ id, title: t.title, files, deviations: devs });
    ctx.taskEvent({
      id,
      status: "done",
      stage: "commit",
      attempt,
      ...(commit ? { commit } : {}),
      files,
      gate: gateSummary,
      ...(devs.length ? { deviations: devs } : {}),
    });
  };

  try {
    for (const t of waves(ctx.plan.tasks).flat()) {
      if (signal?.aborted) break;
      if (!ctx.inScope(t.id)) continue;
      if (t.done || ctx.resumed.has(t.id)) {
        ctx.outcome.set(t.id, "done");
        ctx.taskEvent({ id: t.id, status: "done" });
        ctx.log(`${t.id} already done, skipped`);
        continue;
      }
      const bad = t.dependsOn.filter((d) => {
        const o = ctx.outcome.get(d);
        return o === "failed" || o === "notStarted";
      });
      if (bad.length) {
        ctx.outcome.set(t.id, "notStarted");
        ctx.taskEvent({ id: t.id, status: "skipped" });
        ctx.custom("tlc.log", {
          level: "warn",
          message: `${t.id} not started: dependency ${bad.join(", ")} did not complete`,
        });
        continue;
      }
      try {
        await execTask(t);
        ctx.outcome.set(t.id, "done");
      } catch (err) {
        if (signal?.aborted) break;
        ctx.outcome.set(t.id, "failed");
        if (!(err instanceof TaskFailed)) {
          ctx.blocker(t.id, "error", (err as Error).message);
        }
        ctx.taskEvent({ id: t.id, status: "failed" });
        ctx.log(`${t.id} failed`);
      }
    }
  } finally {
    endSession();
  }
}

/** Worker-reported files plus the task's Where paths (commitFiles keeps only changed ones). */
function changedFiles(reported: string[], block: string): string[] {
  return [...new Set([...reported, ...wherePaths(block)])];
}
