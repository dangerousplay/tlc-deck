import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunState, TlcEvent } from "@tlc-deck/protocol";
import { type FoldOptions, fold } from "./reduce.js";

export const PROGRESS_FILE = "progress.ndjson";

/** Group events by runId (first-seen order). */
export function groupByRun(events: readonly TlcEvent[]): Map<string, TlcEvent[]> {
  const m = new Map<string, TlcEvent[]>();
  for (const e of events) {
    const list = m.get(e.metadata.runId);
    if (list) list.push(e);
    else m.set(e.metadata.runId, [e]);
  }
  return m;
}

const recency = (r: RunState) => r.lastEventAt ?? r.startedAt ?? 0;

/** Folded runs found in `events`, newest first. */
export function foldRuns(events: readonly TlcEvent[], opts: Omit<FoldOptions, "runId"> = {}) {
  return [...groupByRun(events).keys()]
    .map((runId) => fold(events, { ...opts, runId }))
    .sort((a, b) => recency(b) - recency(a));
}

/** Newest run whose status is "running" (not finished, failed, interrupted or stale). */
export function newestActiveRun(runs: readonly RunState[]): RunState | undefined {
  return runs.find((r) => r.status === "running");
}

/** Paths of `.specs/features/<feature>/progress.ndjson` files under a repo. */
export function findProgressFiles(repoDir: string): string[] {
  const dir = join(repoDir, ".specs", "features");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, PROGRESS_FILE))
    .filter((f) => existsSync(f))
    .sort();
}
