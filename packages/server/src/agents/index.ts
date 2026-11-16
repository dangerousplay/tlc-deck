import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type ClaudeParseState, newClaudeState, parseClaudeLine } from "@tlc-deck/core";
import type { AgentInfo, AgentItem, RunState } from "@tlc-deck/protocol";
import type { Store } from "../store.js";

/** DD-04: unregister a session this long after SessionEnd. */
export const UNREGISTER_MS = 30 * 60 * 1000;
/** DD-05: time fallback window for workflow -> run linking. */
const LINK_WINDOW_MS = 10 * 60 * 1000;
const RUN_ID_RE = /tlc_[0-9A-HJKMNP-TV-Z]{26}/;
const LABEL_RE = /^(impl|verify|advise|fix|commit|report)\s+(T\d+)/;
const STAGES: Record<string, string> = {
  impl: "implement",
  verify: "verify",
  advise: "advise",
  fix: "fix",
  commit: "commit",
  report: "report",
};

export interface AgentManagerOptions {
  store: Store;
  now?: () => number;
  /** Do not store text/input/output of items (hooks' --no-content). */
  noContent?: boolean;
  /** Project name (repo basename) of a session, for the run-link time fallback. */
  projectOf?: (sessionId: string) => string | undefined;
  /** Called on every AgentInfo upsert (global `tlc.agent` broadcast). */
  onAgent?: (info: AgentInfo) => void;
  pollMs?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface Watched {
  path: string;
  info: AgentInfo;
  parse: ClaudeParseState;
  offset: number;
  partial: Buffer;
  metaRead: boolean;
  /** Raw agent id (file name without .jsonl), for hook and journal matching. */
  rawId: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  dirty: boolean;
}

interface Workflow {
  id: string;
  dir: string;
  journalSize: number;
  journalAt?: number;
  runLinked: "id" | "time" | undefined;
  entries: Map<string, { label?: string; phase?: string; done: boolean }>;
}

interface SessionWatch {
  sessionId: string;
  dir: string;
  transcript: string;
  files: Map<string, Watched>;
  workflows: Map<string, Workflow>;
  endedAt?: number;
  stopped: Set<string>;
}

export class AgentManager {
  private sessions = new Map<string, SessionWatch>();
  private listeners = new Map<string, Set<(item: AgentItem) => void>>();
  private timer: NodeJS.Timeout | undefined;
  private store: Store;
  private now: () => number;

  constructor(private opts: AgentManagerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.timer = setInterval(() => this.tick(), opts.pollMs ?? 200);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Subscribe to item deltas of one agent. Returns unsubscribe. */
  subscribe(agentId: string, fn: (item: AgentItem) => void): () => void {
    const set = this.listeners.get(agentId) ?? new Set<(item: AgentItem) => void>();
    this.listeners.set(agentId, set);
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Registers/updates sessions from a hook body. Only hooks announce paths (DD-04). */
  onHook(body: Obj): void {
    const sid = typeof body.session_id === "string" ? body.session_id : "";
    const tp = typeof body.transcript_path === "string" ? body.transcript_path : "";
    if (!sid) return;
    let s = this.sessions.get(sid);
    if (!s && tp.endsWith(".jsonl")) {
      const dir = resolve(tp.slice(0, -".jsonl".length));
      s = {
        sessionId: sid,
        dir,
        transcript: resolve(tp),
        files: new Map(),
        workflows: new Map(),
        stopped: new Set(),
      };
      this.sessions.set(sid, s);
    }
    if (!s) return;
    const ev = body.hook_event_name;
    if (ev === "SessionEnd") {
      s.endedAt = this.now();
      this.poll(s);
      for (const w of s.files.values()) this.finish(w, this.now());
    } else if (ev === "SessionStart") {
      s.endedAt = undefined;
    }
    if (ev === "SubagentStop" && typeof body.agent_id === "string") {
      s.stopped.add(body.agent_id);
    }
    // agent_transcript_path is only honoured inside the announced session dir.
    const atp = typeof body.agent_transcript_path === "string" ? body.agent_transcript_path : "";
    if (atp && this.inside(s, atp)) this.addFile(s, resolve(atp));
    this.poll(s);
  }

  private inside(s: SessionWatch, path: string): boolean {
    const p = resolve(path);
    return p === s.transcript || p.startsWith(s.dir + sep);
  }

  private tick(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (s.endedAt !== undefined && t - s.endedAt > UNREGISTER_MS) {
        this.sessions.delete(id);
        continue;
      }
      this.poll(s);
    }
  }

  private poll(s: SessionWatch): void {
    try {
      this.addFile(s, s.transcript);
      this.scanDirs(s);
      for (const wf of s.workflows.values()) this.readJournal(s, wf);
      for (const w of [...s.files.values()]) this.readNew(s, w);
      for (const w of s.files.values()) {
        if (w.dirty) {
          w.dirty = false;
          this.publish(w);
        }
      }
      this.link(s);
    } catch {
      // watchers must never take the server down
    }
  }

  private scanDirs(s: SessionWatch): void {
    const sub = join(s.dir, "subagents");
    if (!existsSync(sub)) return;
    for (const f of readdirSync(sub, { withFileTypes: true })) {
      if (f.isFile() && /^agent-.+\.jsonl$/.test(f.name)) this.addFile(s, join(sub, f.name));
    }
    const wfRoot = join(sub, "workflows");
    if (!existsSync(wfRoot)) return;
    for (const d of readdirSync(wfRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(wfRoot, d.name);
      if (!s.workflows.has(d.name)) {
        s.workflows.set(d.name, {
          id: d.name,
          dir,
          journalSize: -1,
          runLinked: undefined,
          entries: new Map(),
        });
      }
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile() && /^agent-.+\.jsonl$/.test(f.name)) this.addFile(s, join(dir, f.name));
      }
    }
  }

