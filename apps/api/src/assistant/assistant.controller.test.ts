import { assistantStreamEventSchema } from "@dingjiang/contracts";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AssistantController, publicStreamEvent } from "./assistant.controller";

describe("VS12 assistant HTTP seam", () => {
  it("authorizes before creating a run and excludes client-provided scope", () => {
    const createRun = vi.fn();
    const controller = new AssistantController({ createRun } as never);
    expect(() =>
      controller.createRun("PRJ-OTD-001", { projectId: "other" }, "PMC"),
    ).toThrow(BadRequestException);
    expect(createRun).not.toHaveBeenCalled();
    expect(() =>
      controller.createRun("PRJ-OTD-001", { question: "下一步？" }, undefined),
    ).toThrow(ForbiddenException);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("serializes persisted suggestions through the public VS12 SSE contract", () => {
    const event = publicStreamEvent({
      cursor: "7",
      sessionId: "ASST-PRJ-OTD-001",
      runId: "run-1",
      stageCode: null,
      occurredAt: "2026-08-17T00:00:00.000Z",
      type: "SUGGESTION",
      payload: {
        suggestion: {
          classification: "PROPOSAL",
          answer: "由员工决定",
          evidenceIds: ["E-1"],
          nextAction: "核对材料",
          provider: "DEMO_RULES",
        },
      },
    });
    expect(assistantStreamEventSchema.parse(event)).toMatchObject({
      type: "SUGGESTION",
      suggestion: { classification: "PROPOSAL" },
    });
  });

  it("returns history through the frozen public object contract", async () => {
    const controller = new AssistantController({
      history: vi.fn().mockResolvedValue({
        session: {
          id: "ASST-1",
          scope: {
            tenantId: "tenant-demo",
            subjectId: "demo-pmc",
            role: "PMC",
            projectId: "PRJ-OTD-001",
            sourceTaskId: "SO-202608128",
            policyVersion: "VS12-1",
          },
          createdAt: "2026-08-17T00:00:00.000Z",
          lastActiveAt: "2026-08-17T00:00:00.000Z",
        },
        runs: [],
        latestCursor: "0",
        internalOnly: true,
      }),
    } as never);
    await expect(controller.history("PRJ-OTD-001", "PMC")).rejects.toThrow(
      /unrecognized/i,
    );
  });
});
