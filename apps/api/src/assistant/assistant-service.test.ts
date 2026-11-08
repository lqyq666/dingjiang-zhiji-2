import { BadRequestException } from "@nestjs/common";
import { expect, it } from "vitest";
import type { Pool } from "pg";

import type { Project } from "@dingjiang/contracts";
import type { ReadModelService } from "../read-model/read-model-service";
import { assistantContextFingerprint } from "./guided-analysis";
import { AssistantService } from "./assistant-service";

const tenantId = "tenant-demo";

it("builds AI advice from the complete consulting-task context without advancing state", async () => {
  const readModel = {
    project: async (): Promise<unknown> => undefined,
    task: async (): Promise<unknown> => undefined,
  };
  const pool = {} as unknown as Pool;
  const service = new AssistantService(
    pool,
    tenantId,
    readModel as unknown as ReadModelService,
  );
  const phaseCodes = [
    "PROJECT_SCOPING",
    "BASELINE_FACTS",
    "ROOT_CAUSE_VALIDATION",
    "SOLUTION_APPROVAL",
    "EXECUTION_CONTROL",
    "RESULT_ACCEPTANCE",
    "KNOWLEDGE_CAPTURE",
  ] as const;
  const project = {
    id: "PRJ-OTD-001",
    sourceTaskId: "SO-202608128",
    name: "解决订单延期问题",
    status: "RUNNING",
    progress: 25,
    phases: phaseCodes.map((code) => ({
      id: `PHASE-${code}`,
      code,
      name:
        code === "EXECUTION_CONTROL"
          ? "落实解决措施"
          : code === "SOLUTION_APPROVAL"
            ? "定下解决方案"
            : code,
      status:
        code === "EXECUTION_CONTROL"
          ? "IN_PROGRESS"
          : ["RESULT_ACCEPTANCE", "KNOWLEDGE_CAPTURE"].includes(code)
            ? "LOCKED"
            : "COMPLETED",
      progress: code === "EXECUTION_CONTROL" ? 25 : 100,
      completedTaskCount: code === "EXECUTION_CONTROL" ? 1 : 1,
      totalTaskCount: code === "EXECUTION_CONTROL" ? 2 : 1,
      tasks: [
        {
          id: `TASK-${code}`,
          title: code === "EXECUTION_CONTROL" ? "补齐缺失 BOM 材料" : code,
          owner: "PMC",
          status: code === "EXECUTION_CONTROL" ? "READY" : "DONE",
          inputs:
            code === "EXECUTION_CONTROL"
              ? [
                  {
                    label: "缺失 BOM/变更资料",
                    status: "MISSING",
                    reference: null,
                  },
                ]
              : [],
          progressUpdate: null,
          completionNote: code === "EXECUTION_CONTROL" ? "" : "历史事项已完成",
          output: { reference: null, locator: null },
        },
      ],
    })),
    outcome: {
      baseline: 71,
      current: null,
      target: 85,
      status: "NOT_MEASURED",
      locator: null,
      evidenceReference: null,
      conclusion: null,
    },
    experienceCandidate: null,
    publishedExperienceHistory: false,
    experienceReferences: [
      {
        id: "REF-136-001",
        taskId: "SO-202608136",
        experienceId: "FORMAL-EXP-001",
        status: "ACTIVE",
        classification: "PROPOSAL",
        title: "BOM准备前置治理",
        applicableSituation: "多品种小批量订单进入排产前",
        limitations: "采购到货风险为主因时不适用",
        note: "用于核对当前订单，不直接套用结论",
        createdBy: "PMC",
        createdAt: "2026-08-17T00:00:00.000Z",
        withdrawnAt: null,
        withdrawnReason: null,
        experienceLocator: {
          sourceObjectId: "SRC-EXPERIENCE-001",
          sourceVersionId: "SRC-EXPERIENCE-001-V1",
          reference: "正式经验 FORMAL-EXP-001 第1版",
        },
      },
    ],
    auditTrail: [
      {
        eventType: "PROJECT_APPROVED",
        phaseCode: "SOLUTION_APPROVAL",
        note: "方案已批准",
        actor: "OWNER",
        createdAt: "2026-08-17T00:00:00.000Z",
      },
    ],
  };
  readModel.project = async () => project as never;
  readModel.task = async () =>
    ({
      evidence: [{ sourceVersionId: "SRC-ORDERS-V1" }],
      experienceReferences: project.experienceReferences,
    }) as never;

  const response = await service.assistProject("PRJ-OTD-001", {
    actor: "PMC",
    intent: "NEXT_ACTION",
  });

  expect(response.classification).toBe("PROPOSAL");
  expect(response.context.currentStage).toMatchObject({
    code: "EXECUTION_CONTROL",
    name: "落实解决措施",
    completedItemCount: 1,
    totalItemCount: 2,
  });
  expect(response.context.coverage).toMatchObject({
    stageCount: 7,
    workItemCount: 7,
    evidenceCount: 2,
    materialGapCount: 1,
    activityCount: 1,
    experienceReferenceCount: 1,
  });
  expect(response.context.experienceReferences).toHaveLength(1);
  expect(response.context.stages).toHaveLength(7);
  expect(response.context.workItems).toHaveLength(7);
  expect(response.context.materials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        input: "缺失 BOM/变更资料",
        status: "MISSING",
      }),
    ]),
  );
  expect(response.context).toMatchObject({
    sourceTaskId: "SO-202608128",
    materialGaps: expect.arrayContaining([
      expect.objectContaining({
        input: "缺失 BOM/变更资料",
        situationCode: "BOM_DELAY",
      }),
    ]),
  });

  const selectedStageResponse = await service.assistProject("PRJ-OTD-001", {
    actor: "PMC",
    intent: "ASK",
    stageCode: "SOLUTION_APPROVAL",
    question: "这个节点完成了吗？",
  });
  expect(selectedStageResponse.answer).toContain(
    "“定下解决方案”节点已完成 1/1 项（100%）",
  );
  expect(selectedStageResponse.answer).toContain("本节点没有待完成事项");
  expect(selectedStageResponse.context.currentStage.code).toBe(
    "EXECUTION_CONTROL",
  );
  expect(response.context.recentActivities[0]).toMatchObject({
    eventType: "PROJECT_APPROVED",
    actor: "OWNER",
  });
  expect(response.context.experienceReferences[0]).toMatchObject({
    classification: "PROPOSAL",
    title: "BOM准备前置治理",
  });
  expect(response.context.nextAction).toContain("补齐缺失 BOM 材料");
  expect(response.experienceDraft).toBeNull();
  expect(response.workflow).toMatchObject({
    stageCode: "EXECUTION_CONTROL",
    step: "CLARIFY",
  });
  const requiredClarifications = response.workflow.clarifications.filter(
    (item) => item.required,
  );
  expect(requiredClarifications.length).toBeGreaterThan(0);

  await expect(
    service.assistProject("PRJ-OTD-001", {
      actor: "PMC",
      stageCode: "EXECUTION_CONTROL",
      workflowAction: "PLAN",
    }),
  ).rejects.toBeInstanceOf(BadRequestException);

  const clarificationAnswers = requiredClarifications.map((item) => ({
    questionId: item.id,
    answer: `已确认：${item.question}`,
  }));
  const planned = await service.assistProject("PRJ-OTD-001", {
    actor: "PMC",
    stageCode: "EXECUTION_CONTROL",
    workflowAction: "PLAN",
    clarificationAnswers,
  });
  expect(planned.workflow.step).toBe("PLAN");
  expect(planned.workflow.plan.length).toBeGreaterThanOrEqual(3);
  expect(planned.workflow.plan[0]).toMatchObject({
    inputs: expect.any(Array),
    output: expect.any(String),
    dependsOn: expect.any(Array),
    completionCheck: expect.any(String),
  });

  await expect(
    service.assistProject("PRJ-OTD-001", {
      actor: "PMC",
      stageCode: "EXECUTION_CONTROL",
      workflowAction: "ANALYZE",
      clarificationAnswers,
    }),
  ).rejects.toBeInstanceOf(BadRequestException);

  const analyzed = await service.assistProject("PRJ-OTD-001", {
    actor: "PMC",
    stageCode: "EXECUTION_CONTROL",
    workflowAction: "ANALYZE",
    clarificationAnswers,
    planConfirmed: true,
  });
  expect(analyzed.classification).toBe("PROPOSAL");
  expect(analyzed.workflow.step).toBe("VERIFICATION");
  expect(
    analyzed.workflow.plan.every((item) => item.status === "COMPLETED"),
  ).toBe(true);
  expect(analyzed.workflow.verification).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "CHECK-NO-WRITE", status: "PASS" }),
    ]),
  );

  readModel.project = async () =>
    ({
      ...project,
      status: "KNOWLEDGE_CAPTURE",
      outcome: {
        ...project.outcome,
        current: 83,
        status: "ACCEPTED",
        evidenceReference: "OTD 结果复核表 v1",
      },
      phases: project.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((item) => ({ ...item, status: "DONE" })),
      })),
    }) as never;
  readModel.task = async () =>
    ({
      order: { orderId: "SO-202608128", delayDays: 5 },
      evidence: [{ sourceVersionId: "SRC-ORDERS-V1" }],
      experienceReferences: project.experienceReferences,
    }) as never;

  const draftResponse = await service.assistProject("PRJ-OTD-001", {
    actor: "PMC",
    intent: "EXPERIENCE_DRAFT",
  });

  expect(draftResponse.experienceDraft).toMatchObject({
    title: "BOM 准备滞后订单的交付恢复做法",
    resultSummary: expect.stringContaining("71%"),
    evidenceReference: "OTD 结果复核表 v1",
  });
  expect(draftResponse.answer).toContain("人工复核");
});

