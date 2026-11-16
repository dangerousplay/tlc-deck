import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Io, run } from "../src/main.js";

let home: string;
let out: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tlc-home-"));
  out = "";
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const settings = () => join(home, ".claude", "settings.json");
const wf = () => join(home, ".claude", "workflows", "tlc-execute.js");

async function tlc(...argv: string[]) {
  const io: Io = {
    cwd: home,
    env: { HOME: home, PATH: "" },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      out += t;
    },
    version: "0",
  };
  return run(argv, io);
}

const ORIGINAL = `{\n    "model": "opus",\n    "hooks": {\n        "Stop": [\n            { "hooks": [{ "type": "command", "command": "echo hi" }] }\n        ]\n    }\n}\n`;

test("install hooks golden, idempotent, uninstall byte-identical", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settings(), ORIGINAL);
  expect(await tlc("install", "claude-code", "--hooks")).toBe(0);
  const installed = readFileSync(settings(), "utf8");
  const j = JSON.parse(installed);
  expect(Object.keys(j.hooks).sort()).toEqual(
    [
      "Notification",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ].sort(),
  );
  expect(j.hooks.Stop).toHaveLength(2);
  expect(j.hooks.Stop[0].hooks[0].command).toBe("echo hi");
  expect(j.hooks.PreToolUse[0].hooks[0]).toEqual({
    type: "http",
    url: "http://127.0.0.1:7317/hooks",
    timeout: 2,
    tlcDeck: true,
  });
  expect(installed.startsWith('{\n    "model"')).toBe(true);

  await tlc("install", "claude-code", "--hooks");
  expect(readFileSync(settings(), "utf8")).toBe(installed);
  expect(out).toContain("already installed");

  expect(await tlc("uninstall", "claude-code", "--hooks")).toBe(0);
  expect(readFileSync(settings(), "utf8")).toBe(ORIGINAL);
});

test("uninstall removes a created settings file; structural removal after user edits", async () => {
  await tlc("install", "claude-code", "--hooks");
  expect(existsSync(settings())).toBe(true);
  await tlc("uninstall", "claude-code", "--hooks");
  expect(existsSync(settings())).toBe(false);

  await tlc("install", "claude-code", "--hooks");
  const edited = { ...JSON.parse(readFileSync(settings(), "utf8")), theme: "dark" };
  writeFileSync(settings(), `${JSON.stringify(edited, null, 2)}\n`);
  await tlc("uninstall", "claude-code", "--hooks");
  expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual({ theme: "dark" });
});

test("--dry-run writes nothing", async () => {
  expect(await tlc("install", "claude-code", "--dry-run", "--hooks", "--panel")).toBe(0);
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(out).toContain("would write");
  expect(out).toContain("claude plugin marketplace add");
});

test("workflow copy backs up an existing file and uninstall restores it", async () => {
  mkdirSync(join(home, ".claude", "workflows"), { recursive: true });
  writeFileSync(wf(), "// mine\n");
  await tlc("install", "claude-code", "--workflow");
  expect(readFileSync(wf(), "utf8")).toContain("tlc");
  expect(readFileSync(`${wf()}.bak`, "utf8")).toBe("// mine\n");
  const first = readFileSync(wf(), "utf8");
  await tlc("install", "claude-code", "--workflow");
  expect(readFileSync(wf(), "utf8")).toBe(first);
  expect(readFileSync(`${wf()}.bak`, "utf8")).toBe("// mine\n");
  await tlc("uninstall", "claude-code", "--workflow");
  expect(readFileSync(wf(), "utf8")).toBe("// mine\n");
  expect(existsSync(`${wf()}.bak`)).toBe(false);
});

test("panel prints commands when claude is not on PATH", async () => {
  await tlc("install", "claude-code", "--panel");
  expect(out).toContain("not found on PATH");
  expect(out).toContain("claude plugin install tlc-deck-panel@tlc-deck");
});

test("rejects unknown target", async () => {
  expect(await tlc("install", "nope")).toBe(2);
});

test("install --otel writes env block, idempotent, uninstall restores", async () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const original = `{\n  "env": { "OTEL_METRICS_EXPORTER": "console", "KEEP": "1" }\n}\n`;
  writeFileSync(settings(), original);
  expect(await tlc("install", "claude-code", "--otel")).toBe(0);
  const env = JSON.parse(readFileSync(settings(), "utf8")).env;
  expect(env).toMatchObject({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:7317",
    KEEP: "1",
  });
  expect(existsSync(wf())).toBe(false);
  out = "";
  await tlc("install", "claude-code", "--otel");
  expect(out).toContain("already installed");
  expect(await tlc("uninstall", "claude-code", "--otel")).toBe(0);
  expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual(JSON.parse(original));
});
