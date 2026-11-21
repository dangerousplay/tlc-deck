import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, readEvents } from "@tlc-deck/core";
import { FakeDriver } from "@tlc-deck/runner";
import { afterEach, beforeEach, expect, test } from "vitest";
import { run } from "../src/main.js";

const feature = "demo";
const TASKS = `# Tasks

### T1: First

**Where**: \`packages/a/one.txt\`
**Depends on**: none
**Gate**: \`test -f ok.txt\`

---

### T2: Second

**Where**: \`packages/a/two.txt\`
**Depends on**: T1
`;

let root: string;
let repo: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlc-helpers-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(join(repo, ".specs", "features", feature), { recursive: true });
  mkdirSync(join(repo, "packages", "a"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, ".specs", "features", feature, "tasks.md"), TASKS);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function tlc(args: string[], driver?: FakeDriver) {
  let out = "";
  let err = "";
  const code = await run(args, {
    cwd: repo,
    env: { HOME: home, TLC_STATE_DIR: join(root, "state"), TLC_URL: "off" },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    version: "0",
    ...(driver ? { driverFactory: () => driver } : {}),
  });
  return { code, out, err };
}

test("next -> gate -> review -> commit -> next -> done", async () => {
  const n1 = await tlc(["next", "--json"]);
  expect(n1.code).toBe(0);
  const j1 = JSON.parse(n1.out);
  expect(j1.task.id).toBe("T1");
  expect(j1.block).toContain("### T1: First");

  writeFileSync(join(repo, "packages", "a", "one.txt"), "one\n");
  const g1 = await tlc(["gate", "T1"]);
  expect(g1.code).not.toBe(0);
  expect(g1.out).toContain("fail");
  writeFileSync(join(repo, "ok.txt"), "");
  expect((await tlc(["gate", "T1"])).code).toBe(0);

  const reject = new FakeDriver({
    reviewer: [{ data: { verdict: "reject", findings: ["nope"] }, exitCode: 0 }],
  });
  const r0 = await tlc(["review", "T1"], reject);
  expect(r0.code).toBe(1);
  expect(JSON.parse(r0.out)).toEqual({ verdict: "reject", findings: ["nope"] });
  const pass = new FakeDriver({
    reviewer: [{ data: { verdict: "pass", findings: [] }, exitCode: 0 }],
  });
  const r1 = await tlc(["review", "T1"], pass);
  expect(r1.code).toBe(0);
  expect(pass.calls[0]?.prompt).toContain("one");

  const c1 = await tlc(["commit", "T1"]);
  expect(c1.code).toBe(0);
  expect(c1.out.trim()).toMatch(/^[0-9a-f]{7,}$/);
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(subject.trim()).toBe("feat(a): First (T1)");

  const n2 = JSON.parse((await tlc(["next", "--json"])).out);
  expect(n2.task.id).toBe("T2");
  expect(n2.runId).toBe(j1.runId);

  writeFileSync(join(repo, "packages", "a", "two.txt"), "two\n");
  expect((await tlc(["commit", "T2"])).code).toBe(0);
  const n3 = await tlc(["next"]);
  expect(JSON.parse(n3.out)).toEqual({ done: true });

  const events = readEvents(join(repo, ".specs", "features", feature, "progress.ndjson"));
  const state = fold(events, { runId: j1.runId });
  expect(state.tasks.T1?.status).toBe("done");
  expect(state.tasks.T2?.status).toBe("done");
  expect(state.tasks.T1?.commit).toBeTruthy();
  expect(state.status).toBe("finished");
  expect(events.filter((e) => e.type === "RUN_STARTED")).toHaveLength(1);
});
