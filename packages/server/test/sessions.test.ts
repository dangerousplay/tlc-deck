import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.js";

const HOOKS = join(__dirname, "..", "..", "..", "fixtures", "hooks");
let dir: string;
let repo: string;
const servers: RunningServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-sess-"));
  repo = join(dir, "myproj");
  mkdirSync(join(repo, ".git"), { recursive: true });
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function boot(extra: Record<string, unknown> = {}) {
  const s = await startServer({
    port: 0,
    stateDir: join(dir, "state"),
    env: { TLC_STATE_DIR: join(dir, "state"), XDG_STATE_HOME: join(dir, "xdg") },
    webDist: join(dir, "nope"),
    scanMs: 100000,
    ...extra,
  });
  servers.push(s);
  return s;
}

const fixtures = () =>
  readdirSync(HOOKS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(HOOKS, f), "utf8").replaceAll("__CWD__", repo)));

async function post(s: RunningServer, body: unknown) {
  const res = await fetch(`${s.url}/hooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
}
const get = async (s: RunningServer, p: string) => (await fetch(`${s.url}${p}`)).json();

test("hook fixtures drive a session working -> waiting -> idle -> ended with subagents", async () => {
  const s = await boot();
  const states: string[] = [];
  const seen: unknown[] = [];
  for (const body of fixtures()) {
    await post(s, body);
    const list = (await get(s, "/api/sessions")) as { state: string; subagents: unknown[] }[];
    states.push(`${body.hook_event_name}:${list[0]?.state}:${list[0]?.subagents.length}`);
    seen.push(list[0]);
  }
  expect(states).toEqual([
    "SessionStart:idle:0",
    "UserPromptSubmit:working:0",
    "PreToolUse:working:0",
    "SubagentStart:working:1",
    "PostToolUse:working:1",
    "Notification:waiting:1",
    "SubagentStop:waiting:0",
    "Stop:idle:0",
    "SessionEnd:ended:0",
  ]);
  const detail = await get(s, "/api/sessions/sess-1");
  expect(detail.project).toBe("myproj");
  expect(detail.model).toBe("claude-opus-4-5");
  expect(detail.lastPrompt).toContain("Implement the thing");
  expect(detail.events.map((e: { kind: string }) => e.kind)).toHaveLength(9);
  expect(detail.events[2]).toMatchObject({ kind: "PreToolUse", tool: "Bash" });
  expect((await fetch(`${s.url}/api/sessions/nope`)).status).toBe(404);
});

test("current tool is set by PreToolUse and cleared by PostToolUse", async () => {
  const s = await boot();
  const f = fixtures();
  for (const b of f.slice(0, 3)) await post(s, b);
  expect((await get(s, "/api/sessions/sess-1")).currentTool).toBe("Bash");
  await post(s, f[4]);
  expect((await get(s, "/api/sessions/sess-1")).currentTool).toBeUndefined();
});

test("prompts truncated to 200 chars; --no-content drops prompts and tool inputs", async () => {
  const long = "x".repeat(500);
  const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s", cwd: repo, prompt: long };
  const tool = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    cwd: repo,
    tool_name: "Bash",
    tool_input: { command: long },
  };
  const a = await boot();
  await post(a, prompt);
  await post(a, tool);
  const da = await get(a, "/api/sessions/s");
  expect(da.lastPrompt.length).toBeLessThanOrEqual(200);
  expect(da.events[1].toolInput.length).toBeLessThanOrEqual(200);
  await a.close();
  servers.pop();

  const b = await boot({ noContent: true, stateDir: join(dir, "state2") });
  await post(b, prompt);
  await post(b, tool);
  const db = await get(b, "/api/sessions/s");
  expect(db.lastPrompt).toBeUndefined();
  expect(db.events[1].toolInput).toBeUndefined();
  expect(db.currentTool).toBe("Bash");
});

test("silence marks a working session idle; deltas stream as CUSTOM tlc.session", async () => {
  const s = await boot({ idleMs: 150 });
  const res = await fetch(`${s.url}/api/stream`);
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let text = "";
  const dec = new TextDecoder();
  const until = async (pred: (t: string) => boolean) => {
    const end = Date.now() + 4000;
    while (!pred(text) && Date.now() < end) {
      const r = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 200)),
      ]);
      if (r && !r.done) text += dec.decode(r.value);
    }
    return pred(text);
  };
  await until((t) => t.includes("STATE_SNAPSHOT"));
  await post(s, fixtures()[1]);
  expect(
    await until((t) => t.includes('"name":"tlc.session"') && t.includes('"state":"working"')),
  ).toBe(true);
  expect(await until((t) => t.includes('"state":"idle"'))).toBe(true);
  await reader.cancel();
  expect((await get(s, "/api/sessions"))[0].state).toBe("idle");
});

test("malformed hook bodies still answer empty 200", async () => {
  const s = await boot();
  const res = await fetch(`${s.url}/hooks`, { method: "POST", body: "not json" });
  expect(res.status).toBe(200);
  await post(s, { hook_event_name: "Stop" });
  expect(await get(s, "/api/sessions")).toEqual([]);
});
