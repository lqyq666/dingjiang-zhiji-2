import { describe, expect, it } from "vitest";

import {
  workpaperProposalContextSchema,
  workpaperProposeRequestSchema,
  workpaperProposeResultSchema,
} from "./workpaper-proposal";

const payload = {
  proposalType: "ROOT_CAUSE_VALIDATION",
  summary: "订单延期可能与产能负荷有关",
  reasoning: "当前订单 Evidence 显示延期，产能材料仍需人工核验。",
  evidenceFindings: [
    { evidenceId: "E-ORDER-202608136", assertion: "预测交期晚于承诺交期" },
  ],
  materialFindings: [
    {
      materialId: "1",
      assertion: "材料提示负荷风险",
      assessment: "INCONCLUSIVE",
      note: "需要核对统计口径",
    },
  ],
  experienceReferences: [
    { experienceId: "EXP-1", applicationNote: "仅作为排查步骤参考" },
  ],
  assumptions: ["订单与产能材料使用相同统计周期"],
  missingInformation: ["缺少班次级工时明细"],
  limitations: "历史经验不能覆盖当前 Evidence。",
};

const request = {
  requestId: "10000000-0000-4000-8000-000000000011",
  expectedVersion: 0,
  reason: "保留本轮根因分析成果",
  payload,
  correlationId: "20000000-0000-4000-8000-000000000011",
};

describe("workpaper.propose contract", () => {
  it("accepts the minimum traceable proposal without caller identity or locators", () => {
    expect(workpaperProposeRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a proposal without current Evidence", () => {
    expect(() =>
      workpaperProposeRequestSchema.parse({
        ...request,
        payload: { ...payload, evidenceFindings: [] },
      }),
    ).toThrow();
  });

  it("rejects secret-like text before it can enter Workpaper or Audit", () => {
    expect(() =>
      workpaperProposeRequestSchema.parse({
        ...request,
        payload: { ...payload, reasoning: "Bearer must-not-be-persisted" },
      }),
    ).toThrow();
  });

  it("accepts Evidence-only analysis when the project has no traceable Material", () => {
    const evidenceOnly = {
      ...request,
      payload: { ...payload, materialFindings: [] },
    };
    expect(workpaperProposeRequestSchema.parse(evidenceOnly)).toEqual(
      evidenceOnly,
    );
  });

  it.each([
    ["tenantId", "tenant-other"],
    ["actor", "OWNER"],
    ["role", "OWNER"],
    ["scopes", ["*"]],
    ["projectIds", ["*"]],
    ["locator", { sourceVersionId: "SV-OTHER" }],
    ["sql", "select 1"],
    ["shell", "whoami"],
    ["url", "https://example.test"],
    ["filePath", "C:\\secret.txt"],
    ["apiKey", "must-not-enter-contract"],
  ])("rejects privilege or capability injection through %s", (key, value) => {
    expect(() =>
      workpaperProposeRequestSchema.parse({
        ...request,
        payload: { ...payload, [key]: value },
      }),
    ).toThrow();
  });

  it("requires resolved experience references to retain locators and limitations", () => {
    const context = {
      proposalType: "ANALYSIS",
      summary: payload.summary,
      reasoning: payload.reasoning,
      evidenceReferences: [
        {
          evidenceId: "E-1",
          locator: {
            sourceObjectId: "SO-E-1",
            sourceVersionId: "SV-E-1",
            reference: "当前 Evidence",
          },
        },
      ],
      materialReferences: [
        {
          materialId: "1",
          locator: {
            sourceObjectId: "SO-M-1",
            sourceVersionId: "SV-M-1",
            reference: "当前 Material",
          },
        },
      ],
      experienceReferences: [
        {
          experienceId: "EXP-1",
          applicationNote: "仅作为排查步骤参考",
          limitations: "不覆盖当前订单的产能事实",
          locator: {
            sourceObjectId: "SO-X-1",
            sourceVersionId: "SV-X-1",
            reference: "正式经验",
          },
          evidenceLocator: {
            sourceObjectId: "SO-XE-1",
            sourceVersionId: "SV-XE-1",
            reference: "历史结果证据",
          },
        },
      ],
      assumptions: payload.assumptions,
      missingInformation: payload.missingInformation,
      limitations: payload.limitations,
      currentEvidenceTakesPriority: true as const,
    };
    expect(workpaperProposalContextSchema.parse(context)).toEqual(context);
    expect(() =>
      workpaperProposalContextSchema.parse({
        ...context,
        experienceReferences: [
          { ...context.experienceReferences[0], limitations: undefined },
        ],
      }),
    ).toThrow();
  });

  it("returns only a versioned PROPOSAL with a traceable audit", () => {
    expect(
      workpaperProposeResultSchema.parse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        version: 1,
        replayed: false,
        data: {
          workpaperId: "WP-PRJ-OTD-001",
          projectId: "PRJ-OTD-001",
          workItemId: "SUBTASK-1",
          status: "PROPOSAL",
          classification: "PROPOSAL",
          version: 1,
          locator: {
            sourceObjectId: "SRC-WORKPAPER-PRJ-OTD-001",
            sourceVersionId: "SRC-WORKPAPER-VERSION-1",
            reference: "根因核验工作底稿 v1",
          },
          createdBy: "pmc-1",
          createdAt: "2026-08-28T13:00:00.000Z",
          audit: {
            requestId: request.requestId,
            eventType: "WORKPAPER_PROPOSED",
          },
        },
      }).data.status,
    ).toBe("PROPOSAL");
  });
});
