import type { AgentItem } from "@tlc-deck/protocol";

/** Merge items by seq (dedupe, ascending). Later entries win. */
export function mergeItems(existing: AgentItem[], incoming: AgentItem[]): AgentItem[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, AgentItem>();
  for (const it of existing) bySeq.set(it.seq, it);
  for (const it of incoming) bySeq.set(it.seq, it);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export type ChatRow =
  | { type: "message"; item: AgentItem }
  | { type: "tool"; call: AgentItem; result?: AgentItem | undefined }
  | { type: "orphan-result"; result: AgentItem };

/** Pair tool_call items with their tool_result by toolUseId, keeping order of first appearance. */
export function pairItems(items: AgentItem[]): ChatRow[] {
  const results = new Map<string, AgentItem>();
  for (const it of items) {
    if (it.kind === "tool_result" && it.toolUseId) results.set(it.toolUseId, it);
  }
  const calls = new Set<string>();
  for (const it of items) {
    if (it.kind === "tool_call" && it.toolUseId) calls.add(it.toolUseId);
  }
  const rows: ChatRow[] = [];
  for (const it of items) {
    if (it.kind === "tool_call") {
      rows.push({
        type: "tool",
        call: it,
        result: it.toolUseId ? results.get(it.toolUseId) : undefined,
      });
    } else if (it.kind === "tool_result") {
      if (!it.toolUseId || !calls.has(it.toolUseId))
        rows.push({ type: "orphan-result", result: it });
    } else {
      rows.push({ type: "message", item: it });
    }
  }
  return rows;
}
