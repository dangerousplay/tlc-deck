import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const SCRIPT = join(
  __dirname,
  "..",
  "..",
  "..",
  "integrations",
  "claude-code",
  "workflow",
  "tlc-execute.js",
);
const source = readFileSync(SCRIPT, "utf8");
// Workflow scripts use top-level await/return and `export const meta`; wrap like the runtime does.
const body = source.replace("export const meta", "const meta");

type Call = { prompt: string; opts: Record<string, unknown> };

async function stubRun(args: Record<string, unknown>, withTlc = true) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  let verifyCount = 0;
  const tasks = [
    { id: "T1", title: "One", depends_on: [], parallel: false, done: false },
    { id: "T2", title: "Two", depends_on: ["T1"], parallel: false, done: false },
    { id: "T3", title: "Three", depends_on: ["T2"], parallel: false, done: false },
  ];
  const agent = async (prompt: string, opts: Record<string, unknown> = {}) => {
    calls.push({ prompt, opts });
    const label = String(opts.label ?? "");
    if (label === "parse tasks.md")
      return { tasks, project_config: "", user_config: "", run_id: withTlc ? "tlc_RUN1" : "" };
    if (label.startsWith("impl") || label.startsWith("fix"))
      return {
        status: "Complete",
        files_changed: [`${label}.ts`],
        gate: "pass",
        spec_deviations: [],
        issues: [],
      };
    if (label.startsWith("verify")) {
      verifyCount++;
      // second verification (T2 first attempt) is rejected, then fixed
      return verifyCount === 2 ? { pass: false, problems: ["bad"] } : { pass: true, problems: [] };
    }
    if (label.startsWith("advise")) return { diagnosis: "d", environmental: false, steps: ["s"] };
    return "ok";
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", body);
  const result = await fn(
    args,
    agent,
    (fs: Array<() => Promise<unknown>>) => Promise.all(fs.map((f) => f())),
    async (...s: Array<(x: unknown) => unknown>) => s,
    (p: string) => phases.push(p),
    (m: string) => logs.push(m),
  );
  return { calls, result, logs, phases };
}

test("script has valid syntax and no clock, random, fs or env use", () => {
  const dir = mkdtempSync(join(tmpdir(), "tlc-wf-"));
  try {
    const copy = join(dir, "wf.mjs");
    writeFileSync(
      copy,
      `export default async function (args, agent, parallel, pipeline, phase, log) {\n${body}\n}\n`,
    );
    execFileSync(process.execPath, ["--check", copy]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const bad of ["Date.now", "Math.random", "process.env", "require(", "node:fs", "import "]) {
    expect(source.includes(bad), bad).toBe(false);
  }
});

test("stub run of a 3-task plan with one rejection emits the expected commands", async () => {
  const { calls, result } = await stubRun({ feature: "demo", repo: "/r" });
  expect(Object.keys(result as object)).toEqual([
    "tasks_path",
    "roles",
    "completed",
    "failed",
    "not_started",
    "spec_deviations",
    "gates",
  ]);
  const r = result as { completed: string[]; failed: unknown[]; not_started: string[] };
  expect(r.completed).toEqual(["T1", "T2", "T3"]);
  expect(r.failed).toEqual([]);
  expect(r.not_started).toEqual([]);

  const prompt = (label: string) => calls.find((c) => c.opts.label === label)?.prompt ?? "";
  const common = "--run tlc_RUN1 --feature demo --harness claude-code --driver workflow";
  const load = prompt("parse tasks.md");
  expect(load).toContain("tlc plan --feature demo --json");
  expect(load).toContain("tlc emit --start");
  expect(load).toContain("--name tlc.plan");
  expect(load).toContain("CLAUDE_");

  const impl = prompt("impl T1");
  expect(impl).toContain(
    `tlc emit STEP_STARTED '{"stepName":"T1:implement"}' ${common} --source implementer`,
  );
  expect(impl).toContain(`tlc emit STEP_FINISHED '{"stepName":"T1:implement"}'`);
  expect(impl).toContain("--name tlc.task");
  expect(impl).toContain('"kind":"<blocked|partial>"');

  expect(prompt("verify T2")).toContain(`STEP_STARTED '{"stepName":"T2:verify"}'`);
  const rejected = calls.filter(
    (c) => c.opts.label === "verify T2" || c.opts.label === "verify T2 #2",
  );
  expect(rejected).toHaveLength(2);
  expect(rejected[0]?.prompt).toContain('"kind":"rejected"');
  expect(prompt("advise T2")).toContain(`STEP_STARTED '{"stepName":"T2:advise"}'`);
  expect(prompt("fix T2")).toContain(`STEP_STARTED '{"stepName":"T2:fix"}'`);

  const commit = prompt("commit T1");
  expect(commit).toContain('"status":"done"');
  expect(commit).toContain("<commit sha>");
  expect(commit).toContain(`STEP_FINISHED '{"stepName":"T1:commit"}'`);

  const fin = prompt("finish run");
  expect(fin).toContain("tlc emit RUN_FINISHED");
  expect(fin).toContain('"completed":["T1","T2","T3"]');
  // repo prefix preserved
  expect(impl.startsWith("Repository: /r.")).toBe(true);
});

test("without tlc the prompts carry no emit instructions", async () => {
  const { calls, result } = await stubRun({ feature: "demo" }, false);
  expect((result as { completed: string[] }).completed).toEqual(["T1", "T2", "T3"]);
  const stage = calls.filter((c) => /^(impl|verify|advise|fix|commit)/.test(String(c.opts.label)));
  for (const c of stage) expect(c.prompt).not.toContain("tlc emit");
  expect(calls.some((c) => c.opts.label === "finish run")).toBe(false);
});
