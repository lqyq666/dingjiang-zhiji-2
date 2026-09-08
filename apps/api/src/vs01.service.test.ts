import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { Vs01Service } from "./vs01.service";

describe("OWNER read projections", () => {
  it("keeps OWNER high-risk joins inside the tenant and out of acceptance data", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("b.tenant_id = o.tenant_id");
      expect(statement).toContain("p.tenant_id = o.tenant_id");
      expect(statement).toContain("o.status <> 'E2E_ACCEPTANCE'");
      expect(values).toEqual(["tenant-demo", false]);
      return { rowCount: 0, rows: [] };
    });
    const service = new Vs01Service() as unknown as {
      pool: Pool;
      highRiskOrders(includeAcceptance?: boolean): Promise<unknown[]>;
    };
    service.pool = { query } as unknown as Pool;

    await service.highRiskOrders(false);

    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps NON_PRODUCTION acceptance projects out of the OWNER list", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("o.status <> 'E2E_ACCEPTANCE'");
      expect(values).toEqual(["tenant-demo", false]);
      return { rowCount: 0, rows: [] };
    });
    const service = new Vs01Service() as unknown as {
      pool: Pool;
      projects(includeAcceptance?: boolean): Promise<unknown[]>;
    };
    service.pool = { query } as unknown as Pool;

    await service.projects(false);

    expect(query).toHaveBeenCalledOnce();
  });

  it("projects only the three traceable operating data sources", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("WHERE o.tenant_id = $1");
      expect(statement).toContain("E2E_ACCEPTANCE");
      expect(values).toEqual([
        "tenant-demo",
        ["SRC-ORDERS", "SRC-BOM", "SRC-PURCHASES"],
      ]);
      return {
        rowCount: 1,
        rows: [
          {
            source_object_id: "SRC-ORDERS",
            source_version_id: "SRC-ORDERS-V1",
            file_name: "orders.csv",
            version_number: 1,
            record_count: 2,
          },
        ],
      };
    });
    const service = new Vs01Service() as unknown as {
      pool: Pool;
      ownerDataSources(): Promise<unknown[]>;
    };
    service.pool = { query } as unknown as Pool;

    await expect(service.ownerDataSources()).resolves.toEqual([
      {
        sourceObjectId: "SRC-ORDERS",
        sourceVersionId: "SRC-ORDERS-V1",
        fileName: "orders.csv",
        category: "ORDER",
        versionNumber: 1,
        recordCount: 2,
        status: "AVAILABLE",
      },
    ]);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("PMC read projections", () => {
  it("keeps NON_PRODUCTION acceptance fixtures out of the employee workspace", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("o.status <> 'E2E_ACCEPTANCE'");
      expect(values).toEqual(["tenant-demo"]);
      return { rowCount: 0, rows: [] };
    });
    const projects = vi.fn(async () => []);
    const highRiskOrders = vi.fn(async () => []);
    const service = new Vs01Service() as unknown as {
      pool: Pool;
      projects(includeAcceptance?: boolean): Promise<unknown[]>;
      highRiskOrders(includeAcceptance?: boolean): Promise<unknown[]>;
      employee(): Promise<unknown>;
    };
    service.pool = { query } as unknown as Pool;
    service.projects = projects;
    service.highRiskOrders = highRiskOrders;

    await service.employee();

    expect(projects).toHaveBeenCalledWith(false);
    expect(highRiskOrders).toHaveBeenCalledWith(false);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("VS01 task decision seam", () => {
  it("reads only the tenant's published formal experience and maps its traceability receipt", async () => {
    const query = async (statement: string, values?: unknown[]) => {
      expect(statement).toContain(
        "WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED'",
      );
      expect(values).toEqual(["FORMAL-EXP-001", "tenant-demo"]);
      return {
        rowCount: 1,
        rows: [
          {
            id: "FORMAL-EXP-001",
            candidate_id: "EXP-CANDIDATE-001",
            source_project_id: "PRJ-OTD-001",
            source_task_id: "SO-202608128",
            status: "PUBLISHED",
            title: "BOM 准备前置治理",
            applicable_situation: "多品种小批量订单进入排产前",
            business_problem: "交付延期",
            practice: "在排产前核对 BOM 齐套情况",
            result_summary: "减少因缺料造成的排产返工",
            limitations: "采购到货风险为主因时不适用",
            published_at: "2026-08-26T01:02:03.000Z",
            retracted_at: null,
            retracted_reason: null,
            source_object_id: "SRC-FORMAL-001",
            source_version_id: "SRC-FORMAL-001-V2",
            candidate_source_object_id: "SRC-CANDIDATE-001",
            candidate_source_version_id: "SRC-CANDIDATE-001-V1",
            evidence_source_object_id: "SRC-RESULT-001",
            evidence_source_version_id: "SRC-RESULT-001-V1",
            structured_card: null,
            coze_index_status: "INDEXED",
            coze_execute_id: "coze-exec-001",
            coze_debug_url: "https://coze.cn/debug/001",
            coze_indexed_at: "2026-08-26T01:04:05.000Z",
          },
        ],
      };
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = { query } as unknown as Pool;

    await expect(service.experience("FORMAL-EXP-001")).resolves.toMatchObject({
      id: "FORMAL-EXP-001",
      locator: {
        sourceObjectId: "SRC-FORMAL-001",
        sourceVersionId: "SRC-FORMAL-001-V2",
        reference: "BOM 准备前置治理",
      },
      cozeIndex: {
        status: "INDEXED",
        executeId: "coze-exec-001",
        debugUrl: "https://coze.cn/debug/001",
        indexedAt: "2026-08-26T01:04:05.000Z",
      },
    });
  });

  it("does not expose a formal experience that is absent, retracted, or outside the tenant", async () => {
    const query = async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("tenant_id = $2");
      expect(statement).toContain("status = 'PUBLISHED'");
      expect(values).toEqual(["FORMAL-EXP-404", "tenant-demo"]);
      return { rowCount: 0, rows: [] };
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = { query } as unknown as Pool;

    await expect(service.experience("FORMAL-EXP-404")).rejects.toMatchObject({
      message: "正式经验不存在或已撤回",
    });
  });

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

  it("keeps a pending candidate unchanged when its project is not ready to publish", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        if (statement === "BEGIN" || statement === "ROLLBACK") {
          return { rowCount: 0, rows: [] };
        }
        if (statement.includes("SELECT c.*, r.source_object_id")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "EXP-PENDING-001",
                status: "PENDING_REVIEW",
                candidate_source_version_id: "SRC-CANDIDATE-V1",
                project_id: "PRJ-PARTIAL-001",
              },
            ],
          };
        }
        if (statement.includes("SELECT p.status AS project_status")) {
          return {
            rowCount: 1,
            rows: [{ project_status: "RUNNING", result_status: "ACCEPTED" }],
          };
        }
        if (statement.includes("SELECT code, gate_status")) {
          return {
            rowCount: 7,
            rows: [
              { code: "PROJECT_SCOPING", gate_status: "APPROVED" },
              { code: "BASELINE_FACTS", gate_status: "APPROVED" },
              { code: "ROOT_CAUSE_VALIDATION", gate_status: "APPROVED" },
              { code: "SOLUTION_APPROVAL", gate_status: "APPROVED" },
              { code: "EXECUTION_CONTROL", gate_status: "IN_PROGRESS" },
              { code: "RESULT_ACCEPTANCE", gate_status: "APPROVED" },
              { code: "KNOWLEDGE_CAPTURE", gate_status: "PENDING" },
            ],
          };
        }
        throw new Error(`Unexpected query: ${statement}`);
      }),
      release: vi.fn(),
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;

    await expect(
      service.approveExperienceCandidate("EXP-PENDING-001", {
        actor: "EXPERT_REVIEWER",
        expectedCandidateVersionId: "SRC-CANDIDATE-V1",
      }),
    ).rejects.toMatchObject({
      message:
        "请先进入“总结可复用做法”，完成前置阶段并确认经营结果后再批准候选经验",
    });

    expect(
      statements.some((statement) =>
        statement.includes("INSERT INTO vs01_formal_experiences"),
      ),
    ).toBe(false);
    expect(
      statements.some((statement) =>
        statement.includes(
          "UPDATE vs01_experience_candidates SET status = 'APPROVED'",
        ),
      ),
    ).toBe(false);
    expect(
      statements.find((statement) =>
        statement.includes("SELECT p.status AS project_status"),
      ),
    ).toContain("JOIN vs01_result_validations rv");
    expect(
      statements.find((statement) =>
        statement.includes("SELECT p.status AS project_status"),
      ),
    ).toContain("FOR UPDATE OF p, rv");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
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

  it("creates seven phase templates and keeps the result/knowledge work locked", () => {
    const service = new Vs01Service() as unknown as {
      taskTemplates: () => Array<{
        phaseCode: string;
        status: string;
        inputs: unknown[];
        acceptance: unknown[];
      }>;
      activePhaseForProject: (status: string) => string | null;
    };
    const templates = service.taskTemplates();
    expect(new Set(templates.map((task) => task.phaseCode)).size).toBe(7);
    expect(
      templates
        .filter((task) => task.phaseCode === "PROJECT_SCOPING")
        .every((task) => task.status === "DONE"),
    ).toBe(true);
    expect(
      templates
        .filter((task) => task.phaseCode === "RESULT_ACCEPTANCE")
        .every((task) => task.status === "LOCKED"),
    ).toBe(true);
    expect(
      templates.every(
        (task) => task.inputs.length > 0 && task.acceptance.length > 0,
      ),
    ).toBe(true);
    expect(service.activePhaseForProject("RUNNING")).toBe("EXECUTION_CONTROL");
    expect(service.activePhaseForProject("RESULT_VALIDATION")).toBe(
      "RESULT_ACCEPTANCE",
    );
    expect(service.activePhaseForProject("COMPLETED")).toBeNull();
  });

  it("uses consulting-specific IPO instructions instead of one generic task shape", () => {
    const service = new Vs01Service() as unknown as {
      taskTemplates: () => Array<{
        id: string;
        inputs: Array<{ label: string; status: string }>;
        process: Array<{ label: string }>;
        expectedOutput: string;
        acceptance: string[];
      }>;
    };
    const templates = service.taskTemplates();
    const solution = templates.find((task) => task.id === "SUB-SOLUTION-001");
    const execution = templates.find((task) => task.id === "SUB-BOM-002");
    const knowledge = templates.find((task) => task.id === "SUB-KNOWLEDGE-003");
    expect(solution?.process.map((step) => step.label)).toContain(
      "比较预期影响、成本与风险",
    );
    expect(solution?.expectedOutput).toBe("BOM 治理方案比较表");
    expect(execution?.inputs).toContainEqual({
      label: "缺失 BOM/变更资料",
      status: "MISSING",
      reference: null,
    });
    expect(knowledge?.inputs).toContainEqual({
      label: "未核验产能风险",
      status: "UNVERIFIED",
      reference: null,
    });
    expect(knowledge?.acceptance).toContain("候选经验标为待专家审核");
  });

  it("routes unresolved project inputs to the matching material workbench", () => {
    const service = new Vs01Service() as unknown as {
      materialSituationForInput: (
        label: string,
      ) => "BOM_DELAY" | "PURCHASE_DELAY" | "CAPACITY_RISK" | null;
    };

    expect(service.materialSituationForInput("未核验产能风险")).toBe(
      "CAPACITY_RISK",
    );
    expect(service.materialSituationForInput("缺失 BOM/变更资料")).toBe(
      "BOM_DELAY",
    );
    expect(service.materialSituationForInput("供应商到货承诺")).toBe(
      "PURCHASE_DELAY",
    );
    expect(service.materialSituationForInput("原因证据链")).toBeNull();
  });

  it("builds AI advice from the complete consulting-task context without advancing state", async () => {
    const service = new Vs01Service();
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
            completionNote:
              code === "EXECUTION_CONTROL" ? "" : "历史事项已完成",
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
    service.project = async () => project as never;
    service.task = async () =>
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

    service.project = async () =>
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
    service.task = async () =>
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

  it("records only the first OPEN-to-DECIDED decision in one transaction", async () => {
    let taskStatus = "OPEN";
    let savedDecision: { type: string; note: string } | null = null;
    const statements: string[] = [];
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        statements.push(statement);
        if (
          statement === "BEGIN" ||
          statement === "COMMIT" ||
          statement === "ROLLBACK"
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (
          statement.includes("FROM vs01_tasks") &&
          statement.includes("FOR UPDATE")
        ) {
          return { rows: [{ status: taskStatus }], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO vs01_decisions")) {
          savedDecision = {
            type: String(values?.[2]),
            note: String(values?.[3]),
          };
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO vs01_decision_events")) {
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("UPDATE vs01_tasks SET status = 'DECIDED'")) {
          taskStatus = "DECIDED";
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;
    service.task = async () => ({ id: "SO-202608128" }) as never;

    await service.decideTask("SO-202608128", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "first decision",
    });
    await expect(
      service.decideTask("SO-202608128", {
        actor: "PMC",
        type: "MODIFIED",
        note: "must not replace",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(savedDecision).toEqual({
      type: "CONFIRMED",
      note: "first decision",
    });
    expect(
      statements.filter((statement) => statement === "BEGIN"),
    ).toHaveLength(2);
    expect(
      statements.filter((statement) => statement === "COMMIT"),
    ).toHaveLength(1);
    expect(
      statements.filter((statement) => statement === "ROLLBACK"),
    ).toHaveLength(1);
  });

  it("reopens a decided task while preserving a REVERTED audit event", async () => {
    let taskStatus = "DECIDED";
    let currentDecision: { type: string; note: string } | null = {
      type: "MODIFIED",
      note: "现场补充判断",
    };
    let revertedEvent: unknown[] | undefined;
    const statements: string[] = [];
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        statements.push(statement);
        if (
          statement === "BEGIN" ||
          statement === "COMMIT" ||
          statement === "ROLLBACK"
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (
          statement.includes("FROM vs01_tasks") &&
          statement.includes("FOR UPDATE")
        ) {
          return { rows: [{ status: taskStatus }], rowCount: 1 };
        }
        if (statement.includes("FROM vs01_projects")) {
          return { rows: [], rowCount: 0 };
        }
        if (
          statement.includes("FROM vs01_decisions") &&
          statement.includes("FOR UPDATE")
        ) {
          return { rows: [currentDecision], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO vs01_decision_events")) {
          revertedEvent = values;
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("DELETE FROM vs01_decisions")) {
          currentDecision = null;
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("UPDATE vs01_tasks SET status = 'OPEN'")) {
          taskStatus = "OPEN";
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;
    service.task = async () =>
      ({ id: "SO-202608128", status: taskStatus, decision: null }) as never;

    const result = await service.revertTaskDecision("SO-202608128", {
      actor: "PMC",
      reason: "误选了修改，需要重新判断",
    });

    expect(result).toMatchObject({ status: "OPEN", decision: null });
    expect(revertedEvent).toEqual([
      "SO-202608128",
      "tenant-demo",
      "MODIFIED",
      "现场补充判断",
      "误选了修改，需要重新判断",
    ]);
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
  });

  it("rejects a silent decision rollback after a project exists", async () => {
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement);
        if (
          statement === "BEGIN" ||
          statement === "COMMIT" ||
          statement === "ROLLBACK"
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (
          statement.includes("FROM vs01_tasks") &&
          statement.includes("FOR UPDATE")
        ) {
          return { rows: [{ status: "DECIDED" }], rowCount: 1 };
        }
        if (statement.includes("FROM vs01_projects")) {
          return { rows: [{ id: "PRJ-OTD-001" }], rowCount: 1 };
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;

    await expect(
      service.revertTaskDecision("SO-202608128", {
        actor: "PMC",
        reason: "误操作",
      }),
    ).rejects.toThrow("不能直接撤销");
    expect(statements).toContain("ROLLBACK");
    expect(
      statements.some((statement) =>
        statement.includes("DELETE FROM vs01_decisions"),
      ),
    ).toBe(false);
  });

  it("serializes project creation against decision rollback with the task row lock", async () => {
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement);
        if (
          statement === "BEGIN" ||
          statement === "COMMIT" ||
          statement === "ROLLBACK"
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (
          statement.includes("FROM vs01_tasks") &&
          statement.includes("FOR UPDATE")
        ) {
          return {
            rows: [{ id: "SO-202608128", status: "DECIDED" }],
            rowCount: 1,
          };
        }
        if (statement.includes("SELECT id FROM vs01_projects"))
          return { rows: [], rowCount: 0 };
        if (statement.includes("FROM vs01_orders o"))
          return {
            rows: [
              {
                order_id: "SO-202608128",
                promised_date: "2026-08-18",
                forecast_date: "2026-08-23",
                bom_delay: 4,
                purchase_delay: 3,
              },
            ],
            rowCount: 1,
          };
        if (statement.includes("FROM vs01_orders WHERE"))
          return {
            rows: [
              {
                order_id: "SO-202608128",
                promised_date: "2026-08-18",
                forecast_date: "2026-08-23",
                source_row: 2,
                source_version_id: "SRC-ORDERS-V1",
              },
            ],
            rowCount: 1,
          };
        if (
          statement.includes("INSERT INTO vs01_projects") ||
          statement.includes("INSERT INTO vs01_project_nodes") ||
          statement.includes("INSERT INTO vs01_project_phases") ||
          statement.includes("INSERT INTO vs01_result_validations") ||
          statement.includes("INSERT INTO vs01_project_subtasks") ||
          statement.includes("INSERT INTO vs01_source_objects") ||
          statement.includes("INSERT INTO vs01_source_versions")
        ) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;
    service.project = async () => ({ id: "PRJ-OTD-001" }) as never;

    await service.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });

    expect(
      statements.some(
        (statement) =>
          statement.includes("FROM vs01_tasks") &&
          statement.includes("FOR UPDATE"),
      ),
    ).toBe(true);
    expect(statements).toContain("COMMIT");
  });

  it("derives node progress from completed subtasks and can reopen work", async () => {
    let status = "READY";
    const events: string[] = [];
    const progresses: number[] = [];
    const auditSnapshots: string[] = [];
    let completionNote = "";
    let outputReference: string | null = null;
    let sourceObjectId: string | null = null;
    let sourceVersionId: string | null = null;
    let completedAt: string | null = null;
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
          return { rows: [], rowCount: 0 };
        if (statement.includes("FROM vs01_project_subtasks s"))
          return {
            rows: [
              {
                subtask_status: status,
                node_id: "NODE-BOM-001",
                project_id: "PRJ-OTD-001",
                project_status: "RUNNING",
                phase_code: "EXECUTION_CONTROL",
                origin: "LIVE",
                owner: "PMC",
                acceptance: ["口径或范围明确", "输出可追溯"],
                completion_note: completionNote,
                output_reference: outputReference,
                output_source_object_id: sourceObjectId,
                output_source_version_id: sourceVersionId,
                completed_at: completedAt,
              },
            ],
            rowCount: 1,
          };
        if (statement.startsWith("UPDATE vs01_project_subtasks")) {
          status = String(values?.[2]);
          completionNote = String(values?.[3]);
          if (status === "DONE") {
            outputReference = String(values?.[4]);
            sourceObjectId = String(values?.[5]);
            sourceVersionId = String(values?.[6]);
            completedAt = "2026-08-16T10:00:00.000Z";
          }
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO vs01_project_subtask_events")) {
          events.push(String(values?.[2]));
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO vs01_project_events")) {
          auditSnapshots.push(String(values?.[5]));
          return { rows: [], rowCount: 1 };
        }
        if (
          statement.includes("INSERT INTO vs01_source_objects") ||
          statement.includes("INSERT INTO vs01_source_versions")
        )
          return { rows: [], rowCount: 1 };
        if (statement.includes("count(*) FILTER"))
          return {
            rows: [{ total: 4, completed: status === "DONE" ? 1 : 0 }],
            rowCount: 1,
          };
        if (statement.startsWith("UPDATE vs01_project_nodes")) {
          progresses.push(Number(values?.[2]));
          return { rows: [], rowCount: 1 };
        }
        if (statement.startsWith("UPDATE vs01_project_phases"))
          return { rows: [], rowCount: 1 };
        if (statement.includes("INSERT INTO vs01_node_updates"))
          return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;
    service.project = async () => ({ id: "PRJ-OTD-001" }) as never;

    await service.updateSubtask("SUB-BOM-001", {
      actor: "PMC",
      status: "IN_PROGRESS",
      note: "正在核对分类依据",
      outputReference: "分类草稿 v0",
    });
    await service.updateSubtask("SUB-BOM-001", {
      actor: "PMC",
      status: "DONE",
      note: "已复核分类清单",
      outputReference: "BOM 分类清单 v1",
      confirmedAcceptanceCriteria: ["口径或范围明确", "输出可追溯"],
    });
    await service.updateSubtask("SUB-BOM-001", {
      actor: "PMC",
      status: "READY",
      note: "发现遗漏，重新打开",
    });

    expect(progresses).toEqual([0, 25, 0]);
    expect(events).toEqual(["PROGRESS_SAVED", "COMPLETED", "REOPENED"]);
    const reopened = JSON.parse(auditSnapshots[2] ?? "{}");
    expect(reopened.before).toMatchObject({
      status: "DONE",
      completionNote: "已复核分类清单",
      outputReference: "BOM 分类清单 v1",
      completedAt: "2026-08-16T10:00:00.000Z",
    });
    expect(reopened.before.locator).toMatchObject({
      sourceObjectId: expect.stringMatching(/^SRC-PROJECT-/),
      sourceVersionId: expect.stringMatching(/^SRC-PROJECT-VERSION-/),
      reference: "BOM 分类清单 v1",
    });
  });

  it("opens result validation when the employee confirms the final execution item", async () => {
    const statements: string[] = [];
    const projectEvents: unknown[][] = [];
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        statements.push(statement);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
          return { rows: [], rowCount: 0 };
        if (statement.includes("FROM vs01_project_subtasks s"))
          return {
            rows: [
              {
                subtask_status: "READY",
                node_id: "NODE-BOM-001",
                project_id: "PRJ-OTD-001",
                project_status: "RUNNING",
                phase_code: "EXECUTION_CONTROL",
                origin: "LIVE",
                owner: "PMC",
                acceptance: ["口径或范围明确", "输出可追溯"],
              },
            ],
            rowCount: 1,
          };
        if (statement.startsWith("UPDATE vs01_project_subtasks"))
          return { rows: [], rowCount: 1 };
        if (statement.includes("INSERT INTO vs01_project_events") && values)
          projectEvents.push(values);
        if (
          statement.includes("INSERT INTO vs01_project_subtask_events") ||
          statement.includes("INSERT INTO vs01_project_events") ||
          statement.includes("INSERT INTO vs01_source_objects") ||
          statement.includes("INSERT INTO vs01_source_versions") ||
          statement.startsWith("UPDATE vs01_project_nodes") ||
          statement.includes("INSERT INTO vs01_node_updates") ||
          statement.startsWith("UPDATE vs01_projects") ||
          statement.startsWith("UPDATE vs01_project_phases")
        )
          return { rows: [], rowCount: 1 };
        if (statement.includes("count(*) FILTER"))
          return { rows: [{ total: 4, completed: 4 }], rowCount: 1 };
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;
    service.project = async () => ({ id: "PRJ-OTD-001" }) as never;

    await service.updateSubtask("SUB-BOM-004", {
      actor: "PMC",
      status: "DONE",
      note: "执行任务全部完成",
      outputReference: "治理规则发布记录",
      confirmedAcceptanceCriteria: ["口径或范围明确", "输出可追溯"],
    });

    expect(statements).toContain(
      "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
    );
    expect(
      statements.some((statement) => statement.includes("RESULT_VALIDATION")),
    ).toBe(true);
    expect(
      statements.some(
        (statement) =>
          statement.includes("RESULT_ACCEPTANCE") &&
          statement.includes("status = 'READY'"),
      ),
    ).toBe(true);
    expect(
      projectEvents.some(
        (values) =>
          values[2] === "EXECUTION_CONFIRMED_BY_EMPLOYEE" &&
          values[3] === "EXECUTION_CONTROL",
      ),
    ).toBe(true);
  });

  it("returns an execution review without unlocking result work", async () => {
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
          return { rows: [], rowCount: 0 };
        if (statement.includes("FROM vs01_project_nodes"))
          return { rows: [{ id: "NODE-BOM-001" }], rowCount: 1 };
        if (statement.includes("FROM vs01_projects p JOIN vs01_project_phases"))
          return {
            rows: [{ project_status: "RUNNING", gate_status: "PENDING" }],
            rowCount: 1,
          };
        if (
          statement.startsWith("UPDATE vs01_project_phases") ||
          statement.includes("INSERT INTO vs01_project_events")
        )
          return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service();
    (service as unknown as { pool: Pool }).pool = {
      connect: async () => client,
    } as unknown as Pool;
    service.project = async () => ({ id: "PRJ-OTD-001" }) as never;

    await service.reviewExecutionPhase("PRJ-OTD-001", {
      actor: "PMC",
      decision: "RETURN",
      reason: "最后一项输出需要补充",
    });

    expect(statements.some((statement) => statement.includes("RETURNED"))).toBe(
      true,
    );
    expect(
      statements.some((statement) => statement.includes("RESULT_ACCEPTANCE")),
    ).toBe(false);
  });

  it("writes non-empty before/after snapshots for scheme submission and return", async () => {
    const snapshots: unknown[] = [];
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
          return { rows: [], rowCount: 0 };
        if (statement.includes("FROM vs01_projects p JOIN vs01_project_phases"))
          return {
            rows: [
              {
                project_status: "DRAFT",
                project_returned_reason: null,
                gate_status: "OPEN",
                gate_returned_reason: null,
              },
            ],
            rowCount: 1,
          };
        if (statement.startsWith("UPDATE vs01_projects"))
          return { rows: [], rowCount: 1 };
        if (statement.startsWith("UPDATE vs01_project_phases"))
          return { rows: [], rowCount: 1 };
        if (statement.includes("INSERT INTO vs01_project_events")) {
          snapshots.push(JSON.parse(String(values?.[5])));
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      release: () => undefined,
    };
    const service = new Vs01Service() as unknown as {
      pool: Pool;
      projectTransition: (
        id: string,
        next: string,
        allowed: string[],
        eventType: string,
        actor: "PMC" | "OWNER",
        note: string,
        gateStatus: string,
      ) => Promise<void>;
    };
    service.pool = { connect: async () => client } as unknown as Pool;

    await service.projectTransition(
      "PRJ-OTD-001",
      "PENDING_APPROVAL",
      ["DRAFT"],
      "PROJECT_SUBMITTED",
      "PMC",
      "",
      "PENDING",
    );
    await service.projectTransition(
      "PRJ-OTD-001",
      "RETURNED",
      ["PENDING_APPROVAL"],
      "PROJECT_RETURNED",
      "OWNER",
      "请补充成本影响",
      "RETURNED",
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      before: { projectStatus: "DRAFT", gateStatus: "OPEN" },
      after: { projectStatus: "PENDING_APPROVAL", gateStatus: "PENDING" },
    });
    expect(snapshots[1]).toMatchObject({
      after: {
        projectStatus: "RETURNED",
        projectReturnedReason: "请补充成本影响",
        gateStatus: "RETURNED",
      },
    });
  });

  it("records and compensates Teach feedback without changing project state", async () => {
    const statements: string[] = [];
    const eventTypes: string[] = [];
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        statements.push(statement);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
          return { rows: [], rowCount: 0 };
        if (
          statement.includes("INSERT INTO vs01_assistant_feedback_candidates")
        )
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
    const service = new Vs01Service() as unknown as {
      pool: Pool;
      project: (id: string) => Promise<unknown>;
      assistantContextFingerprint: (
        value: unknown,
        stageCode: string,
      ) => string;
      createAssistantFeedback: Vs01Service["createAssistantFeedback"];
      withdrawAssistantFeedback: Vs01Service["withdrawAssistantFeedback"];
    };
    service.pool = { connect: async () => client } as unknown as Pool;
    service.project = async () => project;
    const contextFingerprint = service.assistantContextFingerprint(
      project,
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
});
