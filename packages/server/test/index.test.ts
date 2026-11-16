import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, type NewEvent } from "@tlc-deck/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { name, type RunningServer, startServer } from "../src/index.js";

let dir: string;
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
let repo: string;
let file: string;
const servers: RunningServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-server-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".specs", "features", "f"), { recursive: true });
  file = join(repo, ".specs", "features", "f", "progress.ndjson");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const ev = (type: string, runId: string, extra: Record<string, unknown> = {}): NewEvent =>
  ({
    type,
    timestamp: Date.now(),
    ...(type.startsWith("RUN_") ? { threadId: "repo#f", runId } : {}),
    ...extra,
    metadata: { v: 1, seq: 0, runId, threadId: "repo#f", harness: "t", driver: "t", source: "t" },
  }) as NewEvent;

async function boot(now?: () => number) {
  const s = await startServer({
    port: 0,
    stateDir: join(dir, "state"),
    env: { XDG_STATE_HOME: join(dir, "xdg"), TLC_STATE_DIR: join(dir, "state") },
    repos: [repo],
    webDist: join(dir, "nope"),
    ...(now ? { now } : {}),
    pollMs: 50,
    scanMs: 100,
    heartbeatMs: 200,
  });
  servers.push(s);
  return s;
}

function sse(url: string): {
  next: (pred: (t: string) => boolean, ms?: number) => Promise<string>;
  stop: () => void;
} {
  const ac = new AbortController();
  let buf = "";
  const waiters: (() => void)[] = [];
  void fetch(url, { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const r = await reader?.read();
        if (!r || r.done) return;
        buf += dec.decode(r.value);
        for (const w of waiters.splice(0)) w();
      }
    })
    .catch(() => {});
  return {
    stop: () => ac.abort(),
    async next(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        if (pred(buf)) return buf;
        const left = end - Date.now();
        if (left <= 0) throw new Error(`timeout; got: ${buf}`);
        await new Promise<void>((res) => {
          waiters.push(res);
          setTimeout(res, left);
        });
      }
    },
  };
}

test("exports name", () => {
  expect(name).toBe("@tlc-deck/server");
});

test("append to watched file reaches SSE client < 1s; snapshot and heartbeat", async () => {
  writeFileSync(file, "");
  const s = await boot();
  const c = sse(`${s.url}/api/stream`);
  await c.next((t) => t.includes("STATE_SNAPSHOT"));
  const t0 = Date.now();
  appendEvent(file, ev("RUN_STARTED", "tlc_a", { input: { feature: "f" } }));
  await c.next((t) => t.includes("event: RUN_STARTED"), 1000);
  expect(Date.now() - t0).toBeLessThan(1000);
  await c.next((t) => t.includes(": heartbeat"));
  c.stop();
  const runs = (await (await fetch(`${s.url}/api/runs`)).json()) as { runId: string }[];
  expect(runs.map((r) => r.runId)).toEqual(["tlc_a"]);
  const one = (await (await fetch(`${s.url}/api/runs/tlc_a`)).json()) as { events: unknown[] };
  expect(one.events).toHaveLength(1);
  expect((await fetch(`${s.url}/api/runs/none`)).status).toBe(404);
});

