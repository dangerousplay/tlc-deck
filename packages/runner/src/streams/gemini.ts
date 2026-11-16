import type { DriverUsage } from "../driver.js";
import type { StreamItem, StreamParser, StreamResult } from "./types.js";
import { num, obj, parseLine, str, TextBuffer } from "./util.js";

/** gemini `-o stream-json`: init, message, tool_use, tool_result, result. */
export function geminiParser(): StreamParser {
  const r: StreamResult = { ended: false };
  const text = new TextBuffer();
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const out: StreamItem[] = [];
      switch (e.type) {
        case "init":
          r.sessionId = str(e.session_id) ?? r.sessionId;
          r.model = str(e.model) ?? r.model;
          break;
        case "message":
          if (e.role === "assistant" && typeof e.content === "string") text.add(e.content);
          break;
        case "tool_use":
          out.push(...text.flush());
          out.push({
            kind: "tool_call",
            ...(str(e.tool_name) ? { tool: str(e.tool_name) as string } : {}),
            ...(str(e.tool_id) ? { toolUseId: str(e.tool_id) as string } : {}),
            input: e.parameters,
          });
          break;
        case "tool_result":
          out.push(...text.flush());
          out.push({
            kind: "tool_result",
            ...(str(e.tool_id) ? { toolUseId: str(e.tool_id) as string } : {}),
            output: e.output,
            ...(e.status === "error" ? { isError: true } : {}),
          });
          break;
        case "error":
          r.error = str(e.message) ?? str(obj(e.error).message) ?? "reported an error";
          break;
        case "result": {
          out.push(...text.flush());
          r.ended = true;
          if (e.status === "error") {
            r.error = str(obj(e.error).message) ?? "reported an error";
          }
          const s = obj(e.stats);
          if (Object.keys(s).length) {
            const cached = num(s.cached);
            const model = Object.keys(obj(s.models))[0] ?? r.model;
            const usage: DriverUsage = {
              input: Math.max(0, num(s.input_tokens) - cached),
              output: num(s.output_tokens),
              cacheRead: cached,
              cacheWrite: 0,
              costUsd: null,
              ...(model ? { model } : {}),
            };
            r.usage = usage;
          }
          break;
        }
      }
      return out;
    },
    end() {
      return text.flush();
    },
    result() {
      return { ...r, ...(text.last !== undefined ? { text: text.last } : {}) };
    },
  };
}
