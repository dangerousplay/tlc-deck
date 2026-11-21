import { loadConfig } from "@tlc-deck/core";
import {
  createDriverFactory,
  type DriverConfig,
  type DriverFactory,
  runReview,
  wherePaths,
} from "@tlc-deck/runner";
import type { HelperOptions } from "./next.js";
import { openSession } from "./session.js";

/** `tlc review <T>`: reviewer verdict as JSON; exit 0 on pass, 1 on reject. */
export async function runReviewCommand(
  opts: HelperOptions & {
    harness?: string;
    model?: string;
    driverFactory?: DriverFactory;
    signal?: AbortSignal;
  },
): Promise<number> {
  const id = opts.task;
  if (!id) throw new Error("review: missing task id");
  const s = openSession(opts.repo, opts.feature, opts.env);
  s.task(id);
  const config = loadConfig({ repoDir: opts.repo, env: opts.env });
  const rc = config.roles.reviewer ?? {};
  const harness = opts.harness ?? rc.harness ?? "claude";
  const model = opts.model ?? rc.model;
  const factory =
    opts.driverFactory ??
    createDriverFactory(
      (typeof config.driver === "object" && config.driver !== null
        ? config.driver
        : {}) as DriverConfig,
    );
  const files = [...new Set([...s.taskFiles(id), ...wherePaths(s.block(id))])];
  const result = await s.step(id, "verify", () =>
    runReview({
      repo: s.repo,
      tasksMd: s.tasksMd,
      id,
      files,
      driver: factory(harness),
      ...(model ? { model } : {}),
      ...(rc.effort ? { effort: rc.effort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  );
  if (result.usage) {
    const u = result.usage;
    s.custom("tlc.usage", {
      task: id,
      role: "reviewer",
      harness,
      model: model ?? u.model ?? "default",
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      costUsd: u.costUsd,
    });
  }
  if (result.verdict === "reject") {
    s.custom("tlc.blocker", {
      id: `${id}-review-${Date.now()}`,
      task: id,
      kind: "rejected",
      reason: result.findings.join("; ") || "rejected",
    });
  }
  opts.stdout(`${JSON.stringify({ verdict: result.verdict, findings: result.findings })}\n`);
  return result.verdict === "pass" ? 0 : 1;
}
