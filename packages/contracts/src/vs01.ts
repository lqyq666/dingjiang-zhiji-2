import { z } from "zod";
import { structuredExperienceCardSchema } from "./vs17";

export const roleSchema = z.enum(["PMC", "OWNER", "EXPERT_REVIEWER"]);
export const taskStatusSchema = z.enum(["OPEN", "DECIDED"]);
export const decisionTypeSchema = z.enum([
  "CONFIRMED",
  "MODIFIED",
  "INSUFFICIENT_INFORMATION",
]);
export const projectStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "RETURNED",
  "RUNNING",
  "RESULT_VALIDATION",
  "PENDING_RESULT_ACCEPTANCE",
  "KNOWLEDGE_CAPTURE",
  "COMPLETED",
]);
export const projectNodeStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
]);
export const situationCodeSchema = z.enum([
  "BOM_DELAY",
  "PURCHASE_DELAY",
  "CAPACITY_RISK",
]);
export const subtaskStatusSchema = z.enum(["TODO", "DONE"]);
export const projectPhaseCodeSchema = z.enum([
  "PROJECT_SCOPING",
  "BASELINE_FACTS",
  "ROOT_CAUSE_VALIDATION",
  "SOLUTION_APPROVAL",
  "EXECUTION_CONTROL",
  "RESULT_ACCEPTANCE",
  "KNOWLEDGE_CAPTURE",
]);
export const consultingTaskStatusSchema = z.enum([
  "LOCKED",
  "READY",
  "IN_PROGRESS",
  "WAITING_REVIEW",
  "DONE",
  "RETURNED",
]);
export const phaseGateStatusSchema = z.enum([
  "LOCKED",
  "OPEN",
  "PENDING",
  "APPROVED",
  "RETURNED",
]);
export const taskInputStatusSchema = z.enum([
  "AVAILABLE",
  "MISSING",
  "UNVERIFIED",
]);
export const outcomeStatusSchema = z.enum([
  "NOT_MEASURED",
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "RETURNED",
]);
export const experienceCandidateStatusSchema = z.enum([
  "PENDING_REVIEW",
  "RETURNED",
  "WITHDRAWN",
  "APPROVED",
]);
export const formalExperienceStatusSchema = z.enum(["PUBLISHED", "RETRACTED"]);
export const experienceReferenceStatusSchema = z.enum(["ACTIVE", "WITHDRAWN"]);
export const experienceReferenceEventTypeSchema = z.enum([
  "CITED",
  "WITHDRAWN",
  "RESTORED",
]);

const idSchema = z.string().trim().min(1);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const percentageSchema = z.number().int().min(0).max(100);
export const sourceLocatorSchema = z.object({
  sourceObjectId: idSchema,
  sourceVersionId: idSchema,
  reference: idSchema,
});

export const experienceCandidateSchema = z
  .object({
    id: idSchema,
    title: idSchema,
    applicableSituation: idSchema,
    businessProblem: idSchema,
    practice: idSchema,
    resultSummary: idSchema,
    evidenceReference: idSchema,
    limitations: idSchema,
    status: experienceCandidateStatusSchema,
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
    submittedAt: z.string().datetime(),
    returnedReason: z.string().nullable(),
    reviewedBy: z.literal("EXPERT_REVIEWER").nullable(),
    reviewedAt: z.string().datetime().nullable(),
    formalExperienceId: idSchema.nullable(),
    candidateLocator: sourceLocatorSchema,
    evidenceLocator: sourceLocatorSchema,
    structuredCard: structuredExperienceCardSchema.nullable().default(null),
    feishuSync: z
      .object({
        recordId: idSchema.nullable(),
        revision: z.number().int().min(1).nullable(),
        status: z.enum(["PENDING", "SYNCED", "FAILED"]).nullable(),
        syncedAt: z.string().datetime().nullable(),
      })
      .strict()
      .default({
        recordId: null,
        revision: null,
        status: null,
        syncedAt: null,
      }),
  })
  .superRefine((value, ctx) => {
    if (value.status === "RETURNED" && !value.returnedReason?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["returnedReason"],
        message: "已退回候选经验必须保留退回原因",
      });
    }
    if (value.status === "APPROVED" && !value.formalExperienceId) {
      ctx.addIssue({
        code: "custom",
        path: ["formalExperienceId"],
        message: "已批准候选经验必须指向正式经验",
      });
    }
  });

