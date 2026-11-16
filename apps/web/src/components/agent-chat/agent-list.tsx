import type { AgentInfo } from "@tlc-deck/protocol";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { AgentChatLive } from "./agent-chat";

export function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentInfo;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="agent-row"
        aria-pressed={selected}
        onClick={() => onSelect(agent.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-muted",
          selected && "bg-muted",
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full",
            agent.status === "running"
              ? "bg-blue-500"
              : agent.status === "error"
                ? "bg-red-500"
                : "bg-emerald-500",
          )}
        />
        <span className="truncate font-medium">{agent.label ?? agent.role ?? agent.id}</span>
        {agent.model && <span className="text-muted-foreground">{agent.model}</span>}
        <span className="ml-auto text-muted-foreground">{agent.status}</span>
      </button>
    </li>
  );
}

/** Session agents: main/subagents first, workflow agents grouped by workflow then phase. */
export function groupSessionAgents(agents: AgentInfo[]) {
  const plain = agents.filter((a) => !a.workflowId);
  const workflows = new Map<string, Map<string, AgentInfo[]>>();
  for (const a of agents) {
    if (!a.workflowId) continue;
    const phases = workflows.get(a.workflowId) ?? new Map<string, AgentInfo[]>();
    const phase = a.stage ?? "";
    phases.set(phase, [...(phases.get(phase) ?? []), a]);
    workflows.set(a.workflowId, phases);
  }
  return { plain, workflows };
}

export function SessionAgents({
  agents,
  fetchFn,
  EventSourceCtor,
}: {
  agents: AgentInfo[];
  fetchFn?: typeof fetch | undefined;
  EventSourceCtor?: typeof EventSource | undefined;
}) {
  const [selected, setSelected] = useState<string>();
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground">No agents recorded for this session.</p>;
  }
  const { plain, workflows } = groupSessionAgents(agents);
  const current = agents.find((a) => a.id === selected);
  return (
    <div className="space-y-3" data-testid="session-agents">
      {plain.length > 0 && (
        <ul className="space-y-1">
          {plain.map((a) => (
            <AgentRow key={a.id} agent={a} selected={a.id === selected} onSelect={setSelected} />
          ))}
        </ul>
      )}
      {[...workflows].map(([wf, phases]) => (
        <div key={wf} data-testid="workflow-group" className="space-y-1.5">
          <div className="font-mono text-xs font-semibold">workflow {wf}</div>
          {[...phases].map(([phase, list]) => (
            <div key={phase || "none"} data-testid="phase-group" className="space-y-1 pl-3">
              <div className="text-xs text-muted-foreground">{phase || "unassigned"}</div>
              <ul className="space-y-1">
                {list.map((a) => (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    selected={a.id === selected}
                    onSelect={setSelected}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
      {current && (
        <AgentChatLive
          key={current.id}
          agent={current}
          fetchFn={fetchFn}
          EventSourceCtor={EventSourceCtor}
        />
      )}
    </div>
  );
}
