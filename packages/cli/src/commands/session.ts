import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  appendEvent,
  foldRuns,
  type NewEvent,
  newestActiveRun,
  type Plan,
  type PlanTask,
  PROGRESS_FILE,
  parsePlan,
  readEvents,
  taskBlock,
} from "@tlc-deck/core";
import { PROTOCOL_V, type Stage, type TaskValue } from "@tlc-deck/protocol";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()): string {
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

/** Shared state of the in-session helpers (`tlc next|gate|review|commit`). */
export interface Session {
  repo: string;
  feature: string;
  progress: string;
  tasksMd: string;
  plan: Plan;
  runId: string;
  threadId: string;
  emit: (event: Record<string, unknown>) => void;
  custom: (name: string, value: unknown) => void;
  taskEvent: (v: TaskValue) => void;
  /** Task ids done in any run of the feature or checked in tasks.md. */
  doneIds: () => Set<string>;
  /** Files recorded for the task by earlier events (any run). */
  taskFiles: (id: string) => string[];
  task: (id: string) => PlanTask;
  block: (id: string) => string;
  step: <T>(id: string, stage: Stage, fn: () => Promise<T>) => Promise<T>;
}

/** HLP-01/05: open the newest active run of the feature, else start a `solo-session` run. */
export function openSession(
  repo: string,
  feature: string,
  env: Record<string, string | undefined>,
): Session {
  const dir = join(repo, ".specs", "features", feature);
  const tasksFile = join(dir, "tasks.md");
  if (!existsSync(tasksFile)) throw new Error(`${tasksFile} not found`);
  const tasksMd = readFileSync(tasksFile, "utf8");
  const specFile = join(dir, "spec.md");
  const plan = parsePlan(
    tasksMd,
    existsSync(specFile) ? readFileSync(specFile, "utf8") : undefined,
  );
  const progress = join(dir, PROGRESS_FILE);
  const threadId = `${basename(repo)}#${feature}`;
  const harness = env.TLC_HARNESS ?? "cli";

  const active = newestActiveRun(foldRuns(readEvents(progress)));
  const runId = active?.runId ?? `tlc_${ulid()}`;
  const emitFor = (rid: string, event: Record<string, unknown>) =>
    appendEvent(progress, {
      timestamp: Date.now(),
      ...event,
      metadata: {
        v: PROTOCOL_V,
        seq: 0,
        runId: rid,
        threadId,
        harness,
        driver: "workflow",
        source: "tlc-helper",
      },
    } as unknown as NewEvent);
  if (!active) {
    emitFor(runId, {
      type: "RUN_STARTED",
      threadId,
      runId,
      input: {
        feature,
        tasksPath: join(".specs", "features", feature, "tasks.md"),
        harness,
        mode: "solo-session",
        repoPath: repo,
      },
    });
    emitFor(runId, {
      type: "CUSTOM",
      name: "tlc.plan",
      value: {
        tasks: plan.tasks.map(({ done: _d, ...t }) => t),
        milestones: plan.milestones,
      },
    });
  }
  const emit = (event: Record<string, unknown>) => {
    emitFor(runId, event);
  };
  const custom = (name: string, value: unknown) => emit({ type: "CUSTOM", name, value });
  const task = (id: string) => {
    const t = plan.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`unknown task: ${id}`);
    return t;
  };
  return {
    repo,
    feature,
    progress,
    tasksMd,
    plan,
    runId,
    threadId,
    emit,
    custom,
    taskEvent: (v) => custom("tlc.task", v),
    doneIds: () => {
      const done = new Set(plan.tasks.filter((t) => t.done).map((t) => t.id));
      for (const r of foldRuns(readEvents(progress))) {
        for (const t of Object.values(r.tasks)) if (t.status === "done") done.add(t.id);
      }
      return done;
    },
    taskFiles: (id) => {
      const files = new Set<string>();
      for (const r of foldRuns(readEvents(progress))) {
        for (const f of r.tasks[id]?.files ?? []) files.add(f);
      }
      return [...files];
    },
    task,
    block: (id) => {
      const t = task(id);
      return taskBlock(tasksMd, id) ?? `### ${id}: ${t.title}`;
    },
    step: async (id, stage, fn) => {
      custom("tlc.task", { id, status: "running", stage, attempt: 1 });
      emit({ type: "STEP_STARTED", stepName: `${id}:${stage}` });
      try {
        return await fn();
      } finally {
        emit({ type: "STEP_FINISHED", stepName: `${id}:${stage}` });
      }
    },
  };
}
