import type { DriverUsage } from "../driver.js";
import type { StreamItem, StreamParser, StreamResult } from "./types.js";
import { num, obj, parseLine, str, toolOutput } from "./util.js";

export function envelopeUsage(env: Record<string, unknown>): DriverUsage | undefined {
  const u = obj(env.usage);
  const cost = env.total_cost_usd ?? env.cost_usd;
  if (Object.keys(u).length === 0 && cost === undefined) return undefined;
  const models = Object.keys(obj(env.modelUsage));
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    costUsd: typeof cost === "number" ? cost : null,
    ...(models[0] ? { model: models[0] } : {}),
  };
}

/** Applies a final `result` event (claude and agy share the shape). */
export function applyResult(r: StreamResult, e: Record<string, unknown>): void {
  r.ended = true;
  r.text = str(e.result) ?? str(e.response) ?? r.text;
  if (e.structured_output !== undefined && e.structured_output !== null) {
    r.data = e.structured_output;
  }
  r.sessionId = str(e.session_id) ?? r.sessionId;
  const usage = envelopeUsage(e);
  if (usage) r.usage = usage;
  if (e.is_error === true) r.error = str(e.result) ?? str(e.error) ?? "reported an error";
}

/** claude `--output-format stream-json --verbose`. */
export function claudeParser(): StreamParser {
  const r: StreamResult = { ended: false };
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const out: StreamItem[] = [];
      if (e.type === "system") {
        r.sessionId = str(e.session_id) ?? r.sessionId;
        r.model = str(e.model) ?? r.model;
      } else if (e.type === "assistant") {
        const m = obj(e.message);
        r.model = str(m.model) ?? r.model;
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            const blk = obj(b);
            if (blk.type === "text" && typeof blk.text === "string" && blk.text.trim()) {
              out.push({ kind: "text", text: blk.text });
            } else if (blk.type === "tool_use") {
              out.push({
                kind: "tool_call",
                ...(str(blk.name) ? { tool: str(blk.name) as string } : {}),
                ...(str(blk.id) ? { toolUseId: str(blk.id) as string } : {}),
                input: blk.input,
              });
            }
          }
        }
      } else if (e.type === "user") {
        const c = obj(e.message).content;
        if (Array.isArray(c)) {
          for (const b of c) {
            const blk = obj(b);
            if (blk.type !== "tool_result") continue;
            out.push({
              kind: "tool_result",
              ...(str(blk.tool_use_id) ? { toolUseId: str(blk.tool_use_id) as string } : {}),
              output: toolOutput(blk.content),
              ...(blk.is_error === true ? { isError: true } : {}),
            });
          }
        }
      } else if (e.type === "result") {
        applyResult(r, e);
      }
      return out;
    },
    end: () => [],
    result: () => r,
  };
}
