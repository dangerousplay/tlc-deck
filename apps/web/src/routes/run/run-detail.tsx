import type { BlockerState, RunState, TaskState, TaskStatus, TlcEvent } from "@tlc-deck/protocol";
import {
  AlertOctagon,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock,
  Coins,
  GitCommit,
  Lightbulb,
  Loader2,
  type LucideIcon,
  ShieldAlert,
  SkipForward,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { EmptyState, RunStatusBadge, type Tone, toneClass } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { clock, elapsed, formatCost, formatTokens, runCost, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TaskContent } from "@/routes/task/task-page";
import { taskHref } from "@/routes/task/task-view";

export const BOARD_COLUMNS = [
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
  "skipped",
] as const;

const COLUMN_META: Record<TaskStatus, { icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  pending: { icon: CircleDashed, tone: "muted" },
  running: { icon: Loader2, tone: "blue", spin: true },
  blocked: { icon: ShieldAlert, tone: "amber" },
  done: { icon: CheckCircle2, tone: "green" },
  failed: { icon: XCircle, tone: "red" },
  skipped: { icon: SkipForward, tone: "muted" },
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function RunHeader({ run, now = Date.now() }: { run: RunState; now?: number }) {
  const roles = Object.keys(run.usageByRole);
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="break-all font-mono text-lg font-semibold">{run.runId}</h2>
          <RunStatusBadge status={run.status} testId="run-status" />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Repo">{run.repo ?? "—"}</Fact>
          <Fact label="Feature">{run.feature ?? "—"}</Fact>
          <Fact label="Harness">{run.harness ?? "—"}</Fact>
          <Fact label="Elapsed">
            {elapsed(run, now)}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {timeAgo(run.startedAt, now)}
            </span>
          </Fact>
          <Fact label="Cost">{formatCost(runCost(run))}</Fact>
          <Fact label="Roles">
            {roles.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-wrap gap-1">
                {roles.map((r) => (
                  <Badge key={r} variant="secondary" className="font-normal">
                    {r}
                  </Badge>
                ))}
              </span>
            )}
          </Fact>
        </dl>
      </CardHeader>
    </Card>
  );
}

export function MilestoneStepper({ run }: { run: RunState }) {
  if (run.milestones.length === 0) return null;
  const current = run.status === "running" ? run.milestones.findIndex((m) => !m.reached) : -1;
  return (
    <ol className="flex flex-col gap-4 md:flex-row md:gap-0" aria-label="Milestones">
      {run.milestones.map((m, i) => (
        <li
          key={m.name}
          data-testid="milestone"
          data-reached={m.reached}
          className="relative flex min-w-0 items-center gap-3 md:flex-1 md:flex-col md:gap-2"
        >
          {i > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute top-3.5 right-1/2 hidden h-0.5 w-full -translate-y-1/2 md:block",
                run.milestones[i - 1]?.reached ? "bg-emerald-500" : "bg-border",
              )}
            />
          )}
          <span
            className={cn(
              "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-background text-xs font-medium tabular-nums",
              m.reached && "border-emerald-500 bg-emerald-500 text-white",
              i === current &&
                "border-blue-500 text-blue-600 ring-4 ring-blue-500/15 dark:text-blue-400",
              !m.reached && i !== current && "text-muted-foreground",
            )}
          >
            {m.reached ? <Check className="size-4" aria-hidden /> : i + 1}
          </span>
          <span
            className={cn(
              "truncate text-sm md:max-w-full md:px-1 md:text-center",
              m.reached || i === current ? "font-medium" : "text-muted-foreground",
            )}
          >
            {m.name}
          </span>
        </li>
      ))}
    </ol>
  );
}

