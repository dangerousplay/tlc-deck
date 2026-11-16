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
        type: "system",
        subtype: "init",
        session_id: "sess-claude",
        model: "claude-sonnet-5-5",
      });
      out({
        type: "assistant",
        message: {
          model: "claude-sonnet-5-5",
          content: [
            { type: "text", text: "Running the gate." },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "pnpm check" } },
          ],
        },
      });
      out({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "all green", is_error: false },
          ],
        },
      });
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
      out({ type: "step_update", text_delta: "Checking " });
      out({ type: "step_update", text_delta: "files." });
      out({
        type: "step_update",
        tool_name: "run_command",
        tool_call_id: "c1",
        tool_input: { command: "pnpm check" },
      });
      out({ type: "step_update", tool_call_id: "c1", tool_output: "ok" });
      out({
        type: "result",
        result: "done",
        structured_output: status,
        session_id: "sess-agy",
        usage: { input_tokens: 7, output_tokens: 3 },
      });
      break;
    case "gemini":
      out({ type: "init", session_id: "sess-gem", model: "gemini-3-pro" });
      out({ type: "message", role: "user", content: "do it" });
      out({ type: "message", role: "assistant", content: "Reading ", delta: true });
      out({ type: "message", role: "assistant", content: "files.", delta: true });
      out({
        type: "tool_use",
        tool_name: "read_file",
        tool_id: "g1",
        parameters: { path: "a.ts" },
      });
      out({ type: "tool_result", tool_id: "g1", status: "success", output: "contents" });
      out({
        type: "message",
        role: "assistant",
        content: `\`\`\`json\n${statusText}\n\`\`\``,
        delta: true,
      });
      out({
        type: "result",
        status: "success",
        stats: { input_tokens: 90, output_tokens: 12, cached: 30, models: { "gemini-3-pro": {} } },
      });
      break;
    case "codex": {
      const i = argv.indexOf("-o");
      if (mode !== "nofile" && i >= 0) writeFileSync(argv[i + 1], statusText);
      out({ type: "thread.started", thread_id: "thr-1" });
      out({
        type: "item.completed",
        item: {
          id: "i1",
          type: "command_execution",
          command: "pnpm check",
          aggregated_output: "ok",
          exit_code: 0,
        },
      });
      out({ type: "item.completed", item: { type: "agent_message", text: statusText } });
      out({
        type: "turn.completed",
        usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40 },
      });
      break;
    }
    case "opencode":
      out({ type: "step_start", sessionID: "ses-oc", part: {} });
      out({
        type: "tool_use",
        sessionID: "ses-oc",
        part: {
          callID: "o1",
          tool: "bash",
          state: { status: "completed", input: { command: "pnpm check" }, output: "ok" },
        },
      });
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
