import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunState, TlcEvent } from "@tlc-deck/protocol";
import type { Usage, UsageSource } from "./otel/usage.js";
import type { Session, SessionEvent } from "./sessions/model.js";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface UsageRow extends Usage {
  ts: number;
  source: UsageSource;
  sessionId: string;
  runId?: string;
  workflowRunId?: string;
  model?: string;
}

export interface Store {
  /** Insert an event; false when (runId, seq) already exists. */
  insertEvent(event: TlcEvent): boolean;
  eventsOf(runId: string): TlcEvent[];
  saveRun(state: RunState): void;
  getRun(runId: string): RunState | undefined;
  /** Newest first. */
  listRuns(): RunState[];
  saveSession(session: Session): void;
  getSession(sessionId: string): Session | undefined;
  /** Most recently seen first. */
  listSessions(): Session[];
  addSessionEvent(sessionId: string, event: SessionEvent): void;
  sessionEvents(sessionId: string): SessionEvent[];
  addUsage(row: UsageRow): void;
  /** Usage by session or tlc run; OTel api_request events win over metrics when both exist. */
  sumUsage(by: { sessionId: string } | { runId: string }): Usage | undefined;
  /** Whether this workflow run id was seen before, and the tlc run it was linked to. */
  workflowLink(workflowRunId: string): { seen: boolean; runId?: string };
  /** Delete runs, events and sessions last seen before `before`. Returns deleted run count. */
  purge(before: number): number;
  close(): void;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT NOT NULL,
     started_at INTEGER, last_event_at INTEGER, state TEXT NOT NULL
   );
   CREATE TABLE events (
     run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL,
     PRIMARY KEY (run_id, seq)
   );
   CREATE TABLE sessions (
     session_id TEXT PRIMARY KEY, cwd TEXT, project TEXT, state TEXT,
     last_seen INTEGER NOT NULL, data TEXT NOT NULL
   );
   CREATE TABLE session_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL
   );
   CREATE INDEX session_events_session ON session_events(session_id);
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, session_id TEXT, ts INTEGER NOT NULL,
     role TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
     cost_usd REAL
   );`,
  `ALTER TABLE usage ADD COLUMN workflow_run_id TEXT;
   CREATE INDEX usage_session ON usage(session_id);
   CREATE INDEX usage_run ON usage(run_id);
   CREATE INDEX usage_workflow ON usage(workflow_run_id);`,
];

export class SqliteStore implements Store {
  private db: DatabaseSync;

  /** `file` is a path or ":memory:". */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  insertEvent(event: TlcEvent): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO events (run_id, seq, ts, event) VALUES (?, ?, ?, ?)")
      .run(
        event.metadata.runId,
        event.metadata.seq,
        event.timestamp ?? Date.now(),
        JSON.stringify(event),
      );
    return Number(r.changes) > 0;
  }

  eventsOf(runId: string): TlcEvent[] {
    const rows = this.db
      .prepare("SELECT event FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as TlcEvent);
  }

  saveRun(s: RunState): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, thread_id, status, started_at, last_event_at, state)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET thread_id = excluded.thread_id, status = excluded.status,
           started_at = excluded.started_at, last_event_at = excluded.last_event_at, state = excluded.state`,
      )
      .run(
        s.runId,
        s.threadId ?? null,
        s.status,
        s.startedAt ?? null,
        s.lastEventAt ?? null,
        JSON.stringify(s),
      );
  }

  getRun(runId: string): RunState | undefined {
    const row = this.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(runId) as
      | { state: string }
      | undefined;
    return row ? (JSON.parse(row.state) as RunState) : undefined;
  }

  listRuns(): RunState[] {
    const rows = this.db
      .prepare("SELECT state FROM runs ORDER BY COALESCE(last_event_at, started_at, 0) DESC")
      .all() as { state: string }[];
    return rows.map((r) => JSON.parse(r.state) as RunState);
  }

  saveSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, cwd, project, state, last_seen, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, project = excluded.project,
           state = excluded.state, last_seen = excluded.last_seen, data = excluded.data`,
      )
      .run(s.sessionId, s.cwd ?? null, s.project ?? null, s.state, s.lastSeen, JSON.stringify(s));
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.db.prepare("SELECT data FROM sessions WHERE session_id = ?").get(sessionId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Session) : undefined;
  }

  listSessions(): Session[] {
    const rows = this.db.prepare("SELECT data FROM sessions ORDER BY last_seen DESC").all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Session);
  }

  addSessionEvent(sessionId: string, event: SessionEvent): void {
    this.db
      .prepare("INSERT INTO session_events (session_id, ts, event) VALUES (?, ?, ?)")
      .run(sessionId, event.ts, JSON.stringify(event));
  }

  sessionEvents(sessionId: string): SessionEvent[] {
    const rows = this.db
      .prepare("SELECT event FROM session_events WHERE session_id = ? ORDER BY id")
      .all(sessionId) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as SessionEvent);
  }

  addUsage(u: UsageRow): void {
    this.db
      .prepare(
        `INSERT INTO usage (run_id, session_id, ts, role, model, input, output, cache_read, cache_write, cost_usd, workflow_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.runId ?? null,
        u.sessionId,
        u.ts,
        u.source,
        u.model ?? null,
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
        u.costUsd,
        u.workflowRunId ?? null,
      );
  }

  sumUsage(by: { sessionId: string } | { runId: string }): Usage | undefined {
    const [col, val] = "sessionId" in by ? ["session_id", by.sessionId] : ["run_id", by.runId];
    const rows = this.db
      .prepare(
        `SELECT role, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead,
           SUM(cache_write) AS cacheWrite, SUM(cost_usd) AS costUsd
         FROM usage WHERE ${col} = ? AND role IN ('metric', 'log') GROUP BY role`,
      )
      .all(val) as unknown as (Usage & { role: UsageSource })[];
    const row = rows.find((r) => r.role === "log") ?? rows.find((r) => r.role === "metric");
    if (!row) return undefined;
    return {
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      costUsd: row.costUsd,
    };
  }

  workflowLink(workflowRunId: string): { seen: boolean; runId?: string } {
    const rows = this.db
      .prepare("SELECT run_id FROM usage WHERE workflow_run_id = ?")
      .all(workflowRunId) as { run_id: string | null }[];
    return { seen: rows.length > 0, runId: rows.find((r) => r.run_id)?.run_id ?? undefined };
  }

  purge(before: number): number {
    const old = this.db
      .prepare("SELECT run_id FROM runs WHERE COALESCE(last_event_at, started_at, 0) < ?")
      .all(before) as { run_id: string }[];
    for (const { run_id } of old) {
      this.db.prepare("DELETE FROM events WHERE run_id = ?").run(run_id);
      this.db.prepare("DELETE FROM usage WHERE run_id = ?").run(run_id);
      this.db.prepare("DELETE FROM runs WHERE run_id = ?").run(run_id);
    }
    this.db
      .prepare(
        "DELETE FROM session_events WHERE session_id IN (SELECT session_id FROM sessions WHERE last_seen < ?)",
      )
      .run(before);
    this.db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(before);
    this.db.prepare("DELETE FROM usage WHERE ts < ?").run(before);
    return old.length;
  }

  close(): void {
    this.db.close();
  }
}
