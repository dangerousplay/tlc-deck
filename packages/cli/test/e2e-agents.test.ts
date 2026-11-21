import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "@tlc-deck/core";
import type { AgentInfo, AgentItem } from "@tlc-deck/protocol";
import { FakeDriver } from "@tlc-deck/runner";
import { afterEach, beforeEach, expect, test } from "vitest";
import { run } from "../src/main.js";

const feature = "demo";
const TASKS = `# Tasks

### T1: First

**Depends on**: none
`;
const RUN_ID = "tlc_01M7H0ABGJJP4HAY4WE8CR81GB";

let root: string;
let repo: string;
let ac: AbortController;
let serving: Promise<number> | undefined;
let url: string;
let env: Record<string, string>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tlc-e2e-agents-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".specs", "features", feature), { recursive: true });
  writeFileSync(join(repo, ".specs", "features", feature, "tasks.md"), TASKS);
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
  writeFileSync(join(repo, ".specs", "features", feature, "progress.ndjson"), "");
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

const getJson = async <T>(path: string) => (await (await fetch(`${url}${path}`)).json()) as T;

function sse(path: string) {
  const c = new AbortController();
  let buf = "";
  void fetch(`${url}${path}`, { signal: c.signal })
    .then(async (res) => {
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const r = await reader?.read();
        if (!r || r.done) return;
        buf += dec.decode(r.value);
      }
    })
    .catch(() => {});
  return { text: () => buf, stop: () => c.abort() };
}

const line = (role: "user" | "assistant", id: string, content: unknown) =>
  `${JSON.stringify({
    type: role,
    timestamp: new Date().toISOString(),
    message: { id, role, content, ...(role === "assistant" ? { model: "claude-sonnet-4-6" } : {}) },
  })}\n`;

test("hooks + growing workflow transcript feed a per-agent SSE, linked to the run", async () => {
  const proj = join(root, "home", ".claude", "projects", "-repo");
  const session = join(proj, "sess1");
  const wf = join(session, "subagents", "workflows", "wf_1");
  mkdirSync(wf, { recursive: true });
  const tpath = join(proj, "sess1.jsonl");
  writeFileSync(tpath, line("user", "u0", "hello main"));
  const w1 = join(wf, "agent-w1.jsonl");
  writeFileSync(w1, line("user", "u1", "impl T1"));
  writeFileSync(
    join(wf, "agent-w1.meta.json"),
    JSON.stringify({ agentType: "workflow-subagent", description: "impl T1" }),
  );
  writeFileSync(
    join(wf, "agent-w0.jsonl"),
    line("user", "p0", "parse tasks.md") +
      line("assistant", "p1", [{ type: "text", text: RUN_ID }]),
  );
  writeFileSync(
    join(wf, "journal.jsonl"),
    `${JSON.stringify({ type: "started", agentId: "w0", label: "parse tasks.md" })}\n${JSON.stringify({ type: "started", agentId: "w1", label: "impl T1", phase: "Implement" })}\n`,
  );
  await fetch(`${url}/hooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess1",
      cwd: repo,
      transcript_path: tpath,
    }),
  });
  const agent = await until(async () => {
    const list = await getJson<AgentInfo[]>("/api/agents?session=sess1");
    return list.find((a) => a.id === "sess1-agent-w1" && a.task === "T1");
  });
  expect(agent.stage).toBe("implement");

  const c = sse("/api/agents/sess1-agent-w1/stream");
  await until(() => (c.text().includes("impl T1") ? true : undefined));
  appendFileSync(w1, line("assistant", "a1", [{ type: "text", text: "working on it" }]));
  await until(() => (c.text().includes("working on it") ? true : undefined), 2000);
  c.stop();
  const items = await getJson<AgentItem[]>("/api/agents/sess1-agent-w1/items");
  expect(items.map((i) => i.kind)).toEqual(["prompt", "text"]);
}, 30000);

test("tlc run with a streaming fake driver exposes agent logs through the API", async () => {
  const progress = join(repo, ".specs", "features", feature, "progress.ndjson");
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
    (req) => {
      req.onItem?.({ kind: "tool_call", tool: "Bash", toolUseId: "t1", input: { command: "ls" } });
      req.onItem?.({ kind: "tool_result", toolUseId: "t1", output: "file.txt" });
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
  expect(out).toContain("1 done, 0 failed");
  const runId = readEvents(progress)[0]?.metadata.runId as string;

  const agents = await until(async () => {
    const list = await getJson<AgentInfo[]>(`/api/agents?run=${runId}&task=T1`);
    return list.length >= 2 && list.every((a) => a.status === "done") ? list : undefined;
  });
  const impl = agents.find((a) => a.stage === "implement") as AgentInfo;
  expect(impl).toMatchObject({ source: "tlc-run", role: "implementer", runId });
  const items = await until(async () => {
    const r = await getJson<AgentItem[]>(`/api/agents/${impl.id}/items`);
    return r.length >= 3 ? r : undefined;
  });
  expect(items.map((i) => i.kind)).toEqual(["tool_call", "tool_result", "text"]);
  expect(items[0]?.tool).toBe("Bash");
}, 30000);
