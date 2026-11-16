import { useEffect, useState } from "react";
import { type SessionEventInfo, type SessionInfo, useDeck } from "@/lib/store";
import { SessionDetail } from "./session-detail";

/** Fetches /api/sessions/:id (session + events); refetches when the live session changes. */
export function SessionPage({ id, fetchFn }: { id: string; fetchFn?: typeof fetch }) {
  const live = useDeck((s) => s.sessions.find((x) => x.sessionId === id));
  const [data, setData] = useState<{ session: SessionInfo; events: SessionEventInfo[] } | null>(
    null,
  );
  const [missing, setMissing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` is the refetch trigger
  useEffect(() => {
    let cancelled = false;
    (fetchFn ?? fetch)(`/api/sessions/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setMissing(true);
        const { events, ...session } = (await res.json()) as SessionInfo & {
          events: SessionEventInfo[];
        };
        setMissing(false);
        setData({ session, events });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, live, fetchFn]);
  if (missing) return <p className="text-sm text-muted-foreground">Session not found.</p>;
  const session = live ?? data?.session;
  if (!session) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <SessionDetail session={session} events={data?.events ?? []} />;
}
