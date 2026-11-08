import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  assistantFeedbackInputSchema,
  assistantFeedbackReceiptSchema,
  assistantFeedbackWithdrawInputSchema,
  projectAssistantRequestSchema,
  projectAssistantResponseSchema,
  taskAssistantRequestSchema,
  taskAssistantResponseSchema,
  type AssistantFeedbackReceipt,
  type GuidedAnalysisWorkflow,
  type ProjectAssistantResponse,
  type TaskAssistantResponse,
} from "@dingjiang/contracts";
import { materialSituationForInput } from "../read-model/projections";
import type { ReadModelService } from "../read-model/read-model-service";
import {
  answerConsultingQuestion,
  assistantContextFingerprint,
  currentWorkStage,
  experienceDraft as buildExperienceDraft,
  guidedAnalysisClarifications,
  guidedAnalysisPlan,
  guidedAnalysisVerification,
  nextConsultingAction,
} from "./guided-analysis";

/**
 * The assistant: it reads the full work context and proposes the next step.
 *
 * It never writes a business fact. Every method here produces a proposal
 * that a person still has to confirm, which is why the service needs the
 * read model but no transaction of its own beyond the one it is bound to.
 */
export class AssistantService {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private readonly tenantId: string;
  private readonly readModel: ReadModelService;

  constructor(
    pool: Pool,
    tenantId: string,
    readModel: ReadModelService,
    commandTransaction?: PoolClient,
  ) {
    this.pool = pool;
    this.tenantId = tenantId;
    this.readModel = readModel;
    this.commandTransaction = commandTransaction;
  }

  private get database() {
    return this.commandTransaction ?? this.pool;
  }

  async assistTask(id: string, input: unknown): Promise<TaskAssistantResponse> {
    const body = taskAssistantRequestSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的任务助手请求");
    const task = await this.readModel.task(id);
    const materialGaps = task.situations.flatMap((situation) =>
      situation.requirements
        .filter((requirement) => !requirement.fulfilled)
        .map((requirement) => ({
          situation: situation.label,
          requirementId: requirement.id,
          requirement: requirement.label,
        })),
    );
    const experienceReferences = task.experienceReferences.filter(
      (reference) => reference.status === "ACTIVE",
    );
    const nextAction = materialGaps.length
      ? `先补齐${materialGaps[0]?.requirement}`
      : task.decision
        ? "基于已确认判断进入方案与项目审批"
        : "核对事实与证据后保存人工判断";
    const referenceNote = experienceReferences.length
      ? `已找到 ${experienceReferences.length} 条正式经验引用，仅作候选参考，不替代当前人工判断。`
      : "当前没有有效正式经验引用，请以本任务证据和现场确认作为依据。";
    const intentPrefix =
      body.data.intent === "MATERIAL_GAPS"
        ? "材料检查："
        : body.data.intent === "RISK"
          ? "风险提示："
          : "建议：";
    return taskAssistantResponseSchema.parse({
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      answer: `${intentPrefix}${nextAction}。${referenceNote}${body.data.question ? ` 你关注的是：${body.data.question}` : ""}`,
      context: {
        taskId: task.id,
        workTitle: `处理订单 ${task.order.orderId} 的延期风险`,
        taskStatus: task.status,
        order: task.order,
        coverage: {
          evidenceCount: task.evidence.length,
          materialCount: task.materials.filter(
            (material) => material.status === "ACTIVE",
          ).length,
          materialGapCount: materialGaps.length,
          experienceReferenceCount: experienceReferences.length,
        },
        decision: task.decision
          ? { type: task.decision.type, note: task.decision.note }
          : null,
        materialGaps,
        materials: task.materials.filter(
          (material) => material.status === "ACTIVE",
        ),
        nextAction,
        experienceReferences,
      },
    });
  }

