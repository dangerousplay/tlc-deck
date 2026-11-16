import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInfo, AgentItem } from "@tlc-deck/protocol";
import { describe, expect, test } from "vitest";
import {
  AgentChat,
  AgentChatLive,
  groupSessionAgents,
  mergeItems,
  pairItems,
  SessionAgents,
} from ".";

const agent: AgentInfo = {
  id: "a1",
  source: "claude-code",
  harness: "claude",
  label: "impl T7",
  role: "implementer",
  model: "sonnet",
  status: "running",
  startedAt: 1,
  usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 },
};

const it = (seq: number, kind: AgentItem["kind"], extra: Partial<AgentItem> = {}): AgentItem => ({
  agentId: "a1",
  seq,
  ts: seq,
  kind,
  ...extra,
});

const items: AgentItem[] = [
  it(0, "prompt", { text: "do it" }),
  it(1, "text", { text: "**hello** world" }),
  it(2, "tool_call", { tool: "Bash", toolUseId: "t1", input: { command: "ls" } }),
  it(3, "text", { text: "between" }),
  it(4, "tool_result", {
    toolUseId: "t1",
    output: "boom",
    isError: true,
    truncated: true,
    fullLength: 99999,
  }),
];

describe("pairItems", () => {
  test("pairs results with calls and keeps order", () => {
    const rows = pairItems(items);
    expect(rows.map((r) => r.type)).toEqual(["message", "message", "tool", "message"]);
    const tool = rows[2];
    expect(tool?.type === "tool" && tool.result?.seq).toBe(4);
  });
  test("unpaired call has no result, orphan result kept", () => {
    const rows = pairItems([
      it(0, "tool_call", { toolUseId: "x", tool: "Read" }),
      it(1, "tool_result", { toolUseId: "zz" }),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["tool", "orphan-result"]);
  });
});

describe("AgentChat", () => {
  test("header, markdown, collapse and truncation", () => {
    render(<AgentChat agent={agent} items={items} live />);
    expect(screen.getByTestId("agent-header")).toHaveTextContent("impl T7");
    expect(screen.getByTestId("agent-header")).toHaveTextContent("sonnet");
    expect(screen.getByTestId("agent-usage")).toHaveTextContent("$0.25");
    expect(screen.getByTestId("live-indicator")).toHaveAttribute("data-live", "true");
    expect(screen.getByText("hello").tagName).toBe("STRONG");
    const card = screen.getByTestId("tool-card");
    expect(card).toHaveAttribute("data-error", "true");
    expect(card).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("tool-summary")).toHaveTextContent("ls");
    expect(screen.queryByTestId("truncated-notice")).toBeNull();
    fireEvent.click(card.querySelector("button") as HTMLElement);
    expect(card).toHaveAttribute("data-open", "true");
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.getByTestId("truncated-notice")).toHaveTextContent("99999");
    fireEvent.click(card.querySelector("button") as HTMLElement);
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  test("auto-scroll pauses when scrolled up and jump resumes", () => {
    const { rerender } = render(<AgentChat agent={agent} items={items.slice(0, 2)} />);
    const box = screen.getByTestId("chat-scroll");
    Object.defineProperty(box, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });
    box.scrollTop = 800;
    fireEvent.scroll(box);
    expect(screen.queryByTestId("jump-latest")).toBeNull();
    rerender(<AgentChat agent={agent} items={items.slice(0, 3)} />);
    expect(box.scrollTop).toBe(1000);
    box.scrollTop = 100;
    fireEvent.scroll(box);
    expect(screen.getByTestId("jump-latest")).toBeInTheDocument();
    rerender(<AgentChat agent={agent} items={items} />);
    expect(box.scrollTop).toBe(100);
    fireEvent.click(screen.getByTestId("jump-latest"));
    expect(box.scrollTop).toBe(1000);
    expect(screen.queryByTestId("jump-latest")).toBeNull();
  });
});

describe("mergeItems / live store", () => {
  test("dedupes and orders by seq", () => {
    const merged = mergeItems(
      [items[2] as AgentItem, items[0] as AgentItem],
      [items[1] as AgentItem, items[2] as AgentItem],
    );
    expect(merged.map((i) => i.seq)).toEqual([0, 1, 2]);
  });

  test("backlog fetch + SSE delivery merge", async () => {
    class FakeES {
      static last: FakeES;
      listeners: Record<string, (e: MessageEvent) => void> = {};
      onopen?: () => void;
      onerror?: () => void;
      constructor(public url: string) {
        FakeES.last = this;
      }
      addEventListener(t: string, fn: (e: MessageEvent) => void) {
        this.listeners[t] = fn;
      }
      close() {}
    }
    const fetchFn = (async () =>
      new Response(JSON.stringify(items.slice(0, 2)))) as unknown as typeof fetch;
    render(
      <AgentChatLive
        agent={agent}
        fetchFn={fetchFn}
        EventSourceCtor={FakeES as unknown as typeof EventSource}
      />,
    );
    await waitFor(() => expect(screen.getByText("do it")).toBeInTheDocument());
    act(() => {
      FakeES.last.onopen?.();
      for (const i of items.slice(1, 4)) {
        FakeES.last.listeners.item?.({ data: JSON.stringify(i) } as MessageEvent);
      }
    });
    expect(screen.getAllByTestId("chat-text")).toHaveLength(2);
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1);
    expect(screen.getByTestId("live-indicator")).toHaveAttribute("data-live", "true");
  });
});

describe("SessionAgents", () => {
  const list: AgentInfo[] = [
    { ...agent, id: "main", label: "main" },
    { ...agent, id: "w1", workflowId: "wf_1", stage: "Implement", label: "impl T1" },
    { ...agent, id: "w2", workflowId: "wf_1", stage: "Verify", label: "verify T1" },
  ];
  test("groups by workflow and phase; click opens chat", async () => {
    const g = groupSessionAgents(list);
    expect(g.plain.map((a) => a.id)).toEqual(["main"]);
    expect([...(g.workflows.get("wf_1")?.keys() ?? [])]).toEqual(["Implement", "Verify"]);
    const fetchFn = (async () => new Response("[]")) as unknown as typeof fetch;
    render(<SessionAgents agents={list} fetchFn={fetchFn} />);
    expect(screen.getAllByTestId("phase-group")).toHaveLength(2);
    expect(screen.queryByTestId("agent-chat")).toBeNull();
    fireEvent.click(screen.getAllByTestId("agent-row")[1] as HTMLElement);
    expect(screen.getByTestId("agent-chat")).toHaveTextContent("impl T1");
  });
});
