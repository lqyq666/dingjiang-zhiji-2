import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";
import { createPool } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const projectBusinessState = (
  project: Awaited<ReturnType<Vs01Service["project"]>>,
) => ({
  status: project.status,
  progress: project.progress,
  phases: project.phases.map((phase) => ({
    code: phase.code,
    status: phase.status,
    gate: phase.gate.status,
    tasks: phase.tasks.map((task) => ({ id: task.id, status: task.status })),
  })),
});

const employeeConclusion = (
  candidate: NonNullable<
    Awaited<ReturnType<RootCauseWorkpaperService["candidate"]>>["current"]
  >,
) => ({
  ...candidate.content,
  materialFindings: candidate.content.materialFindings.map((item) => ({
    ...item,
    assessment: "SUPPORTS" as const,
    verificationStatus: "EMPLOYEE_CHECKED" as const,
    note: "已核对产线负荷记录。",
  })),
  conclusion: {
    result: "SUPPORTS" as const,
    statement: "产线负荷风险支持需要纳入解决方案。",
    limitations: "仍需在方案阶段安排责任和时点。",
    nextChecks: ["在方案中明确排产调整责任。"],
  },
});

const runIntegration =
  process.env.VS16_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs16";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS16 root cause validation workpaper", () => {
  const workpapers = new RootCauseWorkpaperService();
  const service = new Vs01Service(undefined, workpapers);
  const verifier = createPool();
  let projectId = "";
  let materialId = "";
  let otherTaskMaterialId = "";

  beforeAll(async () => {
    await service.onModuleInit();
    await service.reset({ actor: "PMC" });
    const material = await service.importTaskMaterial(
      "SO-202608136",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "产线负荷记录",
        note: "用于根因核验",
        requestId: "06111111-1111-4111-8111-111111111111",
      },
      {
        originalName: "产能.csv",
        buffer: Buffer.from("日期,负荷率\n2026-08-20,92%"),
        size: 31,
      },
    );
    materialId = material.id;
    otherTaskMaterialId = (
      await service.importTaskMaterial(
        "SO-202608128",
        {
          actor: "PMC",
          situationCode: "BOM_DELAY",
          requirementId: "REQ-BOM-CHANGE",
          title: "其他订单 BOM 变更清单",
          note: "验证根因底稿不会串读其他任务材料。",
          requestId: "06111111-1111-4111-8111-111111111116",
        },
        {
          originalName: "其他订单BOM.csv",
          buffer: Buffer.from("版本,状态\nv1,冻结"),
          size: Buffer.byteLength("版本,状态\nv1,冻结"),
        },
      )
    ).id;
    await service.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立根因核验咨询任务",
    });
    projectId = (
      await service.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
  });

  afterAll(async () => {
    await verifier.end();
    await service.onModuleDestroy();
    await workpapers.onModuleDestroy();
  });

  it("keeps AI candidates and drafts non-progressing; rejects stale, cross-task, and withdrawn inputs", async () => {
    const beforeCandidate = projectBusinessState(
      await service.project(projectId),
    );
    const candidate = await workpapers.candidate(projectId, {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111112",
      expectedRevision: 0,
      materialIds: [materialId],
    });
    expect(candidate.workItem.status).toBe("READY");
    expect(candidate.current?.classification).toBe("PROPOSAL");
    expect(candidate.revision).toBe(1);
    expect(projectBusinessState(await service.project(projectId))).toEqual(
      beforeCandidate,
    );

    const retry = await workpapers.candidate(projectId, {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111112",
      expectedRevision: 0,
      materialIds: [materialId],
    });
    expect(retry.revision).toBe(1);
    expect(retry.history).toHaveLength(1);

    await expect(
      workpapers.candidate(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111112",
        expectedRevision: 1,
        materialIds: [otherTaskMaterialId],
      }),
    ).rejects.toThrow("相同请求编号不能对应不同工作底稿内容");

    await expect(
      workpapers.candidate(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111117",
        expectedRevision: 1,
        materialIds: [otherTaskMaterialId],
      }),
    ).rejects.toThrow("只能使用当前任务中有效的材料");

    const draft = await workpapers.saveDraft(projectId, {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111118",
      expectedRevision: 1,
      content: employeeConclusion(candidate.current!),
    });
    expect(draft.revision).toBe(2);
    expect(draft.current?.classification).toBe("EMPLOYEE_WORK");
    expect(projectBusinessState(await service.project(projectId))).toEqual(
      beforeCandidate,
    );

    await expect(
      workpapers.saveDraft(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111119",
        expectedRevision: 1,
        content: employeeConclusion(candidate.current!),
      }),
    ).rejects.toMatchObject({
      response: { code: "STALE_WORKPAPER" },
    });

    await service.withdrawTaskMaterial("SO-202608136", materialId, {
      actor: "PMC",
      reason: "用于验证已停用材料不可再进入底稿。",
    });
    await expect(
      workpapers.saveDraft(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111120",
        expectedRevision: 2,
        content: employeeConclusion(candidate.current!),
      }),
    ).rejects.toThrow("工作底稿包含无效、已停用或跨任务材料");
  });

  it("atomically confirms one immutable output, retries safely, and blocks reopening once solution work starts", async () => {
    const secondMaterial = await service.importTaskMaterial(
      "SO-202608136",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "重新核验产线负荷记录",
        note: "用于确认根因结论。",
        requestId: "06111111-1111-4111-8111-111111111121",
      },
      {
        originalName: "重新核验产能.csv",
        buffer: Buffer.from("日期,负荷率\n2026-08-21,93%"),
        size: Buffer.byteLength("日期,负荷率\n2026-08-21,93%"),
      },
    );
    const candidate = await workpapers.candidate(projectId, {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111122",
      expectedRevision: 2,
      materialIds: [secondMaterial.id],
    });
    const content = employeeConclusion(candidate.current!);
    const beforeFailedComplete = await workpapers.view(projectId);
    await expect(
      workpapers.complete(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111123",
        expectedRevision: candidate.revision,
        content: {
          ...content,
          materialFindings: content.materialFindings.map((item) => ({
            ...item,
            verificationStatus: "UNVERIFIED_INPUT" as const,
          })),
        },
        completionNote: "此提交必须完整回滚。",
        confirmedAcceptanceCriteria: candidate.workItem.acceptanceCriteria,
      }),
    ).rejects.toThrow("确认完成前必须由员工逐项核验所引用材料");
    const afterFailedComplete = await workpapers.view(projectId);
    expect(afterFailedComplete.revision).toBe(beforeFailedComplete.revision);
    expect(afterFailedComplete.workItem.status).toBe("READY");

    expect(
      (await service.project(projectId)).phases
        .find((phase) => phase.code === "SOLUTION_APPROVAL")
        ?.tasks.every((task) => task.status === "LOCKED"),
    ).toBe(true);
    const completed = await workpapers.complete(projectId, {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111124",
      expectedRevision: candidate.revision,
      content,
      completionNote: "员工已核验材料并确认结论。",
      confirmedAcceptanceCriteria: candidate.workItem.acceptanceCriteria,
    });
    expect(completed.status).toBe("CONFIRMED");
    expect(completed.workItem.status).toBe("DONE");
    expect(completed.latestConfirmed?.classification).toBe("CONFIRMED_OUTPUT");
    const retry = await workpapers.complete(projectId, {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111124",
      expectedRevision: candidate.revision,
      content,
      completionNote: "员工已核验材料并确认结论。",
      confirmedAcceptanceCriteria: candidate.workItem.acceptanceCriteria,
    });
    expect(retry.revision).toBe(completed.revision);
    expect(retry.latestConfirmed?.locator).toEqual(
      completed.latestConfirmed?.locator,
    );
    expect(
      retry.history.filter((version) => version.kind === "PMC_CONFIRMED"),
    ).toHaveLength(1);
    await expect(
      verifier.query(
        "UPDATE vs16_root_cause_workpaper_versions SET content = content WHERE workpaper_id = $1 AND revision = $2",
        [completed.id, completed.latestConfirmed?.revision],
      ),
    ).rejects.toMatchObject({
      message: "VS16 workpaper history is append-only",
    });
    const afterComplete = await service.project(projectId);
    expect(
      afterComplete.phases.find((phase) => phase.code === "SOLUTION_APPROVAL")
        ?.gate.status,
    ).toBe("OPEN");
    expect(
      afterComplete.phases
        .find((phase) => phase.code === "SOLUTION_APPROVAL")
        ?.tasks.filter((task) => task.owner === "PMC")
        .every((task) => task.status === "READY"),
    ).toBe(true);
    const solutionTask = afterComplete.phases
      .find((phase) => phase.code === "SOLUTION_APPROVAL")
      ?.tasks.find((task) => task.owner === "PMC");
    if (!solutionTask)
      throw new Error("Expected an unlocked PMC solution task");
    await service.updateSubtask(solutionTask.id, {
      actor: "PMC",
      status: "IN_PROGRESS",
      note: "方案已有实际推进，根因结论不可直接重开。",
    });
    await expect(
      workpapers.reopen(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111125",
        expectedRevision: completed.revision,
        reason: "下游已开始时必须阻断。",
      }),
    ).rejects.toMatchObject({
      response: { code: "DOWNSTREAM_DEPENDENCY" },
    });

    await expect(
      workpapers.reopen(projectId, {
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111126",
        expectedRevision: completed.revision,
        reason: "重复验证下游阻断不改变确认版。",
      }),
    ).rejects.toMatchObject({ response: { code: "DOWNSTREAM_DEPENDENCY" } });
    const preserved = await workpapers.view(projectId);
    expect(preserved.latestConfirmed?.locator.sourceVersionId).toBe(
      completed.latestConfirmed?.locator.sourceVersionId,
    );
    expect(
      preserved.history.filter((version) => version.kind === "PMC_CONFIRMED"),
    ).toHaveLength(1);
  });
});
