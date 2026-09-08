import { BadRequestException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { Vs01Service } from "./vs01.service";

const runIntegration =
  process.env.VS11_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs11";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS11 PostgreSQL guided agent analysis", () => {
  const service = new Vs01Service();

  beforeAll(async () => {
    await service.onModuleInit();
    await service.reset({ actor: "PMC" });
    await service.decideTask("SO-202608128", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "VS11 集成验收：确认候选原因",
    });
    await service.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
  });

  afterAll(async () => {
    await service.onModuleDestroy();
  });

  it("clarifies, plans, analyzes and records reversible feedback without advancing the project", async () => {
    const before = await service.project("PRJ-OTD-001");
    const inspected = await service.assistProject(before.id, {
      actor: "PMC",
      intent: "ASK",
      stageCode: "SOLUTION_APPROVAL",
      workflowAction: "INSPECT",
    });
    const required = inspected.workflow.clarifications.filter(
      (item) => item.required,
    );
    expect(required.length).toBeGreaterThan(0);

    await expect(
      service.assistProject(before.id, {
        actor: "PMC",
        intent: "ASK",
        stageCode: "SOLUTION_APPROVAL",
        workflowAction: "PLAN",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const clarificationAnswers = required.map((item) => ({
      questionId: item.id,
      answer: "没有可靠产能数据，本次只比较 BOM 治理方案并明确限制",
    }));
    const planned = await service.assistProject(before.id, {
      actor: "PMC",
      intent: "ASK",
      stageCode: "SOLUTION_APPROVAL",
      workflowAction: "PLAN",
      clarificationAnswers,
    });
    expect(planned.workflow.plan).toHaveLength(4);
    expect(
      planned.workflow.plan.filter((item) => item.executionMode === "PARALLEL"),
    ).toHaveLength(3);

    const analyzed = await service.assistProject(before.id, {
      actor: "PMC",
      intent: "ASK",
      stageCode: "SOLUTION_APPROVAL",
      workflowAction: "ANALYZE",
      clarificationAnswers,
      planConfirmed: true,
    });
    expect(analyzed.classification).toBe("PROPOSAL");
    expect(analyzed.workflow.step).toBe("VERIFICATION");
    expect(analyzed.workflow.verification).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "CHECK-NO-WRITE", status: "PASS" }),
      ]),
    );

    const afterAnalysis = await service.project(before.id);
    expect({
      status: afterAnalysis.status,
      progress: afterAnalysis.progress,
      phases: afterAnalysis.phases.map((phase) => [
        phase.code,
        phase.status,
        phase.completedTaskCount,
      ]),
      outcome: afterAnalysis.outcome.status,
      experience: afterAnalysis.experienceCandidate,
    }).toEqual({
      status: before.status,
      progress: before.progress,
      phases: before.phases.map((phase) => [
        phase.code,
        phase.status,
        phase.completedTaskCount,
      ]),
      outcome: before.outcome.status,
      experience: before.experienceCandidate,
    });

    const created = await service.createAssistantFeedback(before.id, {
      actor: "PMC",
      stageCode: "SOLUTION_APPROVAL",
      contextFingerprint: analyzed.workflow.contextFingerprint,
      issueType: "CONTEXT_GAP",
      assistantAnswer: analyzed.answer,
      feedback: "没有强调产能数据仍然待核验。",
      expectedBehavior: "先展示数据缺口，再给出带限制的方案建议。",
    });
    expect(created.status).toBe("PENDING_REVIEW");
    const withdrawn = await service.withdrawAssistantFeedback(
      before.id,
      created.id,
      { actor: "PMC", reason: "集成测试完成，撤回测试反馈" },
    );
    expect(withdrawn.status).toBe("WITHDRAWN");
    expect(await service.assistantFeedback(before.id)).toEqual([
      expect.objectContaining({
        id: created.id,
        status: "WITHDRAWN",
        withdrawnReason: "集成测试完成，撤回测试反馈",
      }),
    ]);

    const pool = (service as unknown as { pool: Pool }).pool;
    const eventCount = await pool.query(
      "SELECT count(*)::int AS count FROM vs01_assistant_feedback_events WHERE feedback_id = $1 AND tenant_id = $2",
      [created.id, "tenant-demo"],
    );
    expect(eventCount.rows[0]?.count).toBe(2);
    expect((await service.project(before.id)).status).toBe(before.status);
  });
});
