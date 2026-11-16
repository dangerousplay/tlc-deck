import type { RunState } from "@tlc-deck/protocol";
import { create } from "zustand";

export type Connection = "connecting" | "open" | "closed";

export interface DeckStore {
  runs: RunState[];
  connection: Connection;
  setRuns(runs: RunState[]): void;
  setConnection(c: Connection): void;
}

export const useDeck = create<DeckStore>((set) => ({
  runs: [],
  connection: "connecting",
  setRuns: (runs) => set({ runs }),
  setConnection: (connection) => set({ connection }),
}));

export interface ConnectOptions {
  url?: string;
  runsUrl?: string;
  reconnectMs?: number;
  EventSourceCtor?: typeof EventSource;
  fetchFn?: typeof fetch;
}

/** Connect the store to the SSE stream. Reconnects after errors. Returns a disposer. */
export function connectStore(opts: ConnectOptions = {}): () => void {
  const url = opts.url ?? "/api/stream";
  const runsUrl = opts.runsUrl ?? "/api/runs";
  const reconnectMs = opts.reconnectMs ?? 2000;
  const ES = opts.EventSourceCtor ?? EventSource;
  const doFetch = opts.fetchFn ?? fetch;
  const { setRuns, setConnection } = useDeck.getState();
  let es: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const refetch = async () => {
    try {
      const res = await doFetch(runsUrl);
      if (res.ok && !disposed) setRuns((await res.json()) as RunState[]);
    } catch {
      // next event or reconnect retries
    }
  };

  const open = () => {
    setConnection("connecting");
    es = new ES(url);
    es.onopen = () => setConnection("open");
    es.onerror = () => {
      es?.close();
      setConnection("closed");
      if (!disposed) timer = setTimeout(open, reconnectMs);
    };
    const onSnapshot = (e: MessageEvent) => {
      try {
        const snap = JSON.parse(e.data) as { snapshot?: { runs?: RunState[] } };
        setConnection("open");
        setRuns(snap.snapshot?.runs ?? []);
      } catch {
        // ignore malformed
      }
    };
    es.addEventListener("STATE_SNAPSHOT", onSnapshot as EventListener);
    // Any other event changes a run: refetch the folded state.
    es.onmessage = () => void refetch();
    for (const t of [
      "RUN_STARTED",
      "RUN_FINISHED",
      "RUN_ERROR",
      "STEP_STARTED",
      "STEP_FINISHED",
      "CUSTOM",
    ]) {
      es.addEventListener(t, () => void refetch());
    }
  };
  open();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
