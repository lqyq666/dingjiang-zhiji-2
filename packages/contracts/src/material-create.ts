import { z } from "zod";

import {
  governedCommandRequestSchema,
  governedCommandResultSchema,
} from "./governed-command";
import { sourceLocatorSchema } from "./vs01";

const idSchema = z.string().trim().min(1).max(160);
const boundedText = (maximum: number) => z.string().trim().min(3).max(maximum);
const safeReference = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
      !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value),
    "来源引用不得是 URL 或本地路径",
  );

export const materialCreatePayloadSchema = z
  .object({
    workItemId: idSchema,
    situationCode: z.enum(["BOM_DELAY", "PURCHASE_DELAY", "CAPACITY_RISK"]),
    requirementId: idSchema,
    materialType: z.enum(["MANUAL_REFERENCE", "CONTROLLED_TEXT"]),
    displayName: boundedText(200),
    sourceMetadata: z
      .object({
        sourceType: z.enum([
          "INTERNAL_RECORD",
          "EXTERNAL_DOCUMENT",
          "HUMAN_PROVIDED",
        ]),
        sourceName: boundedText(200),
        sourceReference: safeReference.optional(),
      })
      .strict(),
    safeSummary: boundedText(1_000),
    controlledTextContent: z.string().trim().min(3).max(20_000).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.materialType === "CONTROLLED_TEXT" &&
      !payload.controlledTextContent
    )
      context.addIssue({
        code: "custom",
        path: ["controlledTextContent"],
        message: "受控文本材料必须提供内容",
      });
    if (
      payload.materialType === "MANUAL_REFERENCE" &&
      payload.controlledTextContent
    )
      context.addIssue({
        code: "custom",
        path: ["controlledTextContent"],
        message: "人工来源登记不得夹带正文",
      });
  });

const typedRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: boundedText(500),
    payload: materialCreatePayloadSchema,
    correlationId: z.string().uuid(),
  })
  .strict();

export const materialCreateRequestSchema =
  governedCommandRequestSchema.pipe(typedRequestSchema);

export const materialCreateDataSchema = z
  .object({
    materialId: idSchema,
    projectId: idSchema,
    workItemId: idSchema,
    requirementId: idSchema,
    status: z.literal("ACTIVE"),
    verificationStatus: z.literal("UNVERIFIED"),
    version: z.number().int().positive(),
    locator: sourceLocatorSchema,
    createdBy: idSchema,
    createdAt: z.string().datetime(),
    audit: z
      .object({
        requestId: z.string().uuid(),
        eventType: z.literal("MATERIAL_CREATED"),
      })
      .strict(),
  })
  .strict();

export const materialCreateResultSchema = governedCommandResultSchema.pipe(
  z
    .object({
      requestId: z.string().uuid(),
      correlationId: z.string().uuid(),
      version: z.number().int().positive(),
      replayed: z.boolean(),
      data: materialCreateDataSchema,
    })
    .strict(),
);

export type MaterialCreatePayload = z.infer<typeof materialCreatePayloadSchema>;
export type MaterialCreateRequest = z.infer<typeof materialCreateRequestSchema>;
export type MaterialCreateData = z.infer<typeof materialCreateDataSchema>;
