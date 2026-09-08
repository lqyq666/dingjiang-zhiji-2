import { describe, expect, it } from "vitest";

import {
  materialVerificationRequestSchema,
  materialVerificationResultSchema,
} from "./public";

const request = {
  requestId: "50000000-0000-4000-8000-000000000001",
  expectedVersion: 0,
  reason: "PMC 人工核验材料来源与当前用途",
  correlationId: "60000000-0000-4000-8000-000000000001",
  payload: {
    materialId: "42",
    decision: "VERIFIED",
    verificationNote: "已对照原始记录，当前版本可作为后续证据创建输入。",
  },
} as const;

describe("material verification contract", () => {
  it("accepts a bounded human verification command and versioned result", () => {
    expect(materialVerificationRequestSchema.parse(request)).toEqual(request);
    expect(
      materialVerificationResultSchema.parse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        version: 1,
        replayed: false,
        data: {
          materialId: "42",
          projectId: "PRJ-1",
          workItemId: "SUB-1",
          verification: {
            status: "VERIFIED",
            version: 1,
            note: request.payload.verificationNote,
            verifiedBy: "human-pmc",
            verifiedAt: "2026-08-29T04:00:00.000Z",
          },
          locator: {
            sourceObjectId: "SRC-1",
            sourceVersionId: "SV-1",
            reference: "产能记录 · v1",
          },
          audit: {
            requestId: request.requestId,
            eventType: "MATERIAL_VERIFIED",
          },
        },
      }).data.verification.status,
    ).toBe("VERIFIED");
  });

  it.each(["actor", "tenantId", "role", "scope", "filePath", "url"])(
    "rejects caller supplied %s",
    (key) => {
      expect(() =>
        materialVerificationRequestSchema.parse({
          ...request,
          [key]: key === "url" ? "https://example.test" : "injected",
        }),
      ).toThrow();
    },
  );

  it("rejects secret-like text before it reaches a command adapter", () => {
    expect(() =>
      materialVerificationRequestSchema.parse({
        ...request,
        reason: "token=must-not-enter-audit",
      }),
    ).toThrow();
  });
});
