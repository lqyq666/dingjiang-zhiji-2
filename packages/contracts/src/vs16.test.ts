import { describe, expect, it } from "vitest";

import {
  validationCandidateRunInputSchema,
  validationWorkpaperCompleteInputSchema,
  validationWorkpaperContentSchema,
} from "./vs16";

const content = {
  problemStatement: "核验产能负荷是否构成订单延期的主要原因",
  factFindings: [{ evidenceId: "E-ORDER-136", assertion: "订单预计延期 3 天" }],
  materialFindings: [
    {
      materialId: "MAT-CAPACITY-136",
      assertion: "关键产线 8 月 12 至 15 日负荷持续高于 90%",
      assessment: "SUPPORTS" as const,
      verificationStatus: "EMPLOYEE_CHECKED" as const,
      note: "已核对 CSV 日期与订单排产窗口",
    },
  ],
  hypotheses: ["产能负荷过高可能放大排产延迟"],
  conclusion: {
    result: "SUPPORTS" as const,
    statement: "当前材料支持产能负荷是延期的重要影响因素",
    limitations: "仅覆盖 8 月 12 至 15 日，尚未覆盖外协产能",
    nextChecks: ["在方案阶段补充外协产能约束"],
  },
};

describe("VS16 root-cause validation workpaper contracts", () => {
  it("keeps client content scoped to evidence and material identifiers", () => {
    expect(validationWorkpaperContentSchema.parse(content)).toEqual(content);
    expect(() =>
      validationWorkpaperContentSchema.parse({
        ...content,
        tenantId: "other-tenant",
      }),
    ).toThrow();
    expect(() =>
      validationWorkpaperContentSchema.parse({
        ...content,
        materialFindings: [
          {
            ...content.materialFindings[0],
            storageKey: "C:/private/material.csv",
          },
        ],
      }),
    ).toThrow();
  });

  it("requires one scoped material for an AI candidate run", () => {
    expect(
      validationCandidateRunInputSchema.parse({
        actor: "PMC",
        requestId: "76a76361-4d41-49bb-b51d-e22438ec2e46",
        expectedRevision: 0,
        materialIds: ["MAT-CAPACITY-136"],
      }).materialIds,
    ).toEqual(["MAT-CAPACITY-136"]);
    expect(() =>
      validationCandidateRunInputSchema.parse({
        actor: "PMC",
        requestId: "76a76361-4d41-49bb-b51d-e22438ec2e46",
        expectedRevision: 0,
        materialIds: [],
      }),
    ).toThrow();
  });

  it("allows one-click employee completion but blocks insufficient information", () => {
    const command = {
      actor: "PMC" as const,
      requestId: "76a76361-4d41-49bb-b51d-e22438ec2e46",
      expectedRevision: 1,
      content,
      completionNote: "已核对材料、证据和限制，确认本事项完成",
      confirmedAcceptanceCriteria: ["结论引用有效材料", "限制条件明确"],
    };

    expect(
      validationWorkpaperCompleteInputSchema.parse(command).content,
    ).toEqual(content);
    expect(() =>
      validationWorkpaperCompleteInputSchema.parse({
        ...command,
        content: {
          ...content,
          conclusion: {
            ...content.conclusion,
            result: "INSUFFICIENT_INFORMATION",
          },
        },
      }),
    ).toThrow(/信息不足/);
  });
});
