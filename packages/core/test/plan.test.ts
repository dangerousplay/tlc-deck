import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { PlanError, parsePlan } from "../src/plan.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/plans");
const read = (p: string) => readFileSync(join(dir, p), "utf8");

test("memo harness-integration plan: 15 tasks, priority milestones", async () => {
  const plan = parsePlan(
    read("memo-harness-integration/tasks.md"),
    read("memo-harness-integration/spec.md"),
  );
  expect(plan.tasks).toHaveLength(15);
  await expect(`${JSON.stringify(plan, null, 2)}\n`).toMatchFileSnapshot(
    join(dir, "memo-harness-integration/expected.json"),
  );
  expect(plan.tasks.every((t) => t.done)).toBe(true);
  expect(plan.milestones.map((m) => m.source)).toContain("priority");
  expect(plan.tasks.find((t) => t.id === "T11")?.dependsOn).toEqual(["T10"]);
});

test("explicit Milestone fields win; done flags from status and boxes", async () => {
  const plan = parsePlan(read("fields/tasks.md"));
  await expect(`${JSON.stringify(plan, null, 2)}\n`).toMatchFileSnapshot(
    join(dir, "fields/expected.json"),
  );
  expect(plan.tasks.map((t) => t.done)).toEqual([true, true, false]);
  expect(plan.tasks.map((t) => t.parallel)).toEqual([false, true, true]);
});

test("no milestone info falls back to waves", async () => {
  const plan = parsePlan(read("waves/tasks.md"));
  await expect(`${JSON.stringify(plan, null, 2)}\n`).toMatchFileSnapshot(
    join(dir, "waves/expected.json"),
  );
  expect(plan.milestones.map((m) => [m.name, m.source, m.tasks])).toEqual([
    ["Wave 1", "wave", ["T1"]],
    ["Wave 2", "wave", ["T2", "T3"]],
    ["Wave 3", "wave", ["T4"]],
  ]);
});

test("cycle names the tasks", () => {
  const md = "### T1: a\n**Depends on**: T2\n\n### T2: b\n**Depends on**: T1\n\n### T3: c\n";
  try {
    parsePlan(md);
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanError);
    expect((e as PlanError).tasks).toEqual(["T1", "T2"]);
    expect((e as Error).message).toMatch(/T1, T2/);
  }
});

test("missing dependency is an error", () => {
  expect(() => parsePlan("### T1: a\n**Depends on**: T9\n")).toThrow(/missing task T9/);
});
