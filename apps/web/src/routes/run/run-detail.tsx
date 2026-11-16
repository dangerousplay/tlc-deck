import type { BlockerState, RunState, TaskState, TaskStatus, TlcEvent } from "@tlc-deck/protocol";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { elapsed, formatCost, runCost } from "@/lib/format";

export const BOARD_COLUMNS = [
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
  "skipped",
] as const;

const STATUS_VARIANT = {
  running: "default",
  finished: "success",
  failed: "destructive",
  interrupted: "warning",
  stale: "secondary",
} as const;

export function RunHeader({ run, now = Date.now() }: { run: RunState; now?: number }) {
  return (
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="font-mono text-lg font-semibold">{run.runId}</h1>
      <Badge variant={STATUS_VARIANT[run.status]} data-testid="run-status">
        {run.status}
      </Badge>
      <span className="text-sm text-muted-foreground">{elapsed(run, now)}</span>
      <span className="text-sm text-muted-foreground">{formatCost(runCost(run))}</span>
    </header>
  );
}

export function MilestoneStepper({ run }: { run: RunState }) {
  if (run.milestones.length === 0) return null;
  return (
    <ol className="flex flex-col gap-2 md:flex-row md:flex-wrap" aria-label="Milestones">
      {run.milestones.map((m) => (
        <li
          key={m.name}
          data-testid="milestone"
          data-reached={m.reached}
          className="flex items-center gap-2 text-sm"
        >
          <span
            className={`size-3 rounded-full border ${m.reached ? "bg-green-600" : "bg-transparent"}`}
          />
          <span className={m.reached ? "" : "text-muted-foreground"}>{m.name}</span>
        </li>
      ))}
    </ol>
  );
}

function TaskCard({ task }: { task: TaskState }) {
  return (
    <li data-testid="task-card" className="rounded-md border p-2 text-sm">
      <div className="font-mono text-xs">{task.id}</div>
      {task.title && <div>{task.title}</div>}
      <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
        {task.stage && <span>stage: {task.stage}</span>}
        {task.attempt !== undefined && <span>attempt {task.attempt}</span>}
        {task.commit && <span className="font-mono">{task.commit}</span>}
        {task.gate && (
          <span className={task.gate.pass ? "text-green-600" : "text-red-600"}>
            gate {task.gate.pass ? "pass" : "fail"}: {task.gate.summary}
          </span>
        )}
      </div>
    </li>
  );
}

export function TaskBoard({ run }: { run: RunState }) {
  const tasks = Object.values(run.tasks);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {BOARD_COLUMNS.map((status: TaskStatus) => {
        const list = tasks.filter((t) => t.status === status);
        return (
          <section key={status} data-testid={`col-${status}`} className="space-y-2">
            <h3 className="text-sm font-medium">
              {status} <span data-testid={`count-${status}`}>{list.length}</span>
            </h3>
            <ul className="space-y-2">
              {list.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function BlockersPanel({ blockers }: { blockers: BlockerState[] }) {
  const open = blockers.filter((b) => b.open);
  if (open.length === 0) return <p className="text-sm text-muted-foreground">No open blockers.</p>;
  return (
    <ul className="space-y-2">
      {open.map((b) => (
        <li
          key={b.id}
          data-testid="blocker"
          className="rounded-md border border-red-600 p-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge variant="destructive">{b.kind}</Badge>
            <span className="font-mono text-xs">{b.task}</span>
          </div>
          <p>{b.reason}</p>
          {b.advice && <p className="text-muted-foreground">Advice: {b.advice}</p>}
        </li>
      ))}
    </ul>
  );
}

function UsageBars({ title, data }: { title: string; data: RunState["usageByRole"] }) {
  const rows = Object.entries(data).map(([k, u]) => ({
    k,
    tokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: u.costUsd,
  }));
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No usage.</p>}
      {rows.map((r) => (
        <div key={r.k} data-testid="usage-row" className="text-xs">
          <div className="flex justify-between">
            <span>{r.k}</span>
            <span>
              {r.tokens} tok · {formatCost(r.cost)}
            </span>
          </div>
          <div className="h-2 rounded bg-muted">
            <div
              className="h-2 rounded bg-primary"
              style={{ width: `${(r.tokens / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function UsagePanel({ run }: { run: RunState }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <UsageBars title="By role" data={run.usageByRole} />
      <UsageBars title="By model" data={run.usageByModel} />
    </div>
  );
}

export function Deviations({ run }: { run: RunState }) {
  const items = Object.values(run.tasks).flatMap((t) =>
    (t.deviations ?? []).map((d) => ({ task: t.id, text: d })),
  );
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No deviations.</p>;
  return (
    <ul className="list-disc pl-5 text-sm">
      {items.map((d) => (
        <li key={`${d.task}-${d.text}`} data-testid="deviation">
          <span className="font-mono">{d.task}</span> {d.text}
        </li>
      ))}
    </ul>
  );
}

const ROW_H = 24;
const VIEW_H = 320;
const OVERSCAN = 5;

function describe(e: TlcEvent): string {
  const v = e.value as { message?: string; text?: string } | undefined;
  const detail = e.name ? ` ${e.name}` : "";
  const msg = v?.message ?? v?.text;
  return `${e.type}${detail}${msg ? ` ${msg}` : ""}`;
}

export function EventLog({ events }: { events: TlcEvent[] }) {
  const [top, setTop] = useState(0);
  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const end = Math.min(events.length, Math.ceil((top + VIEW_H) / ROW_H) + OVERSCAN);
  return (
    <div
      data-testid="event-log"
      className="overflow-auto rounded-md border font-mono text-xs"
      style={{ height: VIEW_H }}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: events.length * ROW_H, position: "relative" }}>
        {events.slice(start, end).map((e, i) => (
          <div
            key={e.metadata.seq}
            data-testid="log-row"
            className="absolute w-full truncate px-2"
            style={{ top: (start + i) * ROW_H, height: ROW_H, lineHeight: `${ROW_H}px` }}
          >
            {describe(e)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RunDetail({
  run,
  events,
  now,
}: {
  run: RunState;
  events: TlcEvent[];
  now?: number;
}) {
  const section = "space-y-2";
  return (
    <div className="space-y-6">
      <RunHeader run={run} now={now} />
      <section className={section}>
        <h2 className="text-base font-semibold">Milestones</h2>
        <MilestoneStepper run={run} />
      </section>
      <section className={section}>
        <h2 className="text-base font-semibold">Tasks</h2>
        <TaskBoard run={run} />
      </section>
      <section className={section}>
        <h2 className="text-base font-semibold">Blockers</h2>
        <BlockersPanel blockers={run.blockers} />
      </section>
      <section className={section}>
        <h2 className="text-base font-semibold">Usage</h2>
        <UsagePanel run={run} />
      </section>
      <section className={section}>
        <h2 className="text-base font-semibold">Deviations</h2>
        <Deviations run={run} />
      </section>
      <section className={section}>
        <h2 className="text-base font-semibold">Event log</h2>
        <EventLog events={events} />
      </section>
    </div>
  );
}
