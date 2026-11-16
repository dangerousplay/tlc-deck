import { applyResult } from "./claude.js";
import type { StreamItem, StreamParser, StreamResult } from "./types.js";
import { obj, parseLine, str, TextBuffer } from "./util.js";

/** agy stream-json: `step_update` events (text_delta / tool_name ...) and a final `result`. */
export function agyParser(): StreamParser {
  const r: StreamResult = { ended: false };
  const text = new TextBuffer();
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const out: StreamItem[] = [];
      if (e.type === "step_update") {
        if (typeof e.text_delta === "string") text.add(e.text_delta);
        const name = str(e.tool_name);
        const id = str(e.tool_call_id) ?? str(e.step_id);
        if (name && e.tool_output === undefined) {
          out.push(...text.flush());
          out.push({
            kind: "tool_call",
            tool: name,
            ...(id ? { toolUseId: id } : {}),
            input: e.tool_input,
          });
        } else if (e.tool_output !== undefined) {
          out.push(...text.flush());
          out.push({
            kind: "tool_result",
            ...(id ? { toolUseId: id } : {}),
            output: e.tool_output,
            ...(e.is_error === true ? { isError: true } : {}),
          });
        }
      } else if (e.type === "result") {
        out.push(...text.flush());
        r.model = str(obj(e).model) ?? r.model;
        applyResult(r, e);
      }
      return out;
    },
    end: () => text.flush(),
    result: () => r,
  };
}
