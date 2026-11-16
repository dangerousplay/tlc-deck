import type { AgentInfo } from "@tlc-deck/protocol";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeck } from "@/lib/store";
import { type TaskData, TaskView } from "./task-view";

/** Fetches task details + agents; refetches when the live run changes. */
export function useTaskData(runId: string, taskId: string, fetchFn?: typeof fetch) {
  const live = useDeck((s) => s.runs.find((r) => r.runId === runId));
  const [data, setData] = useState<TaskData | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [missing, setMissing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` is the refetch trigger
  useEffect(() => {
    let cancelled = false;
    const doFetch = fetchFn ?? fetch;
    const q = `run=${encodeURIComponent(runId)}&task=${encodeURIComponent(taskId)}`;
    doFetch(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setMissing(true);
        setMissing(false);
        setData((await res.json()) as TaskData);
      })
      .catch(() => {});
    doFetch(`/api/agents?${q}`)
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const list = (await res.json()) as AgentInfo[];
        if (Array.isArray(list)) setAgents(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId, taskId, live, fetchFn]);
  return { data, agents, missing };
}

export function TaskContent({
  runId,
  taskId,
  fetchFn,
}: {
  runId: string;
  taskId: string;
  fetchFn?: typeof fetch;
}) {
  const { data, agents, missing } = useTaskData(runId, taskId, fetchFn);
  if (missing) return <p className="text-sm text-muted-foreground">Run not found.</p>;
  if (!data) return <Skeleton className="h-40 w-full rounded-xl" />;
  return <TaskView runId={runId} taskId={taskId} data={data} agents={agents} fetchFn={fetchFn} />;
}

/** Full-page task view at /runs/:run/tasks/:task. */
export function TaskPage({
  runId,
  taskId,
  fetchFn,
}: {
  runId: string;
  taskId: string;
  fetchFn?: typeof fetch;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <a
        href={`/runs/${encodeURIComponent(runId)}`}
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Run {runId}
      </a>
      <TaskContent runId={runId} taskId={taskId} fetchFn={fetchFn} />
    </div>
  );
}
