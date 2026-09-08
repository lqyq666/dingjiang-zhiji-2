import { z } from "zod";

const idSchema = z.string().trim().min(1);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const timestampSchema = z.string().datetime();

export const experienceDraftSchema = z
  .object({
    title: boundedText(120),
    applicableSituation: boundedText(500),
    businessProblem: boundedText(500),
    practice: boundedText(1_000),
    resultSummary: boundedText(500),
    limitations: boundedText(500),
  })
  .strict();

export const structuredExperienceCardSchema = z
  .object({
    trigger: boundedText(500),
    conditions: z.array(boundedText(500)).max(20),
    actions: z
      .array(
        z
          .object({
            order: z.number().int().min(1),
            action: boundedText(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine(
        (actions) =>
          new Set(actions.map((action) => action.order)).size ===
          actions.length,
        {
          message: "推荐动作顺序不能重复",
        },
      ),
    rationale: boundedText(1_000),
    exceptions: z.array(boundedText(500)).max(20),
    scope: z
      .object({
        products: z.array(boundedText(200)).max(20),
        departments: z.array(boundedText(200)).max(20),
        scenarios: z.array(boundedText(500)).max(20),
      })
      .strict(),
    claims: z
      .array(
        z
          .object({
            statement: boundedText(1_000),
            evidenceIds: z.array(idSchema).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    evidenceRefs: z
      .array(
        z
          .object({
            sourceObjectId: idSchema,
            sourceVersionId: idSchema,
            reference: boundedText(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    missingInformation: z.array(boundedText(500)).max(20),
  })
  .strict();

export const experienceAiPurposeSchema = z.enum([
  "EXTRACT",
  "PUBLISH",
  "ANSWER",
]);
export const experienceAiProviderSchema = z.enum(["COZE", "DEMO_RULES"]);
export const experienceAiRunStatusSchema = z.enum([
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);
export const experienceIndexStatusSchema = z.enum([
  "INDEX_PENDING",
  "INDEXED",
  "INDEX_FAILED",
]);

export const experienceExtractionResultSchema = experienceDraftSchema
  .extend({
    structuredCard: structuredExperienceCardSchema,
    reviewFocus: z.array(boundedText(500)).max(20),
    classification: z.literal("PROPOSAL"),
  })
  .strict();

export const experienceAnswerMatchSchema = z
  .object({
    experienceId: idSchema,
    applicability: z.enum([
      "MATCH",
      "PARTIAL_MATCH",
      "NOT_APPLICABLE",
      "UNKNOWN",
    ]),
    reason: boundedText(1_000),
    citations: z
      .array(
        z
          .object({
            sourceObjectId: idSchema,
            sourceVersionId: idSchema,
            reference: boundedText(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const experienceAnswerResultSchema = z
  .object({
    answer: boundedText(4_000),
    matches: z.array(experienceAnswerMatchSchema).max(20),
    missingInformation: z.array(boundedText(500)).max(20),
    shouldClarify: z.boolean(),
    classification: z.literal("PROPOSAL"),
  })
  .strict();

export const experienceAiInputRefSchema = z
  .object({
    kind: z.enum([
      "PROJECT",
      "CANDIDATE",
      "FORMAL_EXPERIENCE",
      "SOURCE_VERSION",
      "EVIDENCE",
    ]),
    id: idSchema,
  })
  .strict();

export const experienceAiRunErrorSchema = z
  .object({
    code: z.enum([
      "INVALID_PROVIDER_OUTPUT",
      "PROVIDER_TIMEOUT",
      "PROVIDER_FAILED",
      "INDEX_FAILED",
    ]),
    message: boundedText(1_000),
  })
  .strict();

export const experienceAiRunSchema = z
  .object({
    id: idSchema,
    purpose: experienceAiPurposeSchema,
    provider: experienceAiProviderSchema,
    status: experienceAiRunStatusSchema,
    workflowId: idSchema.nullable(),
    inputFingerprint: idSchema,
    inputRefs: z.array(experienceAiInputRefSchema).max(100),
    structuredOutput: z
      .union([experienceExtractionResultSchema, experienceAnswerResultSchema])
      .nullable(),
    executeId: idSchema.nullable(),
    debugUrl: z.string().url().nullable(),
    usage: z
      .object({
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    error: experienceAiRunErrorSchema.nullable(),
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === "RUNNING" &&
      (value.completedAt !== null || value.error !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "运行中的 AI Run 不能包含完成时间或错误",
      });
    }
    if (
      value.status === "SUCCEEDED" &&
      (value.completedAt === null || value.error !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "成功的 AI Run 必须完成且没有错误",
      });
    }
    if (
      value.status === "FAILED" &&
      (value.completedAt === null ||
        value.error === null ||
        value.structuredOutput !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "失败的 AI Run 必须保留完成时间和错误，且不能包含输出",
      });
    }
  });

export const experienceAiDraftResponseSchema = z
  .object({
    run: experienceAiRunSchema,
    draft: experienceExtractionResultSchema,
  })
  .strict();

export const experienceAnswerResponseSchema = z
  .object({ run: experienceAiRunSchema, result: experienceAnswerResultSchema })
  .strict();

export const experiencePublishReceiptSchema = z
  .object({
    experienceId: idSchema,
    experienceVersionId: idSchema,
    indexStatus: experienceIndexStatusSchema,
    run: experienceAiRunSchema,
  })
  .strict();

export const feishuProviderModeSchema = z.enum(["FEISHU", "DEMO_RULES"]);
export const feishuReviewResultSchema = z.enum([
  "PENDING_REVIEW",
  "APPROVED",
  "RETURNED",
]);

export const feishuPushReceiptSchema = z
  .object({
    provider: feishuProviderModeSchema,
    candidateId: idSchema,
    candidateVersionId: idSchema,
    recordId: idSchema,
    pushedAt: timestampSchema,
  })
  .strict();

export const feishuReviewDecisionSchema = z
  .object({
    result: feishuReviewResultSchema,
    comment: z.string().trim().max(1_000),
    reviewer: boundedText(200),
  })
  .strict();

export const feishuReviewPullItemSchema = z
  .object({
    provider: feishuProviderModeSchema,
    candidateId: idSchema,
    candidateVersionId: idSchema,
    decision: feishuReviewDecisionSchema,
    pulledAt: timestampSchema,
  })
  .strict();

export const feishuPullReceiptSchema = z
  .object({
    items: z.array(feishuReviewPullItemSchema).max(100),
    summary: z
      .object({
        applied: z.number().int().min(0),
        skipped: z.number().int().min(0),
        failed: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

const commandBaseSchema = z.object({ requestId: z.string().uuid() }).strict();

export const experienceAiDraftInputSchema = commandBaseSchema.extend({
  actor: z.literal("PMC"),
});

export const experienceCandidateStructuredInputSchema = experienceDraftSchema
  .extend({
    actor: z.literal("PMC"),
    structuredCard: structuredExperienceCardSchema,
  })
  .strict();

export const experienceCandidateStructuredResubmitInputSchema =
  experienceCandidateStructuredInputSchema
    .extend({ expectedCandidateVersionId: idSchema })
    .strict();

export const feishuPushInputSchema = commandBaseSchema.extend({
  actor: z.literal("EXPERT_REVIEWER"),
  expectedCandidateVersionId: idSchema,
});

export const feishuPullInputSchema = commandBaseSchema.extend({
  actor: z.literal("EXPERT_REVIEWER"),
});

export const formalExperiencePublishInputSchema = commandBaseSchema.extend({
  actor: z.literal("EXPERT_REVIEWER"),
  expectedExperienceVersionId: idSchema,
});

export const experienceAnswerInputSchema = commandBaseSchema.extend({
  actor: z.literal("PMC"),
  question: boundedText(2_000),
  projectId: idSchema.optional(),
});

export const vs17ErrorCodeSchema = z.enum([
  "FORBIDDEN",
  "SCOPE_VIOLATION",
  "NOT_FOUND",
  "INVALID_PROVIDER_OUTPUT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_FAILED",
  "STALE_CANDIDATE",
  "INVALID_REVIEW",
  "FORMAL_EXPERIENCE_REQUIRED",
  "INDEX_FAILED",
]);

export type ExperienceDraft = z.infer<typeof experienceDraftSchema>;
export type StructuredExperienceCard = z.infer<
  typeof structuredExperienceCardSchema
>;
export type ExperienceAiPurpose = z.infer<typeof experienceAiPurposeSchema>;
export type ExperienceAiProvider = z.infer<typeof experienceAiProviderSchema>;
export type ExperienceAiRunStatus = z.infer<typeof experienceAiRunStatusSchema>;
export type ExperienceIndexStatus = z.infer<typeof experienceIndexStatusSchema>;
export type ExperienceExtractionResult = z.infer<
  typeof experienceExtractionResultSchema
>;
export type ExperienceAnswerMatch = z.infer<typeof experienceAnswerMatchSchema>;
export type ExperienceAnswerResult = z.infer<
  typeof experienceAnswerResultSchema
>;
export type ExperienceAiRun = z.infer<typeof experienceAiRunSchema>;
export type ExperienceAiDraftResponse = z.infer<
  typeof experienceAiDraftResponseSchema
>;
export type ExperienceAnswerResponse = z.infer<
  typeof experienceAnswerResponseSchema
>;
export type ExperiencePublishReceipt = z.infer<
  typeof experiencePublishReceiptSchema
>;
export type FeishuProviderMode = z.infer<typeof feishuProviderModeSchema>;
export type FeishuPushReceipt = z.infer<typeof feishuPushReceiptSchema>;
export type FeishuReviewDecision = z.infer<typeof feishuReviewDecisionSchema>;
export type FeishuReviewPullItem = z.infer<typeof feishuReviewPullItemSchema>;
export type FeishuPullReceipt = z.infer<typeof feishuPullReceiptSchema>;
export type ExperienceAiDraftInput = z.infer<
  typeof experienceAiDraftInputSchema
>;
export type ExperienceCandidateStructuredInput = z.infer<
  typeof experienceCandidateStructuredInputSchema
>;
export type ExperienceCandidateStructuredResubmitInput = z.infer<
  typeof experienceCandidateStructuredResubmitInputSchema
>;
export type FeishuPushInput = z.infer<typeof feishuPushInputSchema>;
export type FeishuPullInput = z.infer<typeof feishuPullInputSchema>;
export type FormalExperiencePublishInput = z.infer<
  typeof formalExperiencePublishInputSchema
>;
export type ExperienceAnswerInput = z.infer<typeof experienceAnswerInputSchema>;
export type Vs17ErrorCode = z.infer<typeof vs17ErrorCodeSchema>;