export const formalExperienceSchema = z.object({
  id: idSchema,
  candidateId: idSchema,
  sourceProjectId: idSchema,
  sourceTaskId: idSchema,
  status: formalExperienceStatusSchema,
  title: idSchema,
  applicableSituation: idSchema,
  businessProblem: idSchema,
  practice: idSchema,
  resultSummary: idSchema,
  limitations: idSchema,
  publishedBy: z.literal("EXPERT_REVIEWER"),
  publishedAt: z.string().datetime(),
  retractedAt: z.string().datetime().nullable(),
  retractedReason: z.string().nullable(),
  locator: sourceLocatorSchema,
  candidateLocator: sourceLocatorSchema,
  evidenceLocator: sourceLocatorSchema,
  structuredCard: structuredExperienceCardSchema.nullable().default(null),
  cozeIndex: z
    .object({
      status: z.enum(["INDEX_PENDING", "INDEXED", "INDEX_FAILED"]),
      executeId: idSchema.nullable(),
      debugUrl: z.string().url().nullable(),
      indexedAt: z.string().datetime().nullable(),
    })
    .strict()
    .default({
      status: "INDEX_PENDING",
      executeId: null,
      debugUrl: null,
      indexedAt: null,
    }),
});

export const experienceReferenceSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  experienceId: idSchema,
  status: experienceReferenceStatusSchema,
  classification: z.literal("PROPOSAL"),
  title: idSchema,
  applicableSituation: idSchema,
  limitations: idSchema,
  note: z.string(),
  createdBy: z.literal("PMC"),
  createdAt: z.string().datetime(),
  withdrawnAt: z.string().datetime().nullable(),
  withdrawnReason: z.string().nullable(),
  experienceLocator: sourceLocatorSchema,
});

export const experienceReferenceEventSchema = z.object({
  id: idSchema,
  referenceId: idSchema,
  taskId: idSchema,
  experienceId: idSchema,
  experienceTitle: idSchema,
  eventType: experienceReferenceEventTypeSchema,
  actor: z.literal("PMC"),
  note: z.string(),
  createdAt: z.string().datetime(),
  snapshot: z.record(z.string(), z.unknown()),
});

export const experienceCandidateRevisionSchema = z.object({
  revision: z.number().int().min(1),
  title: idSchema,
  applicableSituation: idSchema,
  businessProblem: idSchema,
  practice: idSchema,
  resultSummary: idSchema,
  evidenceReference: idSchema,
  limitations: idSchema,
  submittedAt: z.string().datetime(),
  locator: sourceLocatorSchema,
  structuredCard: structuredExperienceCardSchema.nullable().default(null),
});

export const experienceLifecycleEventSchema = z.object({
  eventType: idSchema,
  actor: roleSchema,
  note: z.string(),
  createdAt: z.string().datetime(),
  snapshot: z.record(z.string(), z.unknown()),
});

export const experienceLifecycleHistorySchema = z.object({
  candidateId: idSchema,
  project: z.object({ id: idSchema, name: idSchema }),
  status: experienceCandidateStatusSchema,
  currentRevision: z.number().int().min(1),
  revisions: z.array(experienceCandidateRevisionSchema).min(1),
  publications: z.array(formalExperienceSchema),
  events: z.array(experienceLifecycleEventSchema),
});

export const experienceLifecycleHistoryListSchema = z.object({
  items: z.array(experienceLifecycleHistorySchema),
});

export const evidenceSchema = z.object({
  id: idSchema,
  sourceObjectId: idSchema,
  sourceVersionId: idSchema,
  sourceFile: idSchema,
  sourceSheet: idSchema,
  sourceRow: z.number().int().min(2),
  fields: z.record(z.string(), z.string()),
  classification: z.enum(["FACT", "PROPOSAL"]),
  origin: z.enum(["SYSTEM_FACT", "HUMAN_CONFIRMED_MATERIAL"]).optional(),
  claim: z.string().optional(),
  evidenceType: z.enum(["OBSERVATION", "METRIC", "DOCUMENTED_FACT"]).optional(),
  exactSpan: z
    .object({
      kind: z.literal("TEXT_SPAN"),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      exactText: z.string().min(1),
    })
    .optional(),
  limitations: z.string().optional(),
  proposalId: idSchema.optional(),
  confirmedBy: idSchema.optional(),
  confirmedAt: z.string().datetime().optional(),
});

export const orderRiskSchema = z.object({
  orderId: idSchema,
  customer: idSchema,
  promisedDate: dateSchema,
  forecastDate: dateSchema,
  delayDays: z.number().int().min(0),
  primaryException: idSchema,
});

