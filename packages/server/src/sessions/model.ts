import type { Usage } from "../otel/usage.js";

export const PROMPT_MAX = 200;
export const IDLE_MS = 10 * 60 * 1000;

export type SessionState = "working" | "waiting" | "idle" | "ended";

export interface Subagent {
  agentId: string;
  agentType?: string;
}

export interface Session {
  sessionId: string;
  cwd?: string;
  project?: string;
  model?: string;
  state: SessionState;
  currentTool?: string;
  lastPrompt?: string;
  subagents: Subagent[];
  startedAt: number;
  lastSeen: number;
  /** Run id of a running tlc run in the same repo. */
  linkedRun?: string;
  /** Tokens and cost from OTel (replaces hook-side estimates). */
  usage?: Usage;
}

export interface SessionEvent {
  ts: number;
  kind: string;
  tool?: string;
  prompt?: string;
  toolInput?: string;
  agentId?: string;
  agentType?: string;
  notification?: string;
}

export interface HookBody {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  model?: string | { id?: string; display_name?: string };
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  agent_id?: string;
  agent_type?: string;
  [k: string]: unknown;
}

export function truncate(text: string, max = PROMPT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function summarizeInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return truncate(text);
}

export interface ApplyOptions {
  noContent?: boolean;
  project?: (cwd: string) => string | undefined;
}

/** Pure reducer: hook body → next session + timeline entry. Undefined when the body is unusable. */
export function applyHook(
  prev: Session | undefined,
  body: HookBody,
  now: number,
  opts: ApplyOptions = {},
): { session: Session; event: SessionEvent } | undefined {
  const sessionId = str(body.session_id);
  const kind = str(body.hook_event_name);
  if (!sessionId || !kind) return undefined;

  const s: Session = prev
    ? { ...prev, subagents: [...prev.subagents] }
    : { sessionId, state: "idle", subagents: [], startedAt: now, lastSeen: now };
  s.lastSeen = now;
  const cwd = str(body.cwd);
  if (cwd && cwd !== s.cwd) {
    s.cwd = cwd;
    s.project = opts.project?.(cwd);
  }
  const model = typeof body.model === "string" ? body.model : str(body.model?.id);
  if (model) s.model = model;

  const event: SessionEvent = { ts: now, kind };
  const tool = str(body.tool_name);
  switch (kind) {
    case "SessionStart":
      s.state = "idle";
      s.currentTool = undefined;
      s.subagents = [];
      break;
    case "UserPromptSubmit": {
      s.state = "working";
      const prompt = str(body.prompt);
      if (prompt && !opts.noContent) {
        s.lastPrompt = truncate(prompt);
        event.prompt = s.lastPrompt;
      }
      break;
    }
    case "PreToolUse":
      s.state = "working";
      s.currentTool = tool;
      event.tool = tool;
      if (!opts.noContent) event.toolInput = summarizeInput(body.tool_input);
      break;
    case "PostToolUse":
      s.currentTool = undefined;
      event.tool = tool;
      break;
    case "Notification": {
      const n = str(body.notification_type);
      event.notification = n;
      if (n === "permission_prompt" || n === "idle_prompt") s.state = "waiting";
      break;
    }
    case "Stop":
      s.state = "idle";
      s.currentTool = undefined;
      break;
    case "SubagentStart": {
      const agentId = str(body.agent_id);
      if (agentId) {
        const agentType = str(body.agent_type);
        s.subagents = s.subagents.filter((a) => a.agentId !== agentId);
        s.subagents.push({ agentId, agentType });
        event.agentId = agentId;
        event.agentType = agentType;
      }
      break;
    }
    case "SubagentStop": {
      const agentId = str(body.agent_id);
      if (agentId) {
        s.subagents = s.subagents.filter((a) => a.agentId !== agentId);
        event.agentId = agentId;
        event.agentType = str(body.agent_type);
      }
      break;
    }
    case "SessionEnd":
      s.state = "ended";
      s.currentTool = undefined;
      s.subagents = [];
      break;
    default:
      break;
  }
  return { session: s, event };
}

/** Sessions silent for `idleMs` read as idle (never overrides ended). */
export function withIdle(s: Session, now: number, idleMs = IDLE_MS): Session {
  if (s.state === "ended" || s.state === "idle") return s;
  return now - s.lastSeen >= idleMs ? { ...s, state: "idle", currentTool: undefined } : s;
}
