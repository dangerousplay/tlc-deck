import { registerRepo } from "@tlc-deck/core";
import { type DriverFactory, runPlan } from "@tlc-deck/runner";

export interface RunCommandOptions {
  repo: string;
  feature: string;
  harness?: string;
  only?: string[];
  retries?: number;
  noCommit?: boolean;
  resume?: boolean;
  concurrency?: number;
  mode?: "solo" | "crew";
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  signal?: AbortSignal;
  driverFactory?: DriverFactory;
}

/** `tlc run`: headless runner. Returns the exit code (130 when interrupted). */
export async function runRun(opts: RunCommandOptions): Promise<number> {
  try {
    registerRepo(opts.repo, opts.env);
  } catch {
    // registry is best effort
  }
  const res = await runPlan({
    repo: opts.repo,
    feature: opts.feature,
    ...(opts.harness ? { harness: opts.harness } : {}),
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.noCommit ? { noCommit: true } : {}),
    ...(opts.resume ? { resume: true } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.driverFactory ? { driverFactory: opts.driverFactory } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    env: opts.env,
    log: (l) => opts.stdout(`${l}\n`),
  });
  opts.stdout(
    `${res.runId} ${res.interrupted ? "interrupted" : res.failed.length ? "failed" : "finished"}: ` +
      `${res.completed.length} done, ${res.failed.length} failed, ${res.notStarted.length} not started\n`,
  );
  return res.code;
}
