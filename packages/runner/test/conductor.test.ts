import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, readEvents } from "@tlc-deck/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type DriverRequest,
  type DriverResult,
  FakeDriver,
  type FakeResponse,
  runPlan,
} from "../src/index.js";

let root: string;
let repo: string;
const feature = "demo";
const fixtures = join(import.meta.dirname, "../../../fixtures");

const task = (id: string, dep: string, extra = "") =>
  `### ${id}: Task ${id}\n\n**Where**: \`${id}.txt\`\n**Depends on**: ${dep}\n**Gate**: \`test -f ${id}.txt\`\n${extra}\n---\n\n`;
const TASKS = `# Tasks\n\n${task("T1", "none")}${task("T2", "T1")}${task("T3", "T2")}`;

const dir = () => join(repo, ".specs", "features", feature);
const progress = () => join(dir(), "progress.ndjson");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const usage = (input = 10) => ({ input, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 });

function setup(tasksMd: string, config?: Record<string, unknown>) {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), "tasks.md"), tasksMd);
  if (config) writeFileSync(join(repo, ".specs", "tlc-execute.json"), JSON.stringify(config));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-solo-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const status = (files: string[], over: Record<string, unknown> = {}) => ({
  status: "Complete",
  files,
  gate: { pass: true, summary: "ok" },
  deviations: [],
  issues: [],
  ...over,
});

/** Scripted solo worker: tracks the current task and the session it was given. */
function worker(
  opts: { input?: number; onFix?: (id: string) => void; skipWrite?: Set<string> } = {},
) {
  let current = "";
  let n = 0;
  const sessions = new Map<string, string>();
  const resp: FakeResponse = (req: DriverRequest): DriverResult => {
    const m = /### (T\d+):/.exec(req.prompt);
    if (m) current = m[1] as string;
    const isFix = req.prompt.includes("## Findings");
    if (isFix) opts.onFix?.(current);
    else if (!opts.skipWrite?.has(current)) writeFileSync(join(repo, `${current}.txt`), "x\n");
    const sessionId = req.resumeSessionId ?? `s${++n}`;
    sessions.set(sessionId, current);
    return {
      data: status([`${current}.txt`]),
      usage: usage(opts.input),
      sessionId,
      exitCode: 0,
    };
  };
  return resp;
}

const pass: FakeResponse = {
  data: { verdict: "pass", findings: [] },
  usage: usage(),
  exitCode: 0,
};

const agentEvents = (name = "tlc.agent") =>
  readEvents(progress())
    .filter((e) => e.type === "CUSTOM" && (e as { name?: string }).name === name)
    .map((e) => (e as unknown as { value: Record<string, unknown> }).value);

const run = (driver: FakeDriver, extra: Record<string, unknown> = {}) =>
  runPlan({ repo, feature, env: { HOME: root }, driverFactory: () => driver, ...extra });

test("solo is the default: one worker session across 3 tasks, commits with trailer", async () => {
  setup(TASKS, { commitTrailer: "Co-Authored-By: Bot <bot@example.com>" });
  const driver = new FakeDriver({ implementer: [worker()], reviewer: [pass] });
  const res = await run(driver);
  expect(res.code).toBe(0);
  expect(res.completed).toEqual(["T1", "T2", "T3"]);
  const impl = driver.calls.filter((c) => c.role === "implementer");
  expect(impl).toHaveLength(3);
  expect(impl[0]?.resumeSessionId).toBeUndefined();
  expect(impl[1]?.resumeSessionId).toBe("s1");
  expect(impl[2]?.resumeSessionId).toBe("s1");
  expect(impl[0]?.prompt).toContain(".specs/features/demo/tasks.md");
  expect(impl[1]?.prompt).not.toContain("## Rules");
  const workers = agentEvents().filter((v) => v.role === "worker" && v.status === "running");
  expect(workers).toHaveLength(1);
  expect(agentEvents().some((v) => Array.isArray(v.tasks) && v.tasks.length === 3)).toBe(true);
  expect(git("log", "--format=%s").trim().split("\n").slice(0, 3)).toEqual([
    "feat(t3): Task T3 (T3)",
    "feat(t2): Task T2 (T2)",
    "feat(t1): Task T1 (T1)",
  ]);
  expect(git("log", "-1", "--format=%B")).toContain("Co-Authored-By: Bot <bot@example.com>");
  const s = fold(readEvents(progress()), { runId: res.runId });
  expect(s.status).toBe("finished");
  expect(s.tasks.T1?.commit).toMatch(/^[0-9a-f]+$/);
  const stages = readEvents(progress())
    .filter((e) => e.type === "STEP_STARTED")
    .map((e) => (e as unknown as { stepName: string }).stepName);
  expect(stages).toContain("T1:gate");
  expect(stages).toContain("T1:commit");
});

test("gate failure sends the output to the same session as a fix turn", async () => {
  setup(TASKS.replace(/\*\*Gate\*\*: `test -f T1.txt`/, "**Gate**: `test -f T1.ok`"));
  const driver = new FakeDriver({
    implementer: [worker({ onFix: () => writeFileSync(join(repo, "T1.ok"), "") })],
    reviewer: [pass],
  });
  const res = await run(driver, { only: ["T1"] });
  expect(res.code).toBe(0);
  const impl = driver.calls.filter((c) => c.role === "implementer");
  expect(impl).toHaveLength(2);
  expect(impl[1]?.resumeSessionId).toBe("s1");
  expect(impl[1]?.prompt).toContain("test -f T1.ok");
  expect(impl[1]?.prompt).toContain("## Findings");
});

