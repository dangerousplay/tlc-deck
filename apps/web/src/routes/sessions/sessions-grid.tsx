import { Bot, Coins, Cpu, MonitorDot, Wrench } from "lucide-react";
import { EmptyState, SessionStateBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCost } from "@/lib/format";
import type { SessionInfo } from "@/lib/store";

export { SessionStateBadge };

export function sessionTokens(s: SessionInfo): number | null {
  const u = s.usage;
  return u ? u.input + u.output + u.cacheRead + u.cacheWrite : null;
}

export function RunBadge({ runId }: { runId: string }) {
  return (
    <a href={`/runs/${encodeURIComponent(runId)}`} data-testid="linked-run">
      <Badge
        variant="outline"
        className="border-emerald-500/25 bg-emerald-500/10 font-mono text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
      >
        run {runId}
      </Badge>
    </a>
  );
}

export function SessionCard({ session: s }: { session: SessionInfo }) {
  const tokens = sessionTokens(s);
  return (
    <Card className="gap-3 py-4" data-testid="session-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4">
        <a
          href={`/sessions/${encodeURIComponent(s.sessionId)}`}
          className="truncate font-medium hover:underline"
          data-testid="session-project"
        >
          {s.project ?? s.sessionId}
        </a>
        <SessionStateBadge state={s.state} />
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1" data-testid="session-model">
            <Cpu className="size-3" aria-hidden />
            {s.model ?? "unknown model"}
          </span>
        </div>
        {s.currentTool ? (
          <div
            className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 font-mono text-xs"
            data-testid="session-tool"
          >
            <Wrench className="size-3" aria-hidden />
            {s.currentTool}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <span className="flex items-center gap-1" data-testid="session-tokens">
            {tokens === null ? "- tokens" : `${tokens} tokens`}
          </span>
          <span className="flex items-center gap-1" data-testid="session-cost">
            <Coins className="size-3" aria-hidden />
            {formatCost(s.usage ? s.usage.costUsd : null)}
          </span>
          <span className="flex items-center gap-1" data-testid="session-subagents">
            <Bot className="size-3" aria-hidden />
            {s.subagents.length} subagent{s.subagents.length === 1 ? "" : "s"}
          </span>
        </div>
        {s.subagents.length > 0 ? (
          <ul className="flex flex-wrap gap-1" data-testid="session-subagent-list">
            {s.subagents.map((a) => (
              <li key={a.agentId}>
                <Badge variant="secondary" className="font-mono">
                  {a.agentType ?? a.agentId}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {s.linkedRun ? <RunBadge runId={s.linkedRun} /> : null}
      </CardContent>
    </Card>
  );
}

export function SessionsGrid({ sessions }: { sessions: SessionInfo[] }) {
  if (sessions.length === 0) {
    return <EmptyState icon={MonitorDot}>No live sessions.</EmptyState>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((s) => (
        <SessionCard key={s.sessionId} session={s} />
      ))}
    </div>
  );
}