export const taskMaterialKindSchema = z.enum([
  "MANUAL_REFERENCE",
  "UPLOADED_FILE",
]);
export const taskMaterialStatusSchema = z.enum(["ACTIVE", "WITHDRAWN"]);
export const taskMaterialExtractionStatusSchema = z.enum([
  "EXTRACTED",
  "NEEDS_REVIEW",
  "FAILED",
]);
export const taskMaterialVerificationStatusSchema = z.enum([
  "UNVERIFIED",
  "VERIFIED",
  "NEEDS_REVISION",
]);
export const taskMaterialVerificationSchema = z
  .object({
    status: taskMaterialVerificationStatusSchema,
    version: z.number().int().nonnegative(),
    note: z.string(),
    verifiedBy: idSchema.nullable(),
    verifiedAt: z.string().datetime().nullable(),
  })
  .strict();
export const taskMaterialFileSchema = z.object({
  originalName: idSchema,
  mediaType: idSchema,
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  extractionStatus: taskMaterialExtractionStatusSchema,
  contentPreview: z.string().max(20_000).nullable(),
  readableByAi: z.boolean(),
});

export const taskMaterialSchema = z
  .object({
    id: idSchema,
    situationCode: situationCodeSchema,
    requirementId: idSchema.nullable().default(null),
    title: idSchema,
    sourceReference: idSchema,
    note: z.string(),
    kind: taskMaterialKindSchema.default("MANUAL_REFERENCE"),
    status: taskMaterialStatusSchema.default("ACTIVE"),
    locator: sourceLocatorSchema.nullable().default(null),
    file: taskMaterialFileSchema.nullable().default(null),
    withdrawnAt: z.string().datetime().nullable().default(null),
    withdrawnReason: z.string().nullable().default(null),
    createdBy: z.literal("PMC"),
    createdAt: z.string().datetime(),
    verification: taskMaterialVerificationSchema.default({
      status: "UNVERIFIED",
      version: 0,
      note: "",
      verifiedBy: null,
      verifiedAt: null,
    }),
    verificationEligible: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "UPLOADED_FILE" &&
      (!value.requirementId || !value.locator || !value.file)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "上传材料必须绑定需求并提供版本化定位和文件元数据",
      });
    }
    if (
      value.file?.readableByAi &&
      (value.file.extractionStatus !== "EXTRACTED" ||
        !value.file.contentPreview?.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AI 可读材料必须包含已提取的受控文本预览",
      });
    }
    if (
      value.status === "WITHDRAWN" &&
      (!value.withdrawnAt || !value.withdrawnReason?.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "停用材料必须保留停用时间和原因",
      });
    }
  });

export const situationSchema = z.object({
  code: situationCodeSchema,
  label: idSchema,
  state: z.enum(["MATCHED", "UNVERIFIED"]),
  summary: idSchema,
  requirements: z.array(
    z.object({
      id: idSchema,
      label: idSchema,
      fulfilled: z.boolean(),
      evidenceId: idSchema.nullable(),
      materialId: idSchema.nullable(),
    }),
  ),
  solutions: z.array(
    z.object({ id: idSchema, title: idSchema, instruction: idSchema }),
  ),
});

export const taskDetailSchema = z.object({
  id: idSchema,
  status: taskStatusSchema,
  order: orderRiskSchema,
  facts: z.array(
    z.object({
      label: idSchema,
      value: idSchema,
      evidenceId: idSchema,
    }),
  ),
  analysis: z.object({
    provider: z.literal("DEMO_RULES"),
    classification: z.literal("PROPOSAL"),
    candidateCause: idSchema,
    evidenceIds: z.array(idSchema).min(1),
  }),
  evidence: z.array(evidenceSchema).min(1),
  situations: z.array(situationSchema).min(1),
  materials: z.array(taskMaterialSchema),
  experienceReferences: z.array(experienceReferenceSchema),
  experienceReferenceAuditTrail: z.array(experienceReferenceEventSchema),
  decision: z
    .object({
      type: decisionTypeSchema,
      note: z.string(),
      decidedBy: z.literal("PMC"),
      decidedAt: z.string().datetime(),
    })
    .nullable(),
});

export const decisionInputSchema = z.object({
  type: decisionTypeSchema,
  note: z.string().trim().max(500).default(""),
  actor: z.literal("PMC"),
});

export const taskMaterialInputSchema = z.object({
  actor: z.literal("PMC"),
  situationCode: situationCodeSchema,
  title: z.string().trim().min(1).max(100),
  sourceReference: z.string().trim().min(1).max(500),
  note: z.string().trim().max(500).default(""),
});