test("review rejection becomes a fix turn, then gate and review again", async () => {
  setup(TASKS);
  const reject: FakeResponse = {
    data: { verdict: "reject", findings: ["missing test"] },
    exitCode: 0,
  };
  const driver = new FakeDriver({ implementer: [worker()], reviewer: [reject, pass] });
  const res = await run(driver, { only: ["T1"] });
  expect(res.code).toBe(0);
  expect(driver.calls.map((c) => c.role)).toEqual([
    "implementer",
    "reviewer",
    "implementer",
    "reviewer",
  ]);
  expect(driver.calls[2]?.prompt).toContain("missing test");
  expect(driver.calls[2]?.resumeSessionId).toBe("s1");
  expect(driver.calls[1]?.prompt).toContain("new file: T1.txt");
});

test("rotation when the last turn exceeds rotateAfterTokens, with a handoff", async () => {
  setup(TASKS);
  const driver = new FakeDriver({ implementer: [worker({ input: 200 })], reviewer: [pass] });
  const res = await run(driver, { rotateAfterTokens: 150 });
  expect(res.code).toBe(0);
  const impl = driver.calls.filter((c) => c.role === "implementer");
  expect(impl.every((c) => c.resumeSessionId === undefined)).toBe(true);
  expect(impl[1]?.prompt).toContain("Handoff");
  expect(impl[1]?.prompt).toContain("T1: Task T1");
  expect(impl[2]?.prompt).toContain("T2: Task T2");
  expect(agentEvents().filter((v) => v.role === "worker" && v.status === "running")).toHaveLength(
    3,
  );
});

test("rotation on every turn when the harness cannot resume", async () => {
  setup(TASKS);
  const driver = new FakeDriver({ implementer: [worker()], reviewer: [pass] });
  driver.resume = "none";
  const res = await run(driver);
  expect(res.code).toBe(0);
  const impl = driver.calls.filter((c) => c.role === "implementer");
  expect(impl.every((c) => c.resumeSessionId === undefined)).toBe(true);
  expect(impl[1]?.prompt).toContain("Handoff");
});

test("dependents of a failed task are skipped, independent ones still run", async () => {
  const md = `# Tasks\n\n${task("T1", "none")}${task("T2", "T1")}${task("T3", "none")}`;
  setup(md);
  const driver = new FakeDriver({
    implementer: [worker({ skipWrite: new Set(["T1"]) })],
    reviewer: [pass],
  });
  const res = await run(driver, { retries: 0 });
  expect(res.code).toBe(1);
  expect(res.failed).toEqual(["T1"]);
  expect(res.notStarted).toEqual(["T2"]);
  expect(res.completed).toEqual(["T3"]);
  expect(existsSync(join(repo, "T2.txt"))).toBe(false);
});

test("crew mode stays available via mode option and config", async () => {
  setup(TASKS, { mode: "crew" });
  const impl: FakeResponse = (req) => {
    const id = /### (T\d+):/.exec(req.prompt)?.[1] as string;
    writeFileSync(join(repo, `${id}.txt`), "x\n");
    return { data: status([`${id}.txt`]), usage: usage(), exitCode: 0 };
  };
  const driver = new FakeDriver({ implementer: [impl], reviewer: [pass] });
  const res = await run(driver, { only: ["T1"] });
  expect(res.code).toBe(0);
  expect(driver.calls.every((c) => c.resumeSessionId === undefined)).toBe(true);
  expect(driver.calls[0]?.prompt).toContain("exactly one task");
});

test("solo uses at most 50% of the input tokens of crew on the memo fixture plan", async () => {
  const memo = readFileSync(join(fixtures, "plans/memo-harness-integration/tasks.md"), "utf8");
  // Make every gate trivially pass and let tasks write their own file.
  const tasksMd = memo
    .split("\n")
    .map((l) => (l.trim().startsWith("|") ? l.replace(/`[^`]*`/g, "`true`") : l))
    .join("\n")
    .replace(/^\*\*Gate\*\*.*$/gm, "");
  const refSize =
    tasksMd.length +
    readFileSync(join(fixtures, "plans/memo-harness-integration/spec.md"), "utf8").length;

  /** Fake token model: a fresh session pays for the prompt plus reading the referenced files. */
  const measure = async (mode: "solo" | "crew") => {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    setup(tasksMd);
    writeFileSync(
      join(dir(), "spec.md"),
      readFileSync(join(fixtures, "plans/memo-harness-integration/spec.md"), "utf8"),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    let current = "";
    let n = 0;
    const cost = (req: DriverRequest) =>
      req.prompt.length +
      (!req.resumeSessionId && req.prompt.includes(".specs/features/") ? refSize : 0);
    const impl: FakeResponse = (req) => {
      const m = /### (T\d+):/.exec(req.prompt);
      if (m) current = m[1] as string;
      writeFileSync(join(repo, `${current}.txt`), "x\n");
      return {
        data: status([`${current}.txt`]),
        usage: { ...usage(cost(req)) },
        sessionId: req.resumeSessionId ?? `s${++n}`,
        exitCode: 0,
      };
    };
    const rev: FakeResponse = (req) => ({
      data: { verdict: "pass", findings: [] },
      usage: usage(cost(req)),
      exitCode: 0,
    });
    const driver = new FakeDriver({ implementer: [impl], reviewer: [rev], advisor: [rev] });
    const res = await run(driver, { mode });
    expect(res.failed).toEqual([]);
    return driver.calls.reduce((sum, c, i) => sum + (driver.calls[i] ? cost(c) : 0), 0);
  };
  const crew = await measure("crew");
  const solo = await measure("solo");
  expect(solo).toBeLessThanOrEqual(crew * 0.5);
});
