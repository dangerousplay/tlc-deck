// Shared fake harness: records argv (FAKE_ARGV_FILE) and replays a canned output.
// FAKE_MODE: ok (default) | malformed | fail | noschema
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RESUME_FLAG = { claude: "-r", agy: "--conversation", opencode: "-s" };

// With FAKE_STATE_DIR set, sessions persist: a resume flag reuses the session id and
// the per-turn input tokens grow with the turn number (100 * turn). gemini never resumes.
function session(harness, argv, defId, defInput) {
  const dir = process.env.FAKE_STATE_DIR;
  if (!dir) return { id: defId, input: defInput };
  mkdirSync(dir, { recursive: true });
  let resumeId;
  if (harness === "codex") {
    if (argv[1] === "resume") resumeId = argv[2];
  } else if (RESUME_FLAG[harness]) {
    const i = argv.indexOf(RESUME_FLAG[harness]);
    if (i >= 0) resumeId = argv[i + 1];
  }
  const counter = join(dir, "counter");
  let id = resumeId;
  let turn = 1;
  if (id) {
    const f = join(dir, `${id}.turns`);
    turn = (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0) + 1;
  } else {
    const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
    writeFileSync(counter, String(n));
    id = `${defId}-${n}`;
  }
  writeFileSync(join(dir, `${id}.turns`), String(turn));
  return { id, input: 100 * turn };
}

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
  const ses = session(
    harness,
    argv,
    {
      claude: "sess-claude",
      agy: "sess-agy",
      gemini: "sess-gem",
      codex: "thr-1",
      opencode: "ses-oc",
    }[harness],
    { claude: 100, agy: 7, gemini: 90, codex: 200, opencode: 11 }[harness],
  );
  switch (harness) {
    case "claude":
      out({
        type: "system",
        subtype: "init",
        session_id: ses.id,
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
        session_id: ses.id,
        total_cost_usd: 0.42,
        usage: {
          input_tokens: ses.input,
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
        session_id: ses.id,
        usage: { input_tokens: ses.input, output_tokens: 3 },
      });
      break;
    case "gemini":
      out({ type: "init", session_id: ses.id, model: "gemini-3-pro" });
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
        stats: {
          input_tokens: ses.input,
          output_tokens: 12,
          cached: 30,
          models: { "gemini-3-pro": {} },
        },
      });
      break;
    case "codex": {
      const i = argv.indexOf("-o");
      if (mode !== "nofile" && i >= 0) writeFileSync(argv[i + 1], statusText);
      out({ type: "thread.started", thread_id: ses.id });
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
        usage: { input_tokens: ses.input, cached_input_tokens: 50, output_tokens: 40 },
      });
      break;
    }
    case "opencode":
      out({ type: "step_start", sessionID: ses.id, part: {} });
      out({
        type: "tool_use",
        sessionID: ses.id,
        part: {
          callID: "o1",
          tool: "bash",
          state: { status: "completed", input: { command: "pnpm check" }, output: "ok" },
        },
      });
      out({ type: "text", sessionID: ses.id, part: { text: `Result: ${statusText}` } });
      if (mode !== "nostep") {
        out({
          type: "step_finish",
          sessionID: ses.id,
          part: {
            cost: 0.05,
            tokens: { input: ses.input, output: 22, cache: { read: 3, write: 4 } },
          },
        });
      }
      break;
  }
}
