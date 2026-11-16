import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, readEvents } from "@tlc-deck/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type DriverRequest, FakeDriver, type FakeResponse, runPlan } from "../src/index.js";

let root: string;
let repo: string;
const feature = "demo";

const TASKS = `# Tasks

### T1: First

**Depends on**: none
**Requirement**: A-01

**Done when**:
- [ ] it works

---

### T2: Second [P]

**Depends on**: T1

---

### T3: Third [P]

**Depends on**: T1

---

### T4: Fourth

**Depends on**: T2
`;

const progress = () => join(repo, ".specs", "features", feature, "progress.ndjson");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const taskOf = (req: DriverRequest) => /### (T\d+):/.exec(req.prompt)?.[1] as string;
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-runner-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".specs", "features", feature), { recursive: true });
  writeFileSync(join(repo, ".specs", "features", feature, "tasks.md"), TASKS);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const status = (over: Record<string, unknown> = {}) => ({
  data: {
    status: "Complete",
    files: [],
    gate: { pass: true, summary: "ok" },
    deviations: [],
    issues: [],
    ...over,
  },
  usage,
  exitCode: 0,
});

/** Implementer response that reports the file the fake "wrote" for the task. */
const implOk: FakeResponse = (req) => status({ files: [`${taskOf(req)}.txt`] });
const pass: FakeResponse = { data: { verdict: "pass", findings: [] }, usage, exitCode: 0 };
const advice: FakeResponse = {
  data: { diagnosis: "do X", environmental: false, steps: ["step 1"] },
  usage,
  exitCode: 0,
};

const writer = (req: DriverRequest) => {
  if (req.role === "implementer") writeFileSync(join(repo, `${taskOf(req)}.txt`), "x\n");
};

const state = (runId: string) => fold(readEvents(progress()), { runId });

