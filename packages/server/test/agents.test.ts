import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, type NewEvent } from "@tlc-deck/core";
import type { AgentInfo, AgentItem } from "@tlc-deck/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.js";
import { SqliteStore } from "../src/store.js";

let dir: string;
let repo: string;
let session: string;
let tpath: string;
const servers: RunningServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-agents-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".specs", "features", "f"), { recursive: true });
  const proj = join(dir, "home", ".claude", "projects", "-repo");
  mkdirSync(proj, { recursive: true });
  tpath = join(proj, "sess1.jsonl");
  session = join(proj, "sess1");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function boot(extra: Record<string, unknown> = {}) {
  const s = await startServer({
    port: 0,
    stateDir: join(dir, "state"),
    env: { XDG_STATE_HOME: join(dir, "xdg"), TLC_STATE_DIR: join(dir, "state") },
    repos: [repo],
    webDist: join(dir, "nope"),
    pollMs: 50,
    scanMs: 100,
    agentPollMs: 30,
    heartbeatMs: 200,
    ...extra,
  });
  servers.push(s);
  return s;
}

const hook = (s: RunningServer, body: Record<string, unknown>) =>
  fetch(`${s.url}/hooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "sess1", cwd: repo, transcript_path: tpath, ...body }),
  });

const asst = (id: string, text: string, extra: unknown[] = []) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      id,
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }, ...extra],
      usage: { input_tokens: 5, output_tokens: 9 },
    },
  })}\n`;
const user = (text: string) =>
  `${JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  })}\n`;

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const agentsOf = async (s: RunningServer, q = "") =>
  (await (await fetch(`${s.url}/api/agents${q}`)).json()) as AgentInfo[];

function sse(url: string) {
  const ac = new AbortController();
  let buf = "";
  void fetch(url, { signal: ac.signal })
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
  return { text: () => buf, stop: () => ac.abort() };
}

function buildTree() {
  writeFileSync(tpath, user("hello main") + asst("m1", "main reply"));
  mkdirSync(join(session, "subagents", "workflows", "wf_1"), { recursive: true });
  writeFileSync(
    join(session, "subagents", "agent-sub1.jsonl"),
    user("sub prompt") + asst("s1", "sub reply"),
  );
  writeFileSync(
    join(session, "subagents", "agent-sub1.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "look around" }),
  );
  const wf = join(session, "subagents", "workflows", "wf_1");
  writeFileSync(
    join(wf, "agent-w1.jsonl"),
    user("parse tasks.md") +
      `${JSON.stringify({
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "run tlc_01M7H0ABGJJP4HAY4WE8CR81GB started",
            },
          ],
        },
      })}\n`,
  );
  writeFileSync(
    join(wf, "agent-w1.meta.json"),
    JSON.stringify({
      agentType: "workflow-subagent",
      description: "impl T3",
      workflowPhase: "Implement",
      model: "sonnet",
    }),
  );
  writeFileSync(join(wf, "agent-w2.jsonl"), user("verify it") + asst("w2m", "ok"));
  writeFileSync(
    join(wf, "journal.jsonl"),
    `${JSON.stringify({ type: "started", agentId: "w1", label: "impl T3", phase: "Implement" })}\n${JSON.stringify({ type: "started", agentId: "w2", label: "verify T3" })}\n`,
  );
}

test("hooks register session; main, subagent and workflow agents listed with task/stage and run link by id", async () => {
  buildTree();
  const s = await boot();
  expect(await agentsOf(s)).toEqual([]);
  await hook(s, { hook_event_name: "SessionStart" });
  const all = await until(async () => {
    const a = await agentsOf(s, "?session=sess1");
    return a.length === 4 ? a : undefined;
  });
  const by = Object.fromEntries(all.map((a) => [a.id, a]));
  expect(by.sess1?.role).toBe("main");
  expect(by.sess1?.model).toBe("claude-sonnet-4-6");
  expect(by.sess1?.usage?.output).toBe(9);
  expect(by["sess1-agent-sub1"]).toMatchObject({ role: "Explore", label: "look around" });
  expect(by["sess1-agent-w1"]).toMatchObject({
    workflowId: "wf_1",
    task: "T3",
    stage: "implement",
    runId: "tlc_01M7H0ABGJJP4HAY4WE8CR81GB",
  });
  expect(by["sess1-agent-w2"]).toMatchObject({ task: "T3", stage: "verify" });
  const filtered = await agentsOf(s, "?run=tlc_01M7H0ABGJJP4HAY4WE8CR81GB&task=T3");
  expect(filtered.map((a) => a.id).sort()).toEqual(["sess1-agent-w1", "sess1-agent-w2"]);
  const items = (await (
    await fetch(`${s.url}/api/agents/sess1/items?after=0`)
  ).json()) as AgentItem[];
  expect(items.map((i) => i.kind)).toEqual(["text"]);
  expect((await fetch(`${s.url}/api/agents/nope/items`)).status).toBe(404);
});

test("appended lines reach a per-agent SSE client < 1 s; tlc.agent upserts on global stream", async () => {
  buildTree();
  const s = await boot();
  const g = sse(`${s.url}/api/stream`);
  await hook(s, { hook_event_name: "SessionStart" });
  await until(async () => (await agentsOf(s)).length === 4);
  const c = sse(`${s.url}/api/agents/sess1/stream`);
  await until(() => c.text().includes("main reply"));
  const t0 = Date.now();
  appendFileSync(tpath, asst("m2", "fresh line"));
  await until(() => c.text().includes("fresh line"), 1000);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(g.text()).toContain("tlc.agent");
  c.stop();
  g.stop();
});

test("workflow linked to a run by time fallback", async () => {
  buildTree();
  // drop the tlc_ id so only the time fallback can link
  writeFileSync(
    join(session, "subagents", "workflows", "wf_1", "agent-w1.jsonl"),
    user("parse tasks.md"),
  );
  const s = await boot();
  await hook(s, { hook_event_name: "SessionStart" });
  await until(async () => (await agentsOf(s)).length === 4);
  const file = join(repo, ".specs", "features", "f", "progress.ndjson");
  appendEvent(file, {
    type: "RUN_STARTED",
    timestamp: Date.now() + 1000,
    threadId: "repo#f",
    runId: "tlc_FALLBACK",
    input: { feature: "f" },
    metadata: {
      v: 1,
      seq: 0,
      runId: "tlc_FALLBACK",
      threadId: "repo#f",
      harness: "t",
      driver: "t",
      source: "t",
    },
  } as NewEvent);
  const w1 = await until(async () => {
    const a = (await agentsOf(s)).find((x) => x.id === "sess1-agent-w1");
    return a?.runId ? a : undefined;
  });
  expect(w1.runId).toBe("tlc_FALLBACK");
});

test("reads only inside the announced session dir", async () => {
  buildTree();
  const other = join(dir, "home", ".claude", "projects", "-repo", "other");
  mkdirSync(join(other, "subagents"), { recursive: true });
  writeFileSync(join(other, "subagents", "agent-evil.jsonl"), user("secret") + asst("e1", "x"));
  writeFileSync(join(dir, "outside.jsonl"), user("outside") + asst("o1", "x"));
  const s = await boot();
  await hook(s, {
    hook_event_name: "SubagentStop",
    agent_id: "evil",
    agent_transcript_path: join(dir, "outside.jsonl"),
  });
  await hook(s, {
    hook_event_name: "SubagentStop",
    agent_id: "evil",
    agent_transcript_path: join(other, "subagents", "agent-evil.jsonl"),
  });
  await until(async () => (await agentsOf(s)).length === 4);
  const ids = (await agentsOf(s)).map((a) => a.id);
  expect(ids.some((i) => i.includes("evil") || i.includes("outside"))).toBe(false);
});

test("--no-content stores items without text/input/output", async () => {
  buildTree();
  const s = await boot({ noContent: true });
  await hook(s, { hook_event_name: "SessionStart" });
  await until(async () => (await agentsOf(s)).length === 4);
  const items = await until(async () => {
    const r = (await (await fetch(`${s.url}/api/agents/sess1/items`)).json()) as AgentItem[];
    return r.length ? r : undefined;
  });
  expect(items[0]?.kind).toBeDefined();
  for (const i of items) {
    expect(i.text).toBeUndefined();
    expect(i.input).toBeUndefined();
    expect(i.output).toBeUndefined();
  }
});

test("store purge: items after 7 days, agents after the retention window", () => {
  const st = new SqliteStore(":memory:");
  const base = { source: "claude-code", harness: "claude-code", status: "done" } as const;
  st.upsertAgent({ ...base, id: "old", startedAt: 100 });
  st.upsertAgent({ ...base, id: "new", startedAt: 10_000 });
  st.addAgentItems([
    { agentId: "old", seq: 0, ts: 100, kind: "text", text: "a" },
    { agentId: "new", seq: 0, ts: 100, kind: "text", text: "b" },
    { agentId: "new", seq: 1, ts: 10_000, kind: "text", text: "c" },
  ]);
  st.addAgentItems([{ agentId: "new", seq: 1, ts: 10_000, kind: "text", text: "dup" }]);
  expect(st.agentItems("new").map((i) => i.text)).toEqual(["b", "c"]);
  expect(st.purgeAgentItems(5_000)).toBe(2);
  expect(st.agentItems("new").map((i) => i.text)).toEqual(["c"]);
  st.purge(5_000);
  expect(st.listAgents().map((a) => a.id)).toEqual(["new"]);
  expect(st.agentItems("old")).toEqual([]);
  st.close();
});

test("tlc run agents: tlc.agent events upsert, agents/<runId>/*.ndjson served through the API", async () => {
  const feat = join(repo, ".specs", "features", "f");
  const runId = "tlc_RUNLOG";
  const meta = {
    v: 1,
    seq: 0,
    runId,
    threadId: "repo#f",
    harness: "codex",
    driver: "runner",
    source: "runner",
  };
  const file = join(feat, "progress.ndjson");
  appendEvent(file, {
    type: "RUN_STARTED",
    timestamp: Date.now(),
    threadId: "repo#f",
    runId,
    input: { feature: "f", repoPath: repo },
    metadata: meta,
  } as NewEvent);
  const aid = `${runId}-T1-implement-1`;
  appendEvent(file, {
    type: "CUSTOM",
    timestamp: Date.now(),
    name: "tlc.agent",
    value: {
      id: aid,
      source: "tlc-run",
      runId,
      task: "T1",
      stage: "implement",
      role: "implementer",
      harness: "codex",
      status: "running",
      startedAt: Date.now(),
    },
    metadata: meta,
  } as NewEvent);
  const logDir = join(feat, "agents", runId);
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${aid}.ndjson`);
  const item = (seq: number, text: string) =>
    `${JSON.stringify({ agentId: aid, seq, ts: Date.now(), kind: "text", text })}\n`;
  writeFileSync(log, item(0, "first"));
  // a log may not write into another agent
  writeFileSync(
    join(logDir, "other.ndjson"),
    `${JSON.stringify({ agentId: "victim", seq: 0, ts: 1, kind: "text", text: "x" })}\n`,
  );

  const s = await boot();
  const listed = await until(async () => {
    const a = await agentsOf(s, `?run=${runId}&task=T1`);
    return a.length ? a : undefined;
  });
  expect(listed[0]).toMatchObject({ id: aid, source: "tlc-run", stage: "implement" });
  const items = await until(async () => {
    const r = (await (await fetch(`${s.url}/api/agents/${aid}/items`)).json()) as AgentItem[];
    return r.length ? r : undefined;
  });
  expect(items.map((i) => i.text)).toEqual(["first"]);
  const c = sse(`${s.url}/api/agents/${aid}/stream`);
  await until(() => c.text().includes("first"));
  appendFileSync(log, item(1, "second"));
  await until(() => c.text().includes("second"), 1000);
  appendEvent(file, {
    type: "CUSTOM",
    timestamp: Date.now(),
    name: "tlc.agent",
    value: { id: aid, status: "done", endedAt: Date.now() },
    metadata: meta,
  } as NewEvent);
  const done = await until(async () => {
    const a = (await agentsOf(s, `?run=${runId}`)).find((x) => x.id === aid);
    return a?.status === "done" ? a : undefined;
  });
  expect(done).toMatchObject({ task: "T1", stage: "implement", harness: "codex" });
  expect((await fetch(`${s.url}/api/agents/victim/items`)).status).toBe(404);
  c.stop();
});
