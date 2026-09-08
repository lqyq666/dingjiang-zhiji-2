import { z } from "zod";

import {
  evidenceSchema,
  formalExperienceSchema,
  projectSchema,
  roleSchema,
  sourceLocatorSchema,
  taskDetailSchema,
  taskMaterialVerificationSchema,
  taskMaterialVerificationStatusSchema,
} from "./vs01";
import { validationWorkpaperViewSchema } from "./vs16";

const idSchema = z.string().trim().min(1);

export const integrationScopeSchema = z.enum([
  "project:read",
  "workitem:read",
  "workitem:write",
  "project:approve",
  "experience:publish",
  "material:read",
  "material:write",
  "material:verify",
  "evidence:read",
  "evidence:write",
  "evidence:confirm",
  "workpaper:read",
  "workpaper:write",
  "experience:read",
]);

export const integrationPrincipalSchema = z.object({
  tenantId: idSchema,
  subjectId: idSchema,
  credentialId: z.string().uuid().optional(),
  role: roleSchema,
  scopes: z.array(integrationScopeSchema).min(1),
  projectIds: z.array(idSchema).min(1),
});

export const integrationTokenBindingsSchema = z
  .array(
    integrationPrincipalSchema
      .extend({ token: z.string().trim().min(16) })
      .strict(),
  )
  .min(1)
  .superRefine((bindings, context) => {
    const tokens = new Set<string>();
    for (const [index, binding] of bindings.entries()) {
      if (tokens.has(binding.token))
        context.addIssue({
          code: "custom",
          path: [index, "token"],
          message: "duplicate token",
        });
      tokens.add(binding.token);
    }
  });

export const integrationSafeMaterialSchema = z.object({
  id: idSchema,
  requirementId: idSchema.nullable(),
  title: idSchema,
  note: z.string(),
  kind: z.enum(["MANUAL_REFERENCE", "UPLOADED_FILE"]),
  status: z.literal("ACTIVE"),
  situationCode: z.enum(["BOM_DELAY", "PURCHASE_DELAY", "CAPACITY_RISK"]),
  locator: sourceLocatorSchema.nullable(),
  file: z
    .object({
      originalName: idSchema,
      mediaType: idSchema,
      extractionStatus: z.enum(["EXTRACTED", "NEEDS_REVIEW", "FAILED"]),
      contentPreview: z.string().nullable(),
      readableByAi: z.boolean(),
    })
    .nullable(),
  verification: taskMaterialVerificationSchema,
  verificationStatus: taskMaterialVerificationStatusSchema,
  latestVerificationAudit: z
    .object({
      eventType: z.enum(["MATERIAL_VERIFIED", "MATERIAL_REVISION_REQUESTED"]),
      version: z.number().int().positive(),
      actor: idSchema,
      note: z.string(),
      occurredAt: z.string().datetime(),
    })
    .strict()
    .nullable(),
  verificationEligible: z.boolean(),
  evidenceProposalVersion: z.number().int().nonnegative().default(0),
});

export const integrationMaterialGapSchema = z.object({
  situationCode: z.enum(["BOM_DELAY", "PURCHASE_DELAY", "CAPACITY_RISK"]),
  requirementId: idSchema,
  label: idSchema,
  status: z.enum(["MISSING", "UNVERIFIED"]),
});

export const integrationProjectContextSchema = z.object({
  project: z.object({
    id: idSchema,
    name: idSchema,
    status: projectSchema.shape.status,
    currentStage: projectSchema.shape.phases.element.nullable(),
    progress: projectSchema.shape.progress,
    phases: projectSchema.shape.phases,
    outcome: projectSchema.shape.outcome,
    experienceSummary: z.array(
      z.object({
        id: idSchema,
        title: idSchema,
        status: z.enum(["PENDING_REVIEW", "RETURNED", "WITHDRAWN", "APPROVED"]),
        locator: sourceLocatorSchema,
      }),
    ),
    recentActivities: z.array(
      z.object({
        eventType: idSchema,
        phaseCode: z.string().nullable(),
        note: z.string(),
        actor: roleSchema,
        createdAt: z.string().datetime(),
      }),
    ),
    latestConfirmedWorkpaper: z
      .object({
        revision: z.number().int().min(1),
        conclusion: z.object({
          result: z.enum([
            "SUPPORTS",
            "DOES_NOT_SUPPORT",
            "INSUFFICIENT_INFORMATION",
          ]),
          statement: idSchema,
          limitations: idSchema,
          nextChecks: z.array(idSchema).min(1),
        }),
        locator: sourceLocatorSchema,
        confirmedAt: z.string().datetime(),
        confirmedBy: roleSchema,
      })
      .nullable(),
  }),
  sourceTask: z.object({
    id: idSchema,
    status: taskDetailSchema.shape.status,
    facts: taskDetailSchema.shape.facts,
    evidence: z.array(evidenceSchema),
    materialGaps: z.array(integrationMaterialGapSchema),
    materials: z.array(integrationSafeMaterialSchema),
  }),
});