export const taskMaterialImportFieldsSchema = z
  .object({
    actor: z.literal("PMC"),
    situationCode: situationCodeSchema,
    requirementId: idSchema,
    title: z.string().trim().min(1).max(100),
    note: z.string().trim().max(500).default(""),
    requestId: z.string().uuid(),
  })
  .strict();

export const taskMaterialWithdrawInputSchema = z
  .object({
    actor: z.literal("PMC"),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export const decisionRevertInputSchema = z.object({
  actor: z.literal("PMC"),
  reason: z.string().trim().min(1).max(500),
});

export const createProjectInputSchema = z
  .object({
    actor: z.literal("PMC"),
    sourceTaskId: idSchema,
  })
  .strict();

export const projectSchema = z.object({
  id: idSchema,
  sourceTaskId: idSchema,
  name: idSchema,
  status: projectStatusSchema,
  progress: percentageSchema,
  returnedReason: z.string().nullable(),
  metric: z.object({
    name: z.literal("OTD"),
    before: percentageSchema,
    current: percentageSchema,
    target: percentageSchema,
    truthfulnessStatus: z.enum([
      "BASELINE_ONLY",
      "PENDING_ACCEPTANCE",
      "ACCEPTED",
    ]),
  }),
  outcome: z.object({
    baseline: percentageSchema,
    target: percentageSchema,
    current: percentageSchema.nullable(),
    status: outcomeStatusSchema,
    conclusion: z.string().nullable(),
    evidenceReference: z.string().nullable(),
    note: z.string().nullable(),
    submittedAt: z.string().datetime().nullable(),
    acceptedAt: z.string().datetime().nullable(),
    locator: sourceLocatorSchema.nullable(),
  }),
  experienceCandidate: experienceCandidateSchema.nullable(),
  publishedExperienceHistory: z.boolean(),
  experienceReferences: z.array(experienceReferenceSchema),
  node: z.object({
    id: idSchema,
    name: idSchema,
    status: projectNodeStatusSchema,
    progress: percentageSchema,
    latestUpdate: z.string(),
    completedSubtaskCount: z.number().int().min(0),
    totalSubtaskCount: z.number().int().min(1),
    subtasks: z
      .array(
        z.object({
          id: idSchema,
          title: idSchema,
          status: subtaskStatusSchema,
          completionNote: z.string(),
          completedAt: z.string().datetime().nullable(),
        }),
      )
      .min(1),
  }),
  phases: z
    .array(
      z.object({
        id: idSchema,
        code: projectPhaseCodeSchema,
        name: idSchema,
        purpose: idSchema,
        status: z.enum([
          "LOCKED",
          "READY",
          "IN_PROGRESS",
          "WAITING_REVIEW",
          "COMPLETED",
          "RETURNED",
        ]),
        progress: percentageSchema,
        completedTaskCount: z.number().int().min(0),
        totalTaskCount: z.number().int().min(1),
        gate: z.object({
          status: phaseGateStatusSchema,
          label: idSchema,
          returnedReason: z.string().nullable(),
        }),
        tasks: z
          .array(
            z.object({
              id: idSchema,
              title: idSchema,
              purpose: idSchema,
              owner: z.enum(["PMC", "OWNER"]),
              origin: z.enum(["LIVE", "HISTORICAL"]),
              status: consultingTaskStatusSchema,
              inputs: z.array(
                z.object({
                  label: idSchema,
                  requirementId: idSchema.nullable().default(null),
                  status: taskInputStatusSchema,
                  reference: z.string().nullable(),
                }),
              ),
              process: z.array(
                z.object({ label: idSchema, completed: z.boolean() }),
              ),
              output: z.object({
                expected: idSchema,
                reference: z.string().nullable(),
                locator: sourceLocatorSchema.nullable(),
              }),
              acceptance: z.array(idSchema).min(1),
              progressUpdate: z
                .object({
                  note: idSchema,
                  outputReference: z.string().nullable(),
                  updatedBy: z.literal("PMC"),
                  updatedAt: z.string().datetime(),
                })
                .nullable(),
              completionConfirmation: z
                .object({
                  basis: z.enum([
                    "HISTORICAL_SOURCE",
                    "ASSIGNEE_CONFIRMED",
                    "ROLE_DECISION",
                  ]),
                  confirmedBy: z.enum(["PMC", "OWNER"]),
                  confirmedAt: z.string().datetime(),
                  confirmedAcceptanceCriteria: z.array(idSchema).min(1),
                })
                .nullable(),
              completionNote: z.string(),
              completedAt: z.string().datetime().nullable(),
              sourceRecordedAt: z.string().datetime().nullable(),
              reopenReason: z.string().nullable(),
            }),
          )
          .min(2),
      }),
    )
    .length(7),
  auditTrail: z.array(
    z.object({
      eventType: idSchema,
      phaseCode: projectPhaseCodeSchema.nullable(),
      note: z.string(),
      actor: roleSchema,
      createdAt: z.string().datetime(),
      snapshot: z.record(z.string(), z.unknown()),
    }),
  ),
});

export const projectActionInputSchema = z.object({ actor: roleSchema });
export const projectReturnInputSchema = z.object({
  actor: z.literal("OWNER"),
  reason: z.string().trim().min(1).max(500),
});
export const projectSubtaskStatusInputSchema = z.discriminatedUnion("status", [
  z.object({
    actor: z.literal("PMC"),
    status: z.literal("IN_PROGRESS"),
    note: z.string().trim().min(1).max(500),
    outputReference: z.string().trim().max(500).default(""),
  }),
  z.object({
    actor: z.literal("PMC"),
    status: z.literal("DONE"),
    note: z.string().trim().min(1).max(500),
    outputReference: z.string().trim().min(1).max(500),
    confirmedAcceptanceCriteria: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: "验收标准确认不能重复",
      }),
  }),
  z.object({
    actor: z.literal("PMC"),
    status: z.literal("READY"),
    note: z.string().trim().min(1).max(500),
  }),
]);

