import { z } from "zod";
import {
  integrationProjectStageSchema,
  integrationSafeMaterialSchema,
  integrationWorkItemSchema,
} from "./integration";
import { governedCommandRequestSchema } from "./governed-command";
import {
  experienceCandidateInputSchema,
  outcomeSubmitInputSchema,
  projectSchema,
  taskDetailSchema,
} from "./vs01";
import { validationWorkpaperContentSchema } from "./vs16";

const id = z.string().trim().min(1).max(160);
const note = z.string().trim().min(3).max(500);
const action = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) =>
  z.object({ action: z.literal(name), ...shape }).strict();
export const workActionSchema = z.discriminatedUnion("action", [
  action("event.start", {}),
  action("progress.record", {
    workItemId: id,
    note,
    outputReference: z.string().trim().max(500).default(""),
  }),
  action("workitem.complete", {
    workItemId: id,
    note,
    outputReference: note,
    confirmedAcceptanceCriteria: z.array(z.string().min(1)).min(1),
  }),
  action("workitem.reopen", { workItemId: id, note }),
  action("project.submit", {}),
  action("project.approve", {}),
  action("project.return", { reason: note }),
  action(
    "outcome.record",
    outcomeSubmitInputSchema.omit({ actor: true }).shape,
  ),
  action("outcome.reopen", { reason: note }),
  action(
    "experience.submit",
    experienceCandidateInputSchema.omit({ actor: true }).shape,
  ),
  action("experience.resubmit", {
    ...experienceCandidateInputSchema.omit({ actor: true }).shape,
    expectedCandidateVersionId: id,
  }),
  action("experience.withdraw", { reason: note }),
  action("experience.publish", { expectedCandidateVersionId: id }),
  action("experience.return", { expectedCandidateVersionId: id, reason: note }),
  action("workpaper.confirm", {
    expectedRevision: z.number().int().nonnegative(),
    content: validationWorkpaperContentSchema,
    completionNote: note,
    confirmedAcceptanceCriteria: z.array(z.string().min(1)).min(1),
  }),
  action("workpaper.reopen", {
    expectedRevision: z.number().int().nonnegative(),
    reason: note,
  }),
]);
export const workExecutionPayloadSchema = z
  .object({
    stateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: note.describe(
      "操作说明原文；不得由模型虚构。在生产中它不构成人工授权，必须另有精确绑定的可信授权记录",
    ),
    operation: workActionSchema,
  })
  .strict();
export const workExecutionRequestSchema =
  governedCommandRequestSchema.safeExtend({
    payload: workExecutionPayloadSchema,
  });
export const integrationExecutionProjectSchema = projectSchema.extend({
  phases: z.array(integrationProjectStageSchema).length(7),
  node: projectSchema.shape.node.extend({
    subtasks: z.array(projectSchema.shape.node.shape.subtasks.element),
  }),
});

const integrationExecutionSourceTaskSchema = taskDetailSchema.extend({
  order: taskDetailSchema.shape.order.optional(),
  analysis: taskDetailSchema.shape.analysis.optional(),
  evidence: z.array(taskDetailSchema.shape.evidence.element),
  situations: z.array(taskDetailSchema.shape.situations.element),
  materials: z.array(integrationSafeMaterialSchema),
});

export const workExecutionContextSchema = z.object({
  project: integrationExecutionProjectSchema.nullable(),
  sourceTask: integrationExecutionSourceTaskSchema.optional(),
  version: z.number().int().nonnegative(),
  stateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  allowedActions: z.array(z.string()),
  // A subset of `allowedActions` that the server only accepts together with a
  // matching human approval record. Hosts use it to decide when to ask the
  // person; it is a signal, never an authorization.
  approvalRequiredActions: z.array(z.string()).default([]),
});
export const workProgressItemSchema = integrationWorkItemSchema
  .pick({
    id: true,
    title: true,
    phaseCode: true,
    phaseName: true,
    status: true,
    progressUpdate: true,
  })
  .strict();

export const workProgressReadbackSchema = z.strictObject({
  responseFormat: z.literal("compact"),
  projectId: id,
  version: workExecutionContextSchema.shape.version,
  item: workProgressItemSchema,
});

export type WorkAction = z.infer<typeof workActionSchema>;
export type WorkExecutionRequest = z.infer<typeof workExecutionRequestSchema>;
