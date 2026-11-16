import type { AgentItem } from "@tlc-deck/protocol";

export const CAP_LIMIT = 8192;

const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abp]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/g,
];
const KEY_VALUE = /\b((?:password|secret|token|api[_-]?key)[ \t]*[=:][ \t]*)["']?[^\s"',;}]+/gi;

/** Replaces secrets with a marker. Ordinary code is left untouched. */
export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out.replace(KEY_VALUE, `$1${REDACTED}`);
}

export interface Capped {
  text: string;
  truncated: boolean;
  fullLength: number;
}

export function cap(text: string, limit = CAP_LIMIT): Capped {
  if (text.length <= limit) return { text, truncated: false, fullLength: text.length };
  return { text: text.slice(0, limit), truncated: true, fullLength: text.length };
}

/** Redacts then caps a value. Objects are stringified; the result stays JSON when it still parses. */
function processValue(v: unknown): { value: unknown; truncated: boolean; fullLength: number } {
  if (typeof v === "string") {
    const c = cap(redact(v));
    return { value: c.text, truncated: c.truncated, fullLength: c.fullLength };
  }
  const c = cap(redact(JSON.stringify(v) ?? "null"));
  if (!c.truncated) {
    try {
      return { value: JSON.parse(c.text), truncated: false, fullLength: c.fullLength };
    } catch {
      return { value: c.text, truncated: false, fullLength: c.fullLength };
    }
  }
  try {
    return { value: JSON.parse(c.text), truncated: true, fullLength: c.fullLength };
  } catch {
    return { value: c.text, truncated: true, fullLength: c.fullLength };
  }
}

export function capItem(item: AgentItem): AgentItem {
  const out: AgentItem = { ...item };
  let truncated = item.truncated ?? false;
  let fullLength = item.fullLength ?? 0;
  const note = (t: boolean, len: number) => {
    if (t) {
      truncated = true;
      fullLength = Math.max(fullLength, len);
    }
  };
  if (item.text !== undefined) {
    const c = cap(redact(item.text));
    out.text = c.text;
    note(c.truncated, c.fullLength);
  }
  for (const k of ["input", "output"] as const) {
    if (item[k] === undefined) continue;
    const r = processValue(item[k]);
    out[k] = r.value;
    note(r.truncated, r.fullLength);
  }
  if (truncated) {
    out.truncated = true;
    out.fullLength = fullLength;
  }
  return out;
}
