import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { normalizeMulterOriginalName, Vs01Controller } from "./vs01.controller";

describe("VS01 demo authorization seam", () => {
  it("normalizes only reversibly mojibaked multipart filenames", () => {
    expect(normalizeMulterOriginalName("äº§èƒ½è´Ÿè·.csv")).toBe("产能负荷.csv");
    expect(normalizeMulterOriginalName("report.csv")).toBe("report.csv");
    expect(normalizeMulterOriginalName("产能负荷.csv")).toBe("产能负荷.csv");
  });

  it("rejects a missing PMC role before invoking the employee service", () => {
    const employee = vi.fn();
    const controller = new Vs01Controller({ employee } as never);

    expect(() => controller.employee(undefined)).toThrow(ForbiddenException);
    expect(employee).not.toHaveBeenCalled();
  });

  it("rejects a missing PMC role before invoking decision rollback", () => {
    const revertTaskDecision = vi.fn();
    const controller = new Vs01Controller({ revertTaskDecision } as never);

    expect(() =>
      controller.revertDecision(
        "SO-202608128",
        { actor: "PMC", reason: "误操作" },
        undefined,
      ),
    ).toThrow(ForbiddenException);
    expect(revertTaskDecision).not.toHaveBeenCalled();
  });

  it("keeps result confirmation behind the responsible employee seam", () => {
    const submitOutcome = vi.fn();
    const controller = new Vs01Controller({ submitOutcome } as never);

    expect(() =>
      controller.submitOutcome(
        "PRJ-OTD-001",
        {
          actor: "PMC",
          currentOtd: 83,
          evidenceReference: "OTD 同口径重算表",
          conclusion: "OTD 提升至 83%",
        },
        "OWNER",
      ),
    ).toThrow(ForbiddenException);
    expect(submitOutcome).not.toHaveBeenCalled();
  });

  it("keeps result correction behind the responsible employee seam", () => {
    const reopenOutcome = vi.fn();
    const controller = new Vs01Controller({ reopenOutcome } as never);

    expect(() =>
      controller.reopenOutcome(
        "PRJ-OTD-001",
        { actor: "PMC", reason: "发现结果口径需修正" },
        "OWNER",
      ),
    ).toThrow(ForbiddenException);
    expect(reopenOutcome).not.toHaveBeenCalled();
  });

  it("rejects a missing consultant role before building AI context", () => {
    const assistProject = vi.fn();
    const controller = new Vs01Controller({ assistProject } as never);

    expect(() =>
      controller.assistProject(
        "PRJ-OTD-001",
        { actor: "PMC", intent: "NEXT_ACTION" },
        undefined,
      ),
    ).toThrow(ForbiddenException);
    expect(assistProject).not.toHaveBeenCalled();
  });

  it("rejects a missing consultant role before recording or withdrawing AI feedback", () => {
    const createAssistantFeedback = vi.fn();
    const assistantFeedback = vi.fn();
    const withdrawAssistantFeedback = vi.fn();
    const controller = new Vs01Controller({
      createAssistantFeedback,
      assistantFeedback,
      withdrawAssistantFeedback,
    } as never);

    expect(() =>
      controller.createAssistantFeedback(
        "PRJ-OTD-001",
        { actor: "PMC" },
        undefined,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      controller.withdrawAssistantFeedback(
        "PRJ-OTD-001",
        "AFC-001",
        { actor: "PMC", reason: "误提交" },
        undefined,
      ),
    ).toThrow(ForbiddenException);
    expect(createAssistantFeedback).not.toHaveBeenCalled();
    expect(() =>
      controller.assistantFeedback("PRJ-OTD-001", undefined),
    ).toThrow(ForbiddenException);
    expect(assistantFeedback).not.toHaveBeenCalled();
    expect(withdrawAssistantFeedback).not.toHaveBeenCalled();
  });

  it("rejects a missing PMC role before invoking the task assistant", () => {
    const assistTask = vi.fn();
    const controller = new Vs01Controller({ assistTask } as never);

    expect(() =>
      controller.assistTask(
        "SO-202608136",
        { actor: "PMC", intent: "NEXT_ACTION" },
        undefined,
      ),
    ).toThrow(ForbiddenException);
    expect(assistTask).not.toHaveBeenCalled();
  });

  it("rejects a missing PMC role before any material vault import", async () => {
    const importTaskMaterial = vi.fn();
    const controller = new Vs01Controller({ importTaskMaterial } as never);

    await expect(
      controller.importMaterial(
        "SO-202608136",
        {
          actor: "PMC",
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          title: "关键产线负荷记录",
          requestId: "4f8be14b-2de9-4cf9-afc7-3097ee4de060",
        },
        {
          originalname: "负荷.csv",
          buffer: Buffer.from("日期,负荷率"),
          size: 13,
        },
        undefined,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(importTaskMaterial).not.toHaveBeenCalled();
  });

  it("rejects PMC and OWNER before an expert review is dispatched", () => {
    const approveExperienceCandidate = vi.fn();
    const controller = new Vs01Controller({
      approveExperienceCandidate,
    } as never);

    expect(() =>
      controller.approveExperienceCandidate(
        "EXP-OTD-001",
        {
          actor: "EXPERT_REVIEWER",
          expectedCandidateVersionId: "SRC-EXPERIENCE-CANDIDATE-VERSION-1",
        },
        "PMC",
      ),
    ).toThrow(ForbiddenException);
    expect(approveExperienceCandidate).not.toHaveBeenCalled();
  });

  it("keeps full candidate and publication history behind the expert seam", () => {
    const expertExperienceHistory = vi.fn();
    const controller = new Vs01Controller({ expertExperienceHistory } as never);

    expect(() => controller.expertExperienceHistory("PMC")).toThrow(
      ForbiddenException,
    );
    expect(expertExperienceHistory).not.toHaveBeenCalled();
  });

  it("requires the strict VS17 structured candidate schema at the public HTTP controller seam", () => {
    const createExperienceCandidate = vi.fn();
    const controller = new Vs01Controller({
      createExperienceCandidate,
    } as never);
    const legacy = {
      actor: "PMC",
      title: "标题",
      applicableSituation: "情境",
      businessProblem: "问题",
      practice: "做法",
      resultSummary: "结果",
      limitations: "限制",
    };
    expect(() =>
      controller.createExperienceCandidate("PRJ-1", legacy, "PMC"),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.createExperienceCandidate(
        "PRJ-1",
        { ...legacy, structuredCard: {}, unexpected: true },
        "PMC",
      ),
    ).toThrow(BadRequestException);
    expect(createExperienceCandidate).not.toHaveBeenCalled();
  });
});