  private addFile(s: SessionWatch, path: string): void {
    if (s.files.has(path) || !this.inside(s, path)) return;
    const isMain = path === s.transcript;
    if (!isMain && !existsSync(path)) return;
    const rawId = isMain ? s.sessionId : basename(path, ".jsonl");
    const wfDir = dirname(path);
    const wfId = basename(dirname(wfDir)) === "workflows" ? basename(wfDir) : undefined;
    const id = isMain ? s.sessionId : `${s.sessionId}-${rawId}`;
    const existing = this.store.getAgent(id);
    const t = this.now();
    const info: AgentInfo = existing ?? {
      id,
      source: "claude-code",
      sessionId: s.sessionId,
      ...(wfId ? { workflowId: wfId } : {}),
      role: isMain ? "main" : wfId ? "workflow-subagent" : "subagent",
      harness: "claude-code",
      status: "running",
      startedAt: isMain ? t : Math.floor(statSync(path).birthtimeMs || t),
    };
    if (isMain) info.label = "main session";
    const w: Watched = {
      path,
      info: { ...info, status: existing?.status ?? "running" },
      parse: newClaudeState(id),
      offset: 0,
      partial: Buffer.alloc(0),
      metaRead: isMain,
      rawId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      dirty: true,
    };
    s.files.set(path, w);
    if (wfId && !s.workflows.has(wfId)) {
      s.workflows.set(wfId, {
        id: wfId,
        dir: wfDir,
        journalSize: -1,
        runLinked: undefined,
        entries: new Map(),
      });
    }
  }

  private readMeta(w: Watched): void {
    const meta = readJson(join(dirname(w.path), `${w.rawId}.meta.json`));
    if (!isObj(meta)) return;
    w.metaRead = true;
    if (typeof meta.agentType === "string") w.info.role = meta.agentType;
    if (typeof meta.description === "string") {
      w.info.label = meta.description;
      this.mapTask(w.info, meta.description);
    }
    if (typeof meta.model === "string" && !w.info.model) w.info.model = meta.model;
    w.dirty = true;
  }

  private mapTask(info: AgentInfo, label: string): void {
    const m = LABEL_RE.exec(label);
    if (!m) return;
    info.task = m[2];
    info.stage = STAGES[m[1] as string];
  }

