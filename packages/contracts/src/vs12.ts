import { z } from "zod";

import { projectPhaseCodeSchema, roleSchema } from "./vs01";

const idSchema = z.string().trim().min(1);
const sequenceSchema = z.string().regex(/^\d+$/);
const timestampSchema = z.string().datetime();
const shortTextSchema = z.string().trim().max(500);

export const workEventTypeSchema = z.enum([
  "WORK_ITEM_PROGRESS_SAVED",
  "WORK_ITEM_CONFIRMED",
  "WORK_ITEM_REOPENED",
  "SOLUTION_SUBMITTED",
  "SOLUTION_APPROVED",
  "SOLUTION_RETURNED",
  "STAGE_CHANGED",
  "RESULT_CONFIRMED",
  "EXPERIENCE_SUBMITTED",
  "EXPERIENCE_RETURNED",
  "EXPERIENCE_APPROVED",
]);

export const workEventPayloadSchema = z
  .object({
    sourceProjectEventId: sequenceSchema,
    note: shortTextSchema,
    evidenceIds: z.array(idSchema).max(20).default([]),
  })
  .strict();

export const workEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: sequenceSchema,
    sequence: sequenceSchema,
    correlationKey: idSchema,
    sourceEventType: idSchema,
    eventType: workEventTypeSchema,
    consultingTaskId: idSchema,
    sourceTaskId: idSchema,
    stageCode: projectPhaseCodeSchema.nullable(),
    workItemId: idSchema.nullable(),
    actorRole: roleSchema,
    occurredAt: timestampSchema,
    payload: workEventPayloadSchema,
  })
  .strict();

export const assistantSessionScopeSchema = z
  .object({
    tenantId: idSchema,
    subjectId: idSchema,
    role: roleSchema,
    projectId: idSchema,
    sourceTaskId: idSchema,
    policyVersion: idSchema,
  })
  .strict();

export const assistantRunStatusSchema = z.enum([
  "QUEUED",
  "THINKING",
  "COMPLETED",
  "FAILED",
  "FALLBACK",
]);
export const assistantProviderSchema = z.enum(["PI", "DEMO_RULES"]);
export const assistantIntentSchema = z.enum([
  "ASK",
  "NEXT_ACTION",
  "MATERIAL_GAPS",
  "RISK",
  "WORK_EVENT",
]);

export const assistantRunRequestSchema = z
  .object({
    stageCode: projectPhaseCodeSchema.optional(),
    question: z.string().trim().max(500).default(""),
    intent: assistantIntentSchema.default("ASK"),
  })
  .strict();

export const assistantSuggestionSchema = z
  .object({
    classification: z.literal("PROPOSAL"),
    answer: z.string().trim().min(1).max(4000),
    evidenceIds: z.array(idSchema).max(20),
    nextAction: z.string().trim().max(500).nullable(),
  })
  .strict();

export const assistantSessionSchema = z
  .object({
    id: idSchema,
    scope: assistantSessionScopeSchema,
    createdAt: timestampSchema,
    lastActiveAt: timestampSchema,
  })
  .strict();

export const assistantRunSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema,
    projectId: idSchema,
    sourceTaskId: idSchema,
    correlationKey: idSchema,
    stageCode: projectPhaseCodeSchema.nullable(),
    intent: assistantIntentSchema,
    question: z.string(),
    status: assistantRunStatusSchema,
    provider: assistantProviderSchema,
    classification: z.literal("PROPOSAL"),
    suggestion: assistantSuggestionSchema.nullable(),
    fallbackReason: z.string().trim().max(500).nullable(),
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .strict();

export const assistantHistorySchema = z
  .object({
    session: assistantSessionSchema,
    runs: z.array(assistantRunSchema),
    latestCursor: sequenceSchema,
  })
  .strict();

export const assistantToolResultStatusSchema = z.enum([
  "OK",
  "NOT_FOUND",
  "FORBIDDEN",
  "BODY_NOT_AVAILABLE",
  "TEMPORARILY_UNAVAILABLE",
  "STALE_CONTEXT",
]);

export const assistantToolResultSchema = z
  .object({
    status: assistantToolResultStatusSchema,
    summary: shortTextSchema,
    evidenceIds: z.array(idSchema).max(20),
  })
  .strict();

const streamEventBaseSchema = z.object({
  cursor: sequenceSchema,
  sessionId: idSchema,
  runId: idSchema,
  stageCode: projectPhaseCodeSchema.nullable(),
  occurredAt: timestampSchema,
});

export const assistantStreamEventSchema = z.discriminatedUnion("type", [
  streamEventBaseSchema
    .extend({ type: z.literal("STREAM_READY"), latestCursor: sequenceSchema })
    .strict(),
  streamEventBaseSchema.extend({ type: z.literal("RUN_STARTED") }).strict(),
  streamEventBaseSchema
    .extend({
      type: z.literal("STATE_CHANGED"),
      status: assistantRunStatusSchema,
    })
    .strict(),
  streamEventBaseSchema
    .extend({ type: z.literal("TOOL_STARTED"), toolName: idSchema })
    .strict(),
  streamEventBaseSchema
    .extend({
      type: z.literal("TOOL_COMPLETED"),
      toolName: idSchema,
      status: assistantToolResultStatusSchema,
      evidenceIds: z.array(idSchema).max(20),
    })
    .strict(),
  streamEventBaseSchema
    .extend({
      type: z.literal("TEXT_DELTA"),
      text: z.string().min(1).max(2000),
    })
    .strict(),
  streamEventBaseSchema
    .extend({
      type: z.literal("SUGGESTION"),
      suggestion: assistantSuggestionSchema,
    })
    .strict(),
  streamEventBaseSchema
    .extend({
      type: z.literal("RUN_COMPLETED"),
      provider: assistantProviderSchema,
    })
    .strict(),
  streamEventBaseSchema
    .extend({
      type: z.literal("RUN_FAILED"),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
  streamEventBaseSchema.extend({ type: z.literal("HEARTBEAT") }).strict(),
]);

export type WorkEvent = z.infer<typeof workEventSchema>;
export type AssistantSessionScope = z.infer<typeof assistantSessionScopeSchema>;
export type AssistantRunRequest = z.infer<typeof assistantRunRequestSchema>;
export type AssistantRun = z.infer<typeof assistantRunSchema>;
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>;
export type AssistantToolResult = z.infer<typeof assistantToolResultSchema>;
