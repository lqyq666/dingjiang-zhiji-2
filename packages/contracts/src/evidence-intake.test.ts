import { describe, expect, it } from "vitest";

import { evidenceProposeRequestSchema } from "./evidence-intake";

const valid = {
  requestId: "b7cba608-2c0d-48a6-acfe-d5397806d8d7",
  expectedVersion: 0,
  reason: "登记经人工核验材料中的可追溯事实候选",
  correlationId: "aec4f698-3024-44d4-a4f8-caa21bfa8db6",
  payload: {
    workItemId: "PRJ-1-SUB-SOLUTION-001",
    materialId: "5",
    claim: "测试产线在指定统计周期内的负荷率为 82%。",
    evidenceType: "METRIC",
    sourceObjectId: "SRC-MATERIAL-1",
    sourceVersionId: "SRC-MATERIAL-1-V1",
    exactSpan: {
      kind: "TEXT_SPAN",
      start: 0,
      end: 13,
      exactText: "测试产线负荷率为 82%。",
    },
    reasoning: "该句直接给出统计口径内的负荷率。",
    limitations: "仅适用于 fixture 指定统计周期。",
  },
};

describe("evidence.propose contract", () => {
  it("accepts a traceable proposal without caller-controlled authority", () => {
    expect(evidenceProposeRequestSchema.parse(valid)).toEqual(valid);
  });

  it.each(["tenantId", "role", "scope", "actor", "url", "path", "reference"])(
    "rejects caller-controlled %s",
    (field) => {
      expect(() =>
        evidenceProposeRequestSchema.parse({
          ...valid,
          payload: { ...valid.payload, [field]: "attacker-controlled" },
        }),
      ).toThrow();
    },
  );

  it("rejects an empty or inconsistent text span", () => {
    expect(() =>
      evidenceProposeRequestSchema.parse({
        ...valid,
        payload: {
          ...valid.payload,
          exactSpan: { kind: "TEXT_SPAN", start: 10, end: 5, exactText: "x" },
        },
      }),
    ).toThrow();
  });

  it("rejects secret-shaped content and executable privilege injection", () => {
    for (const payload of [
      { ...valid.payload, claim: "password=test-secret-sentinel" },
      { ...valid.payload, sql: "UPDATE evidence SET confirmed = true" },
      { ...valid.payload, shellCommand: "confirm-everything" },
      { ...valid.payload, filePath: "C:\\secret.txt" },
    ])
      expect(() =>
        evidenceProposeRequestSchema.parse({ ...valid, payload }),
      ).toThrow();
  });
});
