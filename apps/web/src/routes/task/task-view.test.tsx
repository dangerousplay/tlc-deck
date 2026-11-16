import { render, screen, within } from "@testing-library/react";
import type { TaskDetails } from "@tlc-deck/core";
import type { AgentInfo } from "@tlc-deck/protocol";
import { describe, expect, test } from "vitest";
import golden from "../../../../../fixtures/plans/memo-harness-integration/expected-details.json";
import { App } from "../../app";
import { RunDetail } from "../run/run-detail";
import { TaskPage } from "./task-page";
import { type TaskData, TaskView, taskHref } from "./task-view";

const details = (golden as Record<string, TaskDetails>).T3 as TaskDetails;

const data: TaskData = {
  details,
  state: {
    task: { id: "T3", status: "running", attempt: 2 } as TaskData["state"]["task"],
    stages: [
      { stage: "implement", attempt: 1, startedAt: 0, endedAt: 95_000, durationMs: 95_000 },
      { stage: "review", attempt: 2, startedAt: 100_000 },
    ],
  },
};

const agents = [
  { id: "a1", stage: "implement", label: "impl", status: "done", model: "sonnet" },
  { id: "a2", stage: "review", role: "reviewer", status: "running" },
] as AgentInfo[];

describe("TaskView (memo golden details)", () => {
  test("spec block", () => {
    render(<TaskView runId="r1" taskId="T3" data={data} agents={agents} />);
    expect(screen.getByText(details.title)).toBeInTheDocument();
    const deps = screen.getAllByTestId("dep-link");
    expect(deps.map((d) => d.textContent)).toEqual(details.dependsOn);
    expect(deps[0]).toHaveAttribute("href", taskHref("r1", "T2"));
    const reqs = screen.getAllByTestId("requirement");
    expect(reqs).toHaveLength(details.requirements.length);
    expect(reqs[0]).toHaveTextContent(/^CLI-01\s*WHEN `memo login` runs/);
    const done = screen.getAllByTestId("done-when");
    expect(done).toHaveLength(3);
    expect(done.every((d) => d.getAttribute("data-checked") === "true")).toBe(true);
  });

  test("stage timeline with durations and attempts", () => {
    render(<TaskView runId="r1" taskId="T3" data={data} agents={agents} />);
    const entries = screen.getAllByTestId("stage-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("implement");
    expect(entries[0]).toHaveTextContent("1m 35s");
    expect(entries[1]).toHaveTextContent("attempt 2");
    expect(entries[1]).toHaveTextContent("in progress");
  });

  test("agents grouped per stage", () => {
    render(<TaskView runId="r1" taskId="T3" data={data} agents={agents} />);
    const rows = screen.getAllByTestId("agent-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText("reviewer")).toBeInTheDocument();
  });

  test("missing plan shows notice, still timeline", () => {
    render(
      <TaskView
        runId="r1"
        taskId="T3"
        data={{ ...data, details: null, notice: "repository path unknown for this run" }}
      />,
    );
    expect(screen.getByTestId("task-notice")).toHaveTextContent("repository path unknown");
    expect(screen.queryByTestId("task-spec")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("stage-entry")).toHaveLength(2);
  });
});

describe("TaskPage / routing", () => {
  test("fetches details and agents", async () => {
    const fetchFn = (async (url: string) =>
      new Response(JSON.stringify(url.includes("/api/agents") ? agents : data))) as typeof fetch;
    render(<TaskPage runId="r1" taskId="T3" fetchFn={fetchFn} />);
    expect(await screen.findByTestId("task-view")).toBeInTheDocument();
    expect(await screen.findAllByTestId("agent-row")).toHaveLength(2);
  });

  test("App routes /runs/:run/tasks/:task to the task page", () => {
    render(<App connect={false} path="/runs/r1/tasks/T3" />);
    expect(screen.getByRole("heading", { name: "Task detail" })).toBeInTheDocument();
  });

  test("board cards link to the full page", () => {
    const run = {
      runId: "r1",
      status: "running",
      tasks: { T3: { id: "T3", status: "pending" } },
      milestones: [],
      blockers: [],
      usageByRole: {},
      usageByModel: {},
      startedAt: 0,
    } as never;
    render(<RunDetail run={run} events={[]} now={0} />);
    expect(screen.getByTestId("task-link")).toHaveAttribute("href", "/runs/r1/tasks/T3");
  });
});
