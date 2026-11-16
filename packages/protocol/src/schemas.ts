import { z } from "zod/v4";
import { BLOCKER_KINDS, STAGES, TASK_STATUSES } from "./types.js";

export const PROTOCOL_V = 1;

export const EnvelopeSchema = z.object({
  v: z.number().int().min(1),
  seq: z.number().int().min(0),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  harness: z.string().min(1),
  driver: z.string().min(1),
  source: z.string().min(1),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const BlockerKindSchema = z.enum(BLOCKER_KINDS);

export const PlanPayload = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      milestone: z.string(),
      dependsOn: z.array(z.string()),
      parallel: z.boolean(),
      requirement: z.string().optional(),
    }),
  ),
  milestones: z.array(
    z.object({
      name: z.string(),
      source: z.enum(["field", "priority", "wave"]),
      tasks: z.array(z.string()),
    }),
  ),
});

export const TaskPayload = z.object({
  id: z.string(),
  status: TaskStatusSchema,
  stage: z.enum(STAGES).optional(),
  attempt: z.number().int().optional(),
  commit: z.string().optional(),
  files: z.array(z.string()).optional(),
  gate: z.object({ pass: z.boolean(), summary: z.string() }).optional(),
  deviations: z.array(z.string()).optional(),
});

export const BlockerPayload = z.object({
  id: z.string(),
  task: z.string(),
  kind: BlockerKindSchema,
  reason: z.string(),
  advice: z.string().optional(),
});

export const BlockerResolvedPayload = z.object({ id: z.string() });
export const MilestonePayload = z.object({ name: z.string() });

export const UsagePayload = z.object({
  task: z.string().optional(),
  role: z.string(),
  harness: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number().nullable(),
});

export const LogPayload = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});

export const CUSTOM_PAYLOADS = {
  "tlc.plan": PlanPayload,
  "tlc.task": TaskPayload,
  "tlc.blocker": BlockerPayload,
  "tlc.blocker_resolved": BlockerResolvedPayload,
  "tlc.milestone": MilestonePayload,
  "tlc.usage": UsagePayload,
  "tlc.log": LogPayload,
} as const;
export type CustomName = keyof typeof CUSTOM_PAYLOADS;

export type PlanValue = z.infer<typeof PlanPayload>;
export type TaskValue = z.infer<typeof TaskPayload>;
export type BlockerValue = z.infer<typeof BlockerPayload>;
export type UsageValue = z.infer<typeof UsagePayload>;
export type LogValue = z.infer<typeof LogPayload>;

// Role outputs (design.md: Prompts)
export const StatusOutputSchema = z.object({
  status: z.enum(["Complete", "Blocked", "Partial"]),
  files: z.array(z.string()),
  gate: z.object({ pass: z.boolean(), summary: z.string() }),
  deviations: z.array(z.string()),
  issues: z.array(z.string()),
});
export const ReviewerOutputSchema = z.object({
  verdict: z.enum(["pass", "reject"]),
  findings: z.array(z.string()),
});
export const AdvisorOutputSchema = z.object({
  diagnosis: z.string(),
  environmental: z.boolean(),
  steps: z.array(z.string()),
});

/**
 * JSON Schema for harness structured-output flags. `$schema` is dropped: `claude --json-schema`
 * rejects the draft 2020-12 meta-schema URI that zod emits.
 */
function harnessSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const statusOutputJsonSchema = harnessSchema(StatusOutputSchema);
export const reviewerOutputJsonSchema = harnessSchema(ReviewerOutputSchema);
export const advisorOutputJsonSchema = harnessSchema(AdvisorOutputSchema);
