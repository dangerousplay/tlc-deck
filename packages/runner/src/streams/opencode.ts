import type { DriverUsage } from "../driver.js";
import type { StreamItem, StreamParser, StreamResult } from "./types.js";
import { num, obj, parseLine, str } from "./util.js";

/** opencode `run --format json`: text, tool_use, step_finish, error. */
export function opencodeParser(): StreamParser {
  const r: StreamResult = { ended: false };
  let usage: DriverUsage | undefined;
  let events = 0;
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      events++;
      r.sessionId = str(e.sessionID) ?? r.sessionId;
      const part = obj(e.part);
      const out: StreamItem[] = [];
      if (e.type === "text" && typeof part.text === "string") {
        r.text = part.text;
        out.push({ kind: "text", text: part.text });
      } else if (e.type === "tool_use") {
        const st = obj(part.state);
        const id = str(part.callID) ?? str(part.id);
        const idf = id ? { toolUseId: id } : {};
        out.push({ kind: "tool_call", tool: str(part.tool) ?? "tool", ...idf, input: st.input });
        if (st.status === "completed" || st.status === "error") {
          out.push({
            kind: "tool_result",
            ...idf,
            output: st.status === "error" ? (st.error ?? st.output) : st.output,
            ...(st.status === "error" ? { isError: true } : {}),
          });
        }
      } else if (e.type === "error") {
        r.error = str(obj(obj(e.error).data).message) ?? str(obj(e.error).name) ?? "error";
      } else if (e.type === "step_finish") {
        const t = obj(part.tokens);
        const cache = obj(t.cache);
        const cost = part.cost;
        usage = {
          input: (usage?.input ?? 0) + num(t.input),
          output: (usage?.output ?? 0) + num(t.output),
          cacheRead: (usage?.cacheRead ?? 0) + num(cache.read),
          cacheWrite: (usage?.cacheWrite ?? 0) + num(cache.write),
          costUsd:
            typeof cost === "number" ? (usage?.costUsd ?? 0) + cost : (usage?.costUsd ?? null),
        };
      }
      return out;
    },
    end: () => [],
    result: () => ({ ...r, ended: events > 0, ...(usage ? { usage } : {}) }),
  };
}
