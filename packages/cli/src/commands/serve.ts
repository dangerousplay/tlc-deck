import { resolve } from "node:path";
import { startServer } from "@tlc-deck/server";
import { health, removePidfile, writePidfile } from "../daemon.js";

export interface ServeOptions {
  port?: number;
  repos: string[];
  noContent?: boolean;
  /** Start even when a healthy tlc-deck already answers on the port. */
  force?: boolean;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  signal?: AbortSignal;
}

/** `tlc serve`: run until `signal` aborts. */
export async function runServe(opts: ServeOptions): Promise<number> {
  const port = opts.port ?? (opts.env.TLC_PORT ? Number(opts.env.TLC_PORT) : 7317);
  if (!opts.force && port > 0) {
    const existing = await health(port);
    if (existing) {
      opts.stdout(
        `tlc serve: already running on port ${port} (pid ${existing.pid}); use --force to start anyway\n`,
      );
      return 0;
    }
  }
  const server = await startServer({
    port,
    env: opts.env,
    noContent: opts.noContent,
    repos: opts.repos.map((r) => resolve(r)),
  });
  writePidfile(opts.env, {
    pid: process.pid,
    port: server.port,
    version: (await health(server.port))?.version ?? "0.0.0",
    startedAt: Date.now(),
  });
  opts.stdout(`tlc serve listening on ${server.url}\n`);
  await new Promise<void>((res) => {
    if (opts.signal?.aborted) return res();
    opts.signal?.addEventListener("abort", () => res(), { once: true });
  });
  removePidfile(opts.env, process.pid);
  await server.close();
  return 0;
}
