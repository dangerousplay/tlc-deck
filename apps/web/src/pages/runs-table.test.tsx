import { render, screen, within } from "@testing-library/react";
import type { RunState } from "@tlc-deck/protocol";
import { describe, expect, test } from "vitest";
import { App } from "@/app";
import { useDeck } from "@/lib/store";
import { RunsTable } from "./runs-table";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const run: RunState = {
  runId: "run-1",
  repo: "memo",
  feature: "harness-integration",
  harness: "codex",
  status: "running",
  startedAt: 1_000,
  tasks: {
    T1: { id: "T1", status: "done" },
    T2: { id: "T2", status: "running" },
  },
  milestones: [
    { name: "a", source: "field", tasks: ["T1"], reached: true },
    { name: "b", source: "field", tasks: ["T2"], reached: true },
    { name: "c", source: "field", tasks: ["T3"], reached: true },
    { name: "d", source: "field", tasks: ["T4"], reached: false },
    { name: "e", source: "field", tasks: ["T5"], reached: false },
  ],
  blockers: [
    { id: "b1", task: "T2", kind: "gate", reason: "x", open: true },
    { id: "b2", task: "T1", kind: "gate", reason: "y", open: false },
  ],
  usageByRole: {},
  usageByModel: {
    m1: { ...zero, costUsd: 1.25 },
    m2: { ...zero, costUsd: 0.5 },
  },
};

describe("RunsTable", () => {
  test("renders status, milestones, blockers and cost", () => {
    render(<RunsTable runs={[run]} now={61_000} />);
    const row = screen.getByTestId("run-row");
    expect(within(row).getByTestId("repo")).toHaveTextContent("memo");
    expect(within(row).getByTestId("feature")).toHaveTextContent("harness-integration");
    expect(within(row).getByTestId("harness")).toHaveTextContent("codex");
    expect(within(row).getByTestId("status")).toHaveTextContent("running");
    expect(within(row).getByTestId("milestones")).toHaveTextContent("3/5");
    expect(within(row).getByTestId("tasks")).toHaveTextContent("1/2");
    expect(within(row).getByTestId("blockers")).toHaveTextContent("1");
    expect(within(row).getByTestId("cost")).toHaveTextContent("$1.75");
    expect(row).toHaveTextContent("1m 0s");
  });

  test("empty state", () => {
    render(<RunsTable runs={[]} />);
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
  });
});

describe("App shell", () => {
  test("sidebar, sessions placeholder and store-fed runs", () => {
    useDeck.setState({ runs: [run] });
    render(<App connect={false} />);
    for (const l of ["Overview", "Runs", "Sessions"]) {
      expect(screen.getByRole("link", { name: l })).toBeInTheDocument();
    }
    expect(screen.getByText("No live sessions.")).toBeInTheDocument();
    expect(screen.getAllByTestId("run-row")).toHaveLength(1);
  });
});
