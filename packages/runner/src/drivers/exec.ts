import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** `command -v` equivalent: resolves a binary on PATH, or undefined. */
export function findBinary(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      return undefined;
    }
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return undefined;
}

export function execCapture(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(() => reject(new Error(`${bin} timed out after ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      done(() => reject(new Error(`${bin} aborted`)));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) =>
      done(() => reject(new Error(`${bin} failed to start: ${err.message}`))),
    );
    child.on("close", (code) => done(() => resolve({ stdout, stderr, code: code ?? 1 })));
  });
}

/** Extract the first JSON object from text (plain, fenced, or embedded). */
export function extractJson(text: string): unknown | undefined {
  const t = text.trim();
  const candidates: string[] = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return undefined;
}

export function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {}
  }
  return out;
}

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
