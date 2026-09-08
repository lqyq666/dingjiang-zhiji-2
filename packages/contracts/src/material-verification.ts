import { z } from "zod";

import {
  governedCommandRequestSchema,
  governedCommandResultSchema,
} from "./governed-command";
import {
  sourceLocatorSchema,
  taskMaterialVerificationSchema,
  taskMaterialVerificationStatusSchema,
} from "./vs01";

const idSchema = z.string().trim().min(1).max(160);
const boundedText = (maximum: number) => z.string().trim().min(5).max(maximum);

export const materialVerificationStatusSchema =
  taskMaterialVerificationStatusSchema;

export const materialVerificationPayloadSchema = z
  .object({
    materialId: idSchema,
    decision: materialVerificationStatusSchema.exclude(["UNVERIFIED"]),
    verificationNote: boundedText(1_000),
  })
  .strict();

const typedRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: boundedText(500),
    payload: materialVerificationPayloadSchema,
    correlationId: z.string().uuid(),
  })
  .strict();

export const materialVerificationRequestSchema =
  governedCommandRequestSchema.pipe(typedRequestSchema);

export const materialVerificationViewSchema = taskMaterialVerificationSchema;

export const materialVerificationDataSchema = z
  .object({
    materialId: idSchema,
    projectId: idSchema,
    workItemId: idSchema,
    verification: materialVerificationViewSchema,
    locator: sourceLocatorSchema,
    audit: z
      .object({
        requestId: z.string().uuid(),
        eventType: z.enum(["MATERIAL_VERIFIED", "MATERIAL_REVISION_REQUESTED"]),
      })
      .strict(),
  })
  .strict();

export const materialVerificationResultSchema =
  governedCommandResultSchema.pipe(
    z
      .object({
        requestId: z.string().uuid(),
        correlationId: z.string().uuid(),
        version: z.number().int().positive(),
        replayed: z.boolean(),
        data: materialVerificationDataSchema,
      })
      .strict(),
  );

export type MaterialVerificationPayload = z.infer<
  typeof materialVerificationPayloadSchema
>;
export type MaterialVerificationRequest = z.infer<
  typeof materialVerificationRequestSchema
>;
export type MaterialVerificationView = z.infer<
  typeof materialVerificationViewSchema
>;
