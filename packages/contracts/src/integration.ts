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
import { evidenceProposalReviewListSchema } from "./evidence-intake";

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
  // Optional for older API responses. Do not substitute a project version.
  availabilityVersion: z.union([z.literal(0), z.literal(1)]).optional(),
});

// Integration projects expose only the requesting role's authorized work items.
export const integrationProjectStageSchema =
  projectSchema.shape.phases.element.extend({
    tasks: z.array(projectSchema.shape.phases.element.shape.tasks.element),
  });

export const integrationProjectContextSchema = z.object({
  project: z.object({
    id: idSchema,
    name: idSchema,
    status: projectSchema.shape.status,
    currentStage: integrationProjectStageSchema.nullable(),
    progress: projectSchema.shape.progress,
    phases: z.array(integrationProjectStageSchema).length(7),
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
        conclusion:
          validationWorkpaperViewSchema.shape.latestConfirmed.unwrap().shape
            .content.shape.conclusion,
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
  currentStage: integrationProjectStageSchema.nullable(),
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
  validationWorkpaperViewSchema.extend({
    workItem: validationWorkpaperViewSchema.shape.workItem.nullable(),
  });

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
  "RATE_LIMITED",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const integrationErrorSchema = z.object({
  code: integrationErrorCodeSchema,
  message: idSchema,
  retryable: z.boolean(),
  requiresHuman: z.boolean(),
  requiredScope: integrationScopeSchema.optional(),
});

/**
 * The single derived next action for a project.
 *
 * Derived on the server because "what happens next" is a business rule: stage,
 * current work item and material gaps decide it. A second front end must get
 * the same answer, so it lives here rather than in one adapter.
 */
export const nextActionSchema = z
  .object({
    kind: z.enum(["WORK_ITEM", "MATERIAL_GAP", "HUMAN_GATE_OR_REVIEW"]),
    projectId: z.string(),
    workItemId: z.string().optional(),
    requirementId: z.string().optional(),
    title: z.string(),
    responsibleRole: z.string().optional(),
    explanation: z.string(),
    classification: z.literal("PROPOSAL"),
  })
  .strict();

export type NextAction = z.infer<typeof nextActionSchema>;

// Aggregate replies keep one copy of each domain's details.
const stageSummary = integrationProjectStateSchema.shape.currentStage
  .unwrap()
  .omit({ tasks: true });
const projectStateSummary = integrationProjectStateSchema.extend({
  currentStage: stageSummary.nullable(),
});

const contextShape = integrationProjectContextSchema.shape;
const materialSummary = integrationSafeMaterialSchema.extend({
  file: integrationSafeMaterialSchema.shape.file
    .unwrap()
    .omit({ contentPreview: true })
    .nullable(),
});
const projectContextSummary = integrationProjectContextSchema.extend({
  project: contextShape.project.extend({
    currentStage: stageSummary.nullable(),
    phases: z.array(stageSummary),
  }),
  sourceTask: contextShape.sourceTask.extend({
    materials: z.array(materialSummary),
  }),
});

const workpaperContext = integrationValidationWorkpaperSchema.shape.context;
const workpaperMaterialSummary = z.object(
  workpaperContext.shape.materials.element.omit({ contentPreview: true }).shape,
);
const workpaperSummary = z.object({
  ...integrationValidationWorkpaperSchema.omit({ history: true }).shape,
  context: workpaperContext.extend({
    materials: z.array(workpaperMaterialSummary),
  }),
});

export const integrationWorkContextSchema = z
  .object({
    projectId: z.string(),
    context: projectContextSummary,
    state: projectStateSummary,
    currentWorkItem: integrationCurrentWorkItemSchema,
    workItems: integrationWorkItemListSchema,
  })
  .strict();

export const integrationEvidenceBundleSchema = z
  .object({
    projectId: z.string(),
    evidence: integrationEvidenceListSchema,
    materials: integrationMaterialListSchema,
    workpaper: workpaperSummary.nullable(),
    proposals: evidenceProposalReviewListSchema,
  })
  .strict();

export const integrationWorkspaceResumeSchema = z
  .object({
    projects: integrationProjectListSchema.extend({
      items: z.array(projectStateSummary),
    }),
    ...integrationWorkContextSchema.shape,
    ...integrationEvidenceBundleSchema.shape,
    context: projectContextSummary.extend({
      sourceTask: contextShape.sourceTask.omit({
        evidence: true,
        materials: true,
      }),
    }),
    nextAction: nextActionSchema,
  })
  .strict();

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
