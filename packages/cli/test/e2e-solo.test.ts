import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "@tlc-deck/core";
import type { AgentInfo } from "@tlc-deck/protocol";
import { type DriverRequest, type DriverResult, FakeDriver } from "@tlc-deck/runner";
import { afterEach, beforeEach, expect, test } from "vitest";
import { run } from "../src/main.js";

const feature = "demo";
const task = (id: string, dep: string) =>
  `### ${id}: Task ${id}\n\n**Where**: \`${id}.txt\`\n**Depends on**: ${dep}\n**Gate**: \`test -f ${id}.txt\`\n\n---\n\n`;
const TASKS = `# Tasks\n\n${task("T1", "none")}${task("T2", "T1")}${task("T3", "T2")}`;

let root: string;
let repo: string;
let ac: AbortController;
let serving: Promise<number> | undefined;
let url: string;
let env: Record<string, string>;

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

const until = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tlc-e2e-solo-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".specs", "features", feature), { recursive: true });
  writeFileSync(join(repo, ".specs", "features", feature, "tasks.md"), TASKS);
  writeFileSync(join(repo, ".specs", "features", feature, "progress.ndjson"), "");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  ac = new AbortController();
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  env = { HOME: join(root, "home"), TLC_STATE_DIR: join(root, "state"), TLC_URL: url };
  let serveOut = "";
  serving = run(["serve", "--port", String(port), "--repo", repo], {
    cwd: repo,
    env,
    stdout: (t) => {
      serveOut += t;
    },
    stderr: () => {},
    version: "1",
    signal: ac.signal,
  });
  await until(() => (serveOut.includes("listening") ? true : undefined));
});
afterEach(async () => {
  ac.abort();
  await serving;
  rmSync(root, { recursive: true, force: true });
});

const getJson = async <T>(path: string) => (await (await fetch(`${url}${path}`)).json()) as T;

test("solo run: one worker agent spans tasks, gate/review steps and commits reach the API", async () => {
  let n = 0;
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };
  const worker = (req: DriverRequest): DriverResult => {
    const id = /### (T\d+):/.exec(req.prompt)?.[1] as string;
    writeFileSync(join(repo, `${id}.txt`), "x\n");
    return {
      data: {
        status: "Complete",
        files: [`${id}.txt`],
        gate: { pass: true, summary: "ok" },
        deviations: [],
        issues: [],
      },
      usage,
      sessionId: req.resumeSessionId ?? `s${++n}`,
      exitCode: 0,
    };
  };
  const driver = new FakeDriver({
    implementer: [worker],
    reviewer: [{ data: { verdict: "pass", findings: [] }, usage, exitCode: 0 }],
  });
  let out = "";
  const code = await run(["run", "--no-daemon"], {
    cwd: repo,
    env,
    stdout: (t) => {
      out += t;
    },
    stderr: () => {},
    version: "1",
    driverFactory: () => driver,
  });
  expect(code).toBe(0);
  expect(out).toContain("3 done, 0 failed");
  const impl = driver.calls.filter((c) => c.role === "implementer");
  expect(impl.map((c) => c.resumeSessionId)).toEqual([undefined, "s1", "s1"]);

  const progress = join(repo, ".specs", "features", feature, "progress.ndjson");
  const runId = readEvents(progress)[0]?.metadata.runId as string;
  const workers = await until(async () => {
    const list = await getJson<AgentInfo[]>(`/api/agents?run=${runId}`);
    const w = list.filter((a) => a.role === "worker");
    return w.length && w.every((a) => a.status === "done") ? w : undefined;
  });
  expect(workers).toHaveLength(1);
  expect(workers[0]?.tasks).toEqual(["T1", "T2", "T3"]);

  const steps = readEvents(progress)
    .filter((e) => e.type === "STEP_STARTED")
    .map((e) => (e as unknown as { stepName: string }).stepName);
  expect(steps).toEqual(expect.arrayContaining(["T1:gate", "T1:verify", "T3:gate", "T3:verify"]));
  const log = execFileSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" });
  expect(log.trim().split("\n")).toHaveLength(4);
}, 30000);
