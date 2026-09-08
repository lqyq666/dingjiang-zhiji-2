import { z } from "zod";

import {
  governedCommandRequestSchema,
  governedCommandResultSchema,
} from "./governed-command";
import { sourceLocatorSchema } from "./vs01";

const idSchema = z.string().trim().min(1).max(160);
const boundedText = (maximum: number) => z.string().trim().min(3).max(maximum);
const uniqueBy = <T>(values: T[], select: (value: T) => string): boolean =>
  new Set(values.map(select)).size === values.length;

export const workpaperProposalPayloadSchema = z
  .object({
    proposalType: z.enum(["ROOT_CAUSE_VALIDATION", "ANALYSIS"]),
    summary: boundedText(500),
    reasoning: boundedText(4_000),
    evidenceFindings: z
      .array(
        z
          .object({
            evidenceId: idSchema,
            assertion: boundedText(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine((items) => uniqueBy(items, (item) => item.evidenceId), {
        message: "Evidence 引用不能重复",
      }),
    materialFindings: z
      .array(
        z
          .object({
            materialId: idSchema,
            assertion: boundedText(1_000),
            assessment: z.enum(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]),
            note: z.string().trim().max(500).default(""),
          })
          .strict(),
      )
      .max(20)
      .refine((items) => uniqueBy(items, (item) => item.materialId), {
        message: "Material 引用不能重复",
      }),
    experienceReferences: z
      .array(
        z
          .object({
            experienceId: idSchema,
            applicationNote: boundedText(500),
          })
          .strict(),
      )
      .max(10)
      .refine((items) => uniqueBy(items, (item) => item.experienceId), {
        message: "FormalExperience 引用不能重复",
      }),
    assumptions: z.array(boundedText(500)).min(1).max(20),
    missingInformation: z.array(boundedText(500)).max(20),
    limitations: boundedText(1_000),
  })
  .strict();

const typedRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: boundedText(500),
    payload: workpaperProposalPayloadSchema,
    correlationId: z.string().uuid(),
  })
  .strict();

export const workpaperProposeRequestSchema =
  governedCommandRequestSchema.pipe(typedRequestSchema);

export const workpaperProposalDataSchema = z
  .object({
    workpaperId: idSchema,
    projectId: idSchema,
    workItemId: idSchema,
    status: z.literal("PROPOSAL"),
    classification: z.literal("PROPOSAL"),
    version: z.number().int().positive(),
    locator: sourceLocatorSchema,
    createdBy: idSchema,
    createdAt: z.string().datetime(),
    audit: z
      .object({
        requestId: z.string().uuid(),
        eventType: z.literal("WORKPAPER_PROPOSED"),
      })
      .strict(),
  })
  .strict();

export const workpaperProposalContextSchema = z
  .object({
    proposalType: workpaperProposalPayloadSchema.shape.proposalType,
    summary: workpaperProposalPayloadSchema.shape.summary,
    reasoning: workpaperProposalPayloadSchema.shape.reasoning,
    evidenceReferences: z
      .array(
        z
          .object({ evidenceId: idSchema, locator: sourceLocatorSchema })
          .strict(),
      )
      .min(1)
      .max(20),
    materialReferences: z
      .array(
        z
          .object({ materialId: idSchema, locator: sourceLocatorSchema })
          .strict(),
      )
      .max(20),
    experienceReferences: z
      .array(
        z
          .object({
            experienceId: idSchema,
            applicationNote: boundedText(500),
            limitations: boundedText(1_000),
            locator: sourceLocatorSchema,
            evidenceLocator: sourceLocatorSchema,
          })
          .strict(),
      )
      .max(10),
    assumptions: workpaperProposalPayloadSchema.shape.assumptions,
    missingInformation: workpaperProposalPayloadSchema.shape.missingInformation,
    limitations: workpaperProposalPayloadSchema.shape.limitations,
    currentEvidenceTakesPriority: z.literal(true),
  })
  .strict();

export const workpaperProposeResultSchema = governedCommandResultSchema.pipe(
  z
    .object({
      requestId: z.string().uuid(),
      correlationId: z.string().uuid(),
      version: z.number().int().positive(),
      replayed: z.boolean(),
      data: workpaperProposalDataSchema,
    })
    .strict(),
);

export type WorkpaperProposalPayload = z.infer<
  typeof workpaperProposalPayloadSchema
>;
export type WorkpaperProposeRequest = z.infer<
  typeof workpaperProposeRequestSchema
>;
export type WorkpaperProposalData = z.infer<typeof workpaperProposalDataSchema>;
export type WorkpaperProposalContext = z.infer<
  typeof workpaperProposalContextSchema
>;
