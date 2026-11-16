import { expect, test } from "claude-code/testing";

const RUN = {
  runId: "r1",
  status: "running",
  tasks: {
    T1: { id: "T1", title: "scaffold", status: "done" },
    T2: { id: "T2", title: "protocol", status: "running", stage: "verify", attempt: 1 },
    T3: { id: "T3", title: "core", status: "blocked" },
  },
  milestones: [{ name: "Foundation", reached: false }],
  blockers: [{ id: "b1", task: "T3", kind: "blocked", reason: "needs input", open: true }],
  usageByRole: { implementer: { costUsd: 1.5 } },
};

const PANE = {
  plugin: "tlc-deck-panel",
  component: "Pane",
  requestId: "tlc",
  props: {
    title: "tlc",
    isFocused: false,
    bodyColumns: 80,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

async function start($: any, on: any, out: { exitCode: number; stdout: string }) {
  const statuses: string[] = [];
  const argvs: string[][] = [];
  on("command.register", () => ({ value: { command: "tlc" } }));
  on("process.run", (_: any, e: any) => {
    argvs.push([...e.argv]);
    return { value: { ...out, stderr: "" } };
  });
  on("ui.status", (_: any, e: any) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("session.start", (_: any, e: any) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  return { statuses, argvs };
}

test("running: status text and pane rows", async ($, on) => {
  const { statuses, argvs } = await start($, on, { exitCode: 0, stdout: JSON.stringify(RUN) });
  expect(statuses[statuses.length - 1]).toBe("tlc 1/3 ▲1");
  expect(argvs[0]).toEqual(["tlc", "status", "--json"]);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /tasks 1\/3 blockers 1 cost \$1.50/ })).toBeTruthy();
  expect(await ui.find({ type: "Text", text: /▲ T3 blocked: needs input/ })).toBeTruthy();
  expect(await ui.find({ type: "Text", text: /running T2 protocol \[verify #1\]/ })).toBeTruthy();
  await ui.unmount();
});

test("no run: status text and pane hint", async ($, on) => {
  const { statuses } = await start($, on, { exitCode: 1, stdout: "" });
  expect(statuses[statuses.length - 1]).toBe("tlc -");

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /no active run/ })).toBeTruthy();
  await ui.unmount();
});
