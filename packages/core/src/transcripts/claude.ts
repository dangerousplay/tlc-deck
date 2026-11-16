import type { AgentItem } from "@tlc-deck/protocol";
import { capItem } from "../content.js";

export interface ClaudeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ClaudeParseState {
  agentId: string;
  /** Next item seq. */
  seq: number;
  /** True once the prompt item was emitted. */
  promptSeen: boolean;
  /** Last assistant message id whose usage was reported (a message spans several lines). */
  lastMessageId?: string;
}

export interface ClaudeParseResult {
  items: AgentItem[];
  usage?: ClaudeUsage;
  model?: string;
}

export function newClaudeState(agentId: string): ClaudeParseState {
  return { agentId, seq: 0, promptSeen: false };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) && typeof b.text === "string" ? b.text : ""))
      .filter((s) => s !== "")
      .join("\n");
  }
  return "";
}

/**
 * Parses one Claude Code transcript line into normalised, redacted and capped items.
 * Malformed or irrelevant lines yield no items. Results are not paired with calls here.
 */
export function parseClaudeLine(line: string, state: ClaudeParseState): ClaudeParseResult {
  const empty: ClaudeParseResult = { items: [] };
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return empty;
  }
  if (!isObj(d) || (d.type !== "user" && d.type !== "assistant") || !isObj(d.message)) return empty;
  const msg = d.message;
  const parsedTs = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : Number.NaN;
  const ts = Number.isNaN(parsedTs) ? 0 : parsedTs;
  const items: AgentItem[] = [];
  const push = (it: Omit<AgentItem, "agentId" | "seq" | "ts">) =>
    items.push(capItem({ agentId: state.agentId, seq: state.seq++, ts, ...it }));
  const content = msg.content;

  if (d.type === "user") {
    if (d.isMeta === true) return empty;
    if (typeof content === "string") {
      if (!state.promptSeen) {
        state.promptSeen = true;
        push({ kind: "prompt", text: content });
      }
      return { items };
    }
    if (!Array.isArray(content)) return empty;
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === "tool_result") {
        const isError = b.is_error === true;
        push({
          kind: "tool_result",
          toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
          output: resultText(b.content),
          ...(isError ? { isError: true } : {}),
        });
      } else if (b.type === "text" && !state.promptSeen && typeof b.text === "string") {
        state.promptSeen = true;
        push({ kind: "prompt", text: b.text });
      }
    }
    return { items };
  }

  // assistant
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
        push({ kind: "text", text: b.text });
      } else if (b.type === "tool_use") {
        push({
          kind: "tool_call",
          tool: typeof b.name === "string" ? b.name : undefined,
          toolUseId: typeof b.id === "string" ? b.id : undefined,
          input: b.input,
        });
      }
    }
  }
  const out: ClaudeParseResult = { items };
  if (typeof msg.model === "string" && msg.model !== "<synthetic>") out.model = msg.model;
  const id = typeof msg.id === "string" ? msg.id : undefined;
  if (isObj(msg.usage) && (id === undefined || id !== state.lastMessageId)) {
    if (id !== undefined) state.lastMessageId = id;
    out.usage = {
      input: num(msg.usage.input_tokens),
      output: num(msg.usage.output_tokens),
      cacheRead: num(msg.usage.cache_read_input_tokens),
      cacheWrite: num(msg.usage.cache_creation_input_tokens),
    };
  }
  return out;
}
