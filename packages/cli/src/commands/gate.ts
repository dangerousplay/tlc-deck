import { resolveGate } from "@tlc-deck/core";
import { runGate } from "@tlc-deck/runner";
import type { HelperOptions } from "./next.js";
import { openSession } from "./session.js";

/** `tlc gate <T>`: run the task's gate; exits with the command's status. */
export async function runGateCommand(
  opts: HelperOptions & { signal?: AbortSignal },
): Promise<number> {
  const id = opts.task;
  if (!id) throw new Error("gate: missing task id");
  const s = openSession(opts.repo, opts.feature, opts.env);
  s.task(id);
  const gate = resolveGate(s.tasksMd, id);
  if (!gate) {
    opts.stdout(`${id}: no gate defined\n`);
    return 0;
  }
  const res = await s.step(id, "gate", () => runGate(s.repo, gate.command, undefined, opts.signal));
  const summary = {
    pass: res.pass,
    summary: res.pass ? `${gate.name} passed` : `exit ${res.code}`,
  };
  s.taskEvent({ id, status: "running", stage: "gate", attempt: 1, gate: summary });
  opts.stdout(`${id} gate ${res.pass ? "pass" : "fail"}: ${gate.command} (exit ${res.code})\n`);
  if (!res.pass && res.tail) opts.stdout(`${res.tail}\n`);
  return res.pass ? 0 : res.code || 1;
}
