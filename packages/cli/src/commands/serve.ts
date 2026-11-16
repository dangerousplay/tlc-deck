import { resolve } from "node:path";
import { startServer } from "@tlc-deck/server";

export interface ServeOptions {
  port?: number;
  repos: string[];
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  signal?: AbortSignal;
}

/** `tlc serve`: run until `signal` aborts. */
export async function runServe(opts: ServeOptions): Promise<number> {
  const port = opts.port ?? (opts.env.TLC_PORT ? Number(opts.env.TLC_PORT) : 7317);
  const server = await startServer({
    port,
    env: opts.env,
    repos: opts.repos.map((r) => resolve(r)),
  });
  opts.stdout(`tlc serve listening on ${server.url}\n`);
  await new Promise<void>((res) => {
    if (opts.signal?.aborted) return res();
    opts.signal?.addEventListener("abort", () => res(), { once: true });
  });
  await server.close();
  return 0;
}
