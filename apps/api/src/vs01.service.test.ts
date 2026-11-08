import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { Vs01Service } from "./vs01.service";

describe("VS01 task decision seam", () => {
  it("rejects client-supplied project identifiers before any database mutation", async () => {
    const service = new Vs01Service();
    await expect(
      service.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
        projectId: "PRJ-CLIENT-CONTROLLED",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an empty expert return reason before any database mutation", async () => {
    const service = new Vs01Service();
    await expect(
      service.returnExperienceCandidate("EXP-OTD-001", {
        actor: "EXPERT_REVIEWER",
        expectedCandidateVersionId: "SRC-EXPERIENCE-CANDIDATE-VERSION-1",
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects unconfirmed or non-PMC work-item completion requests before mutation", async () => {
    const service = new Vs01Service();
    await expect(
      service.updateSubtask("SUB-BOM-001", {
        actor: "PMC",
        status: "DONE",
        note: "缺少验收确认",
        outputReference: "输出记录",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSubtask("SUB-BOM-001", {
        actor: "OWNER",
        status: "DONE",
        note: "非事项责任角色",
        outputReference: "输出记录",
        confirmedAcceptanceCriteria: ["口径或范围明确"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
