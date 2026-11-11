import { z } from "zod";
import {
  workExecutionRequestSchema,
  workExecutionContextSchema,
  workProgressItemSchema,
  workProgressReadbackSchema,
  materialVerificationPayloadSchema,
  materialVerificationResultSchema,
  evidenceConfirmationPayloadSchema,
  evidenceConfirmationResultSchema,
  workpaperProposalPayloadSchema,
  workpaperProposeResultSchema,
  materialCreatePayloadSchema,
  materialCreateResultSchema,
  evidenceProposalPayloadSchema,
  evidenceProposeResultSchema,
  governedCommandResultSchema,
  integrationCurrentWorkItemSchema,
  integrationEvidenceDetailSchema,
  integrationEvidenceListSchema,
  integrationExperienceEvidenceSchema,
  integrationExperienceSearchSchema,
  integrationFormalExperienceSchema,
  integrationMaterialListSchema,
  integrationMaterialPreviewSchema,
  integrationProjectContextSchema,
  integrationProjectListSchema,
  integrationProjectStateSchema,
  integrationWorkspaceResumeSchema,
  integrationWorkContextSchema,
  integrationEvidenceBundleSchema,
  integrationSourceVersionSchema,
  integrationValidationWorkpaperSchema,
  integrationWorkItemListSchema,
  nextActionSchema,
} from "@dingjiang/contracts";
import { integrationEventsSchema } from "../client";

export type JsonSchemaObject = {
  [keyword: string]: unknown;
  additionalProperties?: unknown;
};

export const emptyInput = z.object({}).strict();
export const identifierInput = z
  .object({ projectId: z.string().trim().min(1).max(120) })
  .strict();
export const materialInput = identifierInput
  .extend({
    materialId: z.string().trim().min(1).max(120),
  })
  .strict();
export const evidenceInput = identifierInput
  .extend({
    evidenceId: z.string().trim().min(1).max(120),
  })
  .strict();
export const sourceVersionInput = identifierInput
  .extend({
    sourceVersionId: z.string().trim().min(1).max(160),
  })
  .strict();
export const experienceInput = z
  .object({ experienceId: z.string().trim().min(1).max(120) })
  .strict();
export const searchInput = z
  .object({ query: z.string().trim().max(200).default("") })
  .strict();
export const workpaperProposeInput = z
  .object({
    projectId: z.string().trim().min(1).max(120),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    correlationId: z.string().uuid(),
    payload: workpaperProposalPayloadSchema,
  })
  .strict();
export const materialCreateInput = z
  .object({
    projectId: z.string().trim().min(1).max(120),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    correlationId: z.string().uuid(),
    payload: materialCreatePayloadSchema,
  })
  .strict();
export const evidenceProposeInput = z
  .object({
    projectId: z.string().trim().min(1).max(120),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    correlationId: z.string().uuid(),
    payload: evidenceProposalPayloadSchema,
  })
  .strict();

const responseFormat = z.enum(["full", "compact"]).optional();

export const workOperationsInput = identifierInput
  .extend({
    responseFormat,
    workItemId: z.string().trim().min(1).max(160).optional(),
  })
  .refine(
    ({ responseFormat, workItemId }) =>
      !workItemId || responseFormat === "compact",
  );

export const workExecuteInput = workExecutionRequestSchema
  .safeExtend({
    projectId: identifierInput.shape.projectId
      .optional()
      .describe(
        "多个授权项目时必填，从 work.operations 复制用户选定项目的 projectId。只有一个授权项目的进展记录可以省略。",
      ),
    responseFormat,
  })
  .refine(
    ({ projectId, responseFormat, payload }) =>
      payload.operation.action === "progress.record" ||
      (projectId !== undefined && responseFormat !== "compact"),
  );