function TaskCard({
  task,
  runId,
  onOpen,
}: {
  task: TaskState;
  runId: string;
  onOpen?: ((id: string) => void) | undefined;
}) {
  return (
    <li
      data-testid="task-card"
      className="relative space-y-1.5 rounded-lg border bg-background p-2.5 text-sm shadow-xs hover:bg-muted/40"
    >
      <a
        href={taskHref(runId, task.id)}
        data-testid="task-link"
        aria-label={`Open task ${task.id}`}
        className="absolute inset-0 rounded-lg"
        onClick={(e) => {
          if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(task.id);
        }}
      >
        <span className="sr-only">Open task {task.id}</span>
      </a>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold">{task.id}</span>
        {task.gate &&
          (task.gate.pass ? (
            <CheckCircle2 className="size-4 text-emerald-500" aria-label="gate pass" />
          ) : (
            <XCircle className="size-4 text-red-500" aria-label="gate fail" />
          ))}
      </div>
      {task.title && <div className="line-clamp-2 text-xs leading-snug">{task.title}</div>}
      {(task.stage || task.attempt !== undefined || task.commit) && (
        <div className="flex flex-wrap items-center gap-1">
          {task.stage && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {task.stage}
            </Badge>
          )}
          {task.attempt !== undefined && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              attempt {task.attempt}
            </Badge>
          )}
          {task.commit && (
            <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground">
              <GitCommit className="size-3" aria-hidden />
              {task.commit.slice(0, 7)}
            </span>
          )}
        </div>
      )}
      {task.gate && (
        <p
          className={cn(
            "line-clamp-2 text-[11px]",
            task.gate.pass ? "text-muted-foreground" : "text-red-600 dark:text-red-400",
          )}
        >
          {task.gate.summary}
        </p>
      )}
    </li>
  );
}

export function TaskBoard({
  run,
  onOpenTask,
}: {
  run: RunState;
  onOpenTask?: (id: string) => void;
}) {
  const tasks = Object.values(run.tasks);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {BOARD_COLUMNS.map((status: TaskStatus) => {
        const list = tasks.filter((t) => t.status === status);
        const meta = COLUMN_META[status];
        return (
          <section
            key={status}
            data-testid={`col-${status}`}
            className={cn(
              "min-w-0 flex-col gap-2 rounded-xl border bg-muted/40 p-2",
              list.length === 0 ? "hidden md:flex" : "flex",
            )}
          >
            <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium capitalize">
              <meta.icon className={cn("size-3.5", meta.spin && "animate-spin")} aria-hidden />
              {status}
              <span
                data-testid={`count-${status}`}
                className={cn(
                  "ml-auto rounded-full border px-1.5 text-[11px] tabular-nums",
                  toneClass(meta.tone),
                )}
              >
                {list.length}
              </span>
            </h3>
            <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-80">
              {list.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-muted-foreground">No tasks</p>
              ) : (
                <ul className="space-y-2 pr-2">
                  {list.map((t) => (
                    <TaskCard key={t.id} task={t} runId={run.runId} onOpen={onOpenTask} />
                  ))}
                </ul>
              )}
            </ScrollArea>
          </section>
        );
      })}
    </div>
  );
}