export const integrationProjectStateSchema = z.object({
  id: idSchema,
  sourceTaskId: idSchema,
  name: idSchema,
  status: projectSchema.shape.status,
  progress: projectSchema.shape.progress,
  currentStage: projectSchema.shape.phases.element.nullable(),
  outcome: projectSchema.shape.outcome,
});

export const integrationProjectListSchema = z.object({
  items: z.array(integrationProjectStateSchema),
  currentProjectId: idSchema.nullable(),
});

export const integrationWorkItemSchema =
  projectSchema.shape.phases.element.shape.tasks.element.extend({
    projectId: idSchema,
    phaseCode: projectSchema.shape.phases.element.shape.code,
    phaseName: idSchema,
  });

export const integrationWorkItemListSchema = z.object({
  projectId: idSchema,
  items: z.array(integrationWorkItemSchema),
});

export const integrationCurrentWorkItemSchema = z.object({
  projectId: idSchema,
  item: integrationWorkItemSchema.nullable(),
});

export const integrationEvidenceListSchema = z.object({
  projectId: idSchema,
  sourceTaskId: idSchema,
  items: z.array(evidenceSchema),
});

export const integrationMaterialListSchema = z.object({
  projectId: idSchema,
  sourceTaskId: idSchema,
  items: z.array(integrationSafeMaterialSchema),
  gaps: z.array(integrationMaterialGapSchema),
});

export const integrationMaterialPreviewSchema = z.object({
  projectId: idSchema,
  sourceTaskId: idSchema,
  bodyAvailable: z.boolean(),
  material: integrationSafeMaterialSchema,
});

export const integrationEvidenceDetailSchema = z.object({
  projectId: idSchema,
  sourceTaskId: idSchema,
  item: evidenceSchema,
});

export const integrationSourceVersionSchema = z.object({
  projectId: idSchema,
  locator: sourceLocatorSchema,
  foundIn: z.enum([
    "EVIDENCE",
    "MATERIAL",
    "WORK_ITEM_OUTPUT",
    "OUTCOME",
    "WORKPAPER",
  ]),
});

export const integrationValidationWorkpaperSchema =
  validationWorkpaperViewSchema;

export const integrationExperienceSearchSchema = z.object({
  query: z.string(),
  items: z.array(formalExperienceSchema),
});

export const integrationFormalExperienceSchema = formalExperienceSchema;

export const integrationExperienceEvidenceSchema = z.object({
  experienceId: idSchema,
  sourceProjectId: idSchema,
  sourceTaskId: idSchema,
  locator: sourceLocatorSchema,
});

export const integrationErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "STALE_VERSION",
  "CONFLICT",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const integrationErrorSchema = z.object({
  code: integrationErrorCodeSchema,
  message: idSchema,
  retryable: z.boolean(),
  requiresHuman: z.boolean(),
});

export const integrationFailureEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: integrationErrorSchema,
  correlationId: z.string().uuid(),
});

export const integrationSuccessEnvelopeSchema = <T extends z.ZodType>(
  data: T,
) =>
  z.object({
    ok: z.literal(true),
    data,
    correlationId: z.string().uuid(),
  });

export type IntegrationScope = z.infer<typeof integrationScopeSchema>;
export type IntegrationPrincipal = z.infer<typeof integrationPrincipalSchema>;
export type IntegrationSafeMaterial = z.infer<
  typeof integrationSafeMaterialSchema
>;
export type IntegrationProjectContext = z.infer<
  typeof integrationProjectContextSchema
>;
export type IntegrationProjectState = z.infer<
  typeof integrationProjectStateSchema
>;
export type IntegrationProjectList = z.infer<
  typeof integrationProjectListSchema
>;
export type IntegrationWorkItem = z.infer<typeof integrationWorkItemSchema>;
export type IntegrationWorkItemList = z.infer<
  typeof integrationWorkItemListSchema
>;
export type IntegrationCurrentWorkItem = z.infer<
  typeof integrationCurrentWorkItemSchema
>;
export type IntegrationEvidenceList = z.infer<
  typeof integrationEvidenceListSchema
>;
export type IntegrationEvidenceDetail = z.infer<
  typeof integrationEvidenceDetailSchema
>;
export type IntegrationMaterialList = z.infer<
  typeof integrationMaterialListSchema
>;
export type IntegrationMaterialPreview = z.infer<
  typeof integrationMaterialPreviewSchema
>;
export type IntegrationSourceVersion = z.infer<
  typeof integrationSourceVersionSchema
>;
export type IntegrationExperienceSearch = z.infer<
  typeof integrationExperienceSearchSchema
>;
export type IntegrationFormalExperience = z.infer<
  typeof integrationFormalExperienceSchema
>;
export type IntegrationExperienceEvidence = z.infer<
  typeof integrationExperienceEvidenceSchema
>;
export type IntegrationError = z.infer<typeof integrationErrorSchema>;
export type IntegrationFailureEnvelope = z.infer<
  typeof integrationFailureEnvelopeSchema
>;