test("POST /events dedupes by runId+seq, also against the file tail", async () => {
  writeFileSync(file, "");
  const s = await boot();
  const written = appendEvent(file, ev("RUN_STARTED", "tlc_b", { input: {} }));
  for (let i = 0; i < 50; i++) {
    const r = (await (await fetch(`${s.url}/api/runs`)).json()) as unknown[];
    if (r.length) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const post = () =>
    fetch(`${s.url}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(written),
    }).then((r) => r.json() as Promise<{ ok: boolean; duplicate: boolean }>);
  expect((await post()).duplicate).toBe(true);
  const fresh = {
    ...written,
    type: "CUSTOM",
    name: "tlc.log",
    value: { level: "info", message: "x" },
    metadata: { ...written.metadata, seq: 2 },
  };
  const body = JSON.stringify(fresh);
  const send = () =>
    fetch(`${s.url}/events`, { method: "POST", body }).then(
      (r) => r.json() as Promise<{ duplicate: boolean }>,
    );
  expect((await send()).duplicate).toBe(false);
  expect((await send()).duplicate).toBe(true);
  const one = (await (await fetch(`${s.url}/api/runs/tlc_b`)).json()) as { events: unknown[] };
  expect(one.events).toHaveLength(2);
  const bad = await fetch(`${s.url}/events`, { method: "POST", body: "{nope" });
  expect(bad.status).toBe(400);
});

test("restart rebuilds runs from files (even with a fresh db)", async () => {
  appendEvent(file, ev("RUN_STARTED", "tlc_c", { input: {} }));
  appendEvent(
    file,
    ev("RUN_FINISHED", "tlc_c", {
      result: { completed: [], failed: [], notStarted: [], deviations: [] },
    }),
  );
  const s1 = await boot();
  await s1.close();
  servers.pop();
  rmSync(join(dir, "state"), { recursive: true, force: true });
  const s2 = await boot();
  const runs = (await (await fetch(`${s2.url}/api/runs`)).json()) as {
    runId: string;
    status: string;
  }[];
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("finished");
});

test("non-loopback Host gets 403", async () => {
  const s = await boot();
  const status = await new Promise<number>((res, rej) => {
    const r = request(
      { host: "127.0.0.1", port: s.port, path: "/api/runs", headers: { host: "evil.example.com" } },
      (resp) => {
        resp.resume();
        res(resp.statusCode ?? 0);
      },
    );
    r.on("error", rej);
    r.end();
  });
  expect(status).toBe(403);
  expect((await fetch(`${s.url}/api/runs`)).status).toBe(200);
});

test("serves placeholder when web dist is missing, real files and SPA fallback otherwise", async () => {
  const s = await boot();
  const html = await (await fetch(`${s.url}/runs/x`)).text();
  expect(html).toContain("tlc deck");
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html>spa</html>");
  writeFileSync(join(dist, "a.js"), "1");
  const s2 = await startServer({
    port: 0,
    stateDir: join(dir, "s2"),
    env: { TLC_STATE_DIR: join(dir, "s2"), XDG_STATE_HOME: join(dir, "xdg2") },
    webDist: dist,
  });
  servers.push(s2);
  expect(await (await fetch(`${s2.url}/runs/x`)).text()).toBe("<html>spa</html>");
  const js = await fetch(`${s2.url}/a.js`);
  expect(js.headers.get("content-type")).toContain("javascript");
  expect(await fetch(`${s2.url}/..%2f..%2fetc/passwd`).then((r) => r.text())).toBe(
    "<html>spa</html>",
  );
  appendFileSync(join(dir, "unused"), "");
});

test("GET /api/runs/:id/tasks/:task: notice when plan missing, details + stage history from golden run", async () => {
  const feat = join(repo, ".specs", "features", "golden");
  mkdirSync(feat, { recursive: true });
  copyFileSync(join(fixtures, "runs", "golden-15.ndjson"), join(feat, "progress.ndjson"));
  const s = await boot(() => 1763200100000);
  const url = `${s.url}/api/runs/tlc_01JGOLDEN/tasks/T1`;
  type Body = {
    details: { title: string; gate: string } | null;
    notice?: string;
    state: {
      task: { id: string } | null;
      stages: { stage: string; attempt: number; durationMs?: number }[];
    };
  };
  const missing = (await (await fetch(url)).json()) as Body;
  expect(missing.details).toBeNull();
  expect(missing.notice).toMatch(/tasks\.md not found/);
  expect(missing.state.task?.id).toBe("T1");
  expect(missing.state.stages.map((x) => x.stage)).toEqual(["implement", "verify"]);
  expect(missing.state.stages[0]).toMatchObject({ attempt: 1, durationMs: 3000 });

  copyFileSync(join(fixtures, "plans/memo-harness-integration/tasks.md"), join(feat, "tasks.md"));
  copyFileSync(join(fixtures, "plans/memo-harness-integration/spec.md"), join(feat, "spec.md"));
  const ok = (await (await fetch(url)).json()) as Body;
  expect(ok.notice).toBeUndefined();
  expect(ok.details?.title).toBe("Crate scaffold, config, project");
  expect((await fetch(`${s.url}/api/runs/none/tasks/T1`)).status).toBe(404);
});
