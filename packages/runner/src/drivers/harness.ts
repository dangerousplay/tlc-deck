import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverRequest, DriverResult, DriverUsage } from "../driver.js";
import { execCapture, extractJson, findBinary, num, obj, parseJsonLines, str } from "./exec.js";

export interface DriverOptions {
  /** Binary name or path; defaults to the harness name. */
  bin?: string;
  /** `driver.<h>.extraArgs` from config, appended verbatim. */
  extraArgs?: string[];
  timeoutMs?: number;
  /** Opt-in for flags that skip every permission prompt (agy). */
  allowUnsafe?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const tools = (role: DriverRequest["role"]) =>
  role === "implementer" ? "Read,Edit,Write,Bash,Glob,Grep" : "Read,Bash,Glob,Grep";

export interface BuildContext {
  schemaFile?: string;
  outFile?: string;
}

export interface HarnessSpec {
  name: string;
  /** Needs a schema file on disk (codex) and an output file. */
  buildArgs(req: DriverRequest, opts: DriverOptions, ctx: BuildContext): string[];
  parse(stdout: string, ctx: BuildContext): DriverResult;
  needsFiles?: boolean;
}

const schemaText = (req: DriverRequest) => JSON.stringify(req.schema);
const dataFromText = (text: string | undefined, harness: string): unknown => {
  const data = text === undefined ? undefined : extractJson(text);
  if (data === undefined) throw new Error(`${harness}: no JSON status object in output`);
  return data;
};

function envelopeUsage(env: Record<string, unknown>): DriverUsage | undefined {
  const u = obj(env.usage);
  const cost = env.total_cost_usd ?? env.cost_usd;
  if (Object.keys(u).length === 0 && cost === undefined) return undefined;
  const models = Object.keys(obj(env.modelUsage));
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    costUsd: typeof cost === "number" ? cost : null,
    ...(models[0] ? { model: models[0] } : {}),
  };
}

function parseEnvelope(harness: string, stdout: string): DriverResult {
  const env = extractJson(stdout);
  if (env === undefined) throw new Error(`${harness}: output is not valid JSON`);
  const e = obj(env);
  if (e.is_error === true) {
    throw new Error(`${harness}: ${str(e.result) ?? str(e.error) ?? "reported an error"}`);
  }
  const text = str(e.result) ?? str(e.response);
  const data = e.structured_output ?? dataFromText(text, harness);
  const usage = envelopeUsage(e);
  const sessionId = str(e.session_id);
  return {
    data,
    ...(text !== undefined ? { text } : {}),
    ...(usage ? { usage } : {}),
    ...(sessionId ? { sessionId } : {}),
    exitCode: 0,
  };
}

export const claudeSpec: HarnessSpec = {
  name: "claude",
  buildArgs: (req, opts) => [
    "-p",
    req.prompt,
    "--output-format",
    "json",
    "--json-schema",
    schemaText(req),
    ...(req.model ? ["--model", req.model] : []),
    ...(req.effort ? ["--effort", req.effort] : []),
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    tools(req.role),
    ...(opts.extraArgs ?? []),
  ],
  parse: (stdout) => parseEnvelope("claude", stdout),
};

export const agySpec: HarnessSpec = {
  name: "agy",
  buildArgs: (req, opts) => [
    "-p",
    req.prompt,
    "--output-format",
    "json",
    "--json-schema",
    schemaText(req),
    ...(req.model ? ["--model", req.model] : []),
    ...(req.effort ? ["--effort", req.effort] : []),
    ...(opts.allowUnsafe ? ["--dangerously-skip-permissions"] : []),
    ...(opts.extraArgs ?? []),
  ],
  parse: (stdout) => parseEnvelope("agy", stdout),
};

export const codexSpec: HarnessSpec = {
  name: "codex",
  needsFiles: true,
  buildArgs: (req, opts, ctx) => [
    "exec",
    "--json",
    "--output-schema",
    ctx.schemaFile ?? "",
    "-o",
    ctx.outFile ?? "",
    ...(req.model ? ["-m", req.model] : []),
    "-C",
    req.cwd,
    "--sandbox",
    "workspace-write",
    ...(opts.extraArgs ?? []),
    req.prompt,
  ],
  parse(stdout, ctx) {
    const events = parseJsonLines(stdout);
    let usage: DriverUsage | undefined;
    let sessionId: string | undefined;
    for (const ev of events) {
      if (ev.type === "thread.started") sessionId = str(ev.thread_id) ?? sessionId;
      if (ev.type === "turn.completed") {
        const u = obj(ev.usage);
        usage = {
          input: (usage?.input ?? 0) + num(u.input_tokens),
          output: (usage?.output ?? 0) + num(u.output_tokens),
          cacheRead: (usage?.cacheRead ?? 0) + num(u.cached_input_tokens),
          cacheWrite: 0,
          costUsd: null,
        };
      }
      if (ev.type === "turn.failed" || ev.type === "error") {
        throw new Error(`codex: ${str(obj(ev.error).message) ?? str(ev.message) ?? "turn failed"}`);
      }
    }
    let text: string | undefined;
    try {
      text = readFileSync(ctx.outFile ?? "", "utf8");
    } catch {
      throw new Error("codex: no output file written");
    }
    return {
      data: dataFromText(text, "codex"),
      text,
      ...(usage ? { usage } : {}),
      ...(sessionId ? { sessionId } : {}),
      exitCode: 0,
    };
  },
};

