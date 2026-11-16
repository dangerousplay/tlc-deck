import type {
  BlockerState,
  MilestoneState,
  RunState,
  RunStatus,
  TaskState,
  TlcEvent,
  UsageTotals,
} from "@tlc-deck/protocol";

export const STALE_MS = 15 * 60 * 1000;

export interface FoldOptions {
  /** Clock for stale detection. Default Date.now(). */
  now?: number;
  /** Only fold events of this run. Default: the run of the first event. */
  runId?: string;
}

const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
});

function addUsage(t: UsageTotals, v: Record<string, unknown>): void {
  t.input += Number(v.input) || 0;
  t.output += Number(v.output) || 0;
  t.cacheRead += Number(v.cacheRead) || 0;
  t.cacheWrite += Number(v.cacheWrite) || 0;
  if (typeof v.costUsd === "number") t.costUsd = (t.costUsd ?? 0) + v.costUsd;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/**
 * Pure fold of one run's events into RunState. Events are ordered by `metadata.seq` (stable).
 * Status: RUN_FINISHED with failed tasks or a non-"interrupted" RUN_ERROR -> failed;
 * RUN_ERROR code "interrupted" -> interrupted; no terminal event and silent for 15 min -> stale.
 */
export function fold(events: readonly TlcEvent[], opts: FoldOptions = {}): RunState {
  const now = opts.now ?? Date.now();
  const runId = opts.runId ?? events[0]?.metadata.runId ?? "";
  const evs = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.metadata.runId === runId)
    .sort((a, b) => a.e.metadata.seq - b.e.metadata.seq || a.i - b.i)
    .map(({ e }) => e);

  const state: RunState = {
    runId,
    status: "running",
    tasks: {},
    milestones: [],
    blockers: [],
    usageByRole: {},
    usageByModel: {},
  };
  const explicitMilestones = new Set<string>();
  const blockers = new Map<string, BlockerState>();
  let terminal = false;

  const task = (id: string): TaskState => {
    let t = state.tasks[id];
    if (!t) {
      t = { id, status: "pending" };
      state.tasks[id] = t;
    }
    return t;
  };
  const closeBlockersOf = (id: string) => {
    for (const b of blockers.values()) if (b.task === id) b.open = false;
  };

  for (const ev of evs) {
    const ts = typeof ev.timestamp === "number" ? ev.timestamp : undefined;
    if (ts !== undefined) state.lastEventAt = Math.max(state.lastEventAt ?? 0, ts);
    if (typeof ev.threadId === "string") state.threadId ??= ev.threadId;
    state.threadId ??= ev.metadata.threadId;

    switch (ev.type) {
      case "RUN_STARTED":
        state.startedAt ??= ts;
        break;
      case "RUN_FINISHED": {
        const failed = obj(ev.result).failed;
        state.status = Array.isArray(failed) && failed.length > 0 ? "failed" : "finished";
        state.finishedAt = ts;
        terminal = true;
        break;
      }
      case "RUN_ERROR":
        state.status = ev.code === "interrupted" ? "interrupted" : "failed";
        state.finishedAt = ts;
        terminal = true;
        break;
      case "STEP_STARTED": {
        const [id, stage] = String(ev.stepName ?? "").split(":");
        if (!id) break;
        const t = task(id);
        if (t.status !== "done") {
          t.status = "running";
          if (stage) t.stage = stage;
          t.startedAt ??= ts;
        }
        break;
      }
      case "CUSTOM": {
        const v = obj(ev.value);
        switch (ev.name) {
          case "tlc.plan": {
            const plan = v as {
              tasks?: { id: string; title?: string; milestone?: string }[];
              milestones?: { name: string; source: MilestoneState["source"]; tasks: string[] }[];
            };
            for (const p of plan.tasks ?? []) {
              const t = task(p.id);
              t.title = p.title;
              t.milestone = p.milestone;
            }
            state.milestones = (plan.milestones ?? []).map((m) => ({
              name: m.name,
              source: m.source,
              tasks: [...m.tasks],
              reached: false,
            }));
            break;
          }
          case "tlc.task": {
            const id = String(v.id);
            const t = task(id);
            t.status = v.status as TaskState["status"];
            if (typeof v.stage === "string") t.stage = v.stage;
            if (typeof v.attempt === "number") t.attempt = v.attempt;
            if (typeof v.commit === "string") t.commit = v.commit;
            if (Array.isArray(v.files)) t.files = v.files as string[];
            if (v.gate) t.gate = v.gate as TaskState["gate"];
            if (Array.isArray(v.deviations)) t.deviations = v.deviations as string[];
            if (t.status === "running") t.startedAt ??= ts;
            if (t.status === "done" || t.status === "failed" || t.status === "skipped") {
              t.finishedAt = ts;
            }
            if (t.status === "done") closeBlockersOf(id);
            break;
          }
          case "tlc.blocker": {
            const b = v as unknown as Omit<BlockerState, "open">;
            blockers.set(b.id, {
              id: b.id,
              task: b.task,
              kind: b.kind,
              reason: b.reason,
              ...(b.advice !== undefined ? { advice: b.advice } : {}),
              open: true,
            });
            break;
          }
          case "tlc.blocker_resolved": {
            const b = blockers.get(String(v.id));
            if (b) b.open = false;
            break;
          }
          case "tlc.milestone":
            explicitMilestones.add(String(v.name));
            break;
          case "tlc.usage": {
            const role = String(v.role);
            const model = String(v.model);
            const byRole = state.usageByRole[role] ?? emptyUsage();
            const byModel = state.usageByModel[model] ?? emptyUsage();
            addUsage(byRole, v);
            addUsage(byModel, v);
            state.usageByRole[role] = byRole;
            state.usageByModel[model] = byModel;
            break;
          }
        }
        break;
      }
    }
  }

  state.blockers = [...blockers.values()];
  for (const name of explicitMilestones) {
    if (!state.milestones.some((m) => m.name === name)) {
      state.milestones.push({ name, source: "field", tasks: [], reached: false });
    }
  }
  for (const m of state.milestones) {
    m.reached =
      explicitMilestones.has(m.name) ||
      (m.tasks.length > 0 && m.tasks.every((id) => state.tasks[id]?.status === "done"));
  }

  const last = state.lastEventAt;
  if (!terminal && last !== undefined && now - last > STALE_MS) {
    state.status = "stale" satisfies RunStatus;
  }
  return state;
}
