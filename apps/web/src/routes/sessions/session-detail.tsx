import { formatCost } from "@/lib/format";
import type { SessionEventInfo, SessionInfo } from "@/lib/store";
import { RunBadge, SessionStateBadge, sessionTokens } from "./sessions-grid";

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

export function SessionDetail({
  session: s,
  events,
}: {
  session: SessionInfo;
  events: SessionEventInfo[];
}) {
  const tokens = sessionTokens(s);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{s.project ?? s.sessionId}</h2>
          <SessionStateBadge state={s.state} />
          {s.linkedRun ? <RunBadge runId={s.linkedRun} /> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {s.model ?? "unknown model"}
          {s.cwd ? ` · ${s.cwd}` : ""}
        </p>
        {s.currentTool ? <p className="font-mono text-sm">{s.currentTool}</p> : null}
      </header>
      <section className="space-y-2">
        <h3 className="font-semibold">Usage</h3>
        {s.usage ? (
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5" data-testid="session-usage">
            <div>
              <dt className="text-muted-foreground">Input</dt>
              <dd>{s.usage.input}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Output</dt>
              <dd>{s.usage.output}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cache read</dt>
              <dd>{s.usage.cacheRead}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total tokens</dt>
              <dd>{tokens}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cost</dt>
              <dd>{formatCost(s.usage.costUsd)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No usage data.</p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">Timeline</h3>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events.</p>
        ) : (
          <ol className="space-y-1 text-sm" data-testid="session-timeline">
            {events.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only
              <li key={`${e.ts}-${i}`} data-testid="session-event" className="flex gap-3">
                <time className="font-mono text-xs text-muted-foreground">
                  {new Date(e.ts).toISOString().slice(11, 19)}
                </time>
                <span>{describeEvent(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
