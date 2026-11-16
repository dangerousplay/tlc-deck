import type { RunState } from "@tlc-deck/protocol";
import { create } from "zustand";

export type SessionState = "working" | "waiting" | "idle" | "ended";

export interface SessionInfo {
  sessionId: string;
  cwd?: string;
  project?: string;
  model?: string;
  state: SessionState;
  currentTool?: string;
  lastPrompt?: string;
  subagents: { agentId: string; agentType?: string }[];
  startedAt: number;
  lastSeen: number;
  linkedRun?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
}

export interface SessionEventInfo {
  ts: number;
  kind: string;
  tool?: string;
  prompt?: string;
  toolInput?: string;
  agentId?: string;
  agentType?: string;
  notification?: string;
}

export type Connection = "connecting" | "open" | "closed";

export interface DeckStore {
  runs: RunState[];
  sessions: SessionInfo[];
  connection: Connection;
  setRuns(runs: RunState[]): void;
  setSessions(sessions: SessionInfo[]): void;
  upsertSession(session: SessionInfo): void;
  setConnection(c: Connection): void;
}

export const useDeck = create<DeckStore>((set) => ({
  runs: [],
  sessions: [],
  connection: "connecting",
  setRuns: (runs) => set({ runs }),
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (session) =>
    set((st) => {
      const i = st.sessions.findIndex((x) => x.sessionId === session.sessionId);
      if (i < 0) return { sessions: [session, ...st.sessions] };
      const next = st.sessions.slice();
      next[i] = session;
      return { sessions: next };
    }),
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
  const { setRuns, setSessions, upsertSession, setConnection } = useDeck.getState();
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
        const snap = JSON.parse(e.data) as {
          snapshot?: { runs?: RunState[]; sessions?: SessionInfo[] };
        };
        setConnection("open");
        setRuns(snap.snapshot?.runs ?? []);
        setSessions(snap.snapshot?.sessions ?? []);
      } catch {
        // ignore malformed
      }
    };
    es.addEventListener("STATE_SNAPSHOT", onSnapshot as EventListener);
    // Any other event changes a run: refetch the folded state.
    es.onmessage = () => void refetch();
    for (const t of ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "STEP_STARTED", "STEP_FINISHED"]) {
      es.addEventListener(t, () => void refetch());
    }
    es.addEventListener("CUSTOM", ((e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as { name?: string; value?: SessionInfo };
        if (ev.name === "tlc.session" && ev.value?.sessionId) return upsertSession(ev.value);
      } catch {
        // fall through to refetch
      }
      void refetch();
    }) as EventListener);
  };
  open();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
