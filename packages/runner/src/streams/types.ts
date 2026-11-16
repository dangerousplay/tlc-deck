import type { AgentItem } from "@tlc-deck/protocol";
import type { DriverUsage } from "../driver.js";

/** A normalised item as produced by a stream parser; the runner adds agentId/seq/ts. */
export type StreamItem = Omit<AgentItem, "agentId" | "seq" | "ts"> & { ts?: number };

export interface StreamResult {
  /** Final assistant text. */
  text?: string;
  /** Structured output delivered by the stream itself (claude/agy `structured_output`). */
  data?: unknown;
  usage?: DriverUsage;
  sessionId?: string;
  model?: string;
  /** Set when the stream reported a failure. */
  error?: string;
  /** A terminal event (`result`) was seen. */
  ended: boolean;
}

/** Incremental parser of a harness's machine-readable output (DD-10). */
export interface StreamParser {
  /** Feed one stdout line; returns the items it completed. */
  feed(line: string): StreamItem[];
  /** Flush buffered items at end of stream. */
  end(): StreamItem[];
  result(): StreamResult;
}