export const executionPhaseReviewInputSchema = z.discriminatedUnion(
  "decision",
  [
    z.object({
      actor: z.literal("PMC"),
      decision: z.literal("APPROVE"),
      note: z.string().trim().min(1).max(500),
    }),
    z.object({
      actor: z.literal("PMC"),
      decision: z.literal("RETURN"),
      reason: z.string().trim().min(1).max(500),
    }),
  ],
);

export const outcomeSubmitInputSchema = z.object({
  actor: z.literal("PMC"),
  currentOtd: percentageSchema,
  evidenceReference: z.string().trim().min(1).max(500),
  conclusion: z.string().trim().min(1).max(500),
  note: z.string().trim().max(500).default(""),
});

export const outcomeReturnInputSchema = z.object({
  actor: z.literal("OWNER"),
  reason: z.string().trim().min(1).max(500),
});

export const outcomeReopenInputSchema = z.object({
  actor: z.literal("PMC"),
  reason: z.string().trim().min(1).max(500),
});

export const experienceCandidateInputSchema = z.object({
  actor: z.literal("PMC"),
  title: z.string().trim().min(1).max(120),
  applicableSituation: z.string().trim().min(1).max(500),
  businessProblem: z.string().trim().min(1).max(500),
  practice: z.string().trim().min(1).max(1000),
  resultSummary: z.string().trim().min(1).max(500),
  limitations: z.string().trim().min(1).max(500),
  structuredCard: structuredExperienceCardSchema.optional(),
});
export const experienceCandidateWithdrawInputSchema = z.object({
  actor: z.literal("PMC"),
  reason: z.string().trim().min(1).max(500),
});

export const experienceCandidateApproveInputSchema = z.object({
  actor: z.literal("EXPERT_REVIEWER"),
  expectedCandidateVersionId: idSchema,
});

export const experienceCandidateReturnInputSchema = z.object({
  actor: z.literal("EXPERT_REVIEWER"),
  expectedCandidateVersionId: idSchema,
  reason: z.string().trim().min(1).max(500),
});

export const experienceCandidateResubmitInputSchema =
  experienceCandidateInputSchema.extend({
    expectedCandidateVersionId: idSchema,
  });

export const experienceReferenceInputSchema = z.object({
  actor: z.literal("PMC"),
  experienceId: idSchema,
  expectedExperienceVersionId: idSchema,
  note: z.string().trim().max(500).default(""),
});

export const experienceReferenceWithdrawInputSchema = z.object({
  actor: z.literal("PMC"),
  reason: z.string().trim().min(1).max(500),
});

export const formalExperienceRetractInputSchema = z.object({
  actor: z.literal("EXPERT_REVIEWER"),
  expectedExperienceVersionId: idSchema,
  reason: z.string().trim().min(1).max(500),
});

export const expertDashboardSchema = z.object({
  role: z.literal("EXPERT_REVIEWER"),
  pendingReviewCount: z.number().int().min(0),
  candidates: z.array(
    z.object({
      candidate: experienceCandidateSchema,
      project: z.object({ id: idSchema, name: idSchema }),
      outcome: z.object({
        current: percentageSchema,
        conclusion: idSchema,
        locator: sourceLocatorSchema,
      }),
    }),
  ),
});

export const experienceLibrarySchema = z.object({
  query: z.string(),
  items: z.array(formalExperienceSchema),
});

