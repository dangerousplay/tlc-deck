export const TASK_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
  "skipped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const BLOCKER_KINDS = ["blocked", "partial", "rejected", "gate", "error"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const RUN_STATUSES = ["running", "finished", "failed", "interrupted", "stale"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STAGES = ["implement", "verify", "advise", "fix", "commit"] as const;
export type Stage = (typeof STAGES)[number];

export interface TaskState {
  id: string;
  title?: string;
  milestone?: string;
  status: TaskStatus;
  stage?: string;
  attempt?: number;
  commit?: string;
  files?: string[];
  gate?: { pass: boolean; summary: string };
  deviations?: string[];
  startedAt?: number;
  finishedAt?: number;
}

export interface BlockerState {
  id: string;
  task: string;
  kind: BlockerKind;
  reason: string;
  advice?: string;
  open: boolean;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface MilestoneState {
  name: string;
  source: "field" | "priority" | "wave";
  tasks: string[];
  reached: boolean;
}

/** Folded state of a run (the reducer lives in @tlc-deck/core). */
export interface RunState {
  runId: string;
  threadId?: string;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  lastEventAt?: number;
  tasks: Record<string, TaskState>;
  milestones: MilestoneState[];
  blockers: BlockerState[];
  usageByRole: Record<string, UsageTotals>;
  usageByModel: Record<string, UsageTotals>;
}