export const compactProgressContextSchema = z.strictObject({
  responseFormat: z.literal("compact"),
  projectId: identifierInput.shape.projectId,
  projectName: z.string().nullable(),
  version: workExecutionContextSchema.shape.version,
  stateFingerprint: workExecutionContextSchema.shape.stateFingerprint,
  allowedActions: z.array(z.literal("progress.record")).max(1),
  approvalRequiredActions: z.array(z.literal("progress.record")).max(1),
  items: z.array(workProgressItemSchema),
});

export const compactProgressReceiptDataSchema = z.strictObject({
  responseFormat: z.literal("compact"),
  projectId: identifierInput.shape.projectId,
  action: z.literal("progress.record"),
  item: workProgressItemSchema.nullable(),
});
export const materialVerifyInput = z
  .object({
    ...materialCreateInput.shape,
    payload: materialVerificationPayloadSchema,
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export const evidenceConfirmInput = z
  .object({
    ...evidenceProposeInput.shape,
    payload: evidenceConfirmationPayloadSchema,
  })
  .strict();

const aggregateOutputSchemas: Record<string, z.ZodType> = {
  "workspace.resume": integrationWorkspaceResumeSchema,
  "work.context": integrationWorkContextSchema,
  "evidence.bundle": integrationEvidenceBundleSchema,
};

export const aggregateOutputFor = (name: string): z.ZodType | undefined =>
  Object.hasOwn(aggregateOutputSchemas, name)
    ? aggregateOutputSchemas[name]
    : undefined;

/**
 * Declared output contracts, taken from the exact Zod schemas the client
 * already validates each Integration response with. Deriving rather than
 * hand-writing means a contract change cannot leave `outputSchema` behind, and
 * `structuredContent` is conformant by construction rather than by promise.
 *
 * Aggregate output contracts describe how the dispatcher assembles several
 * validated Integration responses into one result.
 */
const outputContractSchemas: Record<string, z.ZodType> = {
  "workspace.events": integrationEventsSchema,
  "work.operations": z.union([
    workExecutionContextSchema,
    compactProgressContextSchema,
    workProgressReadbackSchema,
  ]),
  "work.execute": governedCommandResultSchema,
  "material.verify": materialVerificationResultSchema,
  "evidence.confirm": evidenceConfirmationResultSchema,
  list_projects: integrationProjectListSchema,
  get_current_project: integrationProjectStateSchema,
  get_project_context: integrationProjectContextSchema,
  get_project_state: integrationProjectStateSchema,
  get_current_work_item: integrationCurrentWorkItemSchema,
  list_project_work_items: integrationWorkItemListSchema,
  list_evidence: integrationEvidenceListSchema,
  list_traceable_materials: integrationMaterialListSchema,
  get_material_preview: integrationMaterialPreviewSchema,
  get_evidence: integrationEvidenceDetailSchema,
  get_source_version: integrationSourceVersionSchema,
  get_validation_workpaper: integrationValidationWorkpaperSchema,
  search_formal_experiences: integrationExperienceSearchSchema,
  "experience.search": integrationExperienceSearchSchema,
  get_formal_experience: integrationFormalExperienceSchema,
  get_experience_evidence: integrationExperienceEvidenceSchema,
  "workpaper.propose": workpaperProposeResultSchema,
  "material.create": materialCreateResultSchema,
  "evidence.propose": evidenceProposeResultSchema,
  "project.next_action": nextActionSchema,
  ...aggregateOutputSchemas,
};

export const outputSchemaFor = (name: string): JsonSchemaObject | undefined => {
  const schema = outputContractSchemas[name];
  if (!schema) return undefined;
  // `io: "output"` describes what the server emits rather than what it accepts:
  // an input-oriented schema would advertise defaulted fields as optional and
  // let a client validate against a shape this server never returns.
  return { type: "object", ...z.toJSONSchema(schema, { io: "output" }) };
};

/** Number of tools that declare an output contract; asserted by the tests. */
export const outputContractToolCount = Object.keys(
  outputContractSchemas,
).length;