export const projectAssistantIntentSchema = z.enum([
  "ASK",
  "NEXT_ACTION",
  "MATERIAL_GAPS",
  "RISK",
  "EXPERIENCE_DRAFT",
]);

export const guidedAnalysisActionSchema = z.enum([
  "INSPECT",
  "PLAN",
  "ANALYZE",
  "VERIFY",
]);

export const guidedAnalysisClarificationSchema = z.object({
  id: idSchema,
  question: idSchema,
  reason: idSchema,
  required: z.boolean(),
  answer: z.string().trim().max(500).nullable(),
});

export const analysisWorkUnitSchema = z.object({
  id: idSchema,
  title: idSchema,
  objective: idSchema,
  inputs: z.array(idSchema).min(1),
  output: idSchema,
  dependsOn: z.array(idSchema),
  executionMode: z.enum(["PARALLEL", "SEQUENTIAL"]),
  status: z.enum(["PLANNED", "COMPLETED"]),
  finding: z.string().nullable(),
  evidenceReferences: z.array(idSchema),
  completionCheck: idSchema,
});

export const guidedAnalysisVerificationSchema = z.object({
  id: idSchema,
  label: idSchema,
  status: z.enum(["PASS", "WARNING"]),
  detail: idSchema,
});

export const guidedAnalysisWorkflowSchema = z.object({
  stageCode: projectPhaseCodeSchema,
  step: z.enum(["CLARIFY", "PLAN", "ANALYSIS", "VERIFICATION"]),
  contextFingerprint: idSchema,
  clarifications: z.array(guidedAnalysisClarificationSchema).min(1).max(3),
  plan: z.array(analysisWorkUnitSchema),
  verification: z.array(guidedAnalysisVerificationSchema),
});

export const projectAssistantRequestSchema = z.object({
  actor: z.literal("PMC"),
  intent: projectAssistantIntentSchema.default("ASK"),
  question: z.string().trim().max(500).default(""),
  stageCode: projectPhaseCodeSchema.optional(),
  workflowAction: guidedAnalysisActionSchema.default("INSPECT"),
  clarificationAnswers: z
    .array(
      z.object({
        questionId: idSchema,
        answer: z.string().trim().min(2).max(500),
      }),
    )
    .max(3)
    .default([]),
  planConfirmed: z.boolean().default(false),
});

export const experienceCandidateDraftSchema = experienceCandidateInputSchema
  .omit({ actor: true })
  .extend({ evidenceReference: idSchema });

export const projectAssistantResponseSchema = z.object({
  provider: z.literal("DEMO_RULES"),
  classification: z.literal("PROPOSAL"),
  answer: idSchema,
  context: z.object({
    projectId: idSchema,
    sourceTaskId: idSchema,
    workTitle: idSchema,
    projectStatus: projectStatusSchema,
    currentStage: z.object({
      code: projectPhaseCodeSchema,
      name: idSchema,
      progress: percentageSchema,
      completedItemCount: z.number().int().min(0),
      totalItemCount: z.number().int().min(1),
    }),
    coverage: z.object({
      stageCount: z.number().int().min(1),
      workItemCount: z.number().int().min(1),
      evidenceCount: z.number().int().min(0),
      materialGapCount: z.number().int().min(0),
      activityCount: z.number().int().min(0),
      experienceReferenceCount: z.number().int().min(0),
    }),
    stages: z
      .array(
        z.object({
          code: projectPhaseCodeSchema,
          name: idSchema,
          status: z.enum([
            "LOCKED",
            "READY",
            "IN_PROGRESS",
            "WAITING_REVIEW",
            "COMPLETED",
            "RETURNED",
          ]),
          progress: percentageSchema,
          completedItemCount: z.number().int().min(0),
          totalItemCount: z.number().int().min(1),
        }),
      )
      .length(7),
    workItems: z.array(
      z.object({
        id: idSchema,
        stage: idSchema,
        title: idSchema,
        owner: z.enum(["PMC", "OWNER"]),
        status: consultingTaskStatusSchema,
        inputGapCount: z.number().int().min(0),
        progressNote: z.string().nullable(),
        completionNote: z.string().nullable(),
        outputReference: z.string().nullable(),
      }),
    ),
    materials: z.array(
      z.object({
        stage: idSchema,
        workItem: idSchema,
        input: idSchema,
        requirementId: idSchema.nullable().default(null),
        status: taskInputStatusSchema,
        reference: z.string().nullable(),
      }),
    ),
    uploadedMaterials: z.array(taskMaterialSchema).default([]),
    recentActivities: z.array(
      z.object({
        eventType: idSchema,
        stage: projectPhaseCodeSchema.nullable(),
        note: z.string(),
        actor: roleSchema,
        createdAt: z.string().datetime(),
      }),
    ),
    nextAction: idSchema,
    materialGaps: z.array(
      z.object({
        stage: idSchema,
        workItem: idSchema,
        input: idSchema,
        status: z.enum(["MISSING", "UNVERIFIED"]),
        situationCode: situationCodeSchema.nullable(),
        requirementId: idSchema.nullable().default(null),
      }),
    ),
    outcome: z.object({
      before: percentageSchema,
      current: percentageSchema.nullable(),
      target: percentageSchema,
      status: outcomeStatusSchema,
      conclusion: z.string().nullable(),
      evidenceReference: z.string().nullable(),
    }),
    experience: z.object({
      candidateStatus: experienceCandidateStatusSchema.nullable(),
      formalPublished: z.boolean(),
      activeReferenceCount: z.number().int().min(0),
    }),
    experienceReferences: z.array(experienceReferenceSchema),
  }),
  workflow: guidedAnalysisWorkflowSchema,
  experienceDraft: experienceCandidateDraftSchema.nullable(),
});

