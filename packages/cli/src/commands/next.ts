import { readEvents } from "@tlc-deck/core";
import { openSession, type Session } from "./session.js";

export interface HelperOptions {
  repo: string;
  feature: string;
  task?: string;
  json?: boolean;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** `tlc next`: the next runnable task with its block and run id, or `{"done": true}`. */
export function runNext(opts: HelperOptions): number {
  const s: Session = openSession(opts.repo, opts.feature, opts.env);
  const done = s.doneIds();
  const open = s.plan.tasks.filter((t) => !done.has(t.id));
  if (open.length === 0) {
    // Finish a run the helpers started themselves; leave others alone.
    if (isSoloSession(s)) {
      s.emit({
        type: "RUN_FINISHED",
        threadId: s.threadId,
        runId: s.runId,
        result: {
          completed: s.plan.tasks.map((t) => t.id),
          failed: [],
          notStarted: [],
          deviations: [],
        },
      });
    }
    opts.stdout(`${JSON.stringify({ done: true })}\n`);
    return 0;
  }
  const next = open.find((t) => t.dependsOn.every((d) => done.has(d)));
  if (!next) {
    opts.stdout(`${JSON.stringify({ done: false, waiting: open.map((t) => t.id) })}\n`);
    return 1;
  }
  const block = s.block(next.id);
  if (opts.json) {
    opts.stdout(
      `${JSON.stringify({ done: false, runId: s.runId, task: { id: next.id, title: next.title }, block })}\n`,
    );
  } else {
    opts.stdout(`run ${s.runId}\n\n${block}\n`);
  }
  return 0;
}

function isSoloSession(s: Session): boolean {
  const first = readEvents(s.progress).find(
    (e) => e.type === "RUN_STARTED" && e.metadata?.runId === s.runId,
  ) as { input?: { mode?: string } } | undefined;
  return first?.input?.mode === "solo-session";
}
