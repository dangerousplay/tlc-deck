import type { DriverUsage } from "../driver.js";
import type { StreamItem, StreamParser, StreamResult } from "./types.js";
import { num, obj, parseLine, str } from "./util.js";

/** codex `exec --json`: thread.started, item.completed, turn.completed. */
export function codexParser(): StreamParser {
  const r: StreamResult = { ended: false };
  let usage: DriverUsage | undefined;
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const out: StreamItem[] = [];
      if (e.type === "thread.started") r.sessionId = str(e.thread_id) ?? r.sessionId;
      else if (e.type === "turn.completed") {
        const u = obj(e.usage);
        usage = {
          input: (usage?.input ?? 0) + num(u.input_tokens),
          output: (usage?.output ?? 0) + num(u.output_tokens),
          cacheRead: (usage?.cacheRead ?? 0) + num(u.cached_input_tokens),
          cacheWrite: 0,
          costUsd: null,
        };
        r.ended = true;
      } else if (e.type === "turn.failed" || e.type === "error") {
        r.error = str(obj(e.error).message) ?? str(e.message) ?? "turn failed";
      } else if (e.type === "item.completed") {
        const it = obj(e.item);
        const id = str(it.id);
        const idf = id ? { toolUseId: id } : {};
        switch (it.type) {
          case "agent_message":
            if (typeof it.text === "string") {
              out.push({ kind: "text", text: it.text });
              r.text = it.text;
            }
            break;
          case "command_execution":
            out.push({ kind: "tool_call", tool: "Bash", ...idf, input: { command: it.command } });
            out.push({
              kind: "tool_result",
              ...idf,
              output: it.aggregated_output ?? "",
              ...(typeof it.exit_code === "number" && it.exit_code !== 0 ? { isError: true } : {}),
            });
            break;
          case "file_change":
            out.push({ kind: "tool_call", tool: "file_change", ...idf, input: it.changes });
            break;
          case "mcp_tool_call": {
            const tool = `${str(it.server) ?? "mcp"}.${str(it.tool) ?? "tool"}`;
            out.push({ kind: "tool_call", tool, ...idf, input: it.arguments });
            const failed = it.error !== undefined && it.error !== null;
            out.push({
              kind: "tool_result",
              ...idf,
              output: failed ? it.error : it.result,
              ...(failed ? { isError: true } : {}),
            });
            break;
          }
        }
      }
      return out;
    },
    end: () => [],
    result: () => ({ ...r, ...(usage ? { usage } : {}) }),
  };
}
