import { describe, expect, it } from "vitest";

import {
  experienceAiDraftResponseSchema,
  experienceAiRunSchema,
  experienceExtractionResultSchema,
  feishuPullReceiptSchema,
  structuredExperienceCardSchema,
} from "./vs17";

const card = {
  trigger: "延期",
  conditions: ["订单积压"],
  actions: [{ order: 1, action: "核对瓶颈" }],
  rationale: "先定位约束",
  exceptions: [],
  scope: { products: [], departments: [], scenarios: ["高峰"] },
  claims: [{ statement: "存在瓶颈", evidenceIds: ["E-1"] }],
  evidenceRefs: [
    { sourceObjectId: "SO-1", sourceVersionId: "SV-1", reference: "日报" },
  ],
  missingInformation: [],
};
const draft = {
  title: "经验",
  applicableSituation: "高峰",
  businessProblem: "延期",
  practice: "核对",
  resultSummary: "改善",
  limitations: "需复核",
  structuredCard: card,
  reviewFocus: [],
  classification: "PROPOSAL",
};

describe("VS17 frozen contracts", () => {
  it("rejects unknown fields and requires claim evidence", () => {
    expect(() =>
      experienceExtractionResultSchema.parse({ ...draft, unexpected: true }),
    ).toThrow();
    expect(() =>
      structuredExperienceCardSchema.parse({
        ...card,
        claims: [{ statement: "无依据", evidenceIds: [] }],
      }),
    ).toThrow();
  });

  it("requires unique action order and preserves the PROPOSAL boundary", () => {
    expect(() =>
      structuredExperienceCardSchema.parse({
        ...card,
        actions: [
          { order: 1, action: "一" },
          { order: 1, action: "二" },
        ],
      }),
    ).toThrow();
    expect(() =>
      experienceExtractionResultSchema.parse({
        ...draft,
        classification: "FACT",
      }),
    ).toThrow();
  });

  it("accepts only consistent terminal AI run state", () => {
    const running = {
      id: "run-1",
      purpose: "EXTRACT",
      provider: "DEMO_RULES",
      status: "RUNNING",
      workflowId: "demo",
      inputFingerprint: "fp",
      inputRefs: [],
      structuredOutput: null,
      executeId: null,
      debugUrl: null,
      usage: null,
      error: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
    };
    expect(experienceAiRunSchema.parse(running)).toMatchObject({
      status: "RUNNING",
    });
    expect(() =>
      experienceAiRunSchema.parse({
        ...running,
        completedAt: "2026-08-26T00:01:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      experienceAiRunSchema.parse({
        ...running,
        status: "SUCCEEDED",
        structuredOutput: draft,
        completedAt: null,
      }),
    ).toThrow();
  });

  it("strictly validates response wrappers and Feishu batch receipts", () => {
    expect(() =>
      experienceAiDraftResponseSchema.parse({
        run: {},
        draft,
        leaked: "token",
      }),
    ).toThrow();
    expect(() =>
      feishuPullReceiptSchema.parse({
        items: [],
        summary: { applied: 0, skipped: 0, failed: 0 },
        extra: true,
      }),
    ).toThrow();
  });
});
