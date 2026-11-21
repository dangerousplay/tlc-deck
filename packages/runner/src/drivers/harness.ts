import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverRequest, DriverResult, ResumeCapability } from "../driver.js";
import {
  agyParser,
  claudeParser,
  codexParser,
  geminiParser,
  opencodeParser,
  type StreamItem,
  type StreamParser,
  type StreamResult,
} from "../streams/index.js";
import { execCapture, extractJson, findBinary } from "./exec.js";

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
  /** DD-02: whether `resumeSessionId` is honoured. */
  resume: ResumeCapability;
  /** Needs a schema file on disk (codex) and an output file. */
  buildArgs(req: DriverRequest, opts: DriverOptions, ctx: BuildContext): string[];
  /** Fresh incremental parser of the harness's streaming output (DD-10). */
  stream(): StreamParser;
  /** Final DriverResult from the parsed stream. */
  finish(result: StreamResult, ctx: BuildContext): DriverResult;
  needsFiles?: boolean;
}

const schemaText = (req: DriverRequest) => JSON.stringify(req.schema);
const dataFromText = (text: string | undefined, harness: string): unknown => {
  const data = text === undefined ? undefined : extractJson(text);
  if (data === undefined) throw new Error(`${harness}: no JSON status object in output`);
  return data;
};

/** Turns a finished stream into a DriverResult (structured status extraction per harness). */
function finish(harness: string, r: StreamResult, requireEnd: boolean): DriverResult {
  if (r.error) throw new Error(`${harness}: ${r.error}`);
  if (requireEnd && !r.ended) throw new Error(`${harness}: no result event in output`);
  const data = r.data ?? dataFromText(r.text, harness);
  return {
    data,
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    exitCode: 0,
  };
}

export const claudeSpec: HarnessSpec = {
  name: "claude",
  resume: "id",
  buildArgs: (req, opts) => [
    "-p",
    req.prompt,
    ...(req.resumeSessionId ? ["-r", req.resumeSessionId] : []),
    "--output-format",
    "stream-json",
    "--verbose",
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
  stream: claudeParser,
  finish: (r) => finish("claude", r, true),
};

export const agySpec: HarnessSpec = {
  name: "agy",
  resume: "id",
  buildArgs: (req, opts) => [
    "-p",
    req.prompt,
    ...(req.resumeSessionId ? ["--conversation", req.resumeSessionId] : []),
    "--output-format",
    "stream-json",
    "--json-schema",
    schemaText(req),
    ...(req.model ? ["--model", req.model] : []),
    ...(req.effort ? ["--effort", req.effort] : []),
    ...(opts.allowUnsafe ? ["--dangerously-skip-permissions"] : []),
    ...(opts.extraArgs ?? []),
  ],
  stream: agyParser,
  finish: (r) => finish("agy", r, true),
};

export const codexSpec: HarnessSpec = {
  name: "codex",
  resume: "id",
  needsFiles: true,
  buildArgs: (req, opts, ctx) => [
    "exec",
    ...(req.resumeSessionId ? ["resume", req.resumeSessionId] : []),
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
  stream: codexParser,
  finish(r, ctx) {
    if (r.error) throw new Error(`codex: ${r.error}`);
    let text: string | undefined;
    try {
      text = readFileSync(ctx.outFile ?? "", "utf8");
    } catch {
      throw new Error("codex: no output file written");
    }
    return finish("codex", { ...r, text, data: undefined }, false);
  },
};

export const geminiSpec: HarnessSpec = {
  name: "gemini",
  resume: "none",
  buildArgs: (req, opts) => [
    "-p",
    req.prompt,
    "-o",
    "stream-json",
    ...(req.model ? ["-m", req.model] : []),
    "--approval-mode",
    "auto_edit",
    ...(opts.extraArgs ?? []),
  ],
  stream: geminiParser,
  finish: (r) => finish("gemini", r, true),
};

export const opencodeSpec: HarnessSpec = {
  name: "opencode",
  resume: "id",
  buildArgs: (req, opts) => [
    "run",
    "--format",
    "json",
    ...(req.resumeSessionId ? ["-s", req.resumeSessionId] : []),
    ...(req.model ? ["-m", req.model] : []),
    ...(opts.extraArgs ?? []),
    req.prompt,
  ],
  stream: opencodeParser,
  finish(r) {
    if (!r.ended) throw new Error("opencode: no JSON events in output");
    return finish("opencode", r, false);
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
  readonly resume: ResumeCapability;
  constructor(
    private readonly spec: HarnessSpec,
    private readonly opts: DriverOptions = {},
  ) {
    this.name = spec.name;
    this.resume = spec.resume;
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
      const parser = this.spec.stream();
      const emit = (items: StreamItem[]) => {
        if (req.onItem) for (const it of items) req.onItem(it);
      };
      const res = await execCapture(bin, args, {
        cwd: req.cwd,
        env,
        onLine: (line) => {
          try {
            emit(parser.feed(line));
          } catch {
            // a parser bug must not break the run
          }
        },
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (res.code !== 0) {
        const tail = (res.stderr || res.stdout).trim().slice(-500);
        throw new Error(`${this.spec.name} exited with code ${res.code}: ${tail}`);
      }
      emit(parser.end());
      return this.spec.finish(parser.result(), ctx);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface DriverConfig {
  [harness: string]: DriverOptions | undefined;
}
