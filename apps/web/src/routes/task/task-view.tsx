import type { TaskDetails } from "@tlc-deck/core";
import type { AgentInfo, TaskState } from "@tlc-deck/protocol";
import { CheckSquare, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MiniMarkdown } from "./mini-markdown";

export interface StageEntry {
  stage: string;
  attempt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export interface TaskData {
  details: TaskDetails | null;
  notice?: string;
  state: { task: TaskState | null; stages: StageEntry[] };
}

export function taskHref(runId: string, taskId: string): string {
  return `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

const STATUS_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  running: "bg-blue-500",
  failed: "bg-red-500",
  blocked: "bg-amber-500",
};

export function StageTimeline({
  stages,
  current,
}: {
  stages: StageEntry[];
  current?: string | undefined;
}) {
  if (stages.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages recorded yet.</p>;
  }
  return (
    <ol data-testid="stage-timeline" className="space-y-2 border-l pl-4">
      {stages.map((s, i) => {
        const open = s.endedAt === undefined;
        return (
          <li
            key={`${s.stage}-${s.attempt}-${s.startedAt ?? i}`}
            data-testid="stage-entry"
            data-open={open}
            className="relative flex flex-wrap items-center gap-2 text-sm"
          >
            <span
              aria-hidden
              className={cn(
                "absolute -left-[1.3rem] size-2.5 rounded-full border-2 border-background",
                open ? STATUS_DOT[current === "failed" ? "failed" : "running"] : "bg-emerald-500",
                open && current !== "failed" && "animate-pulse",
              )}
            />
            <span className="font-medium">{s.stage}</span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              attempt {s.attempt}
            </Badge>
            <span className="text-xs tabular-nums text-muted-foreground">
              {open ? "in progress" : fmtDuration(s.durationMs)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function StageAgents({ stages, agents }: { stages: StageEntry[]; agents: AgentInfo[] }) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground">No agents recorded for this task.</p>;
  }
  const names = [...new Set([...stages.map((s) => s.stage), ...agents.map((a) => a.stage ?? "")])];
  return (
    <div className="space-y-3" data-testid="stage-agents">
      {names.map((stage) => {
        const list = agents.filter((a) => (a.stage ?? "") === stage);
        if (list.length === 0) return null;
        return (
          <div key={stage || "none"} className="space-y-1">
            <div className="text-xs font-medium">{stage || "unassigned"}</div>
            <ul className="space-y-1">
              {list.map((a) => (
                <li
                  key={a.id}
                  data-testid="agent-row"
                  className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      a.status === "running"
                        ? "bg-blue-500"
                        : a.status === "error"
                          ? "bg-red-500"
                          : "bg-emerald-500",
                    )}
                  />
                  <span className="truncate font-medium">{a.label ?? a.role ?? a.id}</span>
                  {a.model && <span className="text-muted-foreground">{a.model}</span>}
                  <span className="ml-auto text-muted-foreground">{a.status}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function TaskView({
  runId,
  taskId,
  data,
  agents = [],
}: {
  runId: string;
  taskId: string;
  data: TaskData;
  agents?: AgentInfo[];
}) {
  const { details, notice, state } = data;
  const task = state.task;
  return (
    <div data-testid="task-view" className="space-y-5">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold">{taskId}</span>
          {task && (
            <Badge variant="secondary" data-testid="task-status">
              {task.status}
            </Badge>
          )}
          {task?.attempt !== undefined && <Badge variant="outline">attempt {task.attempt}</Badge>}
          {details?.milestone && (
            <span className="text-xs text-muted-foreground">{details.milestone}</span>
          )}
        </div>
        <h2 className="text-base font-semibold leading-snug">
          {details?.title ?? task?.title ?? taskId}
        </h2>
      </header>

      {notice && (
        <p
          data-testid="task-notice"
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
        >
          {notice}
        </p>
      )}

      {details && (
        <div className="space-y-5" data-testid="task-spec">
          <Block title="What">
            <MiniMarkdown text={details.what} />
          </Block>
          <Block title="Where">
            <MiniMarkdown text={details.where} />
          </Block>
          {details.dependsOn.length > 0 && (
            <Block title="Depends on">
              <div className="flex flex-wrap gap-1.5">
                {details.dependsOn.map((d) => (
                  <a
                    key={d}
                    href={taskHref(runId, d)}
                    data-testid="dep-link"
                    className="rounded-md border px-1.5 py-0.5 font-mono text-xs hover:bg-muted"
                  >
                    {d}
                  </a>
                ))}
              </div>
            </Block>
          )}
          {details.requirements.length > 0 && (
            <Block title="Requirements">
              <ul className="space-y-1.5 text-sm">
                {details.requirements.map((r) => (
                  <li key={r.id} data-testid="requirement" className="flex gap-2">
                    <span className="shrink-0 font-mono text-xs font-semibold">{r.id}</span>
                    <span className="text-muted-foreground">{r.text || "(no text in spec)"}</span>
                  </li>
                ))}
              </ul>
            </Block>
          )}
          <Block title="Done when">
            <ul className="space-y-1 text-sm">
              {details.doneWhen.map((d) => (
                <li
                  key={d.text}
                  data-testid="done-when"
                  data-checked={d.checked}
                  className="flex items-start gap-2"
                >
                  {d.checked ? (
                    <CheckSquare className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
                  ) : (
                    <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={cn(d.checked && "text-muted-foreground")}>{d.text}</span>
                </li>
              ))}
            </ul>
          </Block>
          {details.tests && (
            <Block title="Tests">
              <MiniMarkdown text={details.tests} />
            </Block>
          )}
          {details.gate && (
            <Block title="Gate">
              <MiniMarkdown text={details.gate} />
            </Block>
          )}
        </div>
      )}

      <Block title="Stages">
        <StageTimeline stages={state.stages} current={task?.status} />
      </Block>
      <Block title="Agents">
        <StageAgents stages={state.stages} agents={agents} />
      </Block>
    </div>
  );
}
