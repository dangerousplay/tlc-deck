import type { AgentItem } from "@tlc-deck/protocol";
import { describe, expect, test } from "vitest";
import { cap, capItem, redact } from "../src/content.js";

const base: AgentItem = { agentId: "a", seq: 0, ts: 1, kind: "tool_call" };

describe("redact", () => {
  const cases: [string, string][] = [
    ["sk-abcdefghijklmnopqrstuvwxyz", "sk-"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_"],
    ["xoxb-1234567890-abcdef", "xoxb-"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIA"],
    ["Authorization: Bearer abc.def.ghi", "abc.def"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "MIIE"],
    ["password=hunter2", "hunter2"],
    ['api_key: "zzz"', "zzz"],
    ["TOKEN = abc123", "abc123"],
  ];
  test.each(cases)("redacts %s", (input, secret) => {
    const out = redact(input);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret);
  });

  test("no false positives on ordinary code", () => {
    const code = [
      "const task = skip(); // sk-short",
      "function tokenize(input: string) { return input.split(' '); }",
      "const passwordField = document.getElementById('pw');",
      "import { Bearer } from './x'; // Bearer",
      "if (secretCount > 0) return;",
    ].join("\n");
    expect(redact(code)).toBe(code);
  });
});

describe("cap", () => {
  test("short text untouched", () => {
    expect(cap("hi")).toEqual({ text: "hi", truncated: false, fullLength: 2 });
  });
  test("long text truncated", () => {
    const c = cap("x".repeat(9000), 8192);
    expect(c.text.length).toBe(8192);
    expect(c.truncated).toBe(true);
    expect(c.fullLength).toBe(9000);
  });
});

describe("capItem", () => {
  test("marks truncated + fullLength and redacts text", () => {
    const r = capItem({ ...base, kind: "text", text: `password=abc ${"y".repeat(9000)}` });
    expect(r.truncated).toBe(true);
    expect(r.fullLength).toBeGreaterThan(8192);
    expect(r.text).not.toContain("abc ");
  });
  test("small JSON input stays an object and is redacted", () => {
    const r = capItem({ ...base, input: { cmd: "curl -H 'Bearer tok123456789'", n: 1 } });
    expect(typeof r.input).toBe("object");
    expect(JSON.stringify(r.input)).not.toContain("tok123456789");
    expect(r.truncated).toBeUndefined();
  });
  test("large JSON input is capped to a string when no longer valid JSON", () => {
    const r = capItem({ ...base, input: { data: "z".repeat(9000) } });
    expect(r.truncated).toBe(true);
    expect(typeof r.input).toBe("string");
    expect((r.input as string).length).toBe(8192);
  });
  test("string output capped", () => {
    const r = capItem({ ...base, kind: "tool_result", output: "o".repeat(10000) });
    expect(r.truncated).toBe(true);
    expect(r.fullLength).toBe(10000);
  });
});