export const assistantFeedbackIssueSchema = z.enum([
  "CONTEXT_GAP",
  "WRONG_SUGGESTION",
  "MISSING_ANGLE",
  "OTHER",
]);

export const assistantFeedbackInputSchema = z.object({
  actor: z.literal("PMC"),
  stageCode: projectPhaseCodeSchema,
  contextFingerprint: idSchema,
  issueType: assistantFeedbackIssueSchema,
  assistantAnswer: z.string().trim().min(1).max(2000),
  feedback: z.string().trim().min(5).max(1000),
  expectedBehavior: z.string().trim().min(5).max(1000),
});

export const assistantFeedbackReceiptSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  stageCode: projectPhaseCodeSchema,
  status: z.enum(["PENDING_REVIEW", "WITHDRAWN"]),
  createdAt: z.string().datetime(),
  withdrawnAt: z.string().datetime().nullable().optional(),
  withdrawnReason: z.string().nullable().optional(),
});

export const assistantFeedbackRecordSchema =
  assistantFeedbackReceiptSchema.extend({
    issueType: assistantFeedbackIssueSchema,
    feedback: idSchema,
    expectedBehavior: idSchema,
  });

export const assistantFeedbackListSchema = z.array(
  assistantFeedbackRecordSchema,
);

export const assistantFeedbackWithdrawInputSchema = z.object({
  actor: z.literal("PMC"),
  reason: z.string().trim().min(5).max(500),
});

export const taskAssistantIntentSchema = z.enum([
  "ASK",
  "NEXT_ACTION",
  "MATERIAL_GAPS",
  "RISK",
]);

export const taskAssistantRequestSchema = z.object({
  actor: z.literal("PMC"),
  intent: taskAssistantIntentSchema.default("ASK"),
  question: z.string().trim().max(500).default(""),
});

export const taskAssistantResponseSchema = z.object({
  provider: z.literal("DEMO_RULES"),
  classification: z.literal("PROPOSAL"),
  answer: idSchema,
  context: z.object({
    taskId: idSchema,
    workTitle: idSchema,
    taskStatus: taskStatusSchema,
    order: orderRiskSchema,
    coverage: z.object({
      evidenceCount: z.number().int().min(0),
      materialCount: z.number().int().min(0),
      materialGapCount: z.number().int().min(0),
      experienceReferenceCount: z.number().int().min(0),
    }),
    decision: z
      .object({ type: decisionTypeSchema, note: z.string() })
      .nullable(),
    materialGaps: z.array(
      z.object({
        situation: idSchema,
        requirementId: idSchema,
        requirement: idSchema,
      }),
    ),
    materials: z.array(taskMaterialSchema).default([]),
    nextAction: idSchema,
    experienceReferences: z.array(experienceReferenceSchema),
  }),
});

export const employeeDashboardSchema = z.object({
  role: z.literal("PMC"),
  highRiskOrders: z.array(orderRiskSchema),
  pendingTaskIds: z.array(idSchema),
  projects: z.array(projectSchema),
  project: projectSchema.nullable(),
});

export const ownerDataSourceSchema = z.object({
  sourceObjectId: idSchema,
  sourceVersionId: idSchema,
  fileName: idSchema,
  category: z.enum(["ORDER", "BOM", "PURCHASE"]),
  versionNumber: z.number().int().positive(),
  recordCount: z.number().int().nonnegative(),
  status: z.literal("AVAILABLE"),
});

