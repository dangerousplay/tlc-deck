// Shared fake harness: records argv (FAKE_ARGV_FILE) and replays a canned output.
// FAKE_MODE: ok (default) | malformed | fail | noschema
import { appendFileSync, writeFileSync } from "node:fs";

const status = {
  status: "Complete",
  files: ["a.ts"],
  gate: { pass: true, summary: "ok" },
  deviations: [],
  issues: [],
};
const statusText = JSON.stringify(status);

export function run(harness, argv) {
  if (process.env.FAKE_ARGV_FILE)
    appendFileSync(process.env.FAKE_ARGV_FILE, `${JSON.stringify(argv)}\n`);
  const mode = process.env.FAKE_MODE ?? "ok";
  if (mode === "fail") {
    console.error(`${harness}: boom`);
    process.exit(3);
  }
  if (mode === "hang") {
    setTimeout(() => {}, 60000);
    return;
  }
  if (mode === "malformed") {
    console.log("this is not json {{{");
    return;
  }
  const out = (o) => console.log(JSON.stringify(o));
  switch (harness) {
    case "claude":
      out({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        ...(mode === "noschema"
          ? { result: `Here you go:\n\`\`\`json\n${statusText}\n\`\`\`` }
          : { structured_output: status }),
        session_id: "sess-claude",
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
        modelUsage: { "claude-sonnet-5-5": {} },
      });
      break;
    case "agy":
      out({
        result: "done",
        structured_output: status,
        session_id: "sess-agy",
        usage: { input_tokens: 7, output_tokens: 3 },
      });
      break;
    case "gemini":
      out({
        response: `\`\`\`json\n${statusText}\n\`\`\``,
        stats: {
          models: { "gemini-3-pro": { tokens: { prompt: 90, candidates: 12, cached: 30 } } },
        },
      });
      break;
    case "codex": {
      const i = argv.indexOf("-o");
      if (mode !== "nofile" && i >= 0) writeFileSync(argv[i + 1], statusText);
      out({ type: "thread.started", thread_id: "thr-1" });
      out({ type: "item.completed", item: { type: "agent_message", text: statusText } });
      out({
        type: "turn.completed",
        usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40 },
      });
      break;
    }
    case "opencode":
      out({ type: "step_start", sessionID: "ses-oc", part: {} });
      out({ type: "text", sessionID: "ses-oc", part: { text: `Result: ${statusText}` } });
      if (mode !== "nostep") {
        out({
          type: "step_finish",
          sessionID: "ses-oc",
          part: { cost: 0.05, tokens: { input: 11, output: 22, cache: { read: 3, write: 4 } } },
        });
      }
      break;
  }
}