  async assistProject(
    id: string,
    input: unknown,
  ): Promise<ProjectAssistantResponse> {
    const body = projectAssistantRequestSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的 AI 工作助手请求");
    const project = await this.readModel.project(id);
    const sourceTask = await this.readModel.task(project.sourceTaskId);
    const activeExperienceReferences = (
      sourceTask.experienceReferences ?? []
    ).filter((reference) => reference.status === "ACTIVE");
    const currentStage = currentWorkStage(project);
    const requestedStage = body.data.stageCode
      ? (project.phases.find((phase) => phase.code === body.data.stageCode) ??
        null)
      : null;
    const assistantStage = requestedStage ?? currentStage;
    const workItems = project.phases.flatMap((phase) => phase.tasks);
    const stageContext = project.phases.map((phase) => ({
      code: phase.code,
      name: phase.name,
      status: phase.status,
      progress: phase.progress,
      completedItemCount: phase.completedTaskCount,
      totalItemCount: phase.totalTaskCount,
    }));
    const workItemContext = project.phases.flatMap((phase) =>
      phase.tasks.map((workItem) => ({
        id: workItem.id,
        stage: phase.name,
        title: workItem.title,
        owner: workItem.owner,
        status: workItem.status,
        inputGapCount: workItem.inputs.filter(
          (item) => item.status !== "AVAILABLE",
        ).length,
        progressNote: workItem.progressUpdate?.note ?? null,
        completionNote: workItem.completionNote || null,
        outputReference: workItem.output.reference,
      })),
    );
    const materialContext = project.phases.flatMap((phase) =>
      phase.tasks.flatMap((workItem) =>
        workItem.inputs.map((item) => ({
          stage: phase.name,
          workItem: workItem.title,
          input: item.label,
          requirementId: item.requirementId,
          status: item.status,
          reference: item.reference,
        })),
      ),
    );
    const materialGaps = project.phases.flatMap((phase) =>
      phase.tasks.flatMap((workItem) =>
        workItem.inputs
          .filter(
            (item) => item.status === "MISSING" || item.status === "UNVERIFIED",
          )
          .map((item) => ({
            stage: phase.name,
            workItem: workItem.title,
            input: item.label,
            requirementId: item.requirementId,
            status: item.status as "MISSING" | "UNVERIFIED",
            situationCode: materialSituationForInput(item.label),
          })),
      ),
    );
    const evidenceKeys = new Set([
      ...sourceTask.evidence.map((item) => item.sourceVersionId),
      ...workItems
        .map((item) => item.output.locator?.sourceVersionId)
        .filter((value): value is string => Boolean(value)),
      ...(project.outcome.locator
        ? [project.outcome.locator.sourceVersionId]
        : []),
      ...(project.experienceCandidate
        ? [project.experienceCandidate.candidateLocator.sourceVersionId]
        : []),
      ...activeExperienceReferences.map(
        (reference) => reference.experienceLocator.sourceVersionId,
      ),
    ]);
    const unfinishedStageItems = assistantStage.tasks.filter(
      (item) => item.status !== "DONE",
    );
    const completedStageItems = assistantStage.tasks.filter(
      (item) => item.status === "DONE",
    );
    const stageMaterialGaps = assistantStage.tasks.flatMap((workItem) =>
      workItem.inputs
        .filter(
          (item) => item.status === "MISSING" || item.status === "UNVERIFIED",
        )
        .map((item) => item.label),
    );
    const nextAction = requestedStage
      ? unfinishedStageItems[0]
        ? `先处理“${unfinishedStageItems[0].title}”，由${unfinishedStageItems[0].owner === "OWNER" ? "企业负责人" : "企业绩效咨询师"}确认完成`
        : `“${assistantStage.name}”已经完成，可继续查看本节点的完成说明和操作记录`
      : nextConsultingAction(project, currentStage);
    const clarificationAnswers = new Map(
      body.data.clarificationAnswers.map((item) => [
        item.questionId,
        item.answer,
      ]),
    );
    const clarifications = guidedAnalysisClarifications(
      assistantStage,
      clarificationAnswers,
    );
    const missingRequiredClarifications = clarifications.filter(
      (item) => item.required && !item.answer,
    );
    if (
      body.data.workflowAction !== "INSPECT" &&
      missingRequiredClarifications.length
    )
      throw new BadRequestException(
        `请先回答 ${missingRequiredClarifications.length} 个必答澄清问题`,
      );
    if (
      (body.data.workflowAction === "ANALYZE" ||
        body.data.workflowAction === "VERIFY") &&
      !body.data.planConfirmed
    )
      throw new BadRequestException("请先确认分析计划，再开始分析");
    const analysisCompleted =
      body.data.workflowAction === "ANALYZE" ||
      body.data.workflowAction === "VERIFY";
    const analysisPlan =
      body.data.workflowAction === "INSPECT"
        ? []
        : guidedAnalysisPlan({
            stage: assistantStage,
            evidenceReferences: [...evidenceKeys],
            materialGaps: stageMaterialGaps,
            nextAction,
            completed: analysisCompleted,
          });
    const workflow: GuidedAnalysisWorkflow = {
      stageCode: assistantStage.code,
      step:
        body.data.workflowAction === "INSPECT"
          ? "CLARIFY"
          : body.data.workflowAction === "PLAN"
            ? "PLAN"
            : "VERIFICATION",
      contextFingerprint: assistantContextFingerprint(
        project,
        assistantStage.code,
      ),
      clarifications,
      plan: analysisPlan,
      verification: analysisCompleted
        ? guidedAnalysisVerification({
            evidenceCount: evidenceKeys.size,
            materialGapCount: stageMaterialGaps.length,
          })
        : [],
    };
    const experienceDraft = buildExperienceDraft(project, sourceTask);
    const completedItemSummary = completedStageItems.length
      ? `已完成：${completedStageItems.map((item) => item.title).join("、")}。`
      : "本节点还没有责任人确认完成的事项。";
    const unfinishedItemSummary = unfinishedStageItems.length
      ? `待完成：${unfinishedStageItems.map((item) => item.title).join("、")}。`
      : "本节点没有待完成事项。";
    const progressSummary = `“${assistantStage.name}”节点已完成 ${assistantStage.completedTaskCount}/${assistantStage.totalTaskCount} 项（${assistantStage.progress}%）。${completedItemSummary}${unfinishedItemSummary}整项咨询的措施执行进度为 ${project.progress}%。`;
    const gapSummary = requestedStage
      ? stageMaterialGaps.length
        ? `“${assistantStage.name}”节点有 ${stageMaterialGaps.length} 项材料缺失或待核验：${stageMaterialGaps.join("、")}。`
        : `“${assistantStage.name}”节点没有未标明的材料缺口。`
      : materialGaps.length
        ? `当前有 ${materialGaps.length} 项材料缺失或待核验，优先关注“${materialGaps[0]?.input}”。`
        : "当前没有未标明的材料缺口。";
    const answerByIntent = {
      NEXT_ACTION: `下一步建议：${nextAction}。${progressSummary}`,
      MATERIAL_GAPS: gapSummary,
      RISK: `${gapSummary} AI 只提供建议；人工判断、方案确认、结果确认和任务完成仍由对应责任人操作。`,
      EXPERIENCE_DRAFT: experienceDraft
        ? "我已读取问题、证据、判断、七个工作步骤、执行输出、已确认结果和操作记录，整理出一份候选经验草稿。请人工复核适用范围与限制后再提交。"
        : "当前还未同时满足“结果已确认”和“总结事项全部完成”，暂不能生成完整候选经验草稿。",
      ASK: body.data.question
        ? answerConsultingQuestion(
            body.data.question,
            progressSummary,
            gapSummary,
            nextAction,
            Boolean(experienceDraft),
          )
        : `我已读取这项咨询任务的完整工作上下文。${progressSummary} 已引用 ${activeExperienceReferences.length} 条正式经验作为候选参考；下一步建议：${nextAction}。`,
    } as const;
    const workflowAnswer = {
      INSPECT: answerByIntent[body.data.intent],
      PLAN: `已根据“${assistantStage.name}”的完整上下文生成 ${analysisPlan.length} 个分析工作单元。请核对每项输入、输出、依赖和完成检查；确认计划只会启动候选分析，不会推进业务状态。`,
      ANALYZE: `已按你确认的计划完成“${assistantStage.name}”候选分析和自检。${analysisPlan.at(-1)?.finding ?? nextAction} 这些结论仍是建议，事项完成由责任员工确认。`,
      VERIFY: `已重新检查“${assistantStage.name}”的上下文覆盖、证据边界、材料缺口和越权风险；自检结果不会替代业务验收。`,
    } as const;
    return projectAssistantResponseSchema.parse({
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      answer: workflowAnswer[body.data.workflowAction],
      context: {
        projectId: project.id,
        sourceTaskId: project.sourceTaskId,
        workTitle: project.name,
        projectStatus: project.status,
        currentStage: {
          code: currentStage.code,
          name: currentStage.name,
          progress: currentStage.progress,
          completedItemCount: currentStage.completedTaskCount,
          totalItemCount: currentStage.totalTaskCount,
        },
        coverage: {
          stageCount: project.phases.length,
          workItemCount: workItems.length,
          evidenceCount: evidenceKeys.size,
          materialGapCount: materialGaps.length,
          activityCount: project.auditTrail.length,
          experienceReferenceCount: activeExperienceReferences.length,
        },
        stages: stageContext,
        workItems: workItemContext,
        materials: materialContext,
        uploadedMaterials: (sourceTask.materials ?? []).filter(
          (material) => material.status === "ACTIVE",
        ),
        recentActivities: project.auditTrail
          .slice(-10)
          .reverse()
          .map((event) => ({
            eventType: event.eventType,
            stage: event.phaseCode,
            note: event.note,
            actor: event.actor,
            createdAt: event.createdAt,
          })),
        experienceReferences: activeExperienceReferences,
        nextAction,
        materialGaps,
        outcome: {
          before: project.outcome.baseline,
          current: project.outcome.current,
          target: project.outcome.target,
          status: project.outcome.status,
          conclusion: project.outcome.conclusion,
          evidenceReference: project.outcome.evidenceReference,
        },
        experience: {
          candidateStatus: project.experienceCandidate?.status ?? null,
          formalPublished: project.publishedExperienceHistory,
          activeReferenceCount: activeExperienceReferences.length,
        },
      },
      workflow,
      experienceDraft,
    });
  }

