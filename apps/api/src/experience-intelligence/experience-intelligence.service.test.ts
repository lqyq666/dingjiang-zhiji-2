import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ExperienceIntelligenceService } from "./experience-intelligence.service";
import { DemoExperienceProvider } from "./providers/demo-experience.provider";

const receipt = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "RUNNING" as const,
  response: null,
  errorCode: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  completedAt: null,
};
const commandStore = () => ({
  createOrGet: vi.fn().mockResolvedValue({ receipt, created: true }),
  succeed: vi.fn(),
  fail: vi.fn(),
});
const runStore = () => ({
  createOrGet: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
});

describe("ExperienceIntelligenceService VS17 root-cause source", () => {
  it("rejects an AI draft for a live root-cause task without the immutable VS16 confirmed conclusion", async () => {
    const commands = commandStore();
    const provider = { provider: "DEMO_RULES", extractCandidate: vi.fn() };
    const vs01 = {
      project: vi.fn().mockResolvedValue({
        id: "PRJ-136",
        sourceTaskId: "SO-202608136",
        outcome: { status: "ACCEPTED" },
        phases: [
          {
            code: "ROOT_CAUSE_VALIDATION",
            tasks: [{ origin: "LIVE", owner: "PMC" }],
          },
        ],
      }),
      task: vi.fn().mockResolvedValue({
        evidence: [],
        materials: [],
        decision: { note: "legacy cause" },
      }),
      rootCauseWorkpaper: vi.fn().mockResolvedValue({ latestConfirmed: null }),
    };
    const service = new ExperienceIntelligenceService(
      vs01 as never,
      provider as never,
      {} as never,
      runStore() as never,
      commands as never,
    );

    await expect(
      service.draft("PRJ-136", {
        actor: "PMC",
        requestId: "11111111-1111-4111-8111-111111111112",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.extractCandidate).not.toHaveBeenCalled();
    expect(vs01.rootCauseWorkpaper).toHaveBeenCalledWith("PRJ-136");
  });

  it("passes the immutable confirmed workpaper conclusion and locator to the provider instead of the legacy task decision", async () => {
    const commands = commandStore();
    const demo = new DemoExperienceProvider();
    const extractCandidate = vi.spyOn(demo, "extractCandidate");
    const runs = runStore();
    runs.createOrGet.mockResolvedValue({
      created: true,
      run: {
        id: "11111111-1111-4111-8111-111111111114",
        purpose: "EXTRACT",
        provider: "DEMO_RULES",
        workflowId: "DEMO_RULES_EXTRACT",
        inputFingerprint: "fingerprint",
        inputRefs: [],
        status: "RUNNING",
        structuredOutput: null,
        executeId: null,
        debugUrl: null,
        usage: null,
        error: null,
        createdAt: "2026-08-26T00:00:00.000Z",
        completedAt: null,
      },
    });
    const vs01 = {
      project: vi.fn().mockResolvedValue({
        id: "PRJ-136",
        sourceTaskId: "SO-202608136",
        name: "交付延期",
        outcome: {
          status: "ACCEPTED",
          conclusion: "结果已确认",
          evidenceReference: null,
        },
        phases: [
          {
            code: "ROOT_CAUSE_VALIDATION",
            tasks: [{ origin: "LIVE", owner: "PMC" }],
          },
        ],
      }),
      task: vi.fn().mockResolvedValue({
        evidence: [
          {
            id: "E-ORDER-202608136",
            fields: { order: "SO-202608136" },
            sourceObjectId: "SRC-ORDERS",
            sourceVersionId: "SRC-ORDERS-V1",
            sourceFile: "orders.csv",
            sourceRow: 2,
          },
        ],
        materials: [],
        decision: { note: "legacy cause must not be used" },
      }),
      rootCauseWorkpaper: vi.fn().mockResolvedValue({
        latestConfirmed: {
          content: {
            conclusion: {
              statement: "confirmed workpaper cause",
              result: "SUPPORTS",
              limitations: "",
              nextChecks: [],
            },
          },
          locator: {
            sourceObjectId: "SRC-WORKPAPER",
            sourceVersionId: "SRC-WORKPAPER-V1",
            reference: "根因核验工作底稿 v3",
          },
        },
      }),
    };
    const service = new ExperienceIntelligenceService(
      vs01 as never,
      demo,
      {} as never,
      runs as never,
      commands as never,
    );

    await service.draft("PRJ-136", {
      actor: "PMC",
      requestId: "11111111-1111-4111-8111-111111111115",
    });
    expect(extractCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedRootCause: "confirmed workpaper cause（根因核验工作底稿 v3）",
      }),
    );
  });
});
