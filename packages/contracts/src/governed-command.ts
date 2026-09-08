import { z } from "zod";

import { roleSchema } from "./vs01";

const idSchema = z.string().trim().min(1).max(160);
const forbiddenPayloadKey =
  /^(tenantId|subjectId|role|scopes|projectIds|sql|shell|url|filePath|path|storageKey|bytes|rawBytes)$/i;
const secretPayloadKey =
  /(token|secret|password|authorization|credential|api[-_]?key)/i;
const secretLikeText =
  /\bBearer\s+\S+|(?:token|secret|password|api[-_]?key)\s*[:=]/i;

const inspectPayload = (
  value: unknown,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void => {
  if (typeof value === "string") {
    if (secretLikeText.test(value))
      context.addIssue({
        code: "custom",
        path,
        message: "payload contains secret-like text",
      });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectPayload(item, [...path, index], context),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPayloadKey.test(key) || secretPayloadKey.test(key))
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "payload contains a forbidden control or secret field",
      });
    inspectPayload(child, [...path, key], context);
  }
};

const inspectSecrets = (
  value: unknown,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectSecrets(item, [...path, index], context),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (secretPayloadKey.test(key))
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "result contains a forbidden secret field",
      });
    inspectSecrets(child, [...path, key], context);
  }
};

export const governedCommandRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .refine(
        (value) => !secretLikeText.test(value),
        "reason may not contain a secret",
      ),
    payload: z.record(z.string(), z.unknown()),
    correlationId: z.string().uuid(),
  })
  .strict()
  .superRefine((request, context) =>
    inspectPayload(request.payload, ["payload"], context),
  );

export const governedPrincipalSchema = z
  .object({
    tenantId: idSchema,
    subjectId: idSchema,
    credentialId: z.string().uuid().optional(),
    role: roleSchema,
    scopes: z.array(idSchema).min(1),
    projectIds: z.array(idSchema).min(1),
  })
  .strict();

export const governedCommandEnvelopeSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
    request: governedCommandRequestSchema,
    principal: governedPrincipalSchema,
    target: z.object({ tenantId: idSchema, projectId: idSchema }).strict(),
  })
  .strict();

export const governedCommandErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "INVALID_REQUEST",
  "STALE_VERSION",
  "CONFLICT",
  "INTERNAL_ERROR",
]);

export const governedCommandErrorSchema = z
  .object({
    code: governedCommandErrorCodeSchema,
    message: idSchema,
    retryable: z.boolean(),
    correlationId: z.string().uuid(),
  })
  .strict();

export const governedCommandResultSchema = z
  .object({
    requestId: z.string().uuid(),
    correlationId: z.string().uuid(),
    version: z.number().int().positive(),
    replayed: z.boolean(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((result, context) =>
    inspectSecrets(result.data, ["data"], context),
  );

export type GovernedCommandRequest = z.infer<
  typeof governedCommandRequestSchema
>;
export type GovernedPrincipal = z.infer<typeof governedPrincipalSchema>;
export type GovernedCommandEnvelope = z.infer<
  typeof governedCommandEnvelopeSchema
>;
export type GovernedCommandErrorCode = z.infer<
  typeof governedCommandErrorCodeSchema
>;
export type GovernedCommandResult = z.infer<typeof governedCommandResultSchema>;
