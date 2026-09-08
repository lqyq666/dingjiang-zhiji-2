import { describe, expect, it } from "vitest";
import { workExecutionRequestSchema } from "./work-execution";

const request = () => ({
  requestId: "10000000-0000-4000-8000-000000000001",
  correlationId: "20000000-0000-4000-8000-000000000001",
  expectedVersion: 0,
  reason: "员工请求记录进展",
  payload: {
    stateFingerprint: "a".repeat(64),
    confirmation: "请记录本次处理进展",
    operation: {
      action: "progress.record",
      workItemId: "WI-1",
      note: "已核对原始记录",
    },
  },
});

describe("WorkBuddy action contract", () => {
  it("accepts a concrete progress note without an employee-entered percentage", () => {
    expect(
      workExecutionRequestSchema.parse(request()).payload.operation.action,
    ).toBe("progress.record");
    const input = request();
    expect(
      workExecutionRequestSchema.safeParse({
        ...input,
        payload: {
          ...input.payload,
          operation: { ...input.payload.operation, progress: 80 },
        },
      }).success,
    ).toBe(false);
  });
  it("requires explicit confirmation and rejects caller-controlled roles and scopes", () => {
    const input = request();
    expect(
      workExecutionRequestSchema.safeParse({
        ...input,
        payload: { ...input.payload, confirmation: "" },
      }).success,
    ).toBe(false);
    expect(
      workExecutionRequestSchema.safeParse({
        ...input,
        payload: { ...input.payload, role: "OWNER" },
      }).success,
    ).toBe(false);
    expect(
      workExecutionRequestSchema.safeParse({
        ...input,
        scopes: ["project:approve"],
      }).success,
    ).toBe(false);
  });
  it("requires actual measured results and an evidence reference", () => {
    const input = request();
    expect(
      workExecutionRequestSchema.safeParse({
        ...input,
        payload: {
          ...input.payload,
          operation: { action: "outcome.record", conclusion: "达到目标" },
        },
      }).success,
    ).toBe(false);
  });
});
