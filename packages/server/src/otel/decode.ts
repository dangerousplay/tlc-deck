import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";

export type OtlpKind = "metrics" | "logs" | "traces";

const VENDOR = new URL("../../../../vendor/opentelemetry-proto/", import.meta.url).pathname;

const ROOT_FILES: Record<OtlpKind, [file: string, type: string]> = {
  metrics: [
    "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
  ],
  logs: [
    "opentelemetry/proto/collector/logs/v1/logs_service.proto",
    "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
  ],
  traces: [
    "opentelemetry/proto/collector/trace/v1/trace_service.proto",
    "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
  ],
};

let root: protobuf.Root | undefined;
function loaded(): protobuf.Root {
  if (!root) {
    const r = new protobuf.Root();
    r.resolvePath = (_origin, target) => (target.startsWith("/") ? target : VENDOR + target);
    r.loadSync(Object.values(ROOT_FILES).map(([f]) => VENDOR + f));
    r.resolveAll();
    root = r;
  }
  return root;
}

/** Decode a protobuf export request into the OTLP/JSON shape (camelCase, 64-bit ints as strings). */
export function decodeProtobuf(kind: OtlpKind, body: Uint8Array): unknown {
  const type = loaded().lookupType(ROOT_FILES[kind][1]);
  const msg = type.decode(body);
  return type.toObject(msg, { longs: String, bytes: String, defaults: false, arrays: true });
}

export function maybeGunzip(body: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "gzip" || (enc === "" && body[0] === 0x1f && body[1] === 0x8b)) {
    return gunzipSync(body);
  }
  return body;
}

/** Decode an OTLP/HTTP request body (JSON or protobuf, optionally gzip). Throws on malformed input. */
export function decodeOtlp(
  kind: OtlpKind,
  body: Buffer,
  contentType: string | undefined,
  encoding: string | undefined,
): unknown {
  const raw = maybeGunzip(body, encoding);
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("protobuf")) return decodeProtobuf(kind, raw);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8"));
}
