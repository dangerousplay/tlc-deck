import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import {
  findProgressFiles,
  fold,
  readEvents,
  readRegistry,
  registerRepo,
  STALE_MS,
  tail,
} from "@tlc-deck/core";
import { parseLine, type RunState, type TlcEvent } from "@tlc-deck/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { RETENTION_MS, SqliteStore, type Store } from "./store.js";

export const DEFAULT_PORT = 7317;

export interface ServerOptions {
  /** 0 picks a free port. Default 7317. */
  port?: number;
  env?: Record<string, string | undefined>;
  /** State dir holding deck.db. Default $TLC_STATE_DIR or $XDG_STATE_HOME/tlc-deck. */
  stateDir?: string;
  /** Use this store instead of opening deck.db. */
  store?: Store;
  /** Extra repos to watch (besides repos.json). */
  repos?: string[];
  /** Built SPA directory. Default: apps/web/dist next to this package. */
  webDist?: string;
  heartbeatMs?: number;
  scanMs?: number;
  pollMs?: number;
  now?: () => number;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK.has((name ?? "").toLowerCase());
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>tlc deck</title>
<body style="font-family:system-ui;margin:3rem"><h1>tlc deck</h1>
<p>The web UI is not built. Run <code>pnpm --filter @tlc-deck/web build</code>.</p>
<p>API: <a href="/api/runs">/api/runs</a>, <a href="/api/stream">/api/stream</a></p></body>`;

function defaultWebDist(): string {
  return resolve(new URL("../../../apps/web/dist", import.meta.url).pathname);
}

export function stateDirOf(env: Record<string, string | undefined>): string {
  if (env.TLC_STATE_DIR) return env.TLC_STATE_DIR;
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "tlc-deck");
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const store = opts.store ?? new SqliteStore(join(opts.stateDir ?? stateDirOf(env), "deck.db"));
  const webDist = opts.webDist ?? defaultWebDist();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const subscribers = new Set<(event: unknown) => void>();

  const withStale = (r: RunState): RunState =>
    r.status === "running" && now() - (r.lastEventAt ?? r.startedAt ?? 0) > STALE_MS
      ? { ...r, status: "stale" }
      : r;

  /** Store + fold + broadcast. Returns false for duplicates. */
  const ingest = (event: TlcEvent, broadcast = true): boolean => {
    if (!store.insertEvent(event)) return false;
    const runId = event.metadata.runId;
    store.saveRun(fold(store.eventsOf(runId), { runId, now: now() }));
    if (broadcast) for (const s of subscribers) s(event);
    return true;
  };

  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!isLoopbackHost(c.req.header("host"))) return c.text("forbidden", 403);
    await next();
  });

  app.post("/events", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON" }, 400);
    }
    const r = parseLine(JSON.stringify(body));
    if (!r.ok) return c.json({ ok: false, error: r.reason }, 400);
    return c.json({ ok: true, duplicate: !ingest(r.event) });
  });

  app.get("/api/runs", (c) => c.json(store.listRuns().map(withStale)));
  app.get("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    const run = store.getRun(id);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ ...withStale(run), events: store.eventsOf(id) });
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      const push = (e: unknown) => {
        queue.push(e);
        wake?.();
      };
      subscribers.add(push);
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      try {
        const snapshot = {
          type: "STATE_SNAPSHOT",
          timestamp: now(),
          snapshot: { runs: store.listRuns().map(withStale) },
        };
        await stream.writeSSE({ event: "STATE_SNAPSHOT", data: JSON.stringify(snapshot) });
        let lastWrite = Date.now();
        while (!aborted) {
          const next = queue.shift() as TlcEvent | undefined;
          if (next) {
            await stream.writeSSE({ event: next.type, data: JSON.stringify(next) });
            lastWrite = Date.now();
            continue;
          }
          const wait = Math.max(10, heartbeatMs - (Date.now() - lastWrite));
          await new Promise<void>((res) => {
            const t = setTimeout(res, wait);
            wake = () => {
              clearTimeout(t);
              res();
            };
          });
          wake = undefined;
          if (!aborted && queue.length === 0 && Date.now() - lastWrite >= heartbeatMs) {
            await stream.write(": heartbeat\n\n");
            lastWrite = Date.now();
          }
        }
      } finally {
        subscribers.delete(push);
      }
    }),
  );

  app.get("*", (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    if (existsSync(webDist)) {
      const file = normalize(join(webDist, path));
      if (
        (file === webDist || file.startsWith(webDist + sep)) &&
        existsSync(file) &&
        statSync(file).isFile()
      ) {
        return new Response(readFileSync(file), {
          headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
        });
      }
      const index = join(webDist, "index.html");
      if (existsSync(index)) {
        return c.html(readFileSync(index, "utf8"));
      }
    }
    return c.html(PLACEHOLDER);
  });

  // Repo registry + tailers.
  const repos = new Set<string>((opts.repos ?? []).map((r) => resolve(r)));
  for (const r of opts.repos ?? []) {
    try {
      registerRepo(resolve(r), env);
    } catch {
      // best effort
    }
  }
  const tailers = new Map<string, AbortController>();
  const tailPromises: Promise<void>[] = [];
  let initial = true;
  const scan = () => {
    for (const r of readRegistry(env)) repos.add(r.path);
    for (const repo of repos) {
      for (const file of findProgressFiles(repo)) {
        if (tailers.has(file)) continue;
        for (const e of readEvents(file)) ingest(e, !initial);
        const ac = new AbortController();
        tailers.set(file, ac);
        tailPromises.push(
          tail(file, (e) => void ingest(e), { signal: ac.signal, pollMs: opts.pollMs ?? 100 }),
        );
      }
    }
  };
  scan(); // rebuild runs from files before accepting requests
  initial = false;
  const scanTimer = setInterval(scan, opts.scanMs ?? 5000);
  const purge = () => store.purge(now() - RETENTION_MS);
  purge();
  const purgeTimer = setInterval(purge, 24 * 60 * 60 * 1000);
  scanTimer.unref();
  purgeTimer.unref();

  const server = await new Promise<ReturnType<typeof serve>>((res, rej) => {
    const s = serve(
      { fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: "127.0.0.1" },
      () => res(s),
    );
    s.once("error", rej);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_PORT);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(scanTimer);
      clearInterval(purgeTimer);
      for (const ac of tailers.values()) ac.abort();
      await Promise.all(tailPromises);
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((res) => server.close(() => res()));
      if (!opts.store) store.close();
    },
  };
}
