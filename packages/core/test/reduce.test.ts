import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { fold, foldRuns, newestActiveRun, readEvents, STALE_MS } from "../src/index.js";

const golden = resolve(import.meta.dirname, "../../../fixtures/runs/golden-15.ndjson");
const events = readEvents(golden);
const end = events[events.length - 1]?.timestamp ?? 0;

describe("fold golden 15-task run", () => {
  const s = fold(events, { now: end });

  test("fixture parses fully", () => {
    expect(events).toHaveLength(130);
  });

  test("run status: finished with a failed task", () => {
    expect(s.runId).toBe("tlc_01JGOLDEN");
    expect(s.threadId).toBe("repo#golden");
    expect(s.status).toBe("failed");
    expect(s.finishedAt).toBe(end);
  });

  test("tasks", () => {
    expect(Object.keys(s.tasks)).toHaveLength(15);
    const done = Object.values(s.tasks).filter((t) => t.status === "done");
    expect(done).toHaveLength(14);
    expect(s.tasks.T9?.status).toBe("failed");
    expect(s.tasks.T9?.gate).toEqual({ pass: false, summary: "3 failing" });
    expect(s.tasks.T4?.status).toBe("done");
    expect(s.tasks.T4?.attempt).toBe(2);
    expect(s.tasks.T3?.deviations).toEqual(["used fs.watch"]);
    expect(s.tasks.T1?.commit).toBe("abc0");
    expect(s.tasks.T1?.title).toBe("Task T1");
    expect(s.tasks.T1?.finishedAt).toBeGreaterThan(s.tasks.T1?.startedAt ?? Infinity);
  });

  test("blocker resolved by retry stays closed, failed task blocker open", () => {
    const b1 = s.blockers.find((b) => b.id === "B1");
    const b2 = s.blockers.find((b) => b.id === "B2");
    expect(b1).toMatchObject({
      task: "T4",
      kind: "rejected",
      advice: "retry with fix",
      open: false,
    });
    expect(b2).toMatchObject({ task: "T9", kind: "gate", open: true });
  });

  test("milestones", () => {
    expect(s.milestones.map((m) => [m.name, m.reached])).toEqual([
      ["Foundation", true],
      ["Views", false],
      ["Finish", true],
    ]);
  });

  test("usage per role and model across 3 models", () => {
    expect(Object.keys(s.usageByModel).sort()).toEqual(["haiku", "opus", "sonnet"]);
    expect(s.usageByModel.sonnet).toMatchObject({
      input: 45000,
      output: 4500,
      cacheRead: 7500,
      cacheWrite: 750,
    });
    expect(s.usageByModel.sonnet?.costUsd).toBeCloseTo(0.45);
    expect(s.usageByModel.opus).toMatchObject({ input: 2000, output: 200 });
    expect(s.usageByModel.opus?.costUsd).toBeCloseTo(0.02);
    expect(s.usageByModel.haiku).toMatchObject({ input: 14000 });
    expect(s.usageByModel.haiku?.costUsd).toBeNull();
    expect(s.usageByRole.implementer?.input).toBe(47000);
    expect(s.usageByRole.reviewer?.input).toBe(14000);
  });
});

describe("fold status", () => {
  const upTo = (n: number) => events.slice(0, n);
  const last = (n: number) => upTo(n)[n - 1]?.timestamp ?? 0;

  test("running while fresh, stale after 15 minutes", () => {
    expect(fold(upTo(40), { now: last(40) + 1000 }).status).toBe("running");
    expect(fold(upTo(40), { now: last(40) + STALE_MS + 1 }).status).toBe("stale");
  });

  test("finished is never stale", () => {
    expect(fold(events, { now: end + STALE_MS * 10 }).status).toBe("failed");
  });

  test("RUN_ERROR interrupted vs fatal", () => {
    const m = { ...events[0]?.metadata, seq: 999 } as (typeof events)[number]["metadata"];
    const err = (code: string) => ({
      type: "RUN_ERROR",
      message: "x",
      code,
      timestamp: end + 1,
      metadata: m,
    });
    expect(fold([...upTo(40), err("interrupted")], { now: end }).status).toBe("interrupted");
    expect(fold([...upTo(40), err("boom")], { now: end }).status).toBe("failed");
  });

  test("explicit milestone and task done closes blockers", () => {
    const m = events[0]?.metadata as (typeof events)[number]["metadata"];
    const mk = (seq: number, name: string, value: unknown) => ({
      type: "CUSTOM",
      name,
      value,
      timestamp: seq,
      metadata: { ...m, seq },
    });
    const s = fold(
      [
        mk(1, "tlc.blocker", { id: "X", task: "T1", kind: "blocked", reason: "r" }),
        mk(2, "tlc.milestone", { name: "Early" }),
        mk(3, "tlc.task", { id: "T1", status: "done" }),
      ],
      { now: 3 },
    );
    expect(s.blockers[0]?.open).toBe(false);
    expect(s.milestones).toEqual([{ name: "Early", source: "field", tasks: [], reached: true }]);
  });

  test("empty input", () => {
    expect(fold([]).status).toBe("running");
  });
});

describe("runs", () => {
  test("foldRuns separates runs, newest first; newestActiveRun picks running", () => {
    const m = events[0]?.metadata as (typeof events)[number]["metadata"];
    const other = [1, 2].map((seq) => ({
      type: "CUSTOM",
      name: "tlc.log",
      value: { level: "info", message: "x" },
      timestamp: end + seq * 1000,
      metadata: { ...m, runId: "tlc_other", seq },
    }));
    const runs = foldRuns([...events, ...other], { now: end + 5000 });
    expect(runs.map((r) => r.runId)).toEqual(["tlc_other", "tlc_01JGOLDEN"]);
    expect(newestActiveRun(runs)?.runId).toBe("tlc_other");
    expect(newestActiveRun(runs.slice(1))).toBeUndefined();
  });
});
