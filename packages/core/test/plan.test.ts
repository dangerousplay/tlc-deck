import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { PlanError, parsePlan, parseTaskDetails } from "../src/plan.js";

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

test("parseTaskDetails: memo fixture golden, requirement text from spec", async () => {
  const details = parseTaskDetails(
    read("memo-harness-integration/tasks.md"),
    read("memo-harness-integration/spec.md"),
  );
  expect(Object.keys(details)).toHaveLength(15);
  const t3 = details.T3;
  expect(t3?.title).toBe("Login, credentials, token");
  expect(t3?.dependsOn).toEqual(["T2"]);
  expect(t3?.gate).toBe("full");
  expect(t3?.tests).toBe("integration");
  expect(t3?.doneWhen).toHaveLength(3);
  expect(t3?.doneWhen.every((d) => d.checked)).toBe(true);
  expect(t3?.requirements.map((r) => r.id)).toEqual([
    "CLI-01",
    "CLI-02",
    "CLI-03",
    "CLI-05",
    "DD-02",
    "DD-08",
  ]);
  expect(t3?.requirements[0]?.text).toMatch(/^WHEN `memo login` runs/);
  expect(t3?.requirements[4]?.text).toBe("");
  await expect(`${JSON.stringify(details, null, 2)}\n`).toMatchFileSnapshot(
    join(dir, "memo-harness-integration/expected-details.json"),
  );
});

test("parseTaskDetails: positional requirement ids map to numbered criteria", () => {
  const spec = [
    "### P1: Story",
    "",
    "**Acceptance Criteria**:",
    "",
    "1. WHEN a THEN b.",
    "2. WHEN c THEN d.",
    "",
    "**Requirement IDs**: AL-01..02",
  ].join("\n");
  const tasks = "### T1: One\n\n**Requirement**: AL-02\n";
  expect(parseTaskDetails(tasks, spec).T1?.requirements).toEqual([
    { id: "AL-02", text: "WHEN c THEN d." },
  ]);
});
