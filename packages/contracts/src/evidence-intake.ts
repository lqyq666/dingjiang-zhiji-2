import { z } from "zod";

import {
  governedCommandRequestSchema,
  governedCommandResultSchema,
} from "./governed-command";
import { sourceLocatorSchema } from "./vs01";

const idSchema = z.string().trim().min(1).max(160);
const boundedText = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);

export const evidenceTypeSchema = z.enum([
  "OBSERVATION",
  "METRIC",
  "DOCUMENTED_FACT",
]);

export const evidenceExactSpanSchema = z
  .object({
    kind: z.literal("TEXT_SPAN"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    exactText: boundedText(1, 4_000),
  })
  .strict()
  .refine((span) => span.end > span.start, {
    message: "exact span end must be greater than start",
    path: ["end"],
  });

export const evidenceProposalPayloadSchema = z
  .object({
    workItemId: idSchema,
    materialId: idSchema,
    claim: boundedText(3, 1_000),
    evidenceType: evidenceTypeSchema,
    sourceObjectId: idSchema,
    sourceVersionId: idSchema,
    exactSpan: evidenceExactSpanSchema,
    reasoning: boundedText(3, 4_000),
    limitations: boundedText(3, 1_000),
  })
  .strict();

const typedProposalRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: boundedText(3, 500),
    payload: evidenceProposalPayloadSchema,
    correlationId: z.string().uuid(),
  })
  .strict();

export const evidenceProposeRequestSchema = governedCommandRequestSchema.pipe(
  typedProposalRequestSchema,
);

export const evidenceProposalDataSchema = z
  .object({
    proposalId: idSchema,
    projectId: idSchema,
    workItemId: idSchema,
    materialId: idSchema,
    status: z.literal("PROPOSAL"),
    classification: z.literal("PROPOSAL"),
    claim: boundedText(3, 1_000),
    evidenceType: evidenceTypeSchema,
    locator: sourceLocatorSchema,
    exactSpan: evidenceExactSpanSchema,
    reasoning: boundedText(3, 4_000),
    limitations: boundedText(3, 1_000),
    proposedBy: idSchema,
    proposedAt: z.string().datetime(),
    audit: z
      .object({
        requestId: z.string().uuid(),
        eventType: z.literal("EVIDENCE_PROPOSED"),
      })
      .strict(),
  })
  .strict();

export const evidenceProposeResultSchema = governedCommandResultSchema.pipe(
  z
    .object({
      requestId: z.string().uuid(),
      correlationId: z.string().uuid(),
      version: z.number().int().positive(),
      replayed: z.boolean(),
      data: evidenceProposalDataSchema,
    })
    .strict(),
);

export const evidenceConfirmationPayloadSchema = z
  .object({
    proposalId: idSchema,
    decision: z.enum(["CONFIRMED", "REJECTED"]),
    reviewNote: boundedText(5, 1_000),
  })
  .strict();

const typedConfirmationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: boundedText(3, 500),
    payload: evidenceConfirmationPayloadSchema,
    correlationId: z.string().uuid(),
  })
  .strict();

export const evidenceConfirmationRequestSchema =
  governedCommandRequestSchema.pipe(typedConfirmationRequestSchema);

export const evidenceConfirmationDataSchema = z
  .object({
    proposalId: idSchema,
    evidenceId: idSchema.nullable(),
    projectId: idSchema,
    decision: z.enum(["CONFIRMED", "REJECTED"]),
    version: z.number().int().positive(),
    reviewedBy: idSchema,
    reviewedAt: z.string().datetime(),
    audit: z
      .object({
        requestId: z.string().uuid(),
        eventType: z.enum(["EVIDENCE_CONFIRMED", "EVIDENCE_REJECTED"]),
      })
      .strict(),
  })
  .strict();

export const evidenceConfirmationResultSchema =
  governedCommandResultSchema.pipe(
    z
      .object({
        requestId: z.string().uuid(),
        correlationId: z.string().uuid(),
        version: z.number().int().positive(),
        replayed: z.boolean(),
        data: evidenceConfirmationDataSchema,
      })
      .strict(),
  );

export const evidenceProposalReviewSchema = z
  .object({
    proposalId: idSchema,
    projectId: idSchema,
    workItemId: idSchema,
    materialId: idSchema,
    materialTitle: idSchema,
    claim: boundedText(3, 1_000),
    evidenceType: evidenceTypeSchema,
    locator: sourceLocatorSchema,
    exactSpan: evidenceExactSpanSchema,
    reasoning: boundedText(3, 4_000),
    limitations: boundedText(3, 1_000),
    proposedBy: idSchema,
    proposedAt: z.string().datetime(),
    review: z
      .object({
        decision: z.enum(["CONFIRMED", "REJECTED"]),
        version: z.literal(1),
        reviewedBy: idSchema,
        reviewedAt: z.string().datetime(),
        reviewNote: boundedText(5, 1_000),
        evidenceId: idSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const evidenceProposalReviewListSchema = z.array(
  evidenceProposalReviewSchema,
);

export type EvidenceProposalPayload = z.infer<
  typeof evidenceProposalPayloadSchema
>;
export type EvidenceConfirmationPayload = z.infer<
  typeof evidenceConfirmationPayloadSchema
>;
export type EvidenceConfirmationRequest = z.infer<
  typeof evidenceConfirmationRequestSchema
>;
export type EvidenceProposalReview = z.infer<
  typeof evidenceProposalReviewSchema
>;
