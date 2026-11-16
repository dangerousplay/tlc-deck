import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { App } from "@/app";
import type { SessionInfo } from "@/lib/store";
import { useDeck } from "@/lib/store";
import { SessionDetail } from "./session-detail";
import { SessionsGrid } from "./sessions-grid";

const base: SessionInfo = {
  sessionId: "s1",
  project: "tlc-deck",
  model: "claude-opus",
  state: "working",
  currentTool: "Bash",
  subagents: [{ agentId: "a1", agentType: "reviewer" }],
  startedAt: 1,
  lastSeen: 2,
  linkedRun: "run-9",
  usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, costUsd: 1.5 },
};

describe("SessionsGrid", () => {
  test("card shows state, tool, model, tokens, cost, subagents, run link", () => {
    render(<SessionsGrid sessions={[base]} />);
    const card = screen.getByTestId("session-card");
    expect(within(card).getByTestId("session-state")).toHaveTextContent("working");
    expect(within(card).getByTestId("session-tool")).toHaveTextContent("Bash");
    expect(within(card).getByTestId("session-model")).toHaveTextContent("claude-opus");
    expect(within(card).getByTestId("session-tokens")).toHaveTextContent("165 tokens");
    expect(within(card).getByTestId("session-cost")).toHaveTextContent("$1.50");
    expect(within(card).getByTestId("session-subagents")).toHaveTextContent("1 subagent");
    expect(within(card).getByText("reviewer")).toBeInTheDocument();
    expect(within(card).getByTestId("linked-run")).toHaveAttribute("href", "/runs/run-9");
  });

  test.each(["waiting", "idle", "ended"] as const)("state %s", (state) => {
    render(
      <SessionsGrid
        sessions={[
          { ...base, state, currentTool: undefined, linkedRun: undefined, usage: undefined },
        ]}
      />,
    );
    expect(screen.getByTestId("session-state")).toHaveTextContent(state);
    expect(screen.queryByTestId("session-tool")).toBeNull();
    expect(screen.queryByTestId("linked-run")).toBeNull();
    expect(screen.getByTestId("session-cost")).toHaveTextContent("-");
  });

  test("empty", () => {
    render(<SessionsGrid sessions={[]} />);
    expect(screen.getByText("No live sessions.")).toBeInTheDocument();
  });
});

describe("SessionDetail", () => {
  test("timeline and usage", () => {
    render(
      <SessionDetail
        session={base}
        events={[
          { ts: 0, kind: "UserPromptSubmit", prompt: "hello" },
          { ts: 1000, kind: "PreToolUse", tool: "Bash" },
          { ts: 2000, kind: "SubagentStart", agentType: "reviewer" },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("session-event");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("prompt: hello");
    expect(rows[1]).toHaveTextContent("tool: Bash");
    expect(rows[2]).toHaveTextContent("subagent started: reviewer");
    expect(screen.getByTestId("session-usage")).toHaveTextContent("$1.50");
    expect(screen.getByTestId("linked-run")).toHaveAttribute("href", "/runs/run-9");
  });
});

describe("App routes", () => {
  test("/sessions renders grid from store", () => {
    useDeck.setState({ sessions: [base] });
    render(<App connect={false} path="/sessions" />);
    expect(screen.getByTestId("session-card")).toBeInTheDocument();
    useDeck.setState({ sessions: [] });
  });
});
