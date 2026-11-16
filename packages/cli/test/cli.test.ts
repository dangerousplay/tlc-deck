import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, readEvents } from "@tlc-deck/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { run } from "../src/main.js";

let root: string;
let repo: string;
let home: string;
const feature = "demo";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-cli-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(join(repo, ".specs", "features", feature), { recursive: true });
  mkdirSync(home);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(
    join(repo, ".specs", "features", feature, "tasks.md"),
    "### T1: First\n\n**Depends on**: none\n\n### T2: Second\n\n**Depends on**: T1\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function tlc(args: string[], env: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const code = await run(args, {
    cwd: repo,
    env: { HOME: home, TLC_URL: "http://127.0.0.1:1", ...env },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    version: "1.2.3",
  });
  return { code, out, err };
}

const file = () => join(repo, ".specs", "features", feature, "progress.ndjson");

test("start, emit custom, status --json equals fold of file", async () => {
  const s = await tlc(["emit", "--start"]);
  expect(s.code).toBe(0);
  const runId = s.out.trim();
  expect(runId).toMatch(/^tlc_[0-9A-Z]{26}$/);

  const task = JSON.stringify({ name: "tlc.task", value: { id: "T1", status: "running" } });
  expect((await tlc(["emit", "CUSTOM", task, "--run", runId])).code).toBe(0);
  const done = JSON.stringify({ name: "tlc.task", value: { id: "T1", status: "done" } });
  expect((await tlc(["emit", "CUSTOM", done, "--run", runId])).code).toBe(0);

  const events = readEvents(file());
  expect(events.map((e) => e.metadata.seq)).toEqual([1, 2, 3]);
  expect(events[0]?.type).toBe("RUN_STARTED");
  expect(events[0]?.metadata.threadId).toBe("repo#demo");

  const st = await tlc(["status", "--json"]);
  expect(st.code).toBe(0);
  const expected = fold(events, { runId });
  expect(JSON.parse(st.out)).toEqual(JSON.parse(JSON.stringify(expected)));
  expect(JSON.parse(st.out).tasks.T1.status).toBe("done");

  const reg = JSON.parse(readFileSync(join(home, ".local/state/tlc-deck/repos.json"), "utf8"));
  expect(reg.repos[0].path).toBe(repo);
});

test("emit exits 0 fast with server down; exit 2 on invalid input", async () => {
  const t0 = performance.now();
  const s = await tlc(["emit", "--start"]);
  expect(s.code).toBe(0);
  expect(performance.now() - t0).toBeLessThan(500);
  const runId = s.out.trim();
  expect((await tlc(["emit", "CUSTOM", "{not json", "--run", runId])).code).toBe(2);
  expect(
    (await tlc(["emit", "CUSTOM", '{"name":"tlc.task","value":{}}', "--run", runId])).code,
  ).toBe(2);
  expect((await tlc(["emit", "CUSTOM", "{}"])).code).toBe(2);
  expect(readEvents(file())).toHaveLength(1);
});

test("plan --json", async () => {
  const r = await tlc(["plan", "--json"]);
  expect(r.code).toBe(0);
  const plan = JSON.parse(r.out);
  expect(plan.tasks.map((t: { id: string }) => t.id)).toEqual(["T1", "T2"]);
});

test("feature auto-detect error lists features", async () => {
  mkdirSync(join(repo, ".specs", "features", "other"), { recursive: true });
  writeFileSync(join(repo, ".specs", "features", "other", "tasks.md"), "### T1: X\n");
  const r = await tlc(["plan"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("demo, other");
});

test("version and unknown command", async () => {
  expect((await tlc(["--version"])).out).toBe("1.2.3\n");
  expect((await tlc(["bogus"])).code).toBe(2);
});

test("tlc run drives the runner with an injected driver", async () => {
  const { FakeDriver } = await import("@tlc-deck/runner");
  const { writeFileSync: wf } = await import("node:fs");
  const driver = new FakeDriver(
    {
      implementer: [
        {
          data: {
            status: "Complete",
            files: ["a.txt"],
            gate: { pass: true, summary: "ok" },
            deviations: [],
            issues: [],
          },
          exitCode: 0,
        },
      ],
      reviewer: [{ data: { verdict: "pass", findings: [] }, exitCode: 0 }],
    },
    "fake",
    (req) => {
      if (req.role === "implementer") wf(join(repo, "a.txt"), "x\n");
    },
  );
  let out = "";
  const code = await run(["run", "--only", "T1", "--no-commit"], {
    cwd: repo,
    env: { HOME: home },
    stdout: (t) => {
      out += t;
    },
    stderr: () => {},
    version: "1",
    driverFactory: () => driver,
  });
  expect(code).toBe(0);
  expect(out).toContain("1 done, 0 failed");
  const state = fold(readEvents(file()));
  expect(state.status).toBe("finished");
  expect(state.tasks.T1?.status).toBe("done");
  expect(state.tasks.T2?.status).toBe("pending");
});