test("happy path: one commit per task, events fold to finished", async () => {
  mkdirSync(join(repo, ".specs"), { recursive: true });
  writeFileSync(
    join(repo, ".specs", "tlc-execute.json"),
    JSON.stringify({ commitTrailer: "Co-Authored-By: Bot <bot@example.com>" }),
  );
  const driver = new FakeDriver({ implementer: [implOk], reviewer: [pass] }, "fake", writer);
  const res = await runPlan({
    repo,
    feature,
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.code).toBe(0);
  expect(res.completed).toEqual(["T1", "T2", "T3", "T4"]);
  const subjects = git("log", "--format=%s").trim().split("\n");
  expect(subjects.slice(0, 4).sort()).toEqual([
    "feat(demo): First (T1)",
    "feat(demo): Fourth (T4)",
    "feat(demo): Second (T2)",
    "feat(demo): Third (T3)",
  ]);
  expect(git("log", "-1", "--format=%B")).toContain("Co-Authored-By: Bot <bot@example.com>");
  const s = state(res.runId);
  expect(s.status).toBe("finished");
  expect(Object.values(s.tasks).map((t) => t.status)).toEqual(["done", "done", "done", "done"]);
  expect(s.tasks.T1?.commit).toMatch(/^[0-9a-f]+$/);
  expect(s.milestones.every((m) => m.reached)).toBe(true);
  expect(s.usageByRole.implementer?.input).toBe(40);
  expect(s.usageByRole.reviewer?.output).toBe(20);
  expect(s.blockers).toEqual([]);
});

test("reviewer reject -> advise -> fix -> pass", async () => {
  const reject: FakeResponse = {
    data: { verdict: "reject", findings: ["missing test"] },
    exitCode: 0,
  };
  const driver = new FakeDriver(
    { implementer: [implOk], reviewer: [reject, pass], advisor: [advice] },
    "fake",
    writer,
  );
  const res = await runPlan({
    repo,
    feature,
    only: ["T1"],
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.code).toBe(0);
  expect(driver.calls.map((c) => c.role)).toEqual([
    "implementer",
    "reviewer",
    "advisor",
    "implementer",
    "reviewer",
  ]);
  expect(driver.calls[3]?.prompt).toContain("missing test");
  expect(driver.calls[3]?.prompt).toContain("do X");
  const evs = readEvents(progress());
  const steps = evs.filter((e) => e.type === "STEP_STARTED").map((e) => e.stepName);
  expect(steps).toEqual([
    "T1:implement",
    "T1:verify",
    "T1:advise",
    "T1:fix",
    "T1:verify",
    "T1:commit",
  ]);
  const s = state(res.runId);
  expect(s.blockers).toHaveLength(1);
  expect(s.blockers[0]).toMatchObject({
    kind: "rejected",
    advice: expect.stringContaining("do X"),
    open: false,
  });
  expect(s.tasks.T1?.status).toBe("done");
  expect(s.tasks.T2?.status).toBe("pending");
});

test("Blocked implementer -> advised retry", async () => {
  const blocked = status({ status: "Blocked", issues: ["no db"] });
  const driver = new FakeDriver(
    { implementer: [blocked, implOk], reviewer: [pass], advisor: [advice] },
    "fake",
    writer,
  );
  const res = await runPlan({
    repo,
    feature,
    only: ["T1"],
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.code).toBe(0);
  expect(driver.calls.map((c) => c.role)).toEqual([
    "implementer",
    "advisor",
    "implementer",
    "reviewer",
  ]);
  expect(driver.calls[2]?.prompt).toContain("do X");
  expect(git("log", "-1", "--format=%s")).toBe("feat(demo): First (T1)\n");
});

test("still Blocked after advice fails the task", async () => {
  const blocked = status({ status: "Blocked", issues: ["no db"] });
  const driver = new FakeDriver({ implementer: [blocked], advisor: [advice] }, "fake", writer);
  const res = await runPlan({
    repo,
    feature,
    only: ["T1"],
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.failed).toEqual(["T1"]);
  expect(res.code).toBe(1);
  expect(state(res.runId).status).toBe("failed");
});

test("failure blocks dependents only; independents continue; error blocker", async () => {
  const driver = new FakeDriver(
    {
      implementer: [
        (req) =>
          taskOf(req) === "T2"
            ? new Error("harness missing")
            : status({ files: [`${taskOf(req)}.txt`] }),
      ],
      reviewer: [pass],
    },
    "fake",
    writer,
  );
  const res = await runPlan({ repo, feature, env: { HOME: root }, driverFactory: () => driver });
  expect(res.code).toBe(1);
  expect(res.completed).toEqual(["T1", "T3"]);
  expect(res.failed).toEqual(["T2"]);
  expect(res.notStarted).toEqual(["T4"]);
  const s = state(res.runId);
  expect(s.tasks.T4?.status).toBe("skipped");
  expect(s.blockers).toHaveLength(1);
  expect(s.blockers[0]).toMatchObject({ task: "T2", kind: "error", open: true });
  expect(s.status).toBe("failed");
});

test("invalid driver output and non-zero exit give error blockers", async () => {
  const driver = new FakeDriver(
    { implementer: [{ data: { nope: 1 }, exitCode: 0 }] },
    "fake",
    writer,
  );
  const res = await runPlan({
    repo,
    feature,
    only: ["T1"],
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.failed).toEqual(["T1"]);
  const d2 = new FakeDriver({ implementer: [{ exitCode: 3 }] }, "fake", writer);
  const r2 = await runPlan({
    repo,
    feature,
    only: ["T1"],
    env: { HOME: root },
    driverFactory: () => d2,
  });
  expect(state(r2.runId).blockers[0]?.reason).toContain("code 3");
});

test("retries exhausted fails the task", async () => {
  const reject: FakeResponse = { data: { verdict: "reject", findings: ["bad"] }, exitCode: 0 };
  const driver = new FakeDriver(
    { implementer: [implOk], reviewer: [reject], advisor: [advice] },
    "fake",
    writer,
  );
  const res = await runPlan({
    repo,
    feature,
    only: ["T1"],
    retries: 1,
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.failed).toEqual(["T1"]);
  expect(driver.calls.filter((c) => c.role === "implementer")).toHaveLength(2);
  expect(existsSync(join(repo, "T1.txt"))).toBe(true);
  expect(git("log", "--format=%s").trim().split("\n")).toEqual(["init"]);
});

test("--no-commit leaves the tree dirty", async () => {
  const driver = new FakeDriver({ implementer: [implOk], reviewer: [pass] }, "fake", writer);
  const res = await runPlan({
    repo,
    feature,
    only: ["T1"],
    noCommit: true,
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(res.code).toBe(0);
  expect(git("log", "--format=%s").trim()).toBe("init");
  expect(state(res.runId).tasks.T1?.commit).toBeUndefined();
});

test("resume skips Done tasks of the newest run", async () => {
  const first = new FakeDriver(
    {
      implementer: [
        (req) =>
          taskOf(req) === "T2" ? new Error("boom") : status({ files: [`${taskOf(req)}.txt`] }),
      ],
      reviewer: [pass],
    },
    "fake",
    writer,
  );
  const r1 = await runPlan({ repo, feature, env: { HOME: root }, driverFactory: () => first });
  expect(r1.failed).toEqual(["T2"]);

  const second = new FakeDriver({ implementer: [implOk], reviewer: [pass] }, "fake", writer);
  const r2 = await runPlan({
    repo,
    feature,
    resume: true,
    env: { HOME: root },
    driverFactory: () => second,
  });
  expect(r2.code).toBe(0);
  const ran = second.calls.filter((c) => c.role === "implementer").map(taskOf);
  expect(ran).toEqual(["T2", "T4"]);
  expect(r2.completed).toEqual(["T1", "T2", "T3", "T4"]);
  expect(state(r2.runId).status).toBe("finished");
});

test("tasks.md Status: Done is honoured", async () => {
  const file = join(repo, ".specs", "features", feature, "tasks.md");
  writeFileSync(file, TASKS.replace("### T1: First\n", "### T1: First\n\n**Status**: Done\n"));
  const driver = new FakeDriver({ implementer: [implOk], reviewer: [pass] }, "fake", writer);
  const res = await runPlan({ repo, feature, env: { HOME: root }, driverFactory: () => driver });
  expect(driver.calls.filter((c) => c.role === "implementer").map(taskOf)).not.toContain("T1");
  expect(res.completed).toContain("T1");
});

test("[P] tasks respect the concurrency cap", async () => {
  let active = 0;
  let peak = 0;
  const driver = new FakeDriver(
    { implementer: [implOk], reviewer: [pass] },
    "fake",
    async (req) => {
      writer(req);
      if (req.role !== "implementer") return;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    },
  );
  await runPlan({
    repo,
    feature,
    concurrency: 2,
    env: { HOME: root },
    driverFactory: () => driver,
  });
  expect(peak).toBe(2);
});

test("SIGINT emits RUN_ERROR interrupted and stops", async () => {
  const ac = new AbortController();
  const driver = new FakeDriver({ implementer: [implOk], reviewer: [pass] }, "fake", (req) => {
    writer(req);
    if (taskOf(req) === "T1") ac.abort();
  });
  const res = await runPlan({
    repo,
    feature,
    env: { HOME: root },
    driverFactory: () => driver,
    signal: ac.signal,
  });
  expect(res.interrupted).toBe(true);
  expect(res.code).toBe(130);
  const evs = readEvents(progress());
  expect(evs.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "interrupted" });
  expect(state(res.runId).status).toBe("interrupted");
  expect(driver.calls.map((c) => c.role)).toEqual(["implementer"]);
});
