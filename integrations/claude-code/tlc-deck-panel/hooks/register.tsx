import type { Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { TlcRun } from "../types";

const PANE = "tlc";
const run = atom({ plugin: "tlc-deck-panel", key: "run" } as const, null, { shape: "run-1" });

const ORDER = ["running", "blocked", "failed", "pending", "done", "skipped"];

function counts(r: TlcRun) {
  const tasks = Object.values(r.tasks ?? {});
  const done = tasks.filter((t) => t.status === "done").length;
  const open = (r.blockers ?? []).filter((b) => b.open).length;
  return { tasks, done, open };
}

/** The status text for a run (null = no active run or `tlc status` failed). */
export function statusText(r: TlcRun | null): string {
  if (r === null) return "tlc -";
  const { tasks, done, open } = counts(r);
  return `tlc ${done}/${tasks.length}${open > 0 ? ` ▲${open}` : ""}`;
}

/** Parse a `tlc status --json` run; null when it failed or is not JSON. */
export function toRun(ran: { exitCode: number; stdout: string } | null): TlcRun | null {
  if (ran === null || ran.exitCode !== 0) return null;
  try {
    const v = JSON.parse(ran.stdout);
    return v && typeof v === "object" && v.tasks && typeof v.tasks === "object" ? v : null;
  } catch {
    return null;
  }
}

function cost(r: TlcRun): string {
  let total = 0;
  let known = false;
  for (const u of Object.values(r.usageByRole ?? {})) {
    if (typeof u.costUsd === "number") {
      total += u.costUsd;
      known = true;
    }
  }
  return known ? `$${total.toFixed(2)}` : "-";
}

export const register: Register = (on, options) => {
  const bin = String(options?.tlc_bin || "tlc");
  const argv = [bin, "status", "--json"];

  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "tlc", description: "Show the tlc-deck run board in a pane" });
    const refresh = async () => {
      const ran = await $.process.run(argv, { timeoutMs: 2000 }).catch(() => null);
      const r = toRun(ran);
      await update($, run, () => r);
      $.ui.status(statusText(r));
    };
    await refresh();
    $.clock.every(3000, () => {
      void refresh();
    });

    return next(e);
  });

  on("command.run", { command: "tlc" }, async ($) => {
    const ran = await $.process.run(argv, { timeoutMs: 2000 }).catch(() => null);
    const r = toRun(ran);
    await update($, run, () => r);
    $.ui.status(statusText(r));
    await $.ui.open({ id: PANE, title: "tlc" });

    return { text: "tlc pane opened." };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const r = await read($, run);
    if (r === null) {
      return (
        <Box flexDirection="column">
          <Text>no active run</Text>
          <Text dimColor>run: tlc run</Text>
        </Box>
      );
    }
    const { tasks, done, open } = counts(r);
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 8);
    const sorted = [...tasks].sort(
      (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id),
    );

    return (
      <Box flexDirection="column">
        <Text>
          {r.runId} {r.status} tasks {done}/{tasks.length} blockers {open} cost {cost(r)}
        </Text>
        {(r.milestones ?? []).map((m) => (
          <Text dimColor={!m.reached}>
            milestone {m.name}: {m.reached ? "reached" : "pending"}
          </Text>
        ))}
        {(r.blockers ?? [])
          .filter((b) => b.open)
          .map((b) => (
            <Text>
              ▲ {b.task} {b.kind}: {b.reason}
            </Text>
          ))}
        {sorted.slice(0, room).map((t) => (
          <Text dimColor={t.status === "done" || t.status === "skipped"}>
            {t.status} {t.id} {t.title ?? ""}
            {t.stage ? ` [${t.stage}${t.attempt ? ` #${t.attempt}` : ""}]` : ""}
          </Text>
        ))}
      </Box>
    );
  });
};
