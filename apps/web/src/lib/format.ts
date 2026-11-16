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

export function formatTokens(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function timeAgo(ts: number | undefined, now: number): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function isToday(ts: number | undefined, now: number): boolean {
  if (!ts) return false;
  return new Date(ts).toDateString() === new Date(now).toDateString();
}

export function clock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}
