import { describe, expect, test } from "vitest";
import {
  advisorOutputJsonSchema,
  parseLine,
  reviewerOutputJsonSchema,
  statusOutputJsonSchema,
} from "../src/index.js";

const meta = {
  v: 1,
  seq: 1,
  runId: "tlc_01J",
  threadId: "repo#feat",
  harness: "claude-code",
  driver: "workflow",
  source: "implementer",
};
const line = (e: object) => JSON.stringify({ timestamp: 1, metadata: meta, ...e });
const custom = (name: string, value: unknown) => line({ type: "CUSTOM", name, value });

describe("parseLine valid", () => {
  const valid: [string, string][] = [
    [
      "RUN_STARTED",
      line({
        type: "RUN_STARTED",
        threadId: "repo#feat",
        runId: "tlc_01J",
        input: { feature: "f" },
      }),
    ],
    [
      "RUN_FINISHED",
      line({
        type: "RUN_FINISHED",
        threadId: "repo#feat",
        runId: "tlc_01J",
        result: { completed: [] },
      }),
    ],
    ["RUN_ERROR", line({ type: "RUN_ERROR", message: "boom" })],
    ["STEP_STARTED", line({ type: "STEP_STARTED", stepName: "T1:implement" })],
    ["STEP_FINISHED", line({ type: "STEP_FINISHED", stepName: "T1:implement" })],
    [
      "tlc.plan",
      custom("tlc.plan", {
        tasks: [{ id: "T1", title: "x", milestone: "M", dependsOn: [], parallel: false }],
        milestones: [{ name: "M", source: "wave", tasks: ["T1"] }],
      }),
    ],
    [
      "tlc.task",
      custom("tlc.task", { id: "T1", status: "done", gate: { pass: true, summary: "ok" } }),
    ],
    ["tlc.blocker", custom("tlc.blocker", { id: "b1", task: "T1", kind: "gate", reason: "r" })],
    ["tlc.blocker_resolved", custom("tlc.blocker_resolved", { id: "b1" })],
    ["tlc.milestone", custom("tlc.milestone", { name: "M" })],
    [
      "tlc.usage",
      custom("tlc.usage", {
        role: "implementer",
        harness: "h",
        model: "m",
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: null,
      }),
    ],
    ["tlc.log", custom("tlc.log", { level: "info", message: "hi" })],
  ];
  test.each(valid)("%s", (_n, l) => {
    const r = parseLine(l);
    expect(r).toMatchObject({ ok: true });
  });
});

describe("parseLine invalid / tolerant", () => {
  test.each([
    ["tlc.task bad status", custom("tlc.task", { id: "T1", status: "weird" })],
    ["tlc.blocker bad kind", custom("tlc.blocker", { id: "b", task: "T", kind: "x", reason: "r" })],
    ["tlc.usage missing field", custom("tlc.usage", { role: "r" })],
    [
      "missing envelope",
      JSON.stringify({ type: "CUSTOM", name: "tlc.log", value: { level: "info", message: "m" } }),
    ],
    ["bad JSON", "{nope"],
    ["empty", "  "],
    ["array", "[]"],
  ])("rejects %s", (_n, l) => {
    const r = parseLine(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  test("unknown type is skipped", () => {
    const r = parseLine(line({ type: "FUTURE_THING" }));
    expect(r).toEqual({ ok: false, reason: "unknown type: FUTURE_THING" });
  });

  test("unknown custom name accepted", () => {
    expect(parseLine(custom("tlc.future", { a: 1 })).ok).toBe(true);
  });

  test("newer v with extra fields accepted and preserved", () => {
    const l = JSON.stringify({
      type: "CUSTOM",
      name: "tlc.task",
      value: { id: "T1", status: "running", newField: 1 },
      extra: true,
      metadata: { ...meta, v: 2, more: "x" },
    });
    const r = parseLine(l);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.metadata.v).toBe(2);
      expect(r.event.extra).toBe(true);
    }
  });
});

describe("role output JSON schemas", () => {
  test("shapes", () => {
    expect(statusOutputJsonSchema).toMatchObject({ type: "object" });
    expect(Object.keys((statusOutputJsonSchema as { properties: object }).properties)).toEqual([
      "status",
      "files",
      "gate",
      "deviations",
      "issues",
    ]);
    expect(reviewerOutputJsonSchema).toMatchObject({ type: "object" });
    expect(advisorOutputJsonSchema).toMatchObject({ type: "object" });
  });
});
