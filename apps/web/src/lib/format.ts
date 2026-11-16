import type { RunState } from "@tlc-deck/protocol";

export function milestoneProgress(run: RunState): string {
  const total = run.milestones.length;
  return `${run.milestones.filter((m) => m.reached).length}/${total}`;
}

export function taskProgress(run: RunState): string {
  const tasks = Object.values(run.tasks);
  return `${tasks.filter((t) => t.status === "done").length}/${tasks.length}`;
}

export function openBlockers(run: RunState): number {
  return run.blockers.filter((b) => b.open).length;
}

export function runCost(run: RunState): number | null {
  const all = Object.values(run.usageByModel);
  if (all.length === 0) return null;
  let known = false;
  let sum = 0;
  for (const u of all) {
    if (u.costUsd !== null) {
      known = true;
      sum += u.costUsd;
    }
  }
  return known ? sum : null;
}

export function formatCost(c: number | null): string {
  return c === null ? "-" : `$${c.toFixed(2)}`;
}

export function elapsed(run: RunState, now: number): string {
  if (!run.startedAt) return "-";
  const end = run.finishedAt ?? now;
  const s = Math.max(0, Math.floor((end - run.startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