  private readJournal(s: SessionWatch, wf: Workflow): void {
    const file = join(wf.dir, "journal.jsonl");
    if (!existsSync(file)) return;
    const st = statSync(file);
    if (st.size === wf.journalSize) return;
    wf.journalSize = st.size;
    wf.journalAt ??= Math.floor(st.birthtimeMs || st.mtimeMs);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(e) || typeof e.agentId !== "string") continue;
      const cur = wf.entries.get(e.agentId) ?? { done: false };
      if (e.type === "started") {
        if (typeof e.label === "string") cur.label = e.label;
        if (typeof e.phase === "string") cur.phase = e.phase;
      } else if (e.type === "result") {
        cur.done = true;
      }
      wf.entries.set(e.agentId, cur);
    }
    for (const w of s.files.values()) {
      if (w.info.workflowId !== wf.id) continue;
      const ent = wf.entries.get(w.rawId.replace(/^agent-/, ""));
      if (!ent) continue;
      if (ent.label) {
        if (!w.info.label) w.info.label = ent.label;
        if (!w.info.task) this.mapTask(w.info, ent.label);
      }
      if (ent.done) this.finish(w, this.now());
      w.dirty = true;
    }
  }

  private finish(w: Watched, at: number): void {
    if (w.info.status !== "running") return;
    w.info.status = "done";
    w.info.endedAt = at;
    w.dirty = true;
  }

  private readNew(s: SessionWatch, w: Watched): void {
    if (!w.metaRead) this.readMeta(w);
    let fd: number;
    try {
      fd = openSync(w.path, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < w.offset) {
        w.offset = 0;
        w.partial = Buffer.alloc(0);
        w.parse = newClaudeState(w.info.id);
      }
      if (size === w.offset) return;
      const buf = Buffer.alloc(size - w.offset);
      const n = readSync(fd, buf, 0, buf.length, w.offset);
      w.offset += n;
      let data = w.partial.length
        ? Buffer.concat([w.partial, buf.subarray(0, n)])
        : buf.subarray(0, n);
      const items: AgentItem[] = [];
      let nl = data.indexOf(0x0a);
      while (nl !== -1) {
        const line = data.subarray(0, nl).toString("utf8");
        data = data.subarray(nl + 1);
        if (line.trim()) this.consume(w, line, items);
        nl = data.indexOf(0x0a);
      }
      w.partial = Buffer.from(data);
      if (items.length === 0) return;
      this.deliver(w, items, s);
    } finally {
      closeSync(fd);
    }
  }

  private consume(w: Watched, line: string, items: AgentItem[]): void {
    const r = parseClaudeLine(line, w.parse);
    items.push(...r.items);
    if (r.model && w.info.model !== r.model) {
      w.info.model = r.model;
      w.dirty = true;
    }
    if (r.usage) {
      w.usage.input += r.usage.input;
      w.usage.output += r.usage.output;
      w.usage.cacheRead += r.usage.cacheRead;
      w.usage.cacheWrite += r.usage.cacheWrite;
      w.info.usage = { ...w.usage, costUsd: null };
      w.dirty = true;
    }
  }

  private deliver(w: Watched, items: AgentItem[], s: SessionWatch): void {
    const out = this.opts.noContent
      ? items.map((it) => {
          const { text: _t, input: _i, output: _o, ...rest } = it;
          return rest as AgentItem;
        })
      : items;
    this.store.addAgentItems(out);
    if (!this.opts.noContent && !w.info.runId && w.info.workflowId) {
      for (const it of out) {
        const m = RUN_ID_RE.exec(`${it.text ?? ""} ${JSON.stringify(it.output ?? "")}`);
        if (m) this.setRun(s, w.info.workflowId, m[0], "id");
      }
    }
    const subs = this.listeners.get(w.info.id);
    if (subs) for (const it of out) for (const fn of subs) fn(it);
    w.dirty = true;
  }

  private setRun(s: SessionWatch, wfId: string, runId: string, how: "id" | "time"): void {
    const wf = s.workflows.get(wfId);
    if (!wf || wf.runLinked === "id") return;
    wf.runLinked = how;
    for (const w of s.files.values()) {
      if (w.info.workflowId === wfId && w.info.runId !== runId) {
        w.info.runId = runId;
        w.dirty = true;
      }
    }
  }

  /** DD-05 time fallback; id links are made in deliver(). */
  private link(s: SessionWatch): void {
    const project = this.opts.projectOf?.(s.sessionId);
    if (!project) return;
    for (const wf of s.workflows.values()) {
      if (wf.runLinked || wf.journalAt === undefined) continue;
      const run: RunState | undefined = this.store
        .listRuns()
        .filter(
          (r) =>
            r.threadId?.split("#")[0] === project &&
            r.startedAt !== undefined &&
            r.startedAt >= (wf.journalAt as number) &&
            r.startedAt - (wf.journalAt as number) <= LINK_WINDOW_MS,
        )
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
      if (run) this.setRun(s, wf.id, run.runId, "time");
    }
    for (const w of s.files.values()) {
      if (w.dirty) {
        w.dirty = false;
        this.publish(w);
      }
    }
  }

  private publish(w: Watched): void {
    this.store.upsertAgent(w.info);
    this.opts.onAgent?.({ ...w.info });
  }
}
