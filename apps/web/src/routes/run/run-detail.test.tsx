import { render, screen, within } from "@testing-library/react";
import { fold } from "@tlc-deck/core";
import { parseLine, type TlcEvent } from "@tlc-deck/protocol";
import { describe, expect, test } from "vitest";
import golden from "../../../../../fixtures/runs/golden-15.ndjson?raw";
import { RunDetail } from "./run-detail";

const events: TlcEvent[] = [];
for (const line of golden.split("\n")) {
  const r = parseLine(line);
  if (r.ok) events.push(r.event);
}
const end = events[events.length - 1]?.timestamp ?? 0;
const run = fold(events, { now: end });

describe("RunDetail (golden run)", () => {
  test("board column counts", () => {
    render(<RunDetail run={run} events={events} now={end} />);
    expect(screen.getByTestId("count-done")).toHaveTextContent("14");
    expect(screen.getByTestId("count-failed")).toHaveTextContent("1");
    expect(screen.getAllByTestId("task-card")).toHaveLength(15);
    const failed = within(screen.getByTestId("col-failed"));
    expect(failed.getByText("T9")).toBeInTheDocument();
    expect(failed.getByText(/3 failing/)).toBeInTheDocument();
  });

  test("open blocker shown, resolved hidden", () => {
    render(<RunDetail run={run} events={events} now={end} />);
    const open = run.blockers.filter((b) => b.open);
    expect(open.length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("blocker")).toHaveLength(open.length);
    for (const b of run.blockers.filter((x) => !x.open)) {
      expect(screen.queryByText(b.reason)).not.toBeInTheDocument();
    }
  });

  test("milestone reached states", () => {
    render(<RunDetail run={run} events={events} now={end} />);
    const items = screen.getAllByTestId("milestone");
    expect(items).toHaveLength(run.milestones.length);
    items.forEach((el, i) => {
      expect(el.getAttribute("data-reached")).toBe(String(run.milestones[i]?.reached));
    });
  });

  test("usage, deviations and virtualised log", () => {
    render(<RunDetail run={run} events={events} now={end} />);
    expect(screen.getAllByTestId("usage-row").length).toBeGreaterThan(0);
    expect(screen.getByText(/used fs.watch/)).toBeInTheDocument();
    expect(screen.getAllByTestId("log-row").length).toBeLessThan(events.length);
  });
});
