import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, fold, type NewEvent } from "@tlc-deck/core";
import type { TlcEvent } from "@tlc-deck/protocol";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runWatch } from "../src/watch/index.js";
import { WatchView } from "../src/watch/view.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = join(here, "..", "..", "..", "fixtures", "runs", "golden-15.ndjson");
const T0 = 1763200000000;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-watch-"));
  file = join(dir, "progress.ndjson");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const meta = { runId: "r1", threadId: "repo#f", harness: "claude-code", driver: "workflow", v: 1 };
let n = 0;
const ev = (e: Record<string, unknown>): NewEvent =>
  ({ timestamp: T0 + 1000 * n++, ...e, metadata: { ...meta, source: "t" } }) as unknown as NewEvent;
const custom = (name: string, value: unknown) => ev({ type: "CUSTOM", name, value });
const started = () => ev({ type: "RUN_STARTED", threadId: "repo#f", runId: "r1", input: {} });
const plan = () =>
  custom("tlc.plan", {
    tasks: [
      { id: "T1", title: "First", milestone: "M1", dependsOn: [], parallel: false },
      { id: "T2", title: "Second", milestone: "M2", dependsOn: ["T1"], parallel: false },
    ],
    milestones: [
      { name: "M1", source: "field", tasks: ["T1"] },
      { name: "M2", source: "field", tasks: ["T2"] },
    ],
  });
const task = (id: string, status: string, extra: object = {}) =>
  custom("tlc.task", { id, status, ...extra });

function view(events: NewEvent[]) {
  const run = fold(events as unknown as TlcEvent[], { now: T0 + 60_000 });
  return render(
    <WatchView run={run} harness="claude-code" logs={["info: hello"]} now={T0 + 60_000} />,
  ).lastFrame() as string;
}

test("running frame", () => {
  n = 0;
  const f = view([
    started(),
    plan(),
    task("T1", "done", { commit: "abc123" }),
    task("T2", "running", { stage: "verify", attempt: 2 }),
  ]);
  expect(f).toContain("status running");
  expect(f).toContain("milestones [");
  expect(f).toContain("1/2");
  expect(f).toContain("Running (1)");
  expect(f).toContain("T2 Second verify #2");
  expect(f).toContain("Done (1)");
  expect(f).toContain("info: hello");
});

test("blocked frame shows open blockers with advice", () => {
  n = 0;
  const f = view([
    started(),
    plan(),
    task("T1", "blocked"),
    custom("tlc.blocker", {
      id: "b1",
      task: "T1",
      kind: "gate",
      reason: "tests red",
      advice: "run pnpm install",
    }),
  ]);
  expect(f).toContain("Blocked (1)");
  expect(f).toContain("Blockers (1)");
  expect(f).toContain("! T1 [gate] tests red");
  expect(f).toContain("advice: run pnpm install");
});

test("finished frame", () => {
  n = 0;
  const f = view([
    started(),
    plan(),
    task("T1", "done"),
    task("T2", "done"),
    ev({ type: "RUN_FINISHED", threadId: "repo#f", runId: "r1", result: { failed: [] } }),
  ]);
  expect(f).toContain("status finished");
  expect(f).toContain("2/2");
  expect(f).not.toContain("Blockers");
});

async function watch(extra: { run?: string } = {}) {
  let out = "";
  const code = await runWatch({
    file,
    tty: false,
    stdout: (t) => {
      out += t;
    },
    now: () => T0 + 3_600_000,
    ...extra,
  });
  return { code, out };
}

test("non-TTY golden output and exit 1 on failed tasks", async () => {
  copyFileSync(golden, file);
  const { code, out } = await watch();
  expect(code).toBe(1); // the fixture run has failed task T9
  const g = join(here, "golden", "watch-golden-15.txt");
  if (process.env.UPDATE_GOLDEN) writeFileSync(g, out);
  expect(out).toBe(readFileSync(g, "utf8"));
});

test("exit code 1 when a task failed", async () => {
  n = 0;
  mkdirSync(dirname(file), { recursive: true });
  for (const e of [
    started(),
    plan(),
    task("T1", "failed"),
    ev({ type: "RUN_FINISHED", threadId: "repo#f", runId: "r1", result: { failed: ["T1"] } }),
  ]) {
    appendEvent(file, e);
  }
  const { code, out } = await watch();
  expect(code).toBe(1);
  expect(out).toContain("failed: T1");
});

test("follows a file that grows and picks --run", async () => {
  writeFileSync(file, "");
  const p = watch({ run: "r1" });
  n = 0;
  setTimeout(() => {
    for (const e of [started(), plan(), task("T1", "done")]) appendEvent(file, e);
    appendEvent(
      file,
      ev({ type: "RUN_FINISHED", threadId: "repo#f", runId: "r1", result: { failed: [] } }),
    );
  }, 100);
  const { code, out } = await p;
  expect(code).toBe(0);
  expect(out).toContain("run started r1");
  expect(out).toContain("task T1 done");
});
