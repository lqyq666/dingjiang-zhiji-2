import { describe, expect, it } from "vitest";

import {
  materialCreateRequestSchema,
  materialCreateResultSchema,
} from "./material-create";

const request = {
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: 0,
  reason: "补齐 BOM 差异材料缺口",
  correlationId: "22222222-2222-4222-8222-222222222222",
  payload: {
    workItemId: "SUB-SOLUTION-001",
    situationCode: "BOM_DELAY",
    requirementId: "REQ-BOM-CHANGE",
    materialType: "CONTROLLED_TEXT",
    displayName: "BOM 差异说明",
    sourceMetadata: {
      sourceType: "HUMAN_PROVIDED",
      sourceName: "PMC 核验记录",
      sourceReference: "BOM-CHECK-20260829",
    },
    safeSummary: "待核验的 BOM 差异摘要",
    controlledTextContent: "BOM 变更项仍需由负责人逐项核验。",
  },
};

describe("material.create contract", () => {
  it("accepts the bounded controlled-text command and result", () => {
    expect(materialCreateRequestSchema.parse(request)).toEqual(request);
    expect(
      materialCreateResultSchema.parse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        version: 1,
        replayed: false,
        data: {
          materialId: "42",
          projectId: "PRJ-OTD-001",
          workItemId: request.payload.workItemId,
          requirementId: request.payload.requirementId,
          status: "ACTIVE",
          verificationStatus: "UNVERIFIED",
          version: 1,
          locator: {
            sourceObjectId: "SRC-MATERIAL-42",
            sourceVersionId: "SRC-MATERIAL-42-V1",
            reference: `${request.payload.displayName} · v1`,
          },
          createdBy: "workbuddy-pmc",
          createdAt: "2026-08-29T00:00:00.000Z",
          audit: {
            requestId: request.requestId,
            eventType: "MATERIAL_CREATED",
          },
        },
      }),
    ).toBeTruthy();
  });

  it.each([
    "tenantId",
    "role",
    "scopes",
    "filePath",
    "url",
    "storageKey",
    "sql",
    "shell",
  ])("rejects privilege or unsafe field %s", (field) => {
    const payload = { ...request.payload, [field]: "forbidden" };
    expect(
      materialCreateRequestSchema.safeParse({ ...request, payload }).success,
    ).toBe(false);
  });

  it("requires controlled text only for controlled-text registration", () => {
    const payload = { ...request.payload };
    delete (payload as Partial<typeof payload>).controlledTextContent;
    expect(
      materialCreateRequestSchema.safeParse({ ...request, payload }).success,
    ).toBe(false);
  });

  it("rejects secret-like content", () => {
    expect(
      materialCreateRequestSchema.safeParse({
        ...request,
        payload: {
          ...request.payload,
          sourceMetadata: {
            ...request.payload.sourceMetadata,
            token: "must-not-enter-history",
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    "https://example.test/material",
    "C:\\private\\material.txt",
    "\\\\server\\share",
  ])("rejects URL or path-like source reference %s", (sourceReference) => {
    expect(
      materialCreateRequestSchema.safeParse({
        ...request,
        payload: {
          ...request.payload,
          sourceMetadata: {
            ...request.payload.sourceMetadata,
            sourceReference,
          },
        },
      }).success,
    ).toBe(false);
  });
});
