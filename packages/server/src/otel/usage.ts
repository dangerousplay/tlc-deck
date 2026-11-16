import type { OtlpKind } from "./decode.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export type UsageSource = "metric" | "log";

export interface UsageRecord extends Usage {
  source: UsageSource;
  sessionId: string;
  model?: string;
  agentId?: string;
  workflowRunId?: string;
  workflowName?: string;
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
});

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

function anyValue(v: unknown): string | number | boolean | undefined {
  const a = obj(v);
  if (a.stringValue !== undefined) return String(a.stringValue);
  if (a.intValue !== undefined) return Number(a.intValue);
  if (a.doubleValue !== undefined) return Number(a.doubleValue);
  if (a.boolValue !== undefined) return Boolean(a.boolValue);
  return undefined;
}

function attrs(list: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of arr(list)) {
    const v = anyValue(kv.value);
    if (typeof kv.key === "string" && v !== undefined) out[kv.key] = v;
  }
  return out;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function tokenField(type: string): keyof Usage | undefined {
  switch (type) {
    case "input":
      return "input";
    case "output":
      return "output";
    case "cacheRead":
      return "cacheRead";
    case "cacheCreation":
      return "cacheWrite";
    default:
      return undefined;
  }
}

function fromMetrics(data: Json): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const rm of arr(data.resourceMetrics)) {
    const resAttrs = attrs(obj(rm.resource).attributes);
    for (const sm of arr(rm.scopeMetrics)) {
      for (const m of arr(sm.metrics)) {
        const name = m.name;
        if (name !== "claude_code.cost.usage" && name !== "claude_code.token.usage") continue;
        const points = arr(obj(m.sum).dataPoints ?? obj(m.gauge).dataPoints);
        for (const p of points) {
          const a = { ...resAttrs, ...attrs(p.attributes) };
          const sessionId = text(a["session.id"]);
          if (!sessionId) continue;
          const value = p.asDouble !== undefined ? num(p.asDouble) : num(p.asInt);
          const rec: UsageRecord = {
            ...emptyUsage(),
            source: "metric",
            sessionId,
            model: text(a.model),
          };
          if (name === "claude_code.cost.usage") rec.costUsd = value;
          else {
            const f = tokenField(String(a.type ?? ""));
            if (!f) continue; // unknown token type
            rec[f] = value;
          }
          out.push(rec);
        }
      }
    }
  }
  return out;
}

function fromLogs(data: Json): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const rl of arr(data.resourceLogs)) {
    const resAttrs = attrs(obj(rl.resource).attributes);
    for (const sl of arr(rl.scopeLogs)) {
      for (const lr of arr(sl.logRecords)) {
        const a = { ...resAttrs, ...attrs(lr.attributes) };
        const event =
          text(a["event.name"]) ?? text(lr.eventName) ?? String(anyValue(lr.body) ?? "");
        if (event !== "claude_code.api_request" && event !== "api_request") continue;
        const sessionId = text(a["session.id"]);
        if (!sessionId) continue;
        out.push({
          source: "log",
          sessionId,
          model: text(a.model),
          agentId: text(a.agent_id),
          workflowRunId: text(a["workflow.run_id"]),
          workflowName: text(a["workflow.name"]),
          input: num(a.input_tokens),
          output: num(a.output_tokens),
          cacheRead: num(a.cache_read_tokens),
          cacheWrite: num(a.cache_creation_tokens),
          costUsd: num(a.cost_usd),
        });
      }
    }
  }
  return out;
}

/** Usage records in an OTLP/JSON-shaped request. Traces yield none (see `countSpans`). */
export function extractUsage(kind: OtlpKind, data: unknown): UsageRecord[] {
  const d = obj(data);
  if (kind === "metrics") return fromMetrics(d);
  if (kind === "logs") return fromLogs(d);
  return [];
}

/** Span counts per `session.id` (key "" when absent) plus the total. */
export function countSpans(data: unknown): { total: number; bySession: Map<string, number> } {
  const bySession = new Map<string, number>();
  let total = 0;
  for (const rs of arr(obj(data).resourceSpans)) {
    const resAttrs = attrs(obj(rs.resource).attributes);
    for (const ss of arr(rs.scopeSpans)) {
      for (const sp of arr(ss.spans)) {
        const sid = text({ ...resAttrs, ...attrs(sp.attributes) }["session.id"]) ?? "";
        bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
        total++;
      }
    }
  }
  return { total, bySession };
}
