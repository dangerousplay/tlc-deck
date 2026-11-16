import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { newClaudeState, parseClaudeLine } from "../src/transcripts/claude.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/transcripts/claude");

function run(name: string) {
  const state = newClaudeState(name);
  const items: ReturnType<typeof parseClaudeLine>["items"] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Set<string>();
  for (const line of readFileSync(join(dir, `${name}.jsonl`), "utf8").split("\n")) {
    const r = parseClaudeLine(line, state);
    items.push(...r.items);
    if (r.usage)
      for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += r.usage[k];
    if (r.model) models.add(r.model);
  }
  return { items, usage, models: [...models] };
}

const brief = (items: ReturnType<typeof run>["items"]) =>
  items.map((i) => [
    i.seq,
    i.kind,
    i.tool ?? i.toolUseId ?? "",
    i.text ?? i.input ?? i.output,
    i.isError ?? false,
  ]);

describe("parseClaudeLine", () => {
  test("main session golden", () => {
    const r = run("main");
    expect(brief(r.items)).toEqual([
      [0, "prompt", "", "Add a README to the project", false],
      [1, "text", "", "I will read the directory first.", false],
      [2, "tool_call", "Bash", { command: "ls", description: "List files" }, false],
      [3, "tool_result", "toolu_01", "package.json\nsrc", false],
      [4, "tool_call", "Read", { file_path: "/home/user/missing.md" }, false],
      [5, "tool_result", "toolu_02", "File does not exist.\nTry again.", true],
      [6, "text", "", "Done.", false],
    ]);
    expect(r.items[1]?.ts).toBe(Date.parse("2026-01-01T10:00:05.000Z"));
    expect(r.models).toEqual(["claude-opus-4-7"]);
    // msg_1 spans three lines but is counted once
    expect(r.usage).toEqual({ input: 14, output: 14, cacheRead: 100, cacheWrite: 20 });
  });

  test("subagent golden", () => {
    const r = run("subagent");
    expect(brief(r.items)).toEqual([
      [0, "prompt", "", "Find all TODO comments in src/", false],
      [1, "tool_call", "Grep", { pattern: "TODO", path: "src" }, false],
      [2, "tool_result", "toolu_a1", "src/a.ts:3: // TODO fix", false],
      [3, "text", "", "Found one TODO in src/a.ts line 3.", false],
    ]);
    expect(r.models).toEqual(["claude-haiku-4-5"]);
    expect(r.usage).toEqual({ input: 110, output: 26, cacheRead: 300, cacheWrite: 300 });
  });

  test("workflow agent golden", () => {
    const r = run("workflow");
    expect(brief(r.items).map((x) => x.slice(0, 3))).toEqual([
      [0, "prompt", ""],
      [1, "text", ""],
      [2, "tool_call", "Bash"],
      [3, "tool_result", "toolu_w1"],
      [4, "text", ""],
    ]);
    expect(r.items[0]?.text).toBe("Task T2 from tasks.md. Implement it.");
    expect(r.models).toEqual(["claude-sonnet-4-6"]);
  });

  test("malformed and non-message lines are skipped", () => {
    const s = newClaudeState("x");
    for (const l of ["", "{nope", "[]", "null", '{"type":"summary"}', '{"type":"user"}']) {
      expect(parseClaudeLine(l, s)).toEqual({ items: [] });
    }
    expect(s.seq).toBe(0);
  });

  test("redacts and caps content", () => {
    const s = newClaudeState("x");
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `token=abc123 ${"a".repeat(9000)}` }],
      },
    });
    const it = parseClaudeLine(line, s).items[0];
    expect(it?.text).not.toContain("abc123");
    expect(it?.truncated).toBe(true);
  });
});
