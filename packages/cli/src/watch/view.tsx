import type { TaskDetails } from "@tlc-deck/core";
import type { RunState, TaskState, TlcEvent } from "@tlc-deck/protocol";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { elapsedOf, formatCost, formatElapsed, hhmmss, taskHistory } from "./model.js";

const SPINNER = ["|", "/", "-", "\\"];

export interface WatchViewProps {
  run: RunState;
  harness?: string;
  /** Last log lines, newest last. */
  logs: string[];
  now: number;
  tick?: number;
  /** Enables keyboard task focus (up/down, enter, esc). */
  interactive?: boolean;
  /** Parsed tasks.md/spec.md details, by task id. */
  details?: Record<string, TaskDetails>;
  /** Run events, used for the stage history in the detail view. */
  events?: TlcEvent[];
}

const GROUPS: { status: TaskState["status"]; label: string; color?: string }[] = [
  { status: "running", label: "Running", color: "cyan" },
  { status: "blocked", label: "Blocked", color: "red" },
  { status: "failed", label: "Failed", color: "red" },
  { status: "pending", label: "Pending" },
  { status: "skipped", label: "Skipped" },
  { status: "done", label: "Done", color: "green" },
];

function TaskRow({ t, spin, selected }: { t: TaskState; spin: string; selected?: boolean }) {
  const stage = t.stage ? ` ${t.stage}` : "";
  const attempt = t.attempt && t.attempt > 1 ? ` #${t.attempt}` : "";
  const mark = t.status === "running" ? `${spin} ` : "";
  return (
    <Text>
      {selected ? "> " : "  "}
      {mark}
      {t.id}
      {t.title ? ` ${t.title}` : ""}
      {t.status === "running" ? `${stage}${attempt}` : ""}
      {t.status === "done" && t.commit ? ` (${t.commit})` : ""}
    </Text>
  );
}

function TaskDetail({
  id,
  task,
  details,
  events,
}: {
  id: string;
  task: TaskState | undefined;
  details: TaskDetails | undefined;
  events: TlcEvent[];
}) {
  const history = taskHistory(events, id);
  return (
    <Box flexDirection="column">
      <Text bold>
        {id} {details?.title ?? task?.title ?? ""}
      </Text>
      <Text>
        status {task?.status ?? "-"}
        {task?.stage ? ` stage ${task.stage}` : ""}
        {task?.attempt ? ` attempt ${task.attempt}` : ""}
        {details?.milestone ? ` milestone ${details.milestone}` : ""}
      </Text>
      {details ? (
        <Box flexDirection="column">
          {details.what ? <Text>What: {details.what}</Text> : null}
          {details.where ? <Text>Where: {details.where}</Text> : null}
          {details.dependsOn.length > 0 ? (
            <Text>Depends on: {details.dependsOn.join(", ")}</Text>
          ) : null}
          {details.requirements.map((r) => (
            <Text key={r.id}>
              {"  "}
              {r.id}
              {r.text ? `: ${r.text}` : ""}
            </Text>
          ))}
          {details.doneWhen.length > 0 ? <Text>Done when:</Text> : null}
          {details.doneWhen.map((d) => (
            <Text key={d.text}>
              {"  "}[{d.checked ? "x" : " "}] {d.text}
            </Text>
          ))}
          {details.tests ? <Text>Tests: {details.tests}</Text> : null}
          {details.gate ? <Text>Gate: {details.gate}</Text> : null}
        </Box>
      ) : (
        <Text dimColor>no task details available</Text>
      )}
      <Text bold>History</Text>
      {history.length === 0 ? <Text dimColor>{"  "}no events</Text> : null}
      {history.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: history entries have no id
        <Text key={i}>
          {"  "}
          {hhmmss(h.time)} {h.status}
          {h.stage ? ` ${h.stage}` : ""}
          {h.attempt ? ` #${h.attempt}` : ""}
        </Text>
      ))}
      <Text dimColor>esc back</Text>
    </Box>
  );
}

export function WatchView({
  run,
  harness,
  logs,
  now,
  tick = 0,
  interactive = false,
  details,
  events = [],
}: WatchViewProps) {
  const spin = SPINNER[tick % SPINNER.length] as string;
  const tasks = Object.values(run.tasks);
  const ordered = GROUPS.flatMap((g) => tasks.filter((t) => t.status === g.status));
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const selected = ordered.find((t) => t.id === selectedId)?.id ?? ordered[0]?.id;
  useInput(
    (_input, key) => {
      if (detailId !== undefined) {
        if (key.escape) setDetailId(undefined);
        return;
      }
      if (ordered.length === 0) return;
      const i = Math.max(
        0,
        ordered.findIndex((t) => t.id === selected),
      );
      if (key.downArrow) setSelectedId(ordered[Math.min(ordered.length - 1, i + 1)]?.id);
      else if (key.upArrow) setSelectedId(ordered[Math.max(0, i - 1)]?.id);
      else if (key.return) setDetailId(selected);
    },
    { isActive: interactive },
  );
  if (detailId !== undefined) {
    return (
      <TaskDetail
        id={detailId}
        task={run.tasks[detailId]}
        details={details?.[detailId]}
        events={events}
      />
    );
  }
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
              <TaskRow key={t.id} t={t} spin={spin} selected={interactive && t.id === selected} />
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