  async createAssistantFeedback(
    id: string,
    input: unknown,
  ): Promise<AssistantFeedbackReceipt> {
    const body = assistantFeedbackInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的 AI 学习候选反馈");
    const project = await this.readModel.project(id);
    const stage = project.phases.find(
      (item) => item.code === body.data.stageCode,
    );
    if (!stage) throw new BadRequestException("反馈对应的工作步骤不存在");
    const currentFingerprint = assistantContextFingerprint(project, stage.code);
    if (currentFingerprint !== body.data.contextFingerprint)
      throw new ConflictException(
        "项目上下文已经变化，请刷新 AI 回答后重新登记",
      );
    const feedbackId = `AFC-${randomUUID()}`;
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO vs01_assistant_feedback_candidates (id, tenant_id, project_id, phase_code, context_fingerprint, issue_type, assistant_answer, feedback, expected_behavior, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_REVIEW','PMC') RETURNING created_at",
        [
          feedbackId,
          this.tenantId,
          id,
          body.data.stageCode,
          body.data.contextFingerprint,
          body.data.issueType,
          body.data.assistantAnswer,
          body.data.feedback,
          body.data.expectedBehavior,
        ],
      );
      await client.query(
        "INSERT INTO vs01_assistant_feedback_events (tenant_id, feedback_id, event_type, actor, note, snapshot) VALUES ($1,$2,'SUBMITTED','PMC',$3,$4::jsonb)",
        [
          this.tenantId,
          feedbackId,
          body.data.feedback,
          JSON.stringify({
            status: "PENDING_REVIEW",
            projectId: id,
            stageCode: body.data.stageCode,
            contextFingerprint: body.data.contextFingerprint,
            issueType: body.data.issueType,
            assistantAnswer: body.data.assistantAnswer,
            feedback: body.data.feedback,
            expectedBehavior: body.data.expectedBehavior,
          }),
        ],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
      return assistantFeedbackReceiptSchema.parse({
        id: feedbackId,
        projectId: id,
        stageCode: body.data.stageCode,
        status: "PENDING_REVIEW",
        createdAt: new Date(
          inserted.rows[0]?.created_at ?? new Date(),
        ).toISOString(),
      });
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  async withdrawAssistantFeedback(
    projectIdValue: string,
    feedbackId: string,
    input: unknown,
  ): Promise<AssistantFeedbackReceipt> {
    const body = assistantFeedbackWithdrawInputSchema.safeParse(input);
    if (!body.success)
      throw new BadRequestException("撤回 AI 学习候选必须填写原因");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const current = await client.query(
        "SELECT id, project_id, phase_code, status, created_at FROM vs01_assistant_feedback_candidates WHERE id = $1 AND project_id = $2 AND tenant_id = $3 FOR UPDATE",
        [feedbackId, projectIdValue, this.tenantId],
      );
      if (current.rowCount === 0)
        throw new NotFoundException("AI 学习候选不存在");
      if (current.rows[0]?.status !== "PENDING_REVIEW")
        throw new BadRequestException("只有待评审的 AI 学习候选可以撤回");
      const withdrawn = await client.query(
        "UPDATE vs01_assistant_feedback_candidates SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = $1 WHERE id = $2 AND tenant_id = $3 RETURNING withdrawn_at",
        [body.data.reason, feedbackId, this.tenantId],
      );
      await client.query(
        "INSERT INTO vs01_assistant_feedback_events (tenant_id, feedback_id, event_type, actor, note, snapshot) VALUES ($1,$2,'WITHDRAWN','PMC',$3,$4::jsonb)",
        [
          this.tenantId,
          feedbackId,
          body.data.reason,
          JSON.stringify({
            before: { status: "PENDING_REVIEW" },
            after: { status: "WITHDRAWN", reason: body.data.reason },
          }),
        ],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
      return assistantFeedbackReceiptSchema.parse({
        id: feedbackId,
        projectId: projectIdValue,
        stageCode: current.rows[0]?.phase_code,
        status: "WITHDRAWN",
        createdAt: new Date(current.rows[0]?.created_at).toISOString(),
        withdrawnAt: new Date(withdrawn.rows[0]?.withdrawn_at).toISOString(),
        withdrawnReason: body.data.reason,
      });
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }
}
