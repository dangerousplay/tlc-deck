import type { AgentInfo } from "@tlc-deck/protocol";
import {
  Bell,
  Bot,
  CheckCircle2,
  Circle,
  type LucideIcon,
  MessageSquare,
  Wrench,
} from "lucide-react";
import { SessionAgents } from "@/components/agent-chat";
import { EmptyState, SessionStateBadge } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clock, formatCost, formatTokens } from "@/lib/format";
import type { SessionEventInfo, SessionInfo } from "@/lib/store";
import { RunBadge, sessionTokens } from "./sessions-grid";

export function describeEvent(e: SessionEventInfo): string {
  switch (e.kind) {
    case "UserPromptSubmit":
      return `prompt: ${e.prompt ?? ""}`;
    case "PreToolUse":
      return `tool: ${e.tool ?? ""}${e.toolInput ? ` ${e.toolInput}` : ""}`;
    case "PostToolUse":
      return `tool done: ${e.tool ?? ""}`;
    case "SubagentStart":
      return `subagent started: ${e.agentType ?? e.agentId ?? ""}`;
    case "SubagentStop":
      return `subagent stopped: ${e.agentType ?? e.agentId ?? ""}`;
    case "Notification":
      return `notification: ${e.notification ?? ""}`;
    default:
      return e.kind;
  }
}

const KIND_ICON: Record<string, { icon: LucideIcon; cls: string }> = {
  UserPromptSubmit: { icon: MessageSquare, cls: "text-violet-600 dark:text-violet-400" },
  PreToolUse: { icon: Wrench, cls: "text-blue-600 dark:text-blue-400" },
  PostToolUse: { icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400" },
  SubagentStart: { icon: Bot, cls: "text-cyan-600 dark:text-cyan-400" },
  SubagentStop: { icon: Bot, cls: "text-muted-foreground" },
  Notification: { icon: Bell, cls: "text-amber-600 dark:text-amber-400" },
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function SessionDetail({
  session: s,
  events,
  agents = [],
  fetchFn,
  EventSourceCtor,
}: {
  session: SessionInfo;
  events: SessionEventInfo[];
  agents?: AgentInfo[];
  fetchFn?: typeof fetch | undefined;
  EventSourceCtor?: typeof EventSource | undefined;
}) {
  const tokens = sessionTokens(s);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-lg">{s.project ?? s.sessionId}</CardTitle>
            <SessionStateBadge state={s.state} />
            {s.linkedRun ? <RunBadge runId={s.linkedRun} /> : null}
          </div>
          <p className="break-all text-sm text-muted-foreground">
            {s.model ?? "unknown model"}
            {s.cwd ? ` · ${s.cwd}` : ""}
          </p>
        </CardHeader>
        {s.currentTool ? (
          <CardContent>
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 font-mono text-sm">
              <Wrench className="size-3.5" aria-hidden />
              {s.currentTool}
            </span>
          </CardContent>
        ) : null}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>
          {s.usage ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="session-usage">
              <Stat label="Input" value={s.usage.input} />
              <Stat label="Output" value={s.usage.output} />
              <Stat label="Cache read" value={s.usage.cacheRead} />
              <Stat label="Total tokens" value={tokens ?? formatTokens(null)} />
              <Stat label="Cost" value={formatCost(s.usage.costUsd)} />
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No usage data.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionAgents agents={agents} fetchFn={fetchFn} EventSourceCtor={EventSourceCtor} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <EmptyState>No events.</EmptyState>
          ) : (
            <ol className="relative space-y-4 border-l pl-6" data-testid="session-timeline">
              {events.map((e, i) => {
                const k = KIND_ICON[e.kind] ?? { icon: Circle, cls: "text-muted-foreground" };
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only
                  <li key={`${e.ts}-${i}`} data-testid="session-event" className="relative text-sm">
                    <span className="absolute -left-[37px] flex size-6 items-center justify-center rounded-full border bg-background">
                      <k.icon className={`size-3 ${k.cls}`} aria-hidden />
                    </span>
                    <time className="mr-3 font-mono text-xs tabular-nums text-muted-foreground">
                      {clock(e.ts)}
                    </time>
                    <span className="break-words">{describeEvent(e)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