export const bossDashboardSchema = z.object({
  role: z.literal("OWNER"),
  otd: percentageSchema,
  targetOtd: percentageSchema,
  highRiskOrderCount: z.number().int().min(0),
  highRiskOrders: z.array(orderRiskSchema),
  pendingApprovalCount: z.number().int().min(0),
  dataSources: z.array(ownerDataSourceSchema),
  projects: z.array(projectSchema),
  project: projectSchema.nullable(),
});

export type Role = z.infer<typeof roleSchema>;
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export type DecisionRevertInput = z.infer<typeof decisionRevertInputSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type TaskMaterialInput = z.infer<typeof taskMaterialInputSchema>;
export type TaskMaterialImportFields = z.infer<
  typeof taskMaterialImportFieldsSchema
>;
export type TaskMaterialWithdrawInput = z.infer<
  typeof taskMaterialWithdrawInputSchema
>;
export type TaskMaterial = z.infer<typeof taskMaterialSchema>;
export type ProjectAssistantRequest = z.infer<
  typeof projectAssistantRequestSchema
>;
export type ProjectAssistantResponse = z.infer<
  typeof projectAssistantResponseSchema
>;
export type GuidedAnalysisWorkflow = z.infer<
  typeof guidedAnalysisWorkflowSchema
>;
export type AssistantFeedbackInput = z.infer<
  typeof assistantFeedbackInputSchema
>;
export type AssistantFeedbackReceipt = z.infer<
  typeof assistantFeedbackReceiptSchema
>;
export type AssistantFeedbackRecord = z.infer<
  typeof assistantFeedbackRecordSchema
>;
export type AssistantFeedbackWithdrawInput = z.infer<
  typeof assistantFeedbackWithdrawInputSchema
>;
export type TaskAssistantRequest = z.infer<typeof taskAssistantRequestSchema>;
export type TaskAssistantResponse = z.infer<typeof taskAssistantResponseSchema>;
export type ExperienceCandidateDraft = z.infer<
  typeof experienceCandidateDraftSchema
>;
export type ExperienceCandidate = z.infer<typeof experienceCandidateSchema>;
export type FormalExperience = z.infer<typeof formalExperienceSchema>;
export type ExperienceReference = z.infer<typeof experienceReferenceSchema>;
export type ExperienceReferenceEvent = z.infer<
  typeof experienceReferenceEventSchema
>;
export type ExperienceCandidateRevision = z.infer<
  typeof experienceCandidateRevisionSchema
>;
export type ExperienceLifecycleHistory = z.infer<
  typeof experienceLifecycleHistorySchema
>;
export type ExperienceLifecycleHistoryList = z.infer<
  typeof experienceLifecycleHistoryListSchema
>;
export type ExpertDashboard = z.infer<typeof expertDashboardSchema>;
export type ExperienceLibrary = z.infer<typeof experienceLibrarySchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type OrderRisk = z.infer<typeof orderRiskSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectSubtaskStatusInput = z.infer<
  typeof projectSubtaskStatusInputSchema
>;
export type ExecutionPhaseReviewInput = z.infer<
  typeof executionPhaseReviewInputSchema
>;
export type OutcomeSubmitInput = z.infer<typeof outcomeSubmitInputSchema>;
export type OutcomeReturnInput = z.infer<typeof outcomeReturnInputSchema>;
export type OutcomeReopenInput = z.infer<typeof outcomeReopenInputSchema>;
export type ExperienceCandidateInput = z.infer<
  typeof experienceCandidateInputSchema
>;
export type ExperienceCandidateWithdrawInput = z.infer<
  typeof experienceCandidateWithdrawInputSchema
>;
export type ExperienceCandidateApproveInput = z.infer<
  typeof experienceCandidateApproveInputSchema
>;
export type ExperienceCandidateReturnInput = z.infer<
  typeof experienceCandidateReturnInputSchema
>;
export type ExperienceCandidateResubmitInput = z.infer<
  typeof experienceCandidateResubmitInputSchema
>;
export type ExperienceReferenceInput = z.infer<
  typeof experienceReferenceInputSchema
>;
export type ExperienceReferenceWithdrawInput = z.infer<
  typeof experienceReferenceWithdrawInputSchema
>;
export type FormalExperienceRetractInput = z.infer<
  typeof formalExperienceRetractInputSchema
>;
export type EmployeeDashboard = z.infer<typeof employeeDashboardSchema>;
export type OwnerDataSource = z.infer<typeof ownerDataSourceSchema>;
export type BossDashboard = z.infer<typeof bossDashboardSchema>;
