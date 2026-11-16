import { EventSchema } from "@ag-ui/core/schemas";
import { CUSTOM_PAYLOADS, type CustomName, type Envelope, EnvelopeSchema } from "./schemas.js";

export interface TlcEvent {
  type: string;
  timestamp?: number;
  name?: string;
  value?: unknown;
  metadata: Envelope & Record<string, unknown>;
  [key: string]: unknown;
}

export type ParseResult = { ok: true; event: TlcEvent } | { ok: false; reason: string };

const KNOWN_TYPES = new Set<string>(
  (EventSchema as unknown as { options: { shape: { type: { value: string } } }[] }).options.map(
    (o) => o.shape.type.value,
  ),
);

/** Parse one NDJSON line. Unknown types and extra fields are tolerated (never throws). */
export function parseLine(line: string): ParseResult {
  const text = line.trim();
  if (!text) return { ok: false, reason: "empty line" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== "string") return { ok: false, reason: "missing type" };
  if (!KNOWN_TYPES.has(obj.type)) return { ok: false, reason: `unknown type: ${obj.type}` };

  // RUN_STARTED.input carries tlc's own shape ({feature, tasksPath, ...}), not AG-UI's RunAgentInput.
  const toValidate = obj.type === "RUN_STARTED" ? { ...obj, input: undefined } : obj;
  if (
    obj.type === "RUN_STARTED" &&
    obj.input !== undefined &&
    (typeof obj.input !== "object" || obj.input === null)
  ) {
    return { ok: false, reason: "invalid RUN_STARTED: input must be an object" };
  }
  const base = EventSchema.safeParse(toValidate);
  if (!base.success) return { ok: false, reason: `invalid ${obj.type}: ${base.error.message}` };

  const env = EnvelopeSchema.safeParse(obj.metadata);
  if (!env.success) return { ok: false, reason: `invalid envelope: ${env.error.message}` };

  if (obj.type === "CUSTOM" && typeof obj.name === "string" && obj.name in CUSTOM_PAYLOADS) {
    const p = CUSTOM_PAYLOADS[obj.name as CustomName].safeParse(obj.value);
    if (!p.success) return { ok: false, reason: `invalid ${obj.name}: ${p.error.message}` };
  }
  // Keep the original object so extra fields (newer protocol versions) survive.
  return { ok: true, event: obj as TlcEvent };
}