it("records and compensates Teach feedback without changing project state", async () => {
  const statements: string[] = [];
  const eventTypes: string[] = [];
  const client = {
    query: async (statement: string, values?: unknown[]) => {
      statements.push(statement);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
        return { rows: [], rowCount: 0 };
      if (statement.includes("INSERT INTO vs01_assistant_feedback_candidates"))
        return {
          rows: [{ created_at: "2026-08-17T08:00:00.000Z" }],
          rowCount: 1,
        };
      if (statement.includes("INSERT INTO vs01_assistant_feedback_events")) {
        eventTypes.push(
          statement.includes("'WITHDRAWN'") ? "WITHDRAWN" : "SUBMITTED",
        );
        return { rows: [], rowCount: 1 };
      }
      if (
        statement.includes("FROM vs01_assistant_feedback_candidates") &&
        statement.includes("FOR UPDATE")
      )
        return {
          rows: [
            {
              id: "AFC-001",
              project_id: "PRJ-OTD-001",
              phase_code: "EXECUTION_CONTROL",
              status: "PENDING_REVIEW",
              created_at: "2026-08-17T08:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      if (
        statement.startsWith(
          "UPDATE vs01_assistant_feedback_candidates SET status = 'WITHDRAWN'",
        )
      )
        return {
          rows: [{ withdrawn_at: "2026-08-17T08:05:00.000Z" }],
          rowCount: 1,
        };
      throw new Error(`Unexpected statement: ${statement} ${values}`);
    },
    release: () => undefined,
  };
  const project = {
    id: "PRJ-OTD-001",
    status: "RUNNING",
    phases: [
      {
        code: "EXECUTION_CONTROL",
        status: "IN_PROGRESS",
        progress: 50,
        tasks: [
          {
            id: "SUB-BOM-001",
            status: "IN_PROGRESS",
            inputs: [{ label: "BOM 差异表", status: "UNVERIFIED" }],
            output: { locator: null },
          },
        ],
      },
    ],
    outcome: { status: "NOT_MEASURED", current: null },
    experienceCandidate: null,
    auditTrail: [],
  };
  const readModel = {
    project: async (): Promise<unknown> => undefined,
    task: async (): Promise<unknown> => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const service = new AssistantService(
    pool,
    tenantId,
    readModel as unknown as ReadModelService,
  );

  readModel.project = async () => project;
  const contextFingerprint = assistantContextFingerprint(
    project as unknown as Project,
    "EXECUTION_CONTROL",
  );

  const created = await service.createAssistantFeedback("PRJ-OTD-001", {
    actor: "PMC",
    stageCode: "EXECUTION_CONTROL",
    contextFingerprint,
    issueType: "CONTEXT_GAP",
    assistantAnswer: "建议直接完成事项。",
    feedback: "没有读取最新 BOM 差异表。",
    expectedBehavior: "应先提示核验 BOM 差异表版本。",
  });
  expect(created.status).toBe("PENDING_REVIEW");

  const withdrawn = await service.withdrawAssistantFeedback(
    "PRJ-OTD-001",
    "AFC-001",
    { actor: "PMC", reason: "误选回答，需要重新登记" },
  );
  expect(withdrawn.status).toBe("WITHDRAWN");
  expect(eventTypes).toEqual(["SUBMITTED", "WITHDRAWN"]);
  expect(
    statements.some(
      (statement) =>
        statement.startsWith("UPDATE vs01_projects") ||
        statement.startsWith("UPDATE vs01_project_subtasks") ||
        statement.startsWith("UPDATE vs01_project_phases"),
    ),
  ).toBe(false);
});
