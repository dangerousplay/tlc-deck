import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, readEvents } from "@tlc-deck/core";
import { type DriverRequest, FakeDriver } from "@tlc-deck/runner";
import { afterEach, beforeEach, expect, test } from "vitest";
import { run } from "../src/main.js";

const HOOKS = join(__dirname, "..", "..", "..", "fixtures", "hooks");
const feature = "demo";
const TASKS = `# Tasks

### T1: First

**Depends on**: none

---

### T2: Second

**Depends on**: T1
`;

let root: string;
let repo: string;
let home: string;
let ac: AbortController;
let serving: Promise<number> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-e2e-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(join(repo, ".specs", "features", feature), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, ".specs", "features", feature, "tasks.md"), TASKS);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  ac = new AbortController();
});
afterEach(async () => {
  ac.abort();
  await serving;
  rmSync(root, { recursive: true, force: true });
});

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

test("serve + run: SSE sees the whole run, status matches, hooks link a session", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { HOME: home, TLC_STATE_DIR: join(root, "state"), TLC_URL: url };
  const progress = join(repo, ".specs", "features", feature, "progress.ndjson");
  writeFileSync(progress, ""); // so the server tails it from the start

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

  const sse = await fetch(`${url}/api/stream`);
  const reader = sse.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const dec = new TextDecoder();
  let sseText = "";
  const pump = (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) return;
      sseText += dec.decode(r.value);
    }
  })();

  const hooks = readdirSync(HOOKS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(HOOKS, f), "utf8").replaceAll("__CWD__", repo)));
  let linked: string | undefined;
  const taskOf = (req: DriverRequest) => /### (T\d+):/.exec(req.prompt)?.[1] as string;
  const status = {
    status: "Complete",
    files: [],
    gate: { pass: true, summary: "ok" },
    deviations: [],
    issues: [],
  };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };
  const driver = new FakeDriver(
    {
      implementer: [{ data: status, usage, exitCode: 0 }],
      reviewer: [{ data: { verdict: "pass", findings: [] }, usage, exitCode: 0 }],
    },
    "claude",
    async (req) => {
      if (req.role !== "implementer") return;
      writeFileSync(join(repo, `${taskOf(req)}.txt`), "x\n");
      if (taskOf(req) !== "T1") return;
      await fetch(`${url}/hooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hooks[0]),
      });
      // the run must be visible to the server (tailed) while still running
      linked = await until(async () => {
        const list = (await (await fetch(`${url}/api/sessions`)).json()) as {
          linkedRun?: string;
        }[];
        return list[0]?.linkedRun;
      });
    },
  );

  let out = "";
  const code = await run(["run", "--mode", "crew", "--no-commit"], {
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
  expect(out).toContain("2 done, 0 failed");

  const events = readEvents(progress);
  const runId = events[0]?.metadata.runId as string;
  expect(linked).toBe(runId);

  await until(() => (sseText.includes("RUN_FINISHED") ? true : undefined));
  const types = [...sseText.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
  expect(types.indexOf("RUN_STARTED")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("RUN_STARTED")).toBeLessThan(types.lastIndexOf("RUN_FINISHED"));
  expect(types).toContain("STEP_STARTED");
  await reader.cancel();
  await pump;

  let st = "";
  const sc = await run(["status", "--json"], {
    cwd: repo,
    env,
    stdout: (t) => {
      st += t;
    },
    stderr: () => {},
    version: "1",
  });
  expect(sc).toBe(0);
  const parsed = JSON.parse(st);
  expect(parsed).toEqual(JSON.parse(JSON.stringify(fold(events, { runId }))));
  expect(parsed.status).toBe("finished");
  expect(
    Object.values(parsed.tasks).every((t) => (t as { status: string }).status === "done"),
  ).toBe(true);

  // server-side view agrees
  const api = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as { status: string };
  expect(api.status).toBe("finished");
}, 30000);
