import type { AgentItem } from "@tlc-deck/protocol";
import { useEffect, useState } from "react";
import { mergeItems } from "./items";

export interface AgentItemsOptions {
  fetchFn?: typeof fetch | undefined;
  EventSourceCtor?: typeof EventSource | undefined;
}

/**
 * Loads the backlog (`/items`, paged) and follows the per-agent SSE stream,
 * merging both by `seq`. The stream replays the backlog first, so duplicates are expected.
 */
export function useAgentItems(agentId: string | undefined, opts: AgentItemsOptions = {}) {
  const [items, setItems] = useState<AgentItem[]>([]);
  const [live, setLive] = useState(false);
  const { fetchFn, EventSourceCtor } = opts;
  useEffect(() => {
    setItems([]);
    setLive(false);
    if (!agentId) return;
    let disposed = false;
    let es: EventSource | undefined;
    const doFetch = fetchFn ?? fetch;
    const base = `/api/agents/${encodeURIComponent(agentId)}`;
    (async () => {
      try {
        let after = -1;
        for (;;) {
          const res = await doFetch(`${base}/items?after=${after}&limit=500`);
          if (!res.ok || disposed) break;
          const page = (await res.json()) as AgentItem[];
          if (!Array.isArray(page) || page.length === 0) break;
          setItems((cur) => mergeItems(cur, page));
          after = page[page.length - 1]?.seq ?? after;
          if (page.length < 500) break;
        }
      } catch {
        // the stream still delivers the backlog
      }
    })();
    const ES = EventSourceCtor ?? (typeof EventSource === "undefined" ? undefined : EventSource);
    if (ES) {
      es = new ES(`${base}/stream`);
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false);
      es.addEventListener("item", ((e: MessageEvent) => {
        try {
          const it = JSON.parse(e.data) as AgentItem;
          setItems((cur) => mergeItems(cur, [it]));
        } catch {
          // ignore malformed
        }
      }) as EventListener);
    }
    return () => {
      disposed = true;
      es?.close();
    };
  }, [agentId, fetchFn, EventSourceCtor]);
  return { items, live };
}
