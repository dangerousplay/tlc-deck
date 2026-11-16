import type { RunState, TaskState } from "@tlc-deck/protocol";
import { Box, Text } from "ink";
import { elapsedOf, formatCost, formatElapsed } from "./model.js";

const SPINNER = ["|", "/", "-", "\\"];

export interface WatchViewProps {
  run: RunState;
  harness?: string;
  /** Last log lines, newest last. */
  logs: string[];
  now: number;
  tick?: number;
}

const GROUPS: { status: TaskState["status"]; label: string; color?: string }[] = [
  { status: "running", label: "Running", color: "cyan" },
  { status: "blocked", label: "Blocked", color: "red" },
  { status: "failed", label: "Failed", color: "red" },
  { status: "pending", label: "Pending" },
  { status: "skipped", label: "Skipped" },
  { status: "done", label: "Done", color: "green" },
];

function TaskRow({ t, spin }: { t: TaskState; spin: string }) {
  const stage = t.stage ? ` ${t.stage}` : "";
  const attempt = t.attempt && t.attempt > 1 ? ` #${t.attempt}` : "";
  const mark = t.status === "running" ? `${spin} ` : "";
  return (
    <Text>
      {"  "}
      {mark}
      {t.id}
      {t.title ? ` ${t.title}` : ""}
      {t.status === "running" ? `${stage}${attempt}` : ""}
      {t.status === "done" && t.commit ? ` (${t.commit})` : ""}
    </Text>
  );
}

export function WatchView({ run, harness, logs, now, tick = 0 }: WatchViewProps) {
  const spin = SPINNER[tick % SPINNER.length] as string;
  const tasks = Object.values(run.tasks);
  const reached = run.milestones.filter((m) => m.reached).length;
  const total = run.milestones.length;
  const width = 20;
  const filled = total ? Math.round((reached / total) * width) : 0;
  const open = run.blockers.filter((b) => b.open);
  return (
    <Box flexDirection="column">
      <Text bold>
        tlc watch {run.threadId ?? ""} run {run.runId}
      </Text>
      <Text>
        status {run.status} harness {harness ?? "-"} elapsed {formatElapsed(elapsedOf(run, now))}{" "}
        cost {formatCost(run)}
      </Text>
      <Text>
        milestones [{"#".repeat(filled)}
        {"-".repeat(width - filled)}] {reached}/{total}
        {run.milestones.map((m) => ` ${m.reached ? "x" : "."}${m.name}`).join("")}
      </Text>
      {GROUPS.map((g) => {
        const list = tasks.filter((t) => t.status === g.status);
        if (list.length === 0) return null;
        return (
          <Box key={g.status} flexDirection="column">
            <Text color={g.color}>
              {g.label} ({list.length})
            </Text>
            {list.map((t) => (
              <TaskRow key={t.id} t={t} spin={spin} />
            ))}
          </Box>
        );
      })}
      {open.length > 0 && (
        <Box flexDirection="column">
          <Text color="red" bold>
            Blockers ({open.length})
          </Text>
          {open.map((b) => (
            <Box key={b.id} flexDirection="column">
              <Text color="red">
                {"  "}! {b.task} [{b.kind}] {b.reason}
              </Text>
              {b.advice ? (
                <Text color="yellow">
                  {"    "}advice: {b.advice}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
      )}
      {logs.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Log</Text>
          {logs.slice(-5).map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no id
            <Text key={i} dimColor>
              {"  "}
              {l}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
