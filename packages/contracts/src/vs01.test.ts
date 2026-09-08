import { describe, expect, it } from "vitest";

import {
  bossDashboardSchema,
  createProjectInputSchema,
  decisionInputSchema,
  decisionRevertInputSchema,
  employeeDashboardSchema,
  evidenceSchema,
  executionPhaseReviewInputSchema,
  experienceCandidateApproveInputSchema,
  experienceCandidateInputSchema,
  experienceCandidateRevisionSchema,
  experienceCandidateResubmitInputSchema,
  experienceCandidateReturnInputSchema,
  experienceCandidateWithdrawInputSchema,
  experienceReferenceInputSchema,
  experienceReferenceEventSchema,
  experienceReferenceSchema,
  experienceReferenceWithdrawInputSchema,
  formalExperienceRetractInputSchema,
  formalExperienceSchema,
  outcomeReopenInputSchema,
  assistantFeedbackInputSchema,
  assistantFeedbackListSchema,
  assistantFeedbackReceiptSchema,
  assistantFeedbackWithdrawInputSchema,
  guidedAnalysisWorkflowSchema,
  projectAssistantRequestSchema,
  projectAssistantResponseSchema,
  projectSubtaskStatusInputSchema,
  taskMaterialImportFieldsSchema,
  taskMaterialInputSchema,
  taskMaterialSchema,
  taskMaterialWithdrawInputSchema,
  taskAssistantResponseSchema,
} from "./vs01";

