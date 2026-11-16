import type { StreamItem } from "./types.js";

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Parse one NDJSON line; undefined for blanks and non-JSON noise. */
export function parseLine(line: string): Record<string, unknown> | undefined {
  const s = line.trim();
  if (!s.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Text of a tool result payload: a string, or an array of `{text}` blocks, or raw JSON. */
export function toolOutput(v: unknown): unknown {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map((b) => (typeof obj(b).text === "string" ? (obj(b).text as string) : null));
    if (parts.every((p) => p !== null)) return parts.join("\n");
  }
  return v;
}

/** Collects text deltas and emits one `text` item per run of deltas. */
export class TextBuffer {
  private buf = "";
  last: string | undefined;
  add(s: string): void {
    this.buf += s;
  }
  flush(): StreamItem[] {
    if (!this.buf.trim()) {
      this.buf = "";
      return [];
    }
    const text = this.buf;
    this.buf = "";
    this.last = text;
    return [{ kind: "text", text }];
  }
}