export function BlockersPanel({ blockers }: { blockers: BlockerState[] }) {
  const open = blockers.filter((b) => b.open);
  if (open.length === 0) {
    return <EmptyState icon={CheckCircle2}>No open blockers.</EmptyState>;
  }
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {open.map((b) => (
        <li key={b.id} data-testid="blocker">
          <Card className="gap-2 border-red-500/30 bg-red-500/5 py-4">
            <CardHeader className="flex flex-row items-center gap-2 px-4">
              <AlertOctagon className="size-4 text-red-500" aria-hidden />
              <Badge variant="outline" className={toneClass("red")}>
                {b.kind}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">{b.task}</span>
            </CardHeader>
            <CardContent className="space-y-2 px-4 text-sm">
              <p>{b.reason}</p>
              {b.advice && (
                <div className="flex gap-2 rounded-lg border bg-background/70 p-2.5 text-xs text-muted-foreground">
                  <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
                  <p>
                    <span className="font-medium text-foreground">Advisor:</span> {b.advice}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

type Row = { name: string; tokens: number; cost: number | null };

const chartConfig = { tokens: { label: "Tokens", color: "var(--chart-1)" } } satisfies ChartConfig;

function UsageChart({ title, data }: { title: string; data: RunState["usageByRole"] }) {
  const rows: Row[] = Object.entries(data).map(([name, u]) => ({
    name,
    tokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: u.costUsd,
  }));
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No usage.</p>
      ) : (
        <>
          <ChartContainer
            config={chartConfig}
            className="w-full"
            style={{ height: rows.length * 40 + 12 }}
          >
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ left: 0, right: 8, top: 0, bottom: 0 }}
            >
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={96}
                tick={{ fontSize: 11 }}
              />
              <XAxis type="number" hide />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                content={({ active, payload }) => {
                  const r = payload?.[0]?.payload as Row | undefined;
                  if (!active || !r) return null;
                  return (
                    <div className="grid gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                      <span className="font-medium">{r.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {r.tokens.toLocaleString()} tokens · {formatCost(r.cost)}
                      </span>
                    </div>
                  );
                }}
              />
              <Bar dataKey="tokens" fill="var(--color-tokens)" radius={4} barSize={18} />
            </BarChart>
          </ChartContainer>
          <ul className="space-y-1">
            {rows.map((r) => (
              <li
                key={r.name}
                data-testid="usage-row"
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate font-mono">{r.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatTokens(r.tokens)} tok · {formatCost(r.cost)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function UsagePanel({ run }: { run: RunState }) {
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
      <UsageChart title="By role" data={run.usageByRole} />
      <UsageChart title="By model" data={run.usageByModel} />
    </div>
  );
}

export function Deviations({ run }: { run: RunState }) {
  const items = Object.values(run.tasks).flatMap((t) =>
    (t.deviations ?? []).map((d) => ({ task: t.id, text: d })),
  );
  if (items.length === 0) return <EmptyState icon={CheckCircle2}>No deviations.</EmptyState>;
  return (
    <ul className="space-y-2 text-sm">
      {items.map((d) => (
        <li
          key={`${d.task}-${d.text}`}
          data-testid="deviation"
          className="rounded-lg border bg-muted/40 px-3 py-2"
        >
          <span className="mr-2 font-mono text-xs font-semibold">{d.task}</span> {d.text}
        </li>
      ))}
    </ul>
  );
}

const ROW_H = 26;
const VIEW_H = 320;
const OVERSCAN = 5;

function describe(e: TlcEvent): string {
  const v = e.value as { message?: string; text?: string } | undefined;
  const detail = e.name ? ` ${e.name}` : "";
  const msg = v?.message ?? v?.text;
  return `${e.type}${detail}${msg ? ` ${msg}` : ""}`;
}

function eventTone(e: TlcEvent): string {
  if (e.type === "RUN_ERROR") return "text-red-600 dark:text-red-400";
  if (e.type.startsWith("RUN_")) return "text-blue-600 dark:text-blue-400";
  if (e.type.startsWith("STEP_")) return "text-muted-foreground";
  if (e.name?.includes("block")) return "text-amber-600 dark:text-amber-400";
  if (e.name?.includes("task")) return "text-emerald-600 dark:text-emerald-400";
  return "text-violet-600 dark:text-violet-400";
}

export function EventLog({ events }: { events: TlcEvent[] }) {
  const [top, setTop] = useState(0);
  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const end = Math.min(events.length, Math.ceil((top + VIEW_H) / ROW_H) + OVERSCAN);
  if (events.length === 0) return <EmptyState icon={Clock}>No events yet.</EmptyState>;
  return (
    <ScrollArea
      data-testid="event-log"
      className="rounded-lg border bg-muted/30 font-mono text-xs [&>[data-slot=scroll-area-viewport]]:h-80"
      style={{ height: VIEW_H }}
      onViewportScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: events.length * ROW_H, position: "relative" }}>
        {events.slice(start, end).map((e, i) => (
          <div
            key={e.metadata.seq}
            data-testid="log-row"
            className={cn("absolute flex w-full items-center gap-3 px-3", eventTone(e))}
            style={{ top: (start + i) * ROW_H, height: ROW_H }}
          >
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {clock(e.timestamp ?? 0)}
            </span>
            <span className="truncate">{describe(e)}</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
  const mobile = useIsMobile();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <RunHeader run={run} now={now} />
      {run.milestones.length > 0 && (
        <Section title="Milestones">
          <MilestoneStepper run={run} />
        </Section>
      )}
      <Section title="Tasks" description="Task board grouped by status">
        <TaskBoard run={run} {...(mobile ? {} : { onOpenTask: setOpen })} />
      </Section>
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-xl">
          <SheetTitle className="sr-only">Task {open}</SheetTitle>
          <SheetDescription className="sr-only">Task details</SheetDescription>
          {open && (
            <div className="space-y-3 pt-6">
              <a
                href={taskHref(run.runId, open)}
                data-testid="task-full-page"
                className="text-xs text-muted-foreground hover:underline"
              >
                Open full page
              </a>
              <TaskContent runId={run.runId} taskId={open} />
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Section title="Blockers">
        <BlockersPanel blockers={run.blockers} />
      </Section>
      <Section title="Usage" description="Tokens and cost by role and model">
        <UsagePanel run={run} />
      </Section>
      <Section title="Deviations">
        <Deviations run={run} />
      </Section>
      <Section title="Event log">
        <EventLog events={events} />
      </Section>
    </div>
  );
}