export const geminiSpec: HarnessSpec = {
  name: "gemini",
  buildArgs: (req, opts) => [
    "-p",
    req.prompt,
    "-o",
    "json",
    ...(req.model ? ["-m", req.model] : []),
    "--approval-mode",
    "auto_edit",
    ...(opts.extraArgs ?? []),
  ],
  parse(stdout) {
    const env = obj(extractJson(stdout));
    if (Object.keys(env).length === 0) throw new Error("gemini: output is not valid JSON");
    if (env.error) throw new Error(`gemini: ${str(obj(env.error).message) ?? "reported an error"}`);
    const text = str(env.response);
    const data = dataFromText(text, "gemini");
    let usage: DriverUsage | undefined;
    for (const [model, m] of Object.entries(obj(obj(env.stats).models))) {
      const t = obj(obj(m).tokens);
      const cached = num(t.cached);
      usage = {
        input: (usage?.input ?? 0) + Math.max(0, num(t.prompt) - cached),
        output: (usage?.output ?? 0) + num(t.candidates),
        cacheRead: (usage?.cacheRead ?? 0) + cached,
        cacheWrite: 0,
        costUsd: null,
        model: usage?.model ?? model,
      };
    }
    return {
      data,
      ...(text !== undefined ? { text } : {}),
      ...(usage ? { usage } : {}),
      exitCode: 0,
    };
  },
};

export const opencodeSpec: HarnessSpec = {
  name: "opencode",
  buildArgs: (req, opts) => [
    "run",
    "--format",
    "json",
    ...(req.model ? ["-m", req.model] : []),
    ...(opts.extraArgs ?? []),
    req.prompt,
  ],
  parse(stdout) {
    const events = parseJsonLines(stdout);
    if (events.length === 0) throw new Error("opencode: no JSON events in output");
    let text: string | undefined;
    let sessionId: string | undefined;
    let usage: DriverUsage | undefined;
    for (const ev of events) {
      sessionId = str(ev.sessionID) ?? sessionId;
      const part = obj(ev.part);
      if (ev.type === "text" && typeof part.text === "string") text = part.text;
      if (ev.type === "error") {
        throw new Error(
          `opencode: ${str(obj(obj(ev.error).data).message) ?? str(obj(ev.error).name) ?? "error"}`,
        );
      }
      if (ev.type === "step_finish") {
        const t = obj(part.tokens);
        const cache = obj(t.cache);
        const cost = part.cost;
        usage = {
          input: (usage?.input ?? 0) + num(t.input),
          output: (usage?.output ?? 0) + num(t.output),
          cacheRead: (usage?.cacheRead ?? 0) + num(cache.read),
          cacheWrite: (usage?.cacheWrite ?? 0) + num(cache.write),
          costUsd:
            typeof cost === "number" ? (usage?.costUsd ?? 0) + cost : (usage?.costUsd ?? null),
        };
      }
    }
    return {
      data: dataFromText(text, "opencode"),
      ...(text !== undefined ? { text } : {}),
      ...(usage ? { usage } : {}),
      ...(sessionId ? { sessionId } : {}),
      exitCode: 0,
    };
  },
};

export const SPECS: Record<string, HarnessSpec> = {
  claude: claudeSpec,
  codex: codexSpec,
  agy: agySpec,
  gemini: geminiSpec,
  opencode: opencodeSpec,
};

export class CliDriver implements Driver {
  readonly name: string;
  constructor(
    private readonly spec: HarnessSpec,
    private readonly opts: DriverOptions = {},
  ) {
    this.name = spec.name;
  }

  available(): boolean {
    return findBinary(this.opts.bin ?? this.spec.name, this.opts.env ?? process.env) !== undefined;
  }

  async run(req: DriverRequest): Promise<DriverResult> {
    const bin = this.opts.bin ?? this.spec.name;
    const env = this.opts.env ?? process.env;
    if (!findBinary(bin, env)) {
      throw new Error(`${this.spec.name}: binary "${bin}" not found on PATH`);
    }
    let dir: string | undefined;
    const ctx: BuildContext = {};
    try {
      if (this.spec.needsFiles) {
        dir = mkdtempSync(join(tmpdir(), "tlc-drv-"));
        ctx.schemaFile = join(dir, "schema.json");
        ctx.outFile = join(dir, "out.txt");
        writeFileSync(ctx.schemaFile, schemaText(req));
      }
      const args = this.spec.buildArgs(req, this.opts, ctx);
      const res = await execCapture(bin, args, {
        cwd: req.cwd,
        env,
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (res.code !== 0) {
        const tail = (res.stderr || res.stdout).trim().slice(-500);
        throw new Error(`${this.spec.name} exited with code ${res.code}: ${tail}`);
      }
      return this.spec.parse(res.stdout, ctx);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface DriverConfig {
  [harness: string]: DriverOptions | undefined;
}
