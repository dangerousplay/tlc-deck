import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  agySpec,
  claudeSpec,
  codexSpec,
  createDriverFactory,
  type DriverRequest,
  findBinary,
  geminiSpec,
  opencodeSpec,
} from "../src/index.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "bin");
let tmp: string;
let argvFile: string;
const schema = { type: "object" };
const req = (over: Partial<DriverRequest> = {}): DriverRequest => ({
  role: "implementer",
  prompt: "do T1",
  model: "m1",
  effort: "high",
  cwd: tmp,
  schema,
  ...over,
});
const env = (mode = "ok") => ({
  ...process.env,
  PATH: `${BIN}:${process.env.PATH}`,
  FAKE_MODE: mode,
  FAKE_ARGV_FILE: argvFile,
});
const argvs = () =>
  readFileSync(argvFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
const status = {
  status: "Complete",
  files: ["a.ts"],
  gate: { pass: true, summary: "ok" },
  deviations: [],
  issues: [],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tlc-drv-test-"));
  argvFile = join(tmp, "argv");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("argv golden", () => {
  const ctx = { schemaFile: "/s.json", outFile: "/o.txt" };
  test("claude", () => {
    expect(claudeSpec.buildArgs(req(), { extraArgs: ["--x"] }, ctx)).toEqual([
      "-p",
      "do T1",
      "--output-format",
      "json",
      "--json-schema",
      '{"type":"object"}',
      "--model",
      "m1",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Bash,Glob,Grep",
      "--x",
    ]);
  });
  test("codex", () => {
    expect(codexSpec.buildArgs(req(), { extraArgs: ["--x"] }, ctx)).toEqual([
      "exec",
      "--json",
      "--output-schema",
      "/s.json",
      "-o",
      "/o.txt",
      "-m",
      "m1",
      "-C",
      tmp,
      "--sandbox",
      "workspace-write",
      "--x",
      "do T1",
    ]);
  });
  test("agy: unsafe flag only when opted in", () => {
    expect(agySpec.buildArgs(req(), {}, ctx)).not.toContain("--dangerously-skip-permissions");
    expect(agySpec.buildArgs(req(), { allowUnsafe: true }, ctx)).toEqual([
      "-p",
      "do T1",
      "--output-format",
      "json",
      "--json-schema",
      '{"type":"object"}',
      "--model",
      "m1",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
    ]);
  });
  test("gemini", () => {
    expect(geminiSpec.buildArgs(req(), {}, ctx)).toEqual([
      "-p",
      "do T1",
      "-o",
      "json",
      "-m",
      "m1",
      "--approval-mode",
      "auto_edit",
    ]);
  });
  test("opencode", () => {
    expect(opencodeSpec.buildArgs(req(), {}, ctx)).toEqual([
      "run",
      "--format",
      "json",
      "-m",
      "m1",
      "do T1",
    ]);
  });
  test("reviewer gets read-only tools", () => {
    expect(claudeSpec.buildArgs(req({ role: "reviewer" }), {}, ctx)).toContain(
      "Read,Bash,Glob,Grep",
    );
  });
});

describe("fake executables", () => {
  test("claude: structured_output + usage + cost + session", async () => {
    const r = await createDriverFactory({ claude: { env: env(), extraArgs: ["--foo"] } })(
      "claude",
    ).run(req());
    expect(r.data).toEqual(status);
    expect(r.sessionId).toBe("sess-claude");
    expect(r.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
      costUsd: 0.42,
      model: "claude-sonnet-5-5",
    });
    expect(argvs()[0]).toContain("--foo");
  });

  test("claude: falls back to JSON in result text", async () => {
    const r = await createDriverFactory({ claude: { env: env("noschema") } })("claude").run(req());
    expect(r.data).toEqual(status);
  });

  test("codex: output file + turn.completed usage", async () => {
    const r = await createDriverFactory({ codex: { env: env() } })("codex").run(req());
    expect(r.data).toEqual(status);
    expect(r.sessionId).toBe("thr-1");
    expect(r.usage).toEqual({
      input: 200,
      output: 40,
      cacheRead: 50,
      cacheWrite: 0,
      costUsd: null,
    });
  });

  test("codex: missing output file -> error", async () => {
    await expect(
      createDriverFactory({ codex: { env: env("nofile") } })("codex").run(req()),
    ).rejects.toThrow(/output file/);
  });

  test("agy: envelope", async () => {
    const r = await createDriverFactory({ agy: { env: env() } })("agy").run(req());
    expect(r.data).toEqual(status);
    expect(r.usage).toMatchObject({ input: 7, output: 3, costUsd: null });
  });

  test("gemini: JSON parsed from response, usage from stats", async () => {
    const r = await createDriverFactory({ gemini: { env: env() } })("gemini").run(req());
    expect(r.data).toEqual(status);
    expect(r.usage).toEqual({
      input: 60,
      output: 12,
      cacheRead: 30,
      cacheWrite: 0,
      costUsd: null,
      model: "gemini-3-pro",
    });
  });

  test("opencode: last text part + step_finish usage", async () => {
    const r = await createDriverFactory({ opencode: { env: env() } })("opencode").run(req());
    expect(r.data).toEqual(status);
    expect(r.sessionId).toBe("ses-oc");
    expect(r.usage).toEqual({ input: 11, output: 22, cacheRead: 3, cacheWrite: 4, costUsd: 0.05 });
  });

  test("opencode: without step_finish has no usage", async () => {
    const r = await createDriverFactory({ opencode: { env: env("nostep") } })("opencode").run(
      req(),
    );
    expect(r.data).toEqual(status);
    expect(r.usage).toBeUndefined();
  });

  for (const h of ["claude", "codex", "agy", "gemini", "opencode"]) {
    test(`${h}: malformed output rejects`, async () => {
      await expect(
        createDriverFactory({ [h]: { env: env("malformed") } })(h).run(req()),
      ).rejects.toThrow();
    });
    test(`${h}: non-zero exit rejects with stderr`, async () => {
      await expect(
        createDriverFactory({ [h]: { env: env("fail") } })(h).run(req()),
      ).rejects.toThrow(/code 3.*boom/);
    });
    test(`${h}: missing binary rejects`, async () => {
      const d = createDriverFactory({ [h]: { env: { PATH: tmp } } })(h);
      await expect(d.run(req())).rejects.toThrow(/not found on PATH/);
    });
  }

  test("timeout kills the process", async () => {
    const d = createDriverFactory({ claude: { env: env("hang"), timeoutMs: 200 } })("claude");
    await expect(d.run(req())).rejects.toThrow(/timed out/);
  });

  test("unknown harness rejects", async () => {
    await expect(createDriverFactory()("nope").run(req())).rejects.toThrow(/no driver/);
  });

  test("findBinary", () => {
    expect(findBinary("claude", { PATH: BIN })).toBe(join(BIN, "claude"));
    expect(findBinary("nonexistent-xyz", { PATH: BIN })).toBeUndefined();
  });
});
