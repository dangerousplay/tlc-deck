import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { commitMessage, resolveGate, taskBlock } from "../src/tasks.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/plans");
const memo = readFileSync(join(dir, "memo-harness-integration/tasks.md"), "utf8");

test("taskBlock returns one block, heading included", () => {
  const b = taskBlock(memo, "T2") ?? "";
  expect(b.startsWith("### T2:")).toBe(true);
  expect(b).not.toContain("### T3:");
  expect(taskBlock(memo, "T99")).toBeUndefined();
});

test("resolveGate: table name, inline command, none", () => {
  expect(resolveGate(memo, "T1")).toEqual({
    name: "Quick",
    command: "cargo test -p memo-cli --lib",
  });
  expect(resolveGate(memo, "T2")?.name).toBe("Full");
  expect(resolveGate(memo, "T12")?.name).toBe("Build");
  const md = "### T1: A\n\n**Gate**: `pnpm check`\n\n### T2: B\n\n**What**: x\n";
  expect(resolveGate(md, "T1")).toEqual({ name: "pnpm check", command: "pnpm check" });
  expect(resolveGate(md, "T2")).toBeNull();
  expect(resolveGate(md, "T9")).toBeNull();
});

test("commitMessage goldens on the memo plan", () => {
  const trailer = "Co-Authored-By: X <x@y>";
  const msgs = ["T1", "T2", "T9", "T13", "T15"].map((id) => commitMessage(memo, id, trailer));
  expect(msgs).toMatchInlineSnapshot(`
    [
      "feat(memo-cli): Crate scaffold, config, project (T1)

    Co-Authored-By: X <x@y>",
      "feat(memo-cli): Local state (T2)

    Co-Authored-By: X <x@y>",
      "feat(memo-cli): statusline, events, status, doctor (T9)

    Co-Authored-By: X <x@y>",
      "feat(claude-code): Claude Code mod \`memo-panel\` (T13)

    Co-Authored-By: X <x@y>",
      "feat(memo-cli): End-to-end and docs (T15)

    Co-Authored-By: X <x@y>",
    ]
  `);
});

test("commitMessage type rules", () => {
  const md = (title: string, where: string) => `### T1: ${title}\n\n**Where**: ${where}\n`;
  expect(commitMessage(md("Test harness", "`packages/cli/test/a.ts`"), "T1")).toBe(
    "test(cli): Test harness (T1)",
  );
  expect(commitMessage(md("E2E run", "`packages/cli/test/a.ts`"), "T1")).toBe(
    "test(cli): E2E run (T1)",
  );
  expect(commitMessage(md("Guide", "`README.md`, `docs/*`"), "T1")).toBe(
    "docs(readme): Guide (T1)",
  );
  expect(commitMessage(md("Thing", "`integrations/claude-code/x`"), "T1")).toBe(
    "feat(claude-code): Thing (T1)",
  );
});
