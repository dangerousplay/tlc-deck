import { Badge } from "@/components/ui/badge";
import { formatCost } from "@/lib/format";
import type { SessionInfo, SessionState } from "@/lib/store";

const VARIANT: Record<SessionState, "default" | "warning" | "secondary" | "outline"> = {
  working: "default",
  waiting: "warning",
  idle: "secondary",
  ended: "outline",
};

export function sessionTokens(s: SessionInfo): number | null {
  const u = s.usage;
  return u ? u.input + u.output + u.cacheRead + u.cacheWrite : null;
}

export function SessionStateBadge({ state }: { state: SessionState }) {
  return (
    <Badge variant={VARIANT[state]} data-testid="session-state">
      {state}
    </Badge>
  );
}

export function RunBadge({ runId }: { runId: string }) {
  return (
    <a href={`/runs/${encodeURIComponent(runId)}`} data-testid="linked-run">
      <Badge variant="success">run {runId}</Badge>
    </a>
  );
}

export function SessionCard({ session: s }: { session: SessionInfo }) {
  const tokens = sessionTokens(s);
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="session-card">
      <div className="flex items-center justify-between gap-2">
        <a
          href={`/sessions/${encodeURIComponent(s.sessionId)}`}
          className="truncate font-medium hover:underline"
          data-testid="session-project"
        >
          {s.project ?? s.sessionId}
        </a>
        <SessionStateBadge state={s.state} />
      </div>
      <div className="text-xs text-muted-foreground" data-testid="session-model">
        {s.model ?? "unknown model"}
      </div>
      {s.currentTool ? (
        <div className="font-mono text-sm" data-testid="session-tool">
          {s.currentTool}
        </div>
      ) : null}
      <div className="flex gap-3 text-xs text-muted-foreground">
        <span data-testid="session-tokens">
          {tokens === null ? "- tokens" : `${tokens} tokens`}
        </span>
        <span data-testid="session-cost">{formatCost(s.usage ? s.usage.costUsd : null)}</span>
        <span data-testid="session-subagents">
          {s.subagents.length} subagent{s.subagents.length === 1 ? "" : "s"}
        </span>
      </div>
      {s.subagents.length > 0 ? (
        <ul className="text-xs" data-testid="session-subagent-list">
          {s.subagents.map((a) => (
            <li key={a.agentId}>{a.agentType ?? a.agentId}</li>
          ))}
        </ul>
      ) : null}
      {s.linkedRun ? <RunBadge runId={s.linkedRun} /> : null}
    </div>
  );
}

export function SessionsGrid({ sessions }: { sessions: SessionInfo[] }) {
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No live sessions.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((s) => (
        <SessionCard key={s.sessionId} session={s} />
      ))}
    </div>
  );
}
