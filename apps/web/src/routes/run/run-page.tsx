import type { RunState, TlcEvent } from "@tlc-deck/protocol";
import { useEffect, useState } from "react";
import { useDeck } from "@/lib/store";
import { RunDetail } from "./run-detail";

/** Fetches /api/runs/:id (state + events); refetches whenever the store's run changes. */
export function RunPage({ id, fetchFn }: { id: string; fetchFn?: typeof fetch }) {
  const live = useDeck((s) => s.runs.find((r) => r.runId === id));
  const [data, setData] = useState<{ run: RunState; events: TlcEvent[] } | null>(null);
  const [missing, setMissing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` is the refetch trigger
  useEffect(() => {
    let cancelled = false;
    const doFetch = fetchFn ?? fetch;
    doFetch(`/api/runs/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setMissing(true);
        const { events, ...run } = (await res.json()) as RunState & { events: TlcEvent[] };
        setMissing(false);
        setData({ run, events });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, live, fetchFn]);
  if (missing) return <p className="text-sm text-muted-foreground">Run not found.</p>;
  const run = live ?? data?.run;
  if (!run) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <RunDetail run={run} events={data?.events ?? []} />;
}
