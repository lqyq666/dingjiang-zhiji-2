import { BadRequestException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Vs01Service } from "./vs01.service";

const runIntegration =
  process.env.VS05_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs05";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS05 PostgreSQL experience lifecycle", () => {
  const service = new Vs01Service();

  beforeAll(async () => {
    await service.onModuleInit();
    await service.reset({ actor: "PMC" });
  });

  afterAll(async () => {
    await service.onModuleDestroy();
  });

  const completeReadyTasks = async (
    project: Awaited<ReturnType<Vs01Service["project"]>>,
    phaseCode: string,
  ) => {
    let current = project;
    const phase = current.phases.find((item) => item.code === phaseCode);
    if (!phase) throw new Error(`Missing phase ${phaseCode}`);
    for (const task of phase.tasks.filter(
      (item) =>
        item.owner === "PMC" &&
        (item.status === "READY" || item.status === "IN_PROGRESS"),
    )) {
      current = await service.updateSubtask(task.id, {
        actor: "PMC",
        status: "DONE",
        note: `集成验收完成：${task.title}`,
        outputReference: `集成验收输出：${task.title}`,
        confirmedAcceptanceCriteria: task.acceptance,
      });
    }
    return current;
  };

  it("preserves revisions and reference events while enforcing the permanent publication lock", async () => {
    await service.decideTask("SO-202608128", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "集成验收：确认 BOM 准备滞后",
    });
    let project = await service.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
    for (const historicalCode of [
      "PROJECT_SCOPING",
      "BASELINE_FACTS",
      "ROOT_CAUSE_VALIDATION",
    ]) {
      const historicalPhase = project.phases.find(
        (item) => item.code === historicalCode,
      );
      expect(historicalPhase?.completedTaskCount).toBe(
        historicalPhase?.totalTaskCount,
      );
      expect(historicalPhase?.status).toBe("COMPLETED");
    }
    const solutionBeforeMaterial = project.phases.find(
      (item) => item.code === "SOLUTION_APPROVAL",
    );
    if (!solutionBeforeMaterial) throw new Error("Missing solution phase");
    await service.addTaskMaterial("SO-202608128", {
      actor: "PMC",
      situationCode: "CAPACITY_RISK",
      title: "产能负荷复核表",
      sourceReference: "集成验收/产能负荷复核表.xlsx",
      note: "只补充输入材料，不推进事项",
    });
    project = await service.project(project.id);
    expect(
      project.phases.find((item) => item.code === "SOLUTION_APPROVAL")
        ?.completedTaskCount,
    ).toBe(solutionBeforeMaterial.completedTaskCount);
    const firstSolutionTask = solutionBeforeMaterial.tasks.find(
      (item) => item.owner === "PMC" && item.status === "READY",
    );
    if (!firstSolutionTask) throw new Error("Missing ready solution task");
    project = await service.updateSubtask(firstSolutionTask.id, {
      actor: "PMC",
      status: "IN_PROGRESS",
      note: "正在比较方案影响与风险",
      outputReference: "方案比较表草稿",
    });
    const solutionInProgress = project.phases.find(
      (item) => item.code === "SOLUTION_APPROVAL",
    );
    expect(solutionInProgress?.completedTaskCount).toBe(
      solutionBeforeMaterial.completedTaskCount,
    );
    expect(
      solutionInProgress?.tasks.find((item) => item.id === firstSolutionTask.id)
        ?.status,
    ).toBe("IN_PROGRESS");
    project = await completeReadyTasks(project, "SOLUTION_APPROVAL");
    project = await service.submitProject(project.id, { actor: "PMC" });
    project = await service.approveProject(project.id, { actor: "OWNER" });
    project = await completeReadyTasks(project, "EXECUTION_CONTROL");
    expect(project.status).toBe("RESULT_VALIDATION");
    expect(
      project.phases.find((item) => item.code === "EXECUTION_CONTROL")?.gate
        .status,
    ).toBe("APPROVED");
    project = await completeReadyTasks(project, "RESULT_ACCEPTANCE");
    project = await service.submitOutcome(project.id, {
      actor: "PMC",
      currentOtd: 83,
      evidenceReference: "集成验收 OTD 重算表 83%",
      conclusion: "OTD 从 71% 提升至 83%",
      note: "本地脱敏数据",
    });
    expect(project.status).toBe("KNOWLEDGE_CAPTURE");
    expect(project.outcome.status).toBe("ACCEPTED");
    project = await completeReadyTasks(project, "KNOWLEDGE_CAPTURE");
    project = await service.createExperienceCandidate(project.id, {
      actor: "PMC",
      title: "BOM 准备前置治理",
      applicableSituation: "工程变更已冻结的多品种小批量订单",
      businessProblem: "BOM 准备滞后导致采购和排产启动延迟",
      practice: "分类缺料与版本冲突，明确责任并日清补料",
      resultSummary: "OTD 从 71% 提升至 83%，已由责任员工确认",
      limitations: "仅适用于工程变更已冻结的订单",
    });
    expect(project.status).toBe("KNOWLEDGE_CAPTURE");
    expect(
      project.phases.find((item) => item.code === "KNOWLEDGE_CAPTURE")?.gate
        .status,
    ).toBe("PENDING");

    const revision1 = project.experienceCandidate;
    if (!revision1) throw new Error("Missing candidate revision 1");
    project = await service.withdrawExperienceCandidate(project.id, {
      actor: "PMC",
      reason: "发现适用边界表述不准确，撤回重写",
    });
    const withdrawn = project.experienceCandidate;
    if (!withdrawn) throw new Error("Missing withdrawn candidate");
    expect(withdrawn.status).toBe("WITHDRAWN");
    project = await service.resubmitExperienceCandidate(project.id, {
      actor: "PMC",
      expectedCandidateVersionId: withdrawn.candidateLocator.sourceVersionId,
      title: withdrawn.title,
      applicableSituation: withdrawn.applicableSituation,
      businessProblem: withdrawn.businessProblem,
      practice: withdrawn.practice,
      resultSummary: withdrawn.resultSummary,
      limitations: "仅适用于工程变更已冻结且责任人能够日清的订单",
    });
    const revision2 = project.experienceCandidate;
    if (!revision2) throw new Error("Missing candidate revision 2");
    project = await service.returnExperienceCandidate(revision2.id, {
      actor: "EXPERT_REVIEWER",
      expectedCandidateVersionId: revision2.candidateLocator.sourceVersionId,
      reason: "请补充责任人日清的适用边界",
    });
    const returnedRevision2 = project.experienceCandidate;
    if (!returnedRevision2) throw new Error("Missing returned revision 2");
    project = await service.resubmitExperienceCandidate(project.id, {
      actor: "PMC",
      expectedCandidateVersionId:
        returnedRevision2.candidateLocator.sourceVersionId,
      title: returnedRevision2.title,
      applicableSituation: returnedRevision2.applicableSituation,
      businessProblem: returnedRevision2.businessProblem,
      practice: returnedRevision2.practice,
      resultSummary: returnedRevision2.resultSummary,
      limitations: "仅适用于工程变更已冻结且责任人能够日清的订单",
    });
    const revision3 = project.experienceCandidate;
    if (!revision3) throw new Error("Missing candidate revision 3");
    const formal = await service.approveExperienceCandidate(revision3.id, {
      actor: "EXPERT_REVIEWER",
      expectedCandidateVersionId: revision3.candidateLocator.sourceVersionId,
    });
    const completedProject = await service.project(project.id);
    expect(completedProject.status).toBe("COMPLETED");
    expect(
      completedProject.phases.find((item) => item.code === "KNOWLEDGE_CAPTURE")
        ?.gate.status,
    ).toBe("APPROVED");

    let task = await service.citeExperience("SO-202608136", {
      actor: "PMC",
      experienceId: formal.id,
      expectedExperienceVersionId: formal.locator.sourceVersionId,
      note: "只作为候选参考",
    });
    const reference = task.experienceReferences.find(
      (item) => item.status === "ACTIVE",
    );
    if (!reference) throw new Error("Missing active reference");
    task = await service.withdrawExperienceReference(task.id, reference.id, {
      actor: "PMC",
      reason: "误选后撤回",
    });
    task = await service.citeExperience(task.id, {
      actor: "PMC",
      experienceId: formal.id,
      expectedExperienceVersionId: formal.locator.sourceVersionId,
      note: "重新核对后恢复",
    });
    expect(
      task.experienceReferenceAuditTrail.map((event) => event.eventType),
    ).toEqual(["CITED", "WITHDRAWN", "RESTORED"]);

    await expect(
      service.retractExperience(formal.id, {
        actor: "EXPERT_REVIEWER",
        expectedExperienceVersionId: formal.locator.sourceVersionId,
        reason: "仍有引用时不得下架",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const restoredReference = task.experienceReferences.find(
      (item) => item.status === "ACTIVE",
    );
    if (!restoredReference) throw new Error("Missing restored reference");
    await service.withdrawExperienceReference(task.id, restoredReference.id, {
      actor: "PMC",
      reason: "先解除下游引用",
    });
    await service.retractExperience(formal.id, {
      actor: "EXPERT_REVIEWER",
      expectedExperienceVersionId: formal.locator.sourceVersionId,
      reason: "适用边界需要形成新版本",
    });

    await expect(
      service.returnOutcome(project.id, {
        actor: "OWNER",
        reason: "尝试更正已发布经验的来源结果",
      }),
    ).rejects.toThrow("已有正式经验发布历史");

    const history = await service.expertExperienceHistory();
    expect(history.items[0]).toMatchObject({
      currentRevision: 3,
      publications: [{ status: "RETRACTED" }],
    });
    expect(history.items[0]?.revisions).toHaveLength(3);
    expect((await service.project(project.id)).publishedExperienceHistory).toBe(
      true,
    );

    project = await service.project(project.id);
    const revision3Returned = project.experienceCandidate;
    if (!revision3Returned) throw new Error("Missing returned revision 3");
    project = await service.resubmitExperienceCandidate(project.id, {
      actor: "PMC",
      expectedCandidateVersionId:
        revision3Returned.candidateLocator.sourceVersionId,
      title: revision3Returned.title,
      applicableSituation: revision3Returned.applicableSituation,
      businessProblem: revision3Returned.businessProblem,
      practice: revision3Returned.practice,
      resultSummary: revision3Returned.resultSummary,
      limitations: "第 4 版：仅适用于冻结且已运行补料日清机制的订单",
    });
    const revision4 = project.experienceCandidate;
    if (!revision4) throw new Error("Missing candidate revision 4");
    const replacement = await service.approveExperienceCandidate(revision4.id, {
      actor: "EXPERT_REVIEWER",
      expectedCandidateVersionId: revision4.candidateLocator.sourceVersionId,
    });
    task = await service.citeExperience("SO-202608136", {
      actor: "PMC",
      experienceId: replacement.id,
      expectedExperienceVersionId: replacement.locator.sourceVersionId,
      note: "最终演示：新正式版本作为候选参考",
    });
    const beforeAssistant = { status: task.status, decision: task.decision };
    const assistant = await service.assistTask(task.id, {
      actor: "PMC",
      intent: "NEXT_ACTION",
    });
    expect(assistant.classification).toBe("PROPOSAL");
    expect(assistant.context.coverage.experienceReferenceCount).toBe(1);
    expect(assistant.context.experienceReferences).toHaveLength(1);
    expect(assistant.context.experienceReferences[0]?.classification).toBe(
      "PROPOSAL",
    );
    const afterAssistant = await service.task(task.id);
    expect({
      status: afterAssistant.status,
      decision: afterAssistant.decision,
    }).toEqual(beforeAssistant);
    const finalHistory = await service.expertExperienceHistory();
    expect(finalHistory.items[0]?.revisions).toHaveLength(4);
    expect(
      finalHistory.items[0]?.publications.map((item) => item.status),
    ).toEqual(["RETRACTED", "PUBLISHED"]);
    expect(
      task.experienceReferences.filter((item) => item.status === "ACTIVE"),
    ).toHaveLength(1);
  });
});
