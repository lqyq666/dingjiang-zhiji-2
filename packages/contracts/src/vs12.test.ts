import { describe, expect, it } from "vitest";

import {
  assistantRunRequestSchema,
  assistantStreamEventSchema,
  assistantToolResultSchema,
  workEventSchema,
} from "./vs12";

describe("VS12 Pi Runtime Copilot contracts", () => {
  it("accepts a compact, traceable work event", () => {
    const event = workEventSchema.parse({
      schemaVersion: 1,
      id: "101",
      sequence: "101",
      correlationKey: "project:PRJ-OTD-001:tx:42",
      sourceEventType: "TASK_COMPLETED",
      eventType: "WORK_ITEM_CONFIRMED",
      consultingTaskId: "PRJ-OTD-001",
      sourceTaskId: "SO-202608128",
      stageCode: "EXECUTION_CONTROL",
      workItemId: null,
      actorRole: "PMC",
      occurredAt: "2026-08-17T08:00:00.000Z",
      payload: { sourceProjectEventId: "101", note: "已确认完成 BOM 分类" },
    });

    expect(event.eventType).toBe("WORK_ITEM_CONFIRMED");
    expect(() =>
      workEventSchema.parse({
        ...event,
        payload: { fullProjectContext: { everyFact: "must not be copied" } },
      }),
    ).toThrow();
  });

  it("keeps browser run input free from server-owned scope", () => {
    expect(
      assistantRunRequestSchema.parse({
        stageCode: "EXECUTION_CONTROL",
        question: "下一步应该核对什么？",
        intent: "ASK",
      }).intent,
    ).toBe("ASK");
    expect(() =>
      assistantRunRequestSchema.parse({
        question: "越权尝试",
        tenantId: "other-tenant",
      }),
    ).toThrow();
  });

  it("publishes only safe tool completion metadata to the stream", () => {
    expect(
      assistantStreamEventSchema.parse({
        type: "TOOL_COMPLETED",
        cursor: "17",
        sessionId: "AS-001",
        runId: "AR-001",
        stageCode: "EXECUTION_CONTROL",
        occurredAt: "2026-08-17T08:00:00.000Z",
        toolName: "get_evidence",
        status: "OK",
        evidenceIds: ["E-ORDER-128"],
      }).type,
    ).toBe("TOOL_COMPLETED");
    expect(() =>
      assistantStreamEventSchema.parse({
        type: "TOOL_COMPLETED",
        cursor: "17",
        sessionId: "AS-001",
        runId: "AR-001",
        stageCode: "EXECUTION_CONTROL",
        occurredAt: "2026-08-17T08:00:00.000Z",
        toolName: "get_evidence",
        status: "OK",
        evidenceIds: [],
        sql: "select * from tenants",
      }),
    ).toThrow();
  });

  it("keeps unavailable material bodies explicit instead of invented", () => {
    expect(
      assistantToolResultSchema.parse({
        status: "BODY_NOT_AVAILABLE",
        summary: "该材料仅登记了来源引用，未保存可读取正文。",
        evidenceIds: [],
      }).status,
    ).toBe("BODY_NOT_AVAILABLE");
  });
});
