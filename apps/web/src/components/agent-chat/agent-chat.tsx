import type { AgentInfo, AgentItem } from "@tlc-deck/protocol";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { formatCost, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type ChatRow, pairItems } from "./items";
import { useAgentItems } from "./use-agent-items";

function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs">
      {text}
    </pre>
  );
}

function Truncated({ item }: { item: AgentItem }) {
  if (!item.truncated) return null;
  return (
    <p data-testid="truncated-notice" className="text-xs text-amber-600 dark:text-amber-400">
      Truncated{item.fullLength !== undefined ? ` (full length ${item.fullLength} chars)` : ""}
    </p>
  );
}

/** One-line summary of a tool call's input: command, path, pattern, url or first string field. */
export function toolSummary(input: unknown): string {
  let v: unknown = input;
  if (typeof input === "string") {
    try {
      v = JSON.parse(input);
    } catch {
      return input.split("\n")[0] ?? "";
    }
  }
  if (!v || typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  for (const k of [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
  ]) {
    const x = o[k];
    if (typeof x === "string" && x.trim()) return x.split("\n")[0] ?? "";
  }
  const first = Object.values(o).find((x) => typeof x === "string" && x.trim());
  return typeof first === "string" ? (first.split("\n")[0] ?? "") : "";
}

export function ToolCard({ call, result }: { call: AgentItem; result?: AgentItem | undefined }) {
  const [open, setOpen] = useState(false);
  const error = result?.isError === true;
  return (
    <div
      data-testid="tool-card"
      data-error={error}
      data-open={open}
      className={cn("rounded-lg border text-sm", error && "border-red-500/50 bg-red-500/5")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className="shrink-0 font-mono text-xs font-semibold">{call.tool ?? "tool"}</span>
        <span
          data-testid="tool-summary"
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
        >
          {toolSummary(call.input)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {result ? (error ? "error" : "done") : "running"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-2.5 py-2">
          {call.input !== undefined && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Input</div>
              <Json value={call.input} />
              <Truncated item={call} />
            </div>
          )}
          {result && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Result</div>
              <Json value={result.output ?? result.text ?? ""} />
              <Truncated item={result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ row }: { row: ChatRow }) {
  if (row.type === "tool") return <ToolCard call={row.call} result={row.result} />;
  if (row.type === "orphan-result") {
    return (
      <div data-testid="chat-orphan" className="rounded-lg border px-2.5 py-1.5 text-xs">
        <Json value={row.result.output ?? row.result.text ?? ""} />
        <Truncated item={row.result} />
      </div>
    );
  }
  const it = row.item;
  const text = it.text ?? "";
  if (it.kind === "prompt") {
    return (
      <div
        data-testid="chat-prompt"
        className="rounded-lg border bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap"
      >
        {text}
        <Truncated item={it} />
      </div>
    );
  }
  if (it.kind === "error") {
    return (
      <div
        data-testid="chat-error"
        className="rounded-lg border border-red-500/50 bg-red-500/5 px-3 py-2 text-sm"
      >
        {text}
      </div>
    );
  }
  if (it.kind === "status") {
    return <div className="text-center text-xs text-muted-foreground">{text}</div>;
  }
  return (
    <div data-testid="chat-text" className="space-y-1 text-sm leading-relaxed">
      <div className="space-y-2 [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
      <Truncated item={it} />
    </div>
  );
}

export function AgentHeader({ agent, live }: { agent: AgentInfo; live?: boolean | undefined }) {
  const u = agent.usage;
  const tokens = u ? u.input + u.output + u.cacheRead + u.cacheWrite : undefined;
  return (
    <header data-testid="agent-header" className="flex flex-wrap items-center gap-2 text-sm">
      <span
        data-testid="live-indicator"
        data-live={Boolean(live && agent.status === "running")}
        className={cn(
          "size-2 rounded-full",
          live && agent.status === "running"
            ? "animate-pulse bg-emerald-500"
            : "bg-muted-foreground/40",
        )}
      />
      <span className="font-medium">{agent.label ?? agent.role ?? agent.id}</span>
      {agent.role && agent.label && <Badge variant="outline">{agent.role}</Badge>}
      {agent.model && <span className="text-xs text-muted-foreground">{agent.model}</span>}
      <Badge variant="secondary" data-testid="agent-status">
        {agent.status}
      </Badge>
      {u && (
        <span
          data-testid="agent-usage"
          className="ml-auto text-xs tabular-nums text-muted-foreground"
        >
          {formatTokens(tokens ?? null)} tokens · {formatCost(u.costUsd)}
        </span>
      )}
    </header>
  );
}

const NEAR_BOTTOM_PX = 40;

/** Presentational chat: items in order, paired tool cards, sticky auto-scroll. */
export function AgentChat({
  agent,
  items,
  live,
}: {
  agent: AgentInfo;
  items: AgentItem[];
  live?: boolean | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const rows = pairItems(items);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    pinnedRef.current = near;
    setPinned(near);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new item
  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  return (
    <div data-testid="agent-chat" className="relative space-y-2">
      <AgentHeader agent={agent} live={live} />
      <div
        ref={ref}
        onScroll={onScroll}
        data-testid="chat-scroll"
        className="max-h-[32rem] space-y-2 overflow-y-auto rounded-lg border p-2"
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          rows.map((row) => (
            <Row
              key={
                row.type === "message"
                  ? row.item.seq
                  : row.type === "tool"
                    ? row.call.seq
                    : row.result.seq
              }
              row={row}
            />
          ))
        )}
      </div>
      {!pinned && (
        <button
          type="button"
          data-testid="jump-latest"
          onClick={jump}
          className="absolute bottom-3 right-4 rounded-full border bg-background px-3 py-1 text-xs shadow"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** AgentChat wired to the backlog + per-agent SSE stream. */
export function AgentChatLive({
  agent,
  fetchFn,
  EventSourceCtor,
}: {
  agent: AgentInfo;
  fetchFn?: typeof fetch | undefined;
  EventSourceCtor?: typeof EventSource | undefined;
}) {
  const { items, live } = useAgentItems(agent.id, { fetchFn, EventSourceCtor });
  return <AgentChat agent={agent} items={items} live={live} />;
}
