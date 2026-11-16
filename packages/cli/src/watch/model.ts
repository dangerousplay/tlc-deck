import type { RunState, TlcEvent } from "@tlc-deck/protocol";

const hhmmss = (ts: number | undefined): string =>
  typeof ts === "number" ? new Date(ts).toISOString().slice(11, 19) : "--:--:--";

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** One line per event, used by the non-TTY mode (TUI-04). */
export function formatEventLine(ev: TlcEvent): string {
  const time = hhmmss(typeof ev.timestamp === "number" ? ev.timestamp : undefined);
  const v = obj((ev as { value?: unknown }).value);
  let text: string;
  switch (ev.type) {
    case "RUN_STARTED":
      text = `run started ${ev.metadata.runId} harness=${ev.metadata.harness}`;
      break;
    case "RUN_FINISHED": {
      const r = obj((ev as { result?: unknown }).result);
      text = `run finished completed=${len(r.completed)} failed=${len(r.failed)} notStarted=${len(r.notStarted)}`;
      break;
    }
    case "RUN_ERROR":
      text = `run error ${String(ev.code ?? "error")}: ${String(ev.message ?? "")}`;
      break;
    case "STEP_STARTED":
      text = `step started ${String(ev.stepName)}`;
      break;
    case "STEP_FINISHED":
      text = `step finished ${String(ev.stepName)}`;
      break;
    case "CUSTOM":
      switch (ev.name) {
        case "tlc.plan":
          text = `plan tasks=${len(v.tasks)} milestones=${len(v.milestones)}`;
          break;
        case "tlc.task":
          text = `task ${String(v.id)} ${String(v.status)}${v.stage ? ` ${String(v.stage)}` : ""}${typeof v.commit === "string" ? ` ${v.commit}` : ""}`;
          break;
        case "tlc.blocker":
          text = `blocker ${String(v.task)} [${String(v.kind)}] ${String(v.reason)}`;
          break;
        case "tlc.blocker_resolved":
          text = `blocker resolved ${String(v.id)}`;
          break;
        case "tlc.milestone":
          text = `milestone ${String(v.name)} reached`;
          break;
        case "tlc.usage":
          text = `usage ${String(v.role)} ${String(v.model)}${typeof v.costUsd === "number" ? ` $${v.costUsd.toFixed(4)}` : ""}`;
          break;
        case "tlc.log":
          text = `log ${String(v.level)}: ${String(v.message)}`;
          break;
        default:
          text = `custom ${String(ev.name)}`;
      }
      break;
    default:
      text = String(ev.type).toLowerCase();
  }
  return `${time} ${text}`;
}

export function isTerminal(ev: TlcEvent): boolean {
  return ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR";
}

export function failedTasks(run: RunState): string[] {
  return Object.values(run.tasks)
    .filter((t) => t.status === "failed")
    .map((t) => t.id);
}

/** TUI-03: 0 when the run finished cleanly, 1 when failed tasks or a failed/interrupted run. */
export function exitCodeFor(run: RunState): number {
  if (run.status === "finished" && failedTasks(run).length === 0) return 0;
  return 1;
}

export function totalCost(run: RunState): number | null {
  let sum: number | null = null;
  for (const u of Object.values(run.usageByModel)) {
    if (u.costUsd !== null) sum = (sum ?? 0) + u.costUsd;
  }
  return sum;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function elapsedOf(run: RunState, now: number): number {
  if (run.startedAt === undefined) return 0;
  return (run.finishedAt ?? now) - run.startedAt;
}

export function formatCost(run: RunState): string {
  const c = totalCost(run);
  return c === null ? "-" : `$${c.toFixed(2)}`;
}

/** Final summary printed on exit (TUI-03). */
export function summaryLines(run: RunState, now: number): string[] {
  const tasks = Object.values(run.tasks);
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const lines = [
    `run ${run.runId} ${run.status} in ${formatElapsed(elapsedOf(run, now))}, cost ${formatCost(run)}`,
    `tasks: ${count("done")} done, ${count("failed")} failed, ${count("blocked")} blocked, ${count("skipped")} skipped, ${count("pending")} pending (of ${tasks.length})`,
  ];
  const failed = failedTasks(run);
  if (failed.length) lines.push(`failed: ${failed.join(", ")}`);
  for (const b of run.blockers.filter((x) => x.open)) {
    lines.push(`open blocker ${b.task} [${b.kind}]: ${b.reason}`);
  }
  return lines;
}
