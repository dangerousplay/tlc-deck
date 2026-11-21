import { loadConfig } from "@tlc-deck/core";
import { commitTask } from "@tlc-deck/runner";
import type { HelperOptions } from "./next.js";
import { openSession } from "./session.js";

/** `tlc commit <T>`: deterministic commit, marks the task done, prints the sha. */
export async function runCommitCommand(opts: HelperOptions): Promise<number> {
  const id = opts.task;
  if (!id) throw new Error("commit: missing task id");
  const s = openSession(opts.repo, opts.feature, opts.env);
  s.task(id);
  const config = loadConfig({ repoDir: opts.repo, env: opts.env });
  const trailer = typeof config.commitTrailer === "string" ? config.commitTrailer : undefined;
  const files = s.taskFiles(id);
  const sha = await s.step(id, "commit", () =>
    commitTask({
      repo: s.repo,
      tasksMd: s.tasksMd,
      plan: s.plan,
      id,
      files,
      ...(trailer ? { trailer } : {}),
    }),
  );
  s.taskEvent({
    id,
    status: "done",
    stage: "commit",
    attempt: 1,
    ...(sha ? { commit: sha } : {}),
    ...(files.length ? { files } : {}),
  });
  opts.stdout(`${sha ?? "(no changes to commit)"}\n`);
  return 0;
}