describe("VS01 public contracts", () => {
  it("freezes server-owned project identity and additive multi-engagement dashboards", () => {
    expect(
      createProjectInputSchema.parse({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      }),
    ).toEqual({ actor: "PMC", sourceTaskId: "SO-202608136" });
    expect(() =>
      createProjectInputSchema.parse({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
        projectId: "CLIENT-CONTROLLED",
      }),
    ).toThrow();

    expect(
      employeeDashboardSchema.parse({
        role: "PMC",
        highRiskOrders: [],
        pendingTaskIds: [],
        projects: [],
        project: null,
      }).projects,
    ).toEqual([]);
    expect(
      bossDashboardSchema.parse({
        role: "OWNER",
        otd: 71,
        targetOtd: 85,
        highRiskOrderCount: 0,
        highRiskOrders: [],
        pendingApprovalCount: 0,
        dataSources: [],
        projects: [],
        project: null,
      }).projects,
    ).toEqual([]);
  });

  it("accepts traceable evidence and rejects a header row", () => {
    const evidence = {
      id: "E-ORDER-128",
      sourceObjectId: "SRC-ORDERS",
      sourceVersionId: "SRC-ORDERS-V1",
      sourceFile: "orders.csv",
      sourceSheet: "订单明细",
      sourceRow: 2,
      fields: { orderId: "SO-202608128" },
      classification: "FACT" as const,
    };

    expect(evidenceSchema.parse(evidence).sourceRow).toBe(2);
    expect(() => evidenceSchema.parse({ ...evidence, sourceRow: 1 })).toThrow();
  });

  it("keeps decisions human-owned and subtask progress reversible", () => {
    expect(
      decisionInputSchema.parse({
        type: "CONFIRMED",
        note: "与现场一致",
        actor: "PMC",
      }).actor,
    ).toBe("PMC");
    expect(
      projectSubtaskStatusInputSchema.parse({
        actor: "PMC",
        status: "DONE",
        note: "已核对 BOM 分类清单",
        outputReference: "BOM 分类清单 v1",
        confirmedAcceptanceCriteria: ["分类口径一致", "输出可追溯"],
      }).status,
    ).toBe("DONE");
    expect(
      decisionRevertInputSchema.parse({
        actor: "PMC",
        reason: "误选了确认，需要重新判断",
      }).reason,
    ).toContain("重新判断");
    expect(() =>
      decisionRevertInputSchema.parse({ actor: "PMC", reason: "" }),
    ).toThrow();
    expect(() =>
      projectSubtaskStatusInputSchema.parse({
        actor: "PMC",
        status: "DONE",
        note: "缺少完成依据",
        confirmedAcceptanceCriteria: ["输出可追溯"],
      }),
    ).toThrow();
    expect(() =>
      projectSubtaskStatusInputSchema.parse({
        actor: "PMC",
        status: "DONE",
        note: "未由责任人确认验收标准",
        outputReference: "BOM 分类清单 v1",
      }),
    ).toThrow();
    expect(
      projectSubtaskStatusInputSchema.parse({
        actor: "PMC",
        status: "IN_PROGRESS",
        note: "已完成分类口径，正在核对责任人",
        outputReference: "BOM 分类清单草稿",
      }).status,
    ).toBe("IN_PROGRESS");
    expect(
      projectSubtaskStatusInputSchema.parse({
        actor: "PMC",
        status: "READY",
        note: "发现责任人填写错误，需要重新处理",
      }).status,
    ).toBe("READY");
  });

  it("keeps materials and the project assistant inside truthful seams", () => {
    expect(
      taskMaterialInputSchema.parse({
        actor: "PMC",
        situationCode: "BOM_DELAY",
        title: "BOM 差异清单",
        sourceReference: "共享盘/交付/BOM差异.xlsx",
      }).sourceReference,
    ).toContain("BOM");
    expect(projectAssistantRequestSchema.parse({ actor: "PMC" }).question).toBe(
      "",
    );
    expect(
      projectAssistantRequestSchema.parse({
        actor: "PMC",
        stageCode: "SOLUTION_APPROVAL",
      }).stageCode,
    ).toBe("SOLUTION_APPROVAL");
    expect(
      projectAssistantResponseSchema.parse({
        provider: "DEMO_RULES",
        classification: "PROPOSAL",
        answer: "下一步建议：完成 BOM 问题分类。",
        context: {
          projectId: "PRJ-OTD-001",
          sourceTaskId: "SO-202608128",
          workTitle: "解决订单延期问题",
          projectStatus: "RUNNING",
          currentStage: {
            code: "EXECUTION_CONTROL",
            name: "落实解决措施",
            progress: 25,
            completedItemCount: 1,
            totalItemCount: 4,
          },
          coverage: {
            stageCount: 7,
            workItemCount: 22,
            evidenceCount: 4,
            materialGapCount: 2,
            activityCount: 8,
            experienceReferenceCount: 0,
          },
          stages: [
            ["PROJECT_SCOPING", "界定任务", "COMPLETED", 100, 2, 2],
            ["BASELINE_FACTS", "核清事实", "COMPLETED", 100, 3, 3],
            ["ROOT_CAUSE_VALIDATION", "找到原因", "COMPLETED", 100, 3, 3],
            ["SOLUTION_APPROVAL", "定下方案", "COMPLETED", 100, 3, 3],
            ["EXECUTION_CONTROL", "落实措施", "IN_PROGRESS", 25, 1, 4],
            ["RESULT_ACCEPTANCE", "确认结果", "LOCKED", 0, 0, 3],
            ["KNOWLEDGE_CAPTURE", "总结做法", "LOCKED", 0, 0, 3],
          ].map(
            ([
              code,
              name,
              status,
              progress,
              completedItemCount,
              totalItemCount,
            ]) => ({
              code,
              name,
              status,
              progress,
              completedItemCount,
              totalItemCount,
            }),
          ),
          workItems: [
            {
              id: "SUB-BOM-CLASSIFY",
              stage: "落实措施",
              title: "完成 BOM 问题分类",
              owner: "PMC",
              status: "IN_PROGRESS",
              inputGapCount: 1,
              progressNote: "已核对分类口径",
              completionNote: null,
              outputReference: "BOM 分类清单草稿",
            },
          ],
          materials: [
            {
              stage: "落实措施",
              workItem: "补齐缺失 BOM 材料",
              input: "缺失 BOM/变更资料",
              requirementId: "REQ-BOM-CHANGE",
              status: "MISSING",
              reference: null,
            },
          ],
          recentActivities: [
            {
              eventType: "PROGRESS_SAVED",
              stage: "EXECUTION_CONTROL",
              note: "已核对分类口径",
              actor: "PMC",
              createdAt: "2026-08-17T08:00:00.000Z",
            },
          ],
          nextAction: "完成 BOM 问题分类",
          materialGaps: [
            {
              stage: "落实解决措施",
              workItem: "补齐缺失 BOM 材料",
              input: "缺失 BOM/变更资料",
              status: "MISSING",
              situationCode: "BOM_DELAY",
              requirementId: "REQ-BOM-CHANGE",
            },
          ],
          outcome: {
            before: 71,
            current: null,
            target: 85,
            status: "NOT_MEASURED",
            conclusion: null,
            evidenceReference: null,
          },
          experience: {
            candidateStatus: null,
            formalPublished: false,
            activeReferenceCount: 0,
          },
          experienceReferences: [],
        },
        workflow: {
          stageCode: "EXECUTION_CONTROL",
          step: "CLARIFY",
          contextFingerprint: "ctx-contract-fixture",
          clarifications: [
            {
              id: "CLARIFY-SCOPE",
              question: "本次分析重点是什么？",
              reason: "限定分析范围",
              required: false,
              answer: null,
            },
          ],
          plan: [],
          verification: [],
        },
        experienceDraft: null,
      }).classification,
    ).toBe("PROPOSAL");
  });

  it("freezes traceable material ingestion without exposing server scope", () => {
    expect(
      taskMaterialImportFieldsSchema.parse({
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "关键产线负荷记录",
        note: "用于核验产能风险，不代表事项完成",
        requestId: "de0cf0c8-58ee-4b0f-ae9d-4b112f30c9ab",
      }).requirementId,
    ).toBe("REQ-CAPACITY-LOAD");
    expect(() =>
      taskMaterialImportFieldsSchema.parse({
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "关键产线负荷记录",
        requestId: "de0cf0c8-58ee-4b0f-ae9d-4b112f30c9ab",
        tenantId: "CLIENT-CONTROLLED",
        sourceVersionId: "CLIENT-CONTROLLED",
      }),
    ).toThrow();

    const uploaded = taskMaterialSchema.parse({
      id: "15",
      situationCode: "CAPACITY_RISK",
      requirementId: "REQ-CAPACITY-LOAD",
      title: "关键产线负荷记录",
      sourceReference: "已入库：8月产线负荷.csv",
      note: "仅作为待核验输入",
      kind: "UPLOADED_FILE",
      status: "ACTIVE",
      locator: {
        sourceObjectId: "SRC-MATERIAL-001",
        sourceVersionId: "SRC-MATERIAL-VERSION-001",
        reference: "关键产线负荷记录 · v1",
      },
      file: {
        originalName: "8月产线负荷.csv",
        mediaType: "text/csv",
        byteSize: 128,
        sha256: "a".repeat(64),
        extractionStatus: "EXTRACTED",
        contentPreview: "产线,负荷率\nA线,92%",
        readableByAi: true,
      },
      withdrawnAt: null,
      withdrawnReason: null,
      createdBy: "PMC",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    expect(uploaded.locator?.sourceVersionId).toBe("SRC-MATERIAL-VERSION-001");
    expect(uploaded.file?.readableByAi).toBe(true);
    expect(
      taskMaterialWithdrawInputSchema.parse({
        actor: "PMC",
        reason: "误传了旧版负荷记录，需要停用该关联",
      }).reason,
    ).toContain("停用");
    expect(() =>
      taskMaterialWithdrawInputSchema.parse({ actor: "PMC", reason: "" }),
    ).toThrow();
  });

  it("models a stage-scoped clarify-plan-analyze-verify workflow without business writes", () => {
    expect(
      projectAssistantRequestSchema.parse({
        actor: "PMC",
        stageCode: "EXECUTION_CONTROL",
        workflowAction: "PLAN",
        clarificationAnswers: [
          { questionId: "CLARIFY-MATERIAL-1", answer: "先使用最新 BOM 差异表" },
        ],
      }).workflowAction,
    ).toBe("PLAN");
    expect(
      guidedAnalysisWorkflowSchema.parse({
        stageCode: "EXECUTION_CONTROL",
        step: "VERIFICATION",
        contextFingerprint: "ctx-123",
        clarifications: [
          {
            id: "CLARIFY-MATERIAL-1",
            question: "缺失材料如何处理？",
            reason: "输入状态为缺失",
            required: true,
            answer: "先使用最新 BOM 差异表",
          },
        ],
        plan: [
          {
            id: "WORK-CONTEXT",
            title: "核对事实与材料",
            objective: "识别缺口",
            inputs: ["当前节点事项", "输入材料"],
            output: "材料缺口清单",
            dependsOn: [],
            executionMode: "PARALLEL",
            status: "COMPLETED",
            finding: "发现 1 项待核验材料",
            evidenceReferences: ["orders.csv"],
            completionCheck: "所有缺口均标明状态",
          },
        ],
        verification: [
          {
            id: "CHECK-NO-WRITE",
            label: "业务状态未被 AI 改写",
            status: "PASS",
            detail: "仅返回候选分析",
          },
        ],
      }).step,
    ).toBe("VERIFICATION");
  });

  it("keeps Teach feedback as a reversible candidate rather than a live rule change", () => {
    const input = assistantFeedbackInputSchema.parse({
      actor: "PMC",
      stageCode: "EXECUTION_CONTROL",
      contextFingerprint: "ctx-123",
      issueType: "CONTEXT_GAP",
      assistantAnswer: "建议直接进入下一步。",
      feedback: "没有读取最新 BOM 差异表。",
      expectedBehavior: "应先提示核验 BOM 差异表版本。",
    });
    expect(input.issueType).toBe("CONTEXT_GAP");
    expect(
      assistantFeedbackReceiptSchema.parse({
        id: "AFC-001",
        projectId: "PRJ-OTD-001",
        stageCode: "EXECUTION_CONTROL",
        status: "PENDING_REVIEW",
        createdAt: "2026-08-17T08:00:00.000Z",
      }).status,
    ).toBe("PENDING_REVIEW");
    expect(
      assistantFeedbackWithdrawInputSchema.parse({
        actor: "PMC",
        reason: "误选了当前回答，需要重新登记",
      }).reason,
    ).toContain("重新登记");
    expect(
      assistantFeedbackListSchema.parse([
        {
          id: "AFC-001",
          projectId: "PRJ-OTD-001",
          stageCode: "EXECUTION_CONTROL",
          status: "WITHDRAWN",
          issueType: "CONTEXT_GAP",
          feedback: "没有读取最新 BOM 差异表。",
          expectedBehavior: "应先提示核验 BOM 差异表版本。",
          createdAt: "2026-08-17T08:00:00.000Z",
          withdrawnAt: "2026-08-17T08:05:00.000Z",
          withdrawnReason: "误选回答，需要重新登记",
        },
      ])[0]?.status,
    ).toBe("WITHDRAWN");
  });

  it("requires an employee reason before reopening a confirmed result", () => {
    expect(
      outcomeReopenInputSchema.parse({
        actor: "PMC",
        reason: "发现结果口径包含一笔应排除订单，需要重新确认",
      }).actor,
    ).toBe("PMC");
    expect(() =>
      outcomeReopenInputSchema.parse({ actor: "OWNER", reason: "越权更正" }),
    ).toThrow();
  });

  it("keeps execution phase review separate from work item completion", () => {
    expect(
      executionPhaseReviewInputSchema.parse({
        actor: "PMC",
        decision: "APPROVE",
        note: "已复核四项落实输出，可以进入结果确认",
      }).decision,
    ).toBe("APPROVE");
    expect(
      executionPhaseReviewInputSchema.parse({
        actor: "PMC",
        decision: "RETURN",
        reason: "BOM 发布记录仍需修正",
      }).decision,
    ).toBe("RETURN");
    expect(() =>
      executionPhaseReviewInputSchema.parse({
        actor: "OWNER",
        decision: "APPROVE",
        note: "越权复核",
      }),
    ).toThrow();
  });

  it("requires a compensating reason to withdraw a candidate and does not accept a discarded evidence field", () => {
    expect(
      experienceCandidateWithdrawInputSchema.parse({
        actor: "PMC",
        reason: "结果口径需要更正",
      }).reason,
    ).toContain("更正");
    expect(() =>
      experienceCandidateWithdrawInputSchema.parse({
        actor: "PMC",
        reason: "",
      }),
    ).toThrow();
    expect(experienceCandidateInputSchema.shape).not.toHaveProperty(
      "evidenceReference",
    );
  });

  it("separates expert review authority from project approval authority", () => {
    expect(
      experienceCandidateApproveInputSchema.parse({
        actor: "EXPERT_REVIEWER",
        expectedCandidateVersionId: "SRC-CANDIDATE-EXP-001-V2",
      }).actor,
    ).toBe("EXPERT_REVIEWER");
    expect(() =>
      experienceCandidateApproveInputSchema.parse({
        actor: "OWNER",
        expectedCandidateVersionId: "SRC-CANDIDATE-EXP-001-V2",
      }),
    ).toThrow();
    expect(() =>
      experienceCandidateReturnInputSchema.parse({
        actor: "EXPERT_REVIEWER",
        expectedCandidateVersionId: "SRC-CANDIDATE-EXP-001-V2",
        reason: "",
      }),
    ).toThrow();
  });

  it("requires an expected revision when a consultant resubmits returned content", () => {
    const parsed = experienceCandidateResubmitInputSchema.parse({
      actor: "PMC",
      expectedCandidateVersionId: "SRC-CANDIDATE-EXP-001-V1",
      title: "BOM 准备前置治理",
      applicableSituation: "多品种小批量订单进入排产前",
      businessProblem: "BOM 准备滞后导致交付风险",
      practice: "按缺料、版本冲突和责任人分类处理",
      resultSummary: "OTD 经业务负责人签收为 83%",
      limitations: "只适用于工程变更已冻结的订单",
    });

    expect(parsed.expectedCandidateVersionId).toContain("V1");
  });

  it("keeps formal experience content and result evidence on separate immutable locators", () => {
    const locator = {
      sourceObjectId: "SRC-EXPERIENCE-FE-001",
      sourceVersionId: "SRC-EXPERIENCE-FE-001-V1",
      reference: "正式经验 FE-001 第1版",
    };
    const formal = formalExperienceSchema.parse({
      id: "FE-001",
      candidateId: "EXP-OTD-001",
      sourceProjectId: "PRJ-OTD-001",
      sourceTaskId: "SO-202608128",
      status: "PUBLISHED",
      title: "BOM 准备前置治理",
      applicableSituation: "多品种小批量订单进入排产前",
      businessProblem: "BOM 准备滞后导致交付风险",
      practice: "按缺料、版本冲突和责任人分类处理",
      resultSummary: "OTD 经业务负责人签收为 83%",
      limitations: "只适用于工程变更已冻结的订单",
      publishedBy: "EXPERT_REVIEWER",
      publishedAt: "2026-08-16T10:00:00.000Z",
      retractedAt: null,
      retractedReason: null,
      locator,
      candidateLocator: {
        ...locator,
        sourceObjectId: "SRC-CANDIDATE-EXP-001",
        sourceVersionId: "SRC-CANDIDATE-EXP-001-V2",
        reference: "候选经验 EXP-OTD-001 第2版",
      },
      evidenceLocator: {
        ...locator,
        sourceObjectId: "SRC-PROJECT-PRJ-OTD-001-OUTCOME",
        sourceVersionId: "SRC-PROJECT-PRJ-OTD-001-OUTCOME-V1",
        reference: "OTD 结果验收 83%",
      },
    });

    expect(formal.locator.sourceVersionId).not.toBe(
      formal.evidenceLocator.sourceVersionId,
    );
  });

  it("classifies reused experience as a reversible proposal reference", () => {
    const parsed = experienceReferenceInputSchema.parse({
      actor: "PMC",
      experienceId: "FE-001",
      expectedExperienceVersionId: "SRC-EXPERIENCE-FE-001-V1",
      note: "用于核对当前订单的 BOM 风险，不直接套用结论",
    });
    expect(parsed.actor).toBe("PMC");
    expect(
      experienceReferenceSchema.parse({
        id: "REF-001",
        taskId: "SO-202608136",
        experienceId: "FE-001",
        status: "ACTIVE",
        classification: "PROPOSAL",
        title: "BOM 准备前置治理",
        applicableSituation: "多品种小批量订单进入排产前",
        limitations: "只适用于工程变更已冻结的订单",
        note: parsed.note,
        createdBy: "PMC",
        createdAt: "2026-08-16T11:00:00.000Z",
        withdrawnAt: null,
        withdrawnReason: null,
        experienceLocator: {
          sourceObjectId: "SRC-EXPERIENCE-FE-001",
          sourceVersionId: "SRC-EXPERIENCE-FE-001-V1",
          reference: "正式经验 FE-001 第1版",
        },
      }).classification,
    ).toBe("PROPOSAL");
    expect(() =>
      experienceReferenceWithdrawInputSchema.parse({
        actor: "PMC",
        reason: "",
      }),
    ).toThrow();
    expect(() =>
      formalExperienceRetractInputSchema.parse({
        actor: "EXPERT_REVIEWER",
        expectedExperienceVersionId: "SRC-EXPERIENCE-FE-001-V1",
        reason: "",
      }),
    ).toThrow();
  });

  it("keeps reference actions and candidate revisions as replayable records", () => {
    expect(
      experienceReferenceEventSchema.parse({
        id: "REF-EVENT-001",
        referenceId: "REF-001",
        taskId: "SO-202608136",
        experienceId: "FE-001",
        experienceTitle: "BOM 准备前置治理",
        eventType: "WITHDRAWN",
        actor: "PMC",
        note: "误选后撤回，等待重新核对",
        createdAt: "2026-08-16T11:30:00.000Z",
        snapshot: {
          before: { status: "ACTIVE" },
          after: { status: "WITHDRAWN" },
        },
      }).eventType,
    ).toBe("WITHDRAWN");

    expect(
      experienceCandidateRevisionSchema.parse({
        revision: 2,
        title: "BOM 准备前置治理",
        applicableSituation: "多品种小批量订单进入排产前",
        businessProblem: "BOM 准备滞后导致交付风险",
        practice: "按缺料、版本冲突和责任人分类处理",
        resultSummary: "OTD 经业务负责人签收为 83%",
        evidenceReference: "员工确认结果与版本化证据",
        limitations: "只适用于工程变更已冻结的订单",
        submittedAt: "2026-08-16T11:45:00.000Z",
        locator: {
          sourceObjectId: "SRC-CANDIDATE-EXP-001",
          sourceVersionId: "SRC-CANDIDATE-EXP-001-V2",
          reference: "候选经验 EXP-001 第2版",
        },
      }).revision,
    ).toBe(2);
  });

  it("exposes referenced formal experience in a diagnosis task AI context", () => {
    const parsed = taskAssistantResponseSchema.parse({
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      answer: "先核对当前订单事实，再把正式经验作为候选参考。",
      context: {
        taskId: "SO-202608136",
        workTitle: "处理订单延期：南方设备",
        taskStatus: "OPEN",
        order: {
          orderId: "SO-202608136",
          customer: "南方设备",
          promisedDate: "2026-08-20",
          forecastDate: "2026-08-23",
          delayDays: 3,
          primaryException: "BOM准备",
        },
        coverage: {
          evidenceCount: 3,
          materialCount: 0,
          materialGapCount: 2,
          experienceReferenceCount: 1,
        },
        decision: null,
        materialGaps: [
          {
            situation: "BOM 准备滞后",
            requirementId: "REQ-BOM-CHANGE",
            requirement: "BOM 差异或变更清单",
          },
        ],
        nextAction: "先补齐 BOM 差异或变更清单，再保存人工判断。",
        experienceReferences: [
          {
            id: "REF-136-001",
            taskId: "SO-202608136",
            experienceId: "FORMAL-EXP-001",
            status: "ACTIVE",
            classification: "PROPOSAL",
            title: "BOM 准备前置治理",
            applicableSituation: "工程变更已冻结的订单",
            limitations: "冻结前只用于风险排查",
            note: "候选参考，不替代当前事实",
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
      },
    });
    expect(parsed.context.coverage.experienceReferenceCount).toBe(1);
    expect(parsed.context.materialGaps[0]?.requirementId).toBe(
      "REQ-BOM-CHANGE",
    );
    expect(parsed.context.experienceReferences[0]?.classification).toBe(
      "PROPOSAL",
    );
  });
});
