import { z } from "zod";

import {
  sourceLocatorSchema,
  taskMaterialExtractionStatusSchema,
} from "./vs01";
import { workpaperProposalContextSchema } from "./workpaper-proposal";

const idSchema = z.string().trim().min(1);
const revisionSchema = z.number().int().min(0);

export const validationWorkpaperStatusSchema = z.enum([
  "DRAFTING",
  "CONFIRMED",
]);

export const validationWorkpaperVersionKindSchema = z.enum([
  "AI_CANDIDATE",
  "PMC_PROPOSAL",
  "PMC_DRAFT",
  "PMC_CONFIRMED",
]);

export const validationConclusionResultSchema = z.enum([
  "SUPPORTS",
  "DOES_NOT_SUPPORT",
  "INSUFFICIENT_INFORMATION",
]);

export const validationFindingAssessmentSchema = z.enum([
  "SUPPORTS",
  "CONTRADICTS",
  "INCONCLUSIVE",
]);

export const validationFindingStatusSchema = z.enum([
  "UNVERIFIED_INPUT",
  "EMPLOYEE_CHECKED",
]);

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const validationWorkpaperContentSchema = z
  .object({
    problemStatement: boundedText(500),
    factFindings: z
      .array(
        z
          .object({
            evidenceId: idSchema,
            assertion: boundedText(500),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    materialFindings: z
      .array(
        z
          .object({
            materialId: idSchema,
            assertion: boundedText(1_000),
            assessment: validationFindingAssessmentSchema,
            verificationStatus: validationFindingStatusSchema,
            note: z.string().trim().max(500).default(""),
          })
          .strict(),
      )
      .max(20),
    hypotheses: z.array(boundedText(500)).min(1).max(20),
    conclusion: z
      .object({
        result: validationConclusionResultSchema,
        statement: boundedText(1_000),
        limitations: boundedText(500),
        nextChecks: z.array(boundedText(500)).max(20).default([]),
      })
      .strict(),
  })
  .strict();

export const validationWorkpaperVersionSchema = z
  .object({
    revision: z.number().int().min(1),
    kind: validationWorkpaperVersionKindSchema,
    classification: z.enum(["PROPOSAL", "EMPLOYEE_WORK", "CONFIRMED_OUTPUT"]),
    content: validationWorkpaperContentSchema,
    locator: sourceLocatorSchema,
    basedOnRevision: revisionSchema.nullable(),
    requestedBy: z.literal("PMC"),
    createdAt: z.string().datetime(),
    requestId: z.string().uuid().optional(),
    createdBy: idSchema.optional(),
    proposalContext: workpaperProposalContextSchema.optional(),
    audit: z
      .object({
        requestId: z.string().uuid(),
        eventType: z.literal("WORKPAPER_PROPOSED"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((version, context) => {
    if (
      version.kind === "PMC_PROPOSAL" &&
      (!version.proposalContext ||
        !version.createdBy ||
        !version.requestId ||
        !version.audit ||
        version.audit.requestId !== version.requestId)
    )
      context.addIssue({
        code: "custom",
        message: "PMC_PROPOSAL 必须保留 proposal context、创建者和可追溯 audit",
      });
  });

const evidenceContextSchema = z
  .object({
    evidenceId: idSchema,
    label: idSchema,
    value: idSchema,
    classification: z.literal("FACT"),
    locator: sourceLocatorSchema,
  })
  .strict();

const materialContextSchema = z
  .object({
    materialId: idSchema,
    requirementId: idSchema,
    title: idSchema,
    classification: z.literal("UNVERIFIED_INPUT"),
    extractionStatus: taskMaterialExtractionStatusSchema,
    readableByAi: z.boolean(),
    contentPreview: z.string().max(20_000).nullable(),
    locator: sourceLocatorSchema,
  })
  .strict();

export const validationWorkpaperViewSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    sourceTaskId: idSchema,
    workItem: z
      .object({
        id: idSchema,
        title: idSchema,
        status: z.enum(["LOCKED", "READY", "IN_PROGRESS", "DONE"]),
        acceptanceCriteria: z.array(idSchema).min(1),
      })
      .strict(),
    status: validationWorkpaperStatusSchema,
    revision: revisionSchema,
    current: validationWorkpaperVersionSchema.nullable(),
    latestConfirmed: validationWorkpaperVersionSchema.nullable(),
    history: z.array(validationWorkpaperVersionSchema),
    context: z
      .object({
        facts: z.array(evidenceContextSchema).min(1),
        materials: z.array(materialContextSchema),
        materialGaps: z.array(
          z.object({ requirementId: idSchema, requirement: idSchema }).strict(),
        ),
      })
      .strict(),
  })
  .strict();

const commandBaseSchema = z
  .object({
    actor: z.literal("PMC"),
    requestId: z.string().uuid(),
    expectedRevision: revisionSchema,
  })
  .strict();

export const validationCandidateRunInputSchema = commandBaseSchema.extend({
  materialIds: z
    .array(idSchema)
    .min(1)
    .max(20)
    .refine((items) => new Set(items).size === items.length, {
      message: "材料不能重复",
    }),
});

export const validationWorkpaperDraftInputSchema = commandBaseSchema.extend({
  content: validationWorkpaperContentSchema,
});

export const validationWorkpaperCompleteInputSchema = commandBaseSchema
  .extend({
    content: validationWorkpaperContentSchema,
    completionNote: boundedText(500),
    confirmedAcceptanceCriteria: z
      .array(boundedText(200))
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: "验收标准确认不能重复",
      }),
  })
  .superRefine((value, ctx) => {
    if (value.content.conclusion.result === "INSUFFICIENT_INFORMATION") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content", "conclusion", "result"],
        message: "信息不足时不能确认完成，应先补充材料",
      });
    }
  });

export const validationWorkpaperReopenInputSchema = commandBaseSchema.extend({
  reason: boundedText(500),
});

export type ValidationWorkpaperContent = z.infer<
  typeof validationWorkpaperContentSchema
>;
export type ValidationWorkpaperVersion = z.infer<
  typeof validationWorkpaperVersionSchema
>;
export type ValidationWorkpaperView = z.infer<
  typeof validationWorkpaperViewSchema
>;
export type ValidationCandidateRunInput = z.infer<
  typeof validationCandidateRunInputSchema
>;
export type ValidationWorkpaperDraftInput = z.infer<
  typeof validationWorkpaperDraftInputSchema
>;
export type ValidationWorkpaperCompleteInput = z.infer<
  typeof validationWorkpaperCompleteInputSchema
>;
export type ValidationWorkpaperReopenInput = z.infer<
  typeof validationWorkpaperReopenInputSchema
>;
