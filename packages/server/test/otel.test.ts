import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type RunningServer, startServer } from "../src/index.js";
import { decodeProtobuf } from "../src/otel/decode.js";

let dir: string;
const servers: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlc-otel-"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const s = await startServer({
    port: 0,
    stateDir: join(dir, "state"),
    env: { TLC_STATE_DIR: join(dir, "state"), XDG_STATE_HOME: join(dir, "xdg") },
    webDist: join(dir, "nope"),
    scanMs: 100000,
  });
  servers.push(s);
  return s;
}

const kv = (key: string, v: string | number) => ({
  key,
  value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v },
});
const point = (value: number, sid: string, extra: Record<string, string> = {}) => ({
  attributes: [kv("session.id", sid), ...Object.entries(extra).map(([k, v]) => kv(k, v))],
  timeUnixNano: "1700000000000000000",
  asDouble: value,
});
const metric = (name: string, points: unknown[]) => ({ name, sum: { dataPoints: points } });
const metricsReq = (sid: string) => ({
  resourceMetrics: [
    {
      resource: { attributes: [] },
      scopeMetrics: [
        {
          metrics: [
            metric("claude_code.cost.usage", [point(0.25, sid, { model: "m" })]),
            metric("claude_code.token.usage", [
              point(10, sid, { type: "input" }),
              point(20, sid, { type: "output" }),
              point(5, sid, { type: "cacheRead" }),
              point(2, sid, { type: "cacheCreation" }),
              point(99, sid, { type: "bogus" }),
            ]),
            metric("claude_code.unknown", [point(7, sid)]),
          ],
        },
      ],
    },
  ],
});
const logsReq = (sid: string) => ({
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: "1700000000000000000",
              attributes: [
                kv("event.name", "claude_code.api_request"),
                kv("session.id", sid),
                kv("model", "m"),
                kv("input_tokens", 10),
                kv("output_tokens", 20),
                kv("cache_read_tokens", 5),
                kv("cache_creation_tokens", 2),
                kv("cost_usd", "0.25"),
              ],
            },
            { attributes: [kv("event.name", "claude_code.other"), kv("session.id", sid)] },
          ],
        },
      ],
    },
  ],
});

/** Encode the JSON request with the vendored protos (protobufjs fromObject needs enum/long coercion). */
function toProtobuf(kind: "metrics" | "logs" | "traces", json: unknown): Buffer {
  const root = new protobuf.Root();
  root.resolvePath = (_o, t) =>
    t.startsWith("/") ? t : join(__dirname, "..", "..", "..", "vendor", "opentelemetry-proto", t);
  const files = {
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
  } as const;
  const [file, type] = files[kind];
  root.loadSync(join(__dirname, "..", "..", "..", "vendor", "opentelemetry-proto", file));
  const T = root.lookupType(type);
  return Buffer.from(T.encode(T.fromObject(json as object)).finish());
}

async function send(
  s: RunningServer,
  path: string,
  body: Buffer | string,
  headers: Record<string, string>,
) {
  return fetch(`${s.url}${path}`, { method: "POST", headers, body });
}
const json = { "content-type": "application/json" };
const proto = { "content-type": "application/x-protobuf" };
const sessions = async (s: RunningServer, id: string) =>
  (await fetch(`${s.url}/api/sessions/${id}`)).json() as Promise<{ usage?: unknown }>;

async function seedSession(s: RunningServer, id: string) {
  await fetch(`${s.url}/hooks`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: dir }),
  });
}

const EXPECTED = { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, costUsd: 0.25 };

test("JSON and protobuf metrics produce identical usage", async () => {
  const a = await boot();
  await seedSession(a, "s-json");
  await seedSession(a, "s-pb");
  expect((await send(a, "/v1/metrics", JSON.stringify(metricsReq("s-json")), json)).status).toBe(
    200,
  );
  const res = await send(a, "/v1/metrics", toProtobuf("metrics", metricsReq("s-pb")), proto);
  expect(res.status).toBe(200);
  expect((await sessions(a, "s-json")).usage).toEqual(EXPECTED);
  expect((await sessions(a, "s-pb")).usage).toEqual(EXPECTED);
});

test("JSON and protobuf logs produce identical usage; logs win over metrics", async () => {
  const a = await boot();
  await seedSession(a, "s1");
  await seedSession(a, "s2");
  await send(a, "/v1/logs", JSON.stringify(logsReq("s1")), json);
  await send(a, "/v1/logs", toProtobuf("logs", logsReq("s2")), proto);
  expect((await sessions(a, "s1")).usage).toEqual(EXPECTED);
  expect((await sessions(a, "s2")).usage).toEqual(EXPECTED);
  // metrics for the same session do not double count
  await send(a, "/v1/metrics", JSON.stringify(metricsReq("s1")), json);
  expect((await sessions(a, "s1")).usage).toEqual(EXPECTED);
});

test("gzip accepted, unknown metrics ignored, traces counted", async () => {
  const a = await boot();
  await seedSession(a, "g");
  const res = await send(a, "/v1/metrics", gzipSync(JSON.stringify(metricsReq("g"))), {
    ...json,
    "content-encoding": "gzip",
  });
  expect(res.status).toBe(200);
  expect((await sessions(a, "g")).usage).toEqual(EXPECTED);

  const pb = gzipSync(toProtobuf("metrics", metricsReq("g")));
  expect((await send(a, "/v1/metrics", pb, { ...proto, "content-encoding": "gzip" })).status).toBe(
    200,
  );

  const traces = {
    resourceSpans: [{ scopeSpans: [{ spans: [{ name: "a" }, { name: "b" }] }] }],
  };
  expect((await send(a, "/v1/traces", JSON.stringify(traces), json)).status).toBe(200);
  expect((await send(a, "/v1/traces", toProtobuf("traces", traces), proto)).status).toBe(200);
  const stats = (await (await fetch(`${a.url}/api/otel`)).json()) as { spans: { total: number } };
  expect(stats.spans.total).toBe(4);
});

test("malformed payload is a 400", async () => {
  const a = await boot();
  expect((await send(a, "/v1/logs", "{nope", json)).status).toBe(400);
});

test("decodeProtobuf shape matches JSON", () => {
  const out = decodeProtobuf("logs", toProtobuf("logs", logsReq("x"))) as {
    resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string }[] }[] }[] }[];
  };
  expect(out.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes[0]?.key).toBe("event.name");
});

test("workflow run links to the running tlc run within 120s", async () => {
  const a = await boot();
  const project = dir.split("/").pop() as string;
  await seedSession(a, "wf");
  // no .git in dir: project is basename(dir)
  const ev = (type: string, seq: number, extra: object) => ({
    type,
    timestamp: Date.now(),
    metadata: {
      v: 1,
      seq,
      runId: "run-1",
      threadId: `${project}#x`,
      harness: "claude-code",
      driver: "d",
      source: "t",
    },
    ...extra,
  });
  await fetch(`${a.url}/events`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(ev("RUN_STARTED", 0, { threadId: `${project}#x`, runId: "run-1" })),
  });
  const logs = logsReq("wf") as {
    resourceLogs: { scopeLogs: { logRecords: { attributes: unknown[] }[] }[] }[];
  };
  logs.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes.push(
    kv("workflow.run_id", "w-1"),
    kv("workflow.name", "tlc-execute"),
  );
  await send(a, "/v1/logs", JSON.stringify(logs), json);
  const run = (await (await fetch(`${a.url}/api/runs/run-1`)).json()) as {
    otelUsage?: unknown;
  };
  expect(run.otelUsage).toEqual(EXPECTED);
});
