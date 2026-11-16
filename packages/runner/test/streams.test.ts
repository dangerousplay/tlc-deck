import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  agyParser,
  claudeParser,
  codexParser,
  geminiParser,
  opencodeParser,
  type StreamItem,
  type StreamParser,
} from "../src/index.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "streams");

function run(parser: StreamParser, harness: string) {
  const items: StreamItem[] = [];
  const lines = readFileSync(join(DIR, harness, "basic.jsonl"), "utf8").split("\n");
  for (const l of lines) items.push(...parser.feed(l));
  items.push(...parser.end());
  return { items, result: parser.result() };
}

describe("stream parser goldens", () => {
  test("claude", () => {
    const { items, result } = run(claudeParser(), "claude");
    expect(items).toEqual([
      { kind: "text", text: "Running the gate." },
      { kind: "tool_call", tool: "Bash", toolUseId: "tu1", input: { command: "pnpm check" } },
      { kind: "tool_result", toolUseId: "tu1", output: "all green" },
    ]);
    expect(result).toMatchObject({
      ended: true,
      sessionId: "sess-claude",
      model: "claude-sonnet-5-5",
      data: { status: "Complete" },
      usage: { input: 100, output: 50, costUsd: 0.42 },
    });
  });

  test("codex", () => {
    const { items, result } = run(codexParser(), "codex");
    expect(items.map((i) => i.kind)).toEqual(["tool_call", "tool_result", "text"]);
    expect(items[0]).toMatchObject({ tool: "Bash", input: { command: "pnpm check" } });
    expect(result).toMatchObject({ sessionId: "thr-1", usage: { input: 200, output: 40 } });
  });

  test("agy", () => {
    const { items, result } = run(agyParser(), "agy");
    expect(items).toEqual([
      { kind: "text", text: "Checking files." },
      { kind: "tool_call", tool: "run_command", toolUseId: "c1", input: { command: "pnpm check" } },
      { kind: "tool_result", toolUseId: "c1", output: "ok" },
    ]);
    expect(result).toMatchObject({ ended: true, data: { status: "Complete" } });
  });

  test("gemini", () => {
    const { items, result } = run(geminiParser(), "gemini");
    expect(items.map((i) => i.kind)).toEqual(["text", "tool_call", "tool_result", "text"]);
    expect(items[0]?.text).toBe("Reading files.");
    expect(items[1]).toMatchObject({ tool: "read_file", toolUseId: "g1" });
    expect(result).toMatchObject({
      ended: true,
      usage: { input: 60, output: 12, cacheRead: 30, model: "gemini-3-pro" },
    });
    expect(result.text).toContain("Complete");
  });

  test("opencode", () => {
    const { items, result } = run(opencodeParser(), "opencode");
    expect(items.map((i) => i.kind)).toEqual(["tool_call", "tool_result", "text"]);
    expect(items[1]).toMatchObject({ toolUseId: "o1", output: "ok" });
    expect(result).toMatchObject({ sessionId: "ses-oc", usage: { input: 11, costUsd: 0.05 } });
  });

  test("noise lines are ignored", () => {
    const p = claudeParser();
    expect(p.feed("not json")).toEqual([]);
    expect(p.feed("")).toEqual([]);
    expect(p.result().ended).toBe(false);
  });
});
