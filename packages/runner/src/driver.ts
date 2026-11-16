import type { StreamItem } from "./streams/types.js";

export type Role = "implementer" | "reviewer" | "advisor";

export interface DriverUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  model?: string;
}

export interface DriverRequest {
  role: Role;
  prompt: string;
  model?: string;
  effort?: string;
  cwd: string;
  /** JSON Schema of the expected structured output. */
  schema: unknown;
  signal?: AbortSignal;
  /** Receives normalised agent items as the harness streams them. */
  onItem?: (item: StreamItem) => void;
}

export interface DriverResult {
  /** Parsed structured output (validated by the runner), or undefined when absent. */
  data?: unknown;
  text?: string;
  usage?: DriverUsage;
  sessionId?: string;
  exitCode: number;
}

export interface Driver {
  readonly name: string;
  run(req: DriverRequest): Promise<DriverResult>;
}

export type DriverFactory = (harness: string) => Driver;

/** Placeholder until the real harness drivers exist: every call fails (error blocker). */
export const unavailableDriverFactory: DriverFactory = (harness) => ({
  name: harness,
  run: async () => {
    throw new Error(`no driver available for harness "${harness}"`);
  },
});

export type FakeResponse = DriverResult | Error | ((req: DriverRequest) => DriverResult | Error);

/**
 * Scripted driver for tests. `script[role]` is consumed in order; the last entry repeats.
 * Every request is recorded in `calls`.
 */
export class FakeDriver implements Driver {
  readonly calls: DriverRequest[] = [];
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly script: Partial<Record<Role, FakeResponse[]>>,
    readonly name = "fake",
    private readonly onCall?: (req: DriverRequest) => void | Promise<void>,
  ) {}

  async run(req: DriverRequest): Promise<DriverResult> {
    this.calls.push(req);
    await this.onCall?.(req);
    const list = this.script[req.role] ?? [];
    const n = this.counters.get(req.role) ?? 0;
    this.counters.set(req.role, n + 1);
    let r = list[Math.min(n, list.length - 1)];
    if (r === undefined) throw new Error(`FakeDriver: no response scripted for ${req.role}`);
    if (typeof r === "function") r = r(req);
    if (r instanceof Error) throw r;
    const text = r.text ?? (r.data === undefined ? undefined : JSON.stringify(r.data));
    if (text !== undefined) req.onItem?.({ kind: "text", text });
    return r;
  }
}
