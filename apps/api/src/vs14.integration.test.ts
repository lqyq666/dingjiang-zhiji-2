import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "@dingjiang/contracts";

import { AssistantService } from "./assistant/assistant.service";
import { Vs01ContextAdapter } from "./assistant/context";
import { DemoRulesRuntimeAdapter } from "./assistant/runtime";
import { assistantScopeFromRequest } from "./assistant/scope";
import { AssistantStore } from "./assistant/store";
import { createPool } from "./vs01-db";
import { Vs01Service } from "./vs01.service";
import { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";

const runIntegration =
  process.env.VS14_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs14";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS14 PostgreSQL multi-engagement isolation", () => {
  const workpapers = new RootCauseWorkpaperService();
  const service = new Vs01Service(undefined, workpapers);
  const store = new AssistantStore();
  const context = new Vs01ContextAdapter(service, store);
  const verifierPool = createPool();
  const assistant = new AssistantService(
    store,
    context,
    new DemoRulesRuntimeAdapter(),
    new DemoRulesRuntimeAdapter(),
  );
  let legacyId = "";
  let secondId = "";

  const completePhase = async (
    project: Project,
    phaseCode: Project["phases"][number]["code"],
  ): Promise<Project> => {
    let current = project;
    const phase = current.phases.find((item) => item.code === phaseCode);
    if (!phase) throw new Error(`Missing ${phaseCode} phase`);
    for (const task of phase.tasks.filter(
      (item) =>
        item.owner === "PMC" && ["READY", "IN_PROGRESS"].includes(item.status),
    )) {
      current = await service.updateSubtask(task.id, {
        actor: "PMC",
        status: "DONE",
        note: `VS14 集成验收完成：${task.title}`,
        outputReference: `VS14 第二咨询任务输出：${task.title}`,
        confirmedAcceptanceCriteria: task.acceptance,
      });
    }
    return current;
  };

  beforeAll(async () => {
    await service.onModuleInit();
    await service.reset({ actor: "PMC" });
    for (const taskId of ["SO-202608128", "SO-202608136"]) {
      await service.decideTask(taskId, {
        actor: "PMC",
        type: "CONFIRMED",
        note: `VS14 集成验收：确认 ${taskId} 的候选原因`,
      });
    }
  });

  afterAll(async () => {
    await verifierPool.end();
    await store.onModuleDestroy();
    await service.onModuleDestroy();
    await workpapers.onModuleDestroy();
  });

  it("creates two isolated project graphs and refuses a duplicate source task", async () => {
    await expect(
      service.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608128",
        projectId: "PRJ-CLIENT-CONTROLLED",
      }),
    ).rejects.toThrow("无效的项目创建请求");
    const legacy = await service.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
    const concurrentCreates = await Promise.allSettled([
      service.createProject({ actor: "PMC", sourceTaskId: "SO-202608136" }),
      service.createProject({ actor: "PMC", sourceTaskId: "SO-202608136" }),
    ]);
    const created = concurrentCreates.filter(
      (result): result is PromiseFulfilledResult<Project> =>
        result.status === "fulfilled",
    );
    const rejected = concurrentCreates.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain("该问题已经建立咨询任务");
    const second = created[0]?.value;
    if (!second)
      throw new Error("Concurrent create must return one second project");

    legacyId = legacy.id;
    secondId = second.id;

    const material = await service.importTaskMaterial(
      "SO-202608136",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "VS14 根因核验材料",
        note: "使第二任务遵循 VS16 确认底稿流程。",
        requestId: "14111111-1111-4111-8111-111111111111",
      },
      (() => {
        const buffer = Buffer.from("日期,负荷率\n2026-08-26,93%");
        return {
          originalName: "vs14-capacity.csv",
          buffer,
          size: buffer.length,
        };
      })(),
    );
    const candidate = await workpapers.candidate(secondId, {
      actor: "PMC",
      requestId: "14111111-1111-4111-8111-111111111112",
      expectedRevision: 0,
      materialIds: [material.id],
    });
    if (!candidate.current)
      throw new Error("VS16 candidate workpaper is required");
    await workpapers.complete(secondId, {
      actor: "PMC",
      requestId: "14111111-1111-4111-8111-111111111113",
      expectedRevision: candidate.revision,
      content: {
        ...candidate.current.content,
        materialFindings: candidate.current.content.materialFindings.map(
          (finding) => ({
            ...finding,
            assessment: "SUPPORTS" as const,
            verificationStatus: "EMPLOYEE_CHECKED" as const,
            note: "PMC 已核对 VS14 产能材料。",
          }),
        ),
        conclusion: {
          result: "SUPPORTS",
          statement: "VS14 第二任务已由 PMC 在确认底稿中核验产能负荷风险。",
          limitations: "仅覆盖本地脱敏材料。",
          nextChecks: ["在方案中明确排产责任。"],
        },
      },
      completionNote: "VS14 使用真实 VS16 确认底稿推进根因阶段。",
      confirmedAcceptanceCriteria: candidate.workItem.acceptanceCriteria,
    });

    expect(legacy.id).toBe("PRJ-OTD-001");
    expect(second.id).not.toBe(legacy.id);
    expect(second.sourceTaskId).toBe("SO-202608136");
    expect(second.node.id).not.toBe(legacy.node.id);
    const legacyPhaseIds = new Set(legacy.phases.map((phase) => phase.id));
    const legacyTaskIds = new Set(
      legacy.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
    );
    expect(
      second.phases.filter((phase) => legacyPhaseIds.has(phase.id)),
    ).toEqual([]);
    expect(
      second.phases
        .flatMap((phase) => phase.tasks)
        .filter((task) => legacyTaskIds.has(task.id)),
    ).toEqual([]);
    const secondTask = await service.task("SO-202608136");
    expect(secondTask.evidence.map((item) => item.id)).toEqual([
      "E-ORDER-202608136",
      "E-BOM-202608136",
      "E-PURCHASE-202608136",
    ]);
    expect(
      secondTask.situations
        .flatMap((situation) => situation.requirements)
        .map((item) => item.evidenceId),
    ).not.toContain("E-BOM-128");
    const secondHistoricalTasks = second.phases
      .filter((phase) =>
        ["PROJECT_SCOPING", "BASELINE_FACTS", "ROOT_CAUSE_VALIDATION"].includes(
          phase.code,
        ),
      )
      .flatMap((phase) => phase.tasks)
      .filter((task) => task.origin !== "LIVE");
    expect(secondHistoricalTasks).toHaveLength(8);
    expect(
      secondHistoricalTasks.every(
        (task) =>
          task.output.locator?.sourceObjectId.startsWith("SRC-PROJECT-") &&
          task.output.locator.reference.includes("SRC-ORDERS-V1") &&
          task.output.locator.reference.includes("SRC-BOM-V1") &&
          task.output.locator.reference.includes("SRC-PURCHASES-V1"),
      ),
    ).toBe(true);
    expect(
      secondHistoricalTasks
        .find((task) => task.id.endsWith("SUB-CAUSE-002"))
        ?.process.map((step) => step.label),
    ).toEqual(
      expect.arrayContaining(["关联 BOM 完成晚 1 天", "关联采购启动晚 2 天"]),
    );
    expect(
      second.phases.find((phase) => phase.code === "SOLUTION_APPROVAL")
        ?.tasks[0]?.inputs,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: expect.stringContaining("E-BOM-202608136"),
        }),
      ]),
    );
    await expect(
      service.createProject({ actor: "PMC", sourceTaskId: "SO-202608136" }),
    ).rejects.toThrow("该问题已经建立咨询任务");

    const graphCounts = await verifierPool.query(
      "SELECT (SELECT count(*) FROM vs01_projects WHERE tenant_id = $1 AND source_task_id = $2)::int AS projects, (SELECT count(*) FROM vs01_project_nodes n JOIN vs01_projects p ON p.id = n.project_id WHERE n.tenant_id = $1 AND p.source_task_id = $2)::int AS nodes, (SELECT count(*) FROM vs01_project_phases ph JOIN vs01_projects p ON p.id = ph.project_id WHERE ph.tenant_id = $1 AND p.source_task_id = $2)::int AS phases, (SELECT count(*) FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id JOIN vs01_projects p ON p.id = n.project_id WHERE s.tenant_id = $1 AND p.source_task_id = $2)::int AS subtasks",
      ["tenant-demo", "SO-202608136"],
    );
    expect(graphCounts.rows[0]).toMatchObject({
      projects: 1,
      nodes: 1,
      phases: 7,
      subtasks: second.phases.flatMap((phase) => phase.tasks).length,
    });

    const dashboard = await service.employee();
    expect(dashboard.projects).toHaveLength(2);
    expect(dashboard.projects.map((project) => project.id)).toEqual(
      expect.arrayContaining([legacy.id, second.id]),
    );
    expect(await service.project(legacy.id)).toMatchObject({
      id: legacy.id,
      sourceTaskId: "SO-202608128",
    });
    expect(await service.project(second.id)).toMatchObject({
      id: second.id,
      sourceTaskId: "SO-202608136",
    });
  });

  it("keeps a second-project work item and assistant event out of the legacy project", async () => {
    const [legacy, second] = await Promise.all([
      service.project(legacyId),
      service.project(secondId),
    ]);
    const secondSolution = second.phases
      .find((phase) => phase.code === "SOLUTION_APPROVAL")
      ?.tasks.find((task) => task.owner === "PMC" && task.status === "READY");
    if (!secondSolution)
      throw new Error("Second project needs a ready solution work item");

    await service.updateSubtask(secondSolution.id, {
      actor: "PMC",
      status: "IN_PROGRESS",
      note: "仅推进第二咨询任务的方案比较",
      outputReference: "第二任务方案比较草稿",
    });

    const [legacyAfter, secondAfter] = await Promise.all([
      service.project(legacy.id),
      service.project(second.id),
    ]);
    expect(legacyAfter.auditTrail).toEqual(legacy.auditTrail);
    expect(
      legacyAfter.phases
        .flatMap((phase) => phase.tasks)
        .some((task) => task.progressUpdate?.note.includes("第二咨询任务")),
    ).toBe(false);
    expect(
      secondAfter.phases
        .flatMap((phase) => phase.tasks)
        .find((task) => task.id === secondSolution.id)?.progressUpdate?.note,
    ).toBe("仅推进第二咨询任务的方案比较");
    await expect(
      service.approveOutcome(second.id, { actor: "OWNER" }),
    ).rejects.toThrow("结果审批仅用于旧项目历史补偿");
    await expect(
      service.returnOutcome(second.id, {
        actor: "OWNER",
        reason: "动态咨询任务由责任员工确认结果",
      }),
    ).rejects.toThrow("结果审批仅用于旧项目历史补偿");
  });

  it("keeps persistent assistant runs, current context, and work events in their project scope", async () => {
    const legacyScope = assistantScopeFromRequest(legacyId, "PMC");
    const secondScope = assistantScopeFromRequest(secondId, "PMC");
    const [legacyRun, secondRun, legacyContext, secondContext, secondEvents] =
      await Promise.all([
        assistant.createRun(legacyScope, { intent: "NEXT_ACTION" }),
        assistant.createRun(secondScope, { intent: "NEXT_ACTION" }),
        context.currentWorkContext(legacyScope),
        context.currentWorkContext(secondScope),
        context.recentWorkEvents(secondScope),
      ]);

    expect(legacyRun).toMatchObject({
      projectId: legacyId,
      sourceTaskId: "SO-202608128",
      classification: "PROPOSAL",
    });
    expect(secondRun).toMatchObject({
      projectId: secondId,
      sourceTaskId: "SO-202608136",
      classification: "PROPOSAL",
    });
    expect(legacyContext.data?.project).toMatchObject({ id: legacyId });
    expect(secondContext.data?.project).toMatchObject({ id: secondId });
    expect(secondEvents.status).toBe("OK");
    expect(secondEvents.data?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: secondId,
          sourceTaskId: "SO-202608136",
        }),
      ]),
    );
    expect(secondEvents.data?.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: legacyId }),
      ]),
    );

    const [legacyHistory, secondHistory] = await Promise.all([
      assistant.history(legacyScope),
      assistant.history(secondScope),
    ]);
    expect(legacyHistory.runs.every((run) => run.projectId === legacyId)).toBe(
      true,
    );
    expect(secondHistory.runs.every((run) => run.projectId === secondId)).toBe(
      true,
    );
  });

  it("advances only the second project from solution through a candidate experience", async () => {
    const legacyBefore = await service.project(legacyId);
    let second = await service.project(secondId);

    second = await completePhase(second, "SOLUTION_APPROVAL");
    second = await service.submitProject(second.id, { actor: "PMC" });
    second = await service.approveProject(second.id, { actor: "OWNER" });
    second = await completePhase(second, "EXECUTION_CONTROL");
    expect(second.status).toBe("RESULT_VALIDATION");
    second = await completePhase(second, "RESULT_ACCEPTANCE");
    second = await service.submitOutcome(second.id, {
      actor: "PMC",
      currentOtd: 83,
      evidenceReference: "VS14 第二咨询任务 OTD 重算表",
      conclusion: "第二咨询任务已按同口径确认 OTD 从 71% 提升至 83%",
      note: "仅用于本地脱敏集成验收",
    });
    expect(second.outcome.status).toBe("ACCEPTED");
    second = await completePhase(second, "KNOWLEDGE_CAPTURE");
    second = await service.createExperienceCandidate(second.id, {
      actor: "PMC",
      title: "第二咨询任务的 BOM 准备前置治理",
      applicableSituation: "工程变更已冻结的多品种小批量订单",
      businessProblem: "BOM 准备滞后导致采购和排产启动延迟",
      practice: "分类缺料与版本冲突，明确责任并日清补料",
      resultSummary: "OTD 从 71% 提升至 83%，已由责任员工确认",
      limitations: "仅适用于工程变更已冻结的订单",
    });

    expect(second.experienceCandidate).toMatchObject({
      id: `EXP-${secondId}`,
      status: "PENDING_REVIEW",
      revision: 1,
    });
    const legacyAfter = await service.project(legacyId);
    expect({
      status: legacyAfter.status,
      outcome: legacyAfter.outcome,
      auditTrail: legacyAfter.auditTrail,
      experienceCandidate: legacyAfter.experienceCandidate,
    }).toEqual({
      status: legacyBefore.status,
      outcome: legacyBefore.outcome,
      auditTrail: legacyBefore.auditTrail,
      experienceCandidate: legacyBefore.experienceCandidate,
    });
  });
});
