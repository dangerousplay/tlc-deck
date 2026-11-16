import { describe, expect, it } from "vitest";
import {
  AgentInfoSchema,
  AgentItemSchema,
  advisorOutputJsonSchema,
  parseLine,
  reviewerOutputJsonSchema,
  statusOutputJsonSchema,
} from "../src/index.js";

describe("harness JSON schemas", () => {
  it("omit $schema (claude --json-schema rejects the 2020-12 meta-schema URI)", () => {
    for (const s of [statusOutputJsonSchema, reviewerOutputJsonSchema, advisorOutputJsonSchema]) {
      expect(s).not.toHaveProperty("$schema");
      expect(s.type).toBe("object");
    }
  });
});

const meta = {
  v: 1,
  seq: 1,
  runId: "tlc_01J",
  threadId: "repo#feat",
  harness: "claude-code",
  driver: "workflow",
  source: "implementer",
};
const line = (e: object) => JSON.stringify({ timestamp: 1, metadata: meta, ...e });
const custom = (name: string, value: unknown) => line({ type: "CUSTOM", name, value });

describe("agent schemas", () => {
  const agent = { id: "a1", harness: "claude-code", status: "running", startedAt: 1 };
  it("tlc.agent accepts partial upsert and rejects missing id", () => {
    expect(parseLine(custom("tlc.agent", { id: "a1", status: "done" })).ok).toBe(true);
    expect(parseLine(custom("tlc.agent", { status: "done" })).ok).toBe(false);
    expect(parseLine(custom("tlc.agent", { id: "a1", status: "bogus" })).ok).toBe(false);
    expect(parseLine(custom("tlc.agent", { ...agent, source: "tlc-run" })).ok).toBe(true);
  });
  it("AgentItem schema", () => {
    const ok = AgentItemSchema.safeParse({
      agentId: "a",
      seq: 0,
      ts: 1,
      kind: "tool_call",
      input: { a: 1 },
    });
    expect(ok.success).toBe(true);
    expect(AgentItemSchema.safeParse({ agentId: "a", seq: 0, ts: 1, kind: "nope" }).success).toBe(
      false,
    );
    expect(AgentInfoSchema.safeParse({ ...agent, source: "claude-code" }).success).toBe(true);
  });
  it("RUN_STARTED input.repoPath optional string", () => {
    const rs = (input: unknown) => line({ type: "RUN_STARTED", threadId: "t", runId: "r", input });
    expect(parseLine(rs({ feature: "f", repoPath: "/x" })).ok).toBe(true);
    expect(parseLine(rs({ feature: "f" })).ok).toBe(true);
    expect(parseLine(rs({ repoPath: 5 })).ok).toBe(false);
  });
});
