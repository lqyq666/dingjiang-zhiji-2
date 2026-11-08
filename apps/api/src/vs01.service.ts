import {
  assistantFeedbackInputSchema,
  assistantFeedbackReceiptSchema,
  assistantFeedbackWithdrawInputSchema,
  decisionInputSchema,
  decisionRevertInputSchema,
  experienceCandidateApproveInputSchema,
  experienceCandidateInputSchema,
  experienceCandidateResubmitInputSchema,
  experienceCandidateReturnInputSchema,
  experienceCandidateWithdrawInputSchema,
  experienceReferenceInputSchema,
  experienceReferenceWithdrawInputSchema,
  formalExperienceRetractInputSchema,
  projectAssistantRequestSchema,
  projectAssistantResponseSchema,
  taskAssistantRequestSchema,
  taskAssistantResponseSchema,
  type TaskMaterial,
  type BossDashboard,
  type AssistantFeedbackReceipt,
  type AssistantFeedbackRecord,
  type EmployeeDashboard,
  type ExperienceLibrary,
  type EvidenceProposalReview,
  type ExperienceLifecycleHistoryList,
  type ExpertDashboard,
  type FormalExperience,
  type GuidedAnalysisWorkflow,
  type Project,
  type ProjectAssistantResponse,
  type TaskDetail,
  type TaskAssistantResponse,
} from "@dingjiang/contracts";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  answerConsultingQuestion,
  assistantContextFingerprint,
  currentWorkStage,
  experienceDraft as buildExperienceDraft,
  guidedAnalysisClarifications,
  guidedAnalysisPlan,
  guidedAnalysisVerification,
  nextConsultingAction,
} from "./assistant/guided-analysis";
import {
  assertDatabaseReady,
  createPool,
  migrate,
  resetAndSeed,
} from "./vs01-db";
import { isProduction, runtimeTenantId } from "./runtime-config";
import { phases } from "./work-stages";
import { ProjectLifecycleService } from "./projects/project-lifecycle-service";
import {
  appendProjectEvent,
  assertProjectAction,
  legacyProjectId,
  projectNodeId,
} from "./projects/project-primitives";
import { ReadModelService } from "./read-model/read-model-service";
import {
  formalExperienceView,
  materialSituationForInput,
} from "./read-model/projections";
import {} from "./intake/source-facts";
import {} from "./projects/production-lifecycle";
import {
  MaterialContentVault,
  type MaterialContentStore,
  type UploadedMaterialFile,
} from "./materials/content-vault";
import { MaterialService } from "./materials/material-service";
import type { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";

const tenantId = runtimeTenantId();

@Injectable()
export class Vs01Service implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private get database() {
    return this.commandTransaction ?? this.pool;
  }
  private workpapers: RootCauseWorkpaperService | undefined;
  private readonly materials: MaterialService;
  private readonly readModel: ReadModelService;
  private readonly lifecycle: ProjectLifecycleService;

  constructor(
    private readonly materialVault: MaterialContentStore = new MaterialContentVault(),
    workpapers?: RootCauseWorkpaperService,
    transactionScope?: { pool: Pool; client: PoolClient },
  ) {
    this.workpapers = workpapers;
    this.pool = transactionScope?.pool ?? createPool();
    this.commandTransaction = transactionScope?.client;
    this.materials = new MaterialService(
      this.pool,
      this.materialVault,
      tenantId,
      this.commandTransaction,
    );
    this.readModel = new ReadModelService(
      this.pool,
      tenantId,
      this.commandTransaction,
    );
    this.lifecycle = new ProjectLifecycleService(
      this.pool,
      tenantId,
      this.readModel,
      this.commandTransaction,
    );
  }

  /** Bind existing domain operations and their reads to the command kernel's transaction.
   * The bound instance never commits, rolls back or releases its caller's client. */
  inCommandTransaction<T>(
    client: PoolClient,
    run: (domain: Vs01Service) => Promise<T>,
  ): Promise<T> {
    return run(
      new Vs01Service(this.materialVault, this.workpapers, {
        pool: this.pool,
        client,
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    if (isProduction()) {
      await assertDatabaseReady(this.pool);
      return;
    }
    await migrate(this.pool);
    const result = await this.database.query(
      "SELECT count(*)::int AS count FROM vs01_orders WHERE tenant_id = $1",
      [tenantId],
    );
    if (Number(result.rows[0]?.count ?? 0) === 0) await resetAndSeed(this.pool);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async employee(): Promise<EmployeeDashboard> {
    return this.readModel.employee();
  }

  async boss(): Promise<BossDashboard> {
    return this.readModel.boss();
  }

  async task(id: string): Promise<TaskDetail> {
    return this.readModel.task(id);
  }

  async evidenceProposals(
    projectId: string,
  ): Promise<EvidenceProposalReview[]> {
    return this.readModel.evidenceProposals(projectId);
  }

  async assistTask(id: string, input: unknown): Promise<TaskAssistantResponse> {
    const body = taskAssistantRequestSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的任务助手请求");
    const task = await this.task(id);
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

  async addTaskMaterial(id: string, input: unknown): Promise<TaskDetail> {
    await this.materials.addTaskMaterial(id, input);
    return this.task(id);
  }

  async importTaskMaterial(
    id: string,
    input: unknown,
    file: UploadedMaterialFile | undefined,
  ): Promise<TaskMaterial> {
    return this.materials.importTaskMaterial(id, input, file);
  }

  async withdrawTaskMaterial(
    id: string,
    materialId: string,
    input: unknown,
  ): Promise<TaskMaterial> {
    return this.materials.withdrawTaskMaterial(id, materialId, input);
  }

  async taskMaterialContent(id: string, materialId: string) {
    return this.materials.taskMaterialContent(id, materialId);
  }

  async decideTask(id: string, input: unknown): Promise<TaskDetail> {
    const decision = decisionInputSchema.safeParse(input);
    if (!decision.success) throw new BadRequestException("无效的任务决策");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const task = await client.query(
        "SELECT status FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (task.rowCount === 0) throw new NotFoundException("任务不存在");
      if (task.rows[0]?.status !== "OPEN")
        throw new BadRequestException("任务当前不能再次决策");
      await client.query(
        "INSERT INTO vs01_decisions (task_id, tenant_id, type, note, decided_by, decided_at) VALUES ($1, $2, $3, $4, 'PMC', now())",
        [id, tenantId, decision.data.type, decision.data.note],
      );
      await client.query(
        "INSERT INTO vs01_decision_events (task_id, tenant_id, event_type, decision_type, decision_note, reason, actor) VALUES ($1, $2, 'DECIDED', $3, $4, NULL, 'PMC')",
        [id, tenantId, decision.data.type, decision.data.note],
      );
      const updated = await client.query(
        "UPDATE vs01_tasks SET status = 'DECIDED' WHERE id = $1 AND tenant_id = $2 AND status = 'OPEN'",
        [id, tenantId],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("任务当前不能再次决策");
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.task(id);
  }

  async revertTaskDecision(id: string, input: unknown): Promise<TaskDetail> {
    const body = decisionRevertInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的撤销请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const task = await client.query(
        "SELECT status FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (task.rowCount === 0) throw new NotFoundException("任务不存在");
      if (task.rows[0]?.status !== "DECIDED")
        throw new BadRequestException("任务当前没有可撤销的判断");
      const project = await client.query(
        "SELECT id FROM vs01_projects WHERE source_task_id = $1 AND tenant_id = $2 LIMIT 1",
        [id, tenantId],
      );
      if (project.rowCount !== 0)
        throw new BadRequestException(
          "判断已形成关联项目，不能直接撤销；请先处理下游项目",
        );
      const current = await client.query(
        "SELECT type, note FROM vs01_decisions WHERE task_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (current.rowCount === 0)
        throw new BadRequestException("任务当前没有可撤销的判断");
      await client.query(
        "INSERT INTO vs01_decision_events (task_id, tenant_id, event_type, decision_type, decision_note, reason, actor) VALUES ($1, $2, 'REVERTED', $3, $4, $5, 'PMC')",
        [
          id,
          tenantId,
          current.rows[0]?.type,
          current.rows[0]?.note,
          body.data.reason,
        ],
      );
      await client.query(
        "DELETE FROM vs01_decisions WHERE task_id = $1 AND tenant_id = $2",
        [id, tenantId],
      );
      const reopened = await client.query(
        "UPDATE vs01_tasks SET status = 'OPEN' WHERE id = $1 AND tenant_id = $2 AND status = 'DECIDED'",
        [id, tenantId],
      );
      if (reopened.rowCount !== 1)
        throw new BadRequestException("任务判断未能撤销");
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.task(id);
  }

  async createProject(
    input: unknown,
    reservedProjectId?: string,
  ): Promise<Project> {
    return this.lifecycle.createProject(input, reservedProjectId);
  }

  async submitProject(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.submitProject(id, input);
  }

  async approveProject(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.approveProject(id, input);
  }

  async returnProject(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.returnProject(id, input);
  }

  async project(id: string): Promise<Project> {
    return this.readModel.project(id);
  }

  /** Stable read seam for authorized Integration API projections. */
  async projectList(): Promise<Project[]> {
    return this.readModel.projectList();
  }

  /** Safe, contract-shaped projection used by the read-only project assistant. */
  async rootCauseWorkpaper(id: string) {
    return this.readModel.rootCauseWorkpaper(id);
  }

  async assistProject(
    id: string,
    input: unknown,
  ): Promise<ProjectAssistantResponse> {
    const body = projectAssistantRequestSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的 AI 工作助手请求");
    const project = await this.project(id);
    const sourceTask = await this.task(project.sourceTaskId);
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
    const project = await this.project(id);
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
          tenantId,
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
          tenantId,
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

  async assistantFeedback(
    projectIdValue: string,
  ): Promise<AssistantFeedbackRecord[]> {
    return this.readModel.assistantFeedback(projectIdValue);
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
        [feedbackId, projectIdValue, tenantId],
      );
      if (current.rowCount === 0)
        throw new NotFoundException("AI 学习候选不存在");
      if (current.rows[0]?.status !== "PENDING_REVIEW")
        throw new BadRequestException("只有待评审的 AI 学习候选可以撤回");
      const withdrawn = await client.query(
        "UPDATE vs01_assistant_feedback_candidates SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = $1 WHERE id = $2 AND tenant_id = $3 RETURNING withdrawn_at",
        [body.data.reason, feedbackId, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_assistant_feedback_events (tenant_id, feedback_id, event_type, actor, note, snapshot) VALUES ($1,$2,'WITHDRAWN','PMC',$3,$4::jsonb)",
        [
          tenantId,
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

  async updateSubtask(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.updateSubtask(id, input);
  }

  async reviewExecutionPhase(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.reviewExecutionPhase(id, input);
  }

  async submitOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.submitOutcome(id, input);
  }

  async approveOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.approveOutcome(id, input);
  }

  async returnOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.returnOutcome(id, input);
  }

  async reopenOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.reopenOutcome(id, input);
  }

  async createExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    const body = experienceCandidateInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的候选经验提交");
    const client = this.commandTransaction ?? (await this.pool.connect());
    const candidateId = id === legacyProjectId ? "EXP-OTD-001" : `EXP-${id}`;
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const project = await client.query(
        "SELECT status FROM vs01_projects WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (project.rowCount === 0) throw new NotFoundException("项目不存在");
      if (!["KNOWLEDGE_CAPTURE"].includes(String(project.rows[0]?.status)))
        throw new BadRequestException("结果签收后才能沉淀候选经验");
      const tasks = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE'",
        [tenantId, scopedNodeId],
      );
      if (Number(tasks.rows[0]?.total) !== Number(tasks.rows[0]?.completed))
        throw new BadRequestException("请先完成经验沉淀节点的全部小任务");
      const outcome = await client.query(
        "SELECT evidence_reference, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 AND status = 'ACCEPTED' FOR UPDATE",
        [id, tenantId],
      );
      if (outcome.rowCount !== 1)
        throw new BadRequestException("必须使用已签收的结果证据创建候选经验");
      await this.assertStructuredCardEvidence(
        client,
        id,
        body.data.structuredCard,
      );
      const candidateLocator = await this.createExperienceSource(
        client,
        `候选经验：${body.data.title}`,
      );
      const created = await client.query(
        "INSERT INTO vs01_experience_candidates (id, tenant_id, project_id, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, status, revision) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING_REVIEW', 1) ON CONFLICT (id) DO NOTHING",
        [
          candidateId,
          tenantId,
          id,
          body.data.title,
          body.data.applicableSituation,
          body.data.businessProblem,
          body.data.practice,
          body.data.resultSummary,
          outcome.rows[0]?.evidence_reference,
          body.data.limitations,
          outcome.rows[0]?.source_object_id,
          outcome.rows[0]?.source_version_id,
        ],
      );
      if (created.rowCount !== 1)
        throw new BadRequestException(
          "候选经验已存在，请刷新页面后使用“修订并重提”生成新版本",
        );
      await client.query(
        "INSERT INTO vs01_experience_candidate_revisions (id, tenant_id, candidate_id, revision, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, structured_card) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)",
        [
          `EXP-REV-${randomUUID()}`,
          tenantId,
          candidateId,
          body.data.title,
          body.data.applicableSituation,
          body.data.businessProblem,
          body.data.practice,
          body.data.resultSummary,
          outcome.rows[0]?.evidence_reference,
          body.data.limitations,
          candidateLocator.sourceObjectId,
          candidateLocator.sourceVersionId,
          JSON.stringify(body.data.structuredCard ?? null),
        ],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'PENDING' WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'EXPERIENCE_CANDIDATE_CREATED', 'KNOWLEDGE_CAPTURE', $3, 'PMC', $4::jsonb)",
        [
          tenantId,
          id,
          body.data.title,
          JSON.stringify({
            before: { projectStatus: "KNOWLEDGE_CAPTURE", candidate: null },
            after: {
              projectStatus: "KNOWLEDGE_CAPTURE",
              candidate: {
                title: body.data.title,
                applicableSituation: body.data.applicableSituation,
                businessProblem: body.data.businessProblem,
                practice: body.data.practice,
                resultSummary: body.data.resultSummary,
                evidenceReference: outcome.rows[0]?.evidence_reference,
                limitations: body.data.limitations,
                status: "PENDING_REVIEW",
                candidateLocator,
                evidenceLocator: {
                  sourceObjectId: outcome.rows[0]?.source_object_id,
                  sourceVersionId: outcome.rows[0]?.source_version_id,
                  reference: outcome.rows[0]?.evidence_reference,
                },
              },
            },
          }),
        ],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(id);
  }

  async withdrawExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    const body = experienceCandidateWithdrawInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的候选经验撤回请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const candidate = await client.query(
        "SELECT c.title, c.status, c.evidence_reference, c.source_object_id, c.source_version_id, p.status AS project_status FROM vs01_experience_candidates c JOIN vs01_projects p ON p.id = c.project_id WHERE c.project_id = $1 AND c.tenant_id = $2 FOR UPDATE OF c, p",
        [id, tenantId],
      );
      if (
        candidate.rowCount !== 1 ||
        candidate.rows[0]?.status !== "PENDING_REVIEW"
      )
        throw new BadRequestException("当前没有可撤回的候选经验");
      const project = await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2 AND status = 'KNOWLEDGE_CAPTURE'",
        [id, tenantId],
      );
      if (project.rowCount !== 1)
        throw new BadRequestException("项目当前不能撤回候选经验");
      await client.query(
        "UPDATE vs01_experience_candidates SET status = 'WITHDRAWN' WHERE project_id = $1 AND tenant_id = $2 AND status = 'PENDING_REVIEW'",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'EXPERIENCE_CANDIDATE_WITHDRAWN', 'KNOWLEDGE_CAPTURE', $3, 'PMC', $4::jsonb)",
        [
          tenantId,
          id,
          body.data.reason,
          JSON.stringify({
            before: {
              projectStatus: candidate.rows[0]?.project_status,
              candidate: {
                title: candidate.rows[0]?.title,
                status: "PENDING_REVIEW",
                locator: {
                  sourceObjectId: candidate.rows[0]?.source_object_id,
                  sourceVersionId: candidate.rows[0]?.source_version_id,
                  reference: candidate.rows[0]?.evidence_reference,
                },
              },
            },
            after: {
              projectStatus: "KNOWLEDGE_CAPTURE",
              candidate: { status: "WITHDRAWN" },
            },
          }),
        ],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(id);
  }

  async resubmitExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    const body = experienceCandidateResubmitInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的候选经验重提请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const candidate = await client.query(
        "SELECT c.*, r.source_version_id AS candidate_version_id FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision WHERE c.project_id = $1 AND c.tenant_id = $2 FOR UPDATE OF c, r",
        [id, tenantId],
      );
      if (
        candidate.rowCount !== 1 ||
        !["RETURNED", "WITHDRAWN"].includes(String(candidate.rows[0]?.status))
      )
        throw new BadRequestException("当前候选经验不能修订重提");
      if (
        candidate.rows[0]?.candidate_version_id !==
        body.data.expectedCandidateVersionId
      )
        throw new BadRequestException("候选经验已变化，请刷新后再提交");
      const outcome = await client.query(
        "SELECT evidence_reference, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 AND status = 'ACCEPTED' FOR UPDATE",
        [id, tenantId],
      );
      if (outcome.rowCount !== 1)
        throw new BadRequestException("来源结果不再可用于重提");
      await this.assertStructuredCardEvidence(
        client,
        id,
        body.data.structuredCard,
      );
      const revision = Number(candidate.rows[0]?.revision) + 1;
      const locator = await this.createExperienceSource(
        client,
        `候选经验：${body.data.title}`,
      );
      await client.query(
        "UPDATE vs01_experience_candidates SET title = $3, applicable_situation = $4, business_problem = $5, practice = $6, result_summary = $7, evidence_reference = $8, limitations = $9, source_object_id = $10, source_version_id = $11, status = 'PENDING_REVIEW', revision = $12, returned_reason = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE project_id = $1 AND tenant_id = $2",
        [
          id,
          tenantId,
          body.data.title,
          body.data.applicableSituation,
          body.data.businessProblem,
          body.data.practice,
          body.data.resultSummary,
          outcome.rows[0]?.evidence_reference,
          body.data.limitations,
          outcome.rows[0]?.source_object_id,
          outcome.rows[0]?.source_version_id,
          revision,
        ],
      );
      await client.query(
        "INSERT INTO vs01_experience_candidate_revisions (id, tenant_id, candidate_id, revision, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, structured_card) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)",
        [
          `EXP-REV-${randomUUID()}`,
          tenantId,
          candidate.rows[0]?.id,
          revision,
          body.data.title,
          body.data.applicableSituation,
          body.data.businessProblem,
          body.data.practice,
          body.data.resultSummary,
          outcome.rows[0]?.evidence_reference,
          body.data.limitations,
          locator.sourceObjectId,
          locator.sourceVersionId,
          JSON.stringify(body.data.structuredCard ?? null),
        ],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'PENDING', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, tenantId],
      );
      await appendProjectEvent(
        client,
        id,
        "EXPERIENCE_RESUBMITTED",
        "PMC",
        body.data.title,
        {
          before: {
            status: candidate.rows[0]?.status,
            revision: candidate.rows[0]?.revision,
            candidateVersionId: candidate.rows[0]?.candidate_version_id,
            returnedReason: candidate.rows[0]?.returned_reason,
          },
          after: {
            status: "PENDING_REVIEW",
            revision,
            candidateLocator: locator,
          },
        },
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(id);
  }

  async expertExperienceReviews(): Promise<ExpertDashboard> {
    return this.readModel.expertExperienceReviews();
  }

  async approveExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<FormalExperience> {
    const body = experienceCandidateApproveInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验批准请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const candidate = await client.query(
        "SELECT c.*, r.source_object_id AS candidate_source_object_id, r.source_version_id AS candidate_source_version_id, r.structured_card, p.source_task_id FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision JOIN vs01_projects p ON p.id = c.project_id WHERE c.id = $1 AND c.tenant_id = $2 FOR UPDATE OF c, r, p",
        [id, tenantId],
      );
      if (
        candidate.rowCount !== 1 ||
        candidate.rows[0]?.status !== "PENDING_REVIEW"
      )
        throw new BadRequestException("当前候选经验不能批准");
      const row = candidate.rows[0];
      if (
        row.candidate_source_version_id !== body.data.expectedCandidateVersionId
      )
        throw new BadRequestException("候选经验已变化，请刷新后再批准");
      const projectReadiness = await client.query(
        "SELECT p.status AS project_status, rv.status AS result_status FROM vs01_projects p JOIN vs01_result_validations rv ON rv.project_id = p.id AND rv.tenant_id = p.tenant_id WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, rv",
        [row.project_id, tenantId],
      );
      const phaseGates = await client.query(
        "SELECT code, gate_status FROM vs01_project_phases WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [row.project_id, tenantId],
      );
      const nonKnowledgePhases = phaseGates.rows.filter(
        (phase) => phase.code !== "KNOWLEDGE_CAPTURE",
      );
      const prerequisitesComplete =
        projectReadiness.rowCount === 1 &&
        projectReadiness.rows[0]?.project_status === "KNOWLEDGE_CAPTURE" &&
        projectReadiness.rows[0]?.result_status === "ACCEPTED" &&
        nonKnowledgePhases.length === phases.length - 1 &&
        nonKnowledgePhases.every((phase) => phase.gate_status === "APPROVED");
      if (!prerequisitesComplete)
        throw new BadRequestException(
          "请先进入“总结可复用做法”，完成前置阶段并确认经营结果后再批准候选经验",
        );
      const existing = await client.query(
        "SELECT id FROM vs01_formal_experiences WHERE candidate_id = $1 AND status = 'PUBLISHED' FOR UPDATE",
        [id],
      );
      if (existing.rowCount)
        throw new BadRequestException("该候选经验已经发布");
      const publishedLocator = await this.createExperienceSource(
        client,
        `正式经验：${row.title}`,
      );
      const formalId = `FORMAL-EXP-${randomUUID()}`;
      await client.query(
        "INSERT INTO vs01_formal_experiences (id, tenant_id, candidate_id, source_project_id, source_task_id, status, title, applicable_situation, business_problem, practice, result_summary, limitations, published_by, source_object_id, source_version_id, candidate_source_object_id, candidate_source_version_id, evidence_source_object_id, evidence_source_version_id, structured_card) VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', $6, $7, $8, $9, $10, $11, 'EXPERT_REVIEWER', $12, $13, $14, $15, $16, $17, $18::jsonb)",
        [
          formalId,
          tenantId,
          id,
          row.project_id,
          row.source_task_id,
          row.title,
          row.applicable_situation,
          row.business_problem,
          row.practice,
          row.result_summary,
          row.limitations,
          publishedLocator.sourceObjectId,
          publishedLocator.sourceVersionId,
          row.candidate_source_object_id,
          row.candidate_source_version_id,
          row.source_object_id,
          row.source_version_id,
          JSON.stringify(row.structured_card ?? null),
        ],
      );
      await client.query(
        "UPDATE vs01_experience_candidates SET status = 'APPROVED', reviewed_by = 'EXPERT_REVIEWER', reviewed_at = now(), formal_experience_id = $3 WHERE id = $1 AND tenant_id = $2",
        [id, tenantId, formalId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [row.project_id, tenantId],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'COMPLETED' WHERE id = $1 AND tenant_id = $2",
        [row.project_id, tenantId],
      );
      await appendProjectEvent(
        client,
        row.project_id,
        "EXPERIENCE_APPROVED",
        "EXPERT_REVIEWER",
        row.title,
        {
          before: {
            status: "PENDING_REVIEW",
            candidateVersionId: row.candidate_source_version_id,
          },
          after: { status: "APPROVED", formalExperienceId: formalId },
        },
      );
      await appendProjectEvent(
        client,
        row.project_id,
        "FORMAL_EXPERIENCE_PUBLISHED",
        "EXPERT_REVIEWER",
        row.title,
        {
          before: { formalExperience: null },
          after: {
            formalExperienceId: formalId,
            locator: publishedLocator,
            candidateLocator: {
              sourceObjectId: row.candidate_source_object_id,
              sourceVersionId: row.candidate_source_version_id,
              reference: row.title,
            },
            evidenceLocator: {
              sourceObjectId: row.source_object_id,
              sourceVersionId: row.source_version_id,
              reference: row.evidence_reference,
            },
          },
        },
      );
      if (!this.commandTransaction) await client.query("COMMIT");
      return this.experience(formalId);
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  /** VS17 integration read model; it exposes only the current pending projection. */
  async pendingExperienceCandidate(candidateId: string) {
    return this.readModel.pendingExperienceCandidate(candidateId);
  }

  async recordFeishuCandidateSync(
    candidateId: string,
    expectedCandidateVersionId: string,
    recordId: string,
  ): Promise<void> {
    const updated = await this.database.query(
      "UPDATE vs01_experience_candidates c SET feishu_record_id = $3, feishu_synced_revision = c.revision, feishu_sync_status = 'SYNCED', feishu_synced_at = now() FROM vs01_experience_candidate_revisions r WHERE c.id = $1 AND c.tenant_id = $2 AND c.status = 'PENDING_REVIEW' AND r.candidate_id = c.id AND r.revision = c.revision AND r.source_version_id = $4",
      [candidateId, tenantId, recordId, expectedCandidateVersionId],
    );
    if (updated.rowCount !== 1)
      throw new BadRequestException("候选经验已变化，请刷新后重试");
  }

  async recordFeishuCandidateSyncFailure(
    candidateId: string,
    expectedCandidateVersionId: string,
  ): Promise<void> {
    const updated = await this.database.query(
      "UPDATE vs01_experience_candidates c SET feishu_synced_revision = c.revision, feishu_sync_status = 'FAILED', feishu_synced_at = now() FROM vs01_experience_candidate_revisions r WHERE c.id = $1 AND c.tenant_id = $2 AND c.status = 'PENDING_REVIEW' AND r.candidate_id = c.id AND r.revision = c.revision AND r.source_version_id = $3",
      [candidateId, tenantId, expectedCandidateVersionId],
    );
    if (updated.rowCount !== 1)
      throw new BadRequestException("候选经验已变化，请刷新后重试");
  }

  /** Integration-only serialization; it does not alter candidate business facts. */
  async withFeishuCandidatePushLock<T>(
    candidateId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        candidateId,
      ]);
      const result = await action();
      if (!this.commandTransaction) await client.query("COMMIT");
      return result;
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  /** Minimal VS17 review lookup: terminal decisions remain re-readable for idempotent Feishu pulls. */
  async feishuReviewCandidate(candidateId: string): Promise<{
    status: "PENDING_REVIEW" | "APPROVED" | "RETURNED" | "WITHDRAWN";
    candidateVersionId: string;
  }> {
    const row = await this.database.query(
      "SELECT c.status, r.source_version_id FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision WHERE c.id = $1 AND c.tenant_id = $2",
      [candidateId, tenantId],
    );
    if (row.rowCount !== 1) throw new NotFoundException("候选经验不存在");
    return {
      status: row.rows[0]?.status,
      candidateVersionId: row.rows[0]?.source_version_id,
    } as {
      status: "PENDING_REVIEW" | "APPROVED" | "RETURNED" | "WITHDRAWN";
      candidateVersionId: string;
    };
  }

  async recordFormalExperienceIndex(
    experienceId: string,
    status: "INDEX_PENDING" | "INDEXED" | "INDEX_FAILED",
    execution?: { executeId: string | null; debugUrl: string | null },
  ): Promise<void> {
    const updated = await this.database.query(
      "UPDATE vs01_formal_experiences SET coze_index_status = $3, coze_execute_id = $4, coze_debug_url = $5, coze_indexed_at = CASE WHEN $3 = 'INDEXED' THEN now() ELSE coze_indexed_at END WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED'",
      [
        experienceId,
        tenantId,
        status,
        execution?.executeId ?? null,
        execution?.debugUrl ?? null,
      ],
    );
    if (updated.rowCount !== 1)
      throw new NotFoundException("正式经验不存在或尚未发布");
  }

  async returnExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    const body = experienceCandidateReturnInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验退回请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const candidate = await client.query(
        "SELECT c.*, r.source_version_id AS candidate_version_id FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision WHERE c.id = $1 AND c.tenant_id = $2 FOR UPDATE OF c, r",
        [id, tenantId],
      );
      if (
        candidate.rowCount !== 1 ||
        candidate.rows[0]?.status !== "PENDING_REVIEW"
      )
        throw new BadRequestException("当前候选经验不能退回");
      const row = candidate.rows[0];
      if (row.candidate_version_id !== body.data.expectedCandidateVersionId)
        throw new BadRequestException("候选经验已变化，请刷新后再退回");
      await client.query(
        "UPDATE vs01_experience_candidates SET status = 'RETURNED', returned_reason = $3, reviewed_by = 'EXPERT_REVIEWER', reviewed_at = now() WHERE id = $1 AND tenant_id = $2",
        [id, tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [row.project_id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [row.project_id, tenantId, body.data.reason],
      );
      await appendProjectEvent(
        client,
        row.project_id,
        "EXPERIENCE_RETURNED",
        "EXPERT_REVIEWER",
        body.data.reason,
        {
          before: {
            status: "PENDING_REVIEW",
            candidateVersionId: row.candidate_version_id,
          },
          after: {
            status: "RETURNED",
            returnedReason: body.data.reason,
            projectStatus: "KNOWLEDGE_CAPTURE",
          },
        },
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(
      (
        await this.database.query(
          "SELECT project_id FROM vs01_experience_candidates WHERE id = $1",
          [id],
        )
      ).rows[0]?.project_id,
    );
  }

  async experiences(query = ""): Promise<ExperienceLibrary> {
    return this.readModel.experiences(query);
  }

  async expertExperienceHistory(): Promise<ExperienceLifecycleHistoryList> {
    return this.readModel.expertExperienceHistory();
  }

  async experience(id: string): Promise<FormalExperience> {
    return this.readModel.experience(id);
  }

  async citeExperience(taskId: string, input: unknown): Promise<TaskDetail> {
    const body = experienceReferenceInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验引用请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const experience = await client.query(
        "SELECT * FROM vs01_formal_experiences WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED' FOR UPDATE",
        [body.data.experienceId, tenantId],
      );
      if (experience.rowCount !== 1)
        throw new BadRequestException("只能引用已发布正式经验");
      const formal = experience.rows[0];
      if (formal.source_task_id === taskId)
        throw new BadRequestException("不能将本任务产生的经验引用回本任务");
      if (formal.source_version_id !== body.data.expectedExperienceVersionId)
        throw new BadRequestException("正式经验已变化，请刷新后再引用");
      const task = await client.query(
        "SELECT id FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [taskId, tenantId],
      );
      if (!task.rowCount) throw new NotFoundException("任务不存在");
      const referenceId = `EXP-REF-${randomUUID()}`;
      const existingReference = await client.query(
        "SELECT id, status FROM vs01_experience_references WHERE task_id = $1 AND experience_id = $2 AND experience_source_version_id = $3 FOR UPDATE",
        [taskId, formal.id, formal.source_version_id],
      );
      if (existingReference.rows[0]?.status === "WITHDRAWN") {
        const restoredId = existingReference.rows[0]?.id;
        await client.query(
          "UPDATE vs01_experience_references SET status = 'ACTIVE', withdrawn_at = NULL, withdrawn_reason = NULL, note = $4 WHERE id = $1 AND task_id = $2 AND tenant_id = $3",
          [restoredId, taskId, tenantId, body.data.note],
        );
        await client.query(
          "INSERT INTO vs01_experience_reference_events (tenant_id, reference_id, task_id, event_type, actor, note, snapshot) VALUES ($1, $2, $3, 'RESTORED', 'PMC', $4, $5::jsonb)",
          [
            tenantId,
            restoredId,
            taskId,
            body.data.note,
            JSON.stringify({
              before: { status: "WITHDRAWN" },
              after: { status: "ACTIVE" },
              experienceVersionId: formal.source_version_id,
            }),
          ],
        );
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.task(taskId);
      }
      if (existingReference.rowCount)
        throw new BadRequestException("这条正式经验已被当前任务引用");
      const inserted = await client.query(
        "INSERT INTO vs01_experience_references (id, tenant_id, task_id, experience_id, status, classification, note, created_by, experience_source_object_id, experience_source_version_id) VALUES ($1, $2, $3, $4, 'ACTIVE', 'PROPOSAL', $5, 'PMC', $6, $7) ON CONFLICT (task_id, experience_id, experience_source_version_id) DO NOTHING",
        [
          referenceId,
          tenantId,
          taskId,
          formal.id,
          body.data.note,
          formal.source_object_id,
          formal.source_version_id,
        ],
      );
      if (inserted.rowCount !== 1)
        throw new BadRequestException("经验引用创建失败");
      await client.query(
        "INSERT INTO vs01_experience_reference_events (tenant_id, reference_id, task_id, event_type, actor, note, snapshot) VALUES ($1, $2, $3, 'CITED', 'PMC', $4, $5::jsonb)",
        [
          tenantId,
          referenceId,
          taskId,
          body.data.note,
          JSON.stringify({
            experienceId: formal.id,
            experienceVersionId: formal.source_version_id,
            note: body.data.note,
          }),
        ],
      );
      const project = await client.query(
        "SELECT id FROM vs01_projects WHERE source_task_id = $1 AND tenant_id = $2",
        [taskId, tenantId],
      );
      if (project.rowCount)
        await appendProjectEvent(
          client,
          project.rows[0]?.id,
          "FORMAL_EXPERIENCE_CITED",
          "PMC",
          formal.title,
          {
            before: { experienceReferences: "unchanged" },
            after: {
              referenceId,
              classification: "PROPOSAL",
              experienceVersionId: formal.source_version_id,
            },
          },
        );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.task(taskId);
  }

  async withdrawExperienceReference(
    taskId: string,
    referenceId: string,
    input: unknown,
  ): Promise<TaskDetail> {
    const body = experienceReferenceWithdrawInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验引用撤回请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const reference = await client.query(
        "SELECT * FROM vs01_experience_references WHERE id = $1 AND task_id = $2 AND tenant_id = $3 FOR UPDATE",
        [referenceId, taskId, tenantId],
      );
      if (reference.rowCount !== 1 || reference.rows[0]?.status !== "ACTIVE")
        throw new BadRequestException("当前没有可撤回的经验引用");
      await client.query(
        "UPDATE vs01_experience_references SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = $4 WHERE id = $1 AND task_id = $2 AND tenant_id = $3",
        [referenceId, taskId, tenantId, body.data.reason],
      );
      await client.query(
        "INSERT INTO vs01_experience_reference_events (tenant_id, reference_id, task_id, event_type, actor, note, snapshot) VALUES ($1, $2, $3, 'WITHDRAWN', 'PMC', $4, $5::jsonb)",
        [
          tenantId,
          referenceId,
          taskId,
          body.data.reason,
          JSON.stringify({
            before: { status: "ACTIVE" },
            after: { status: "WITHDRAWN", reason: body.data.reason },
          }),
        ],
      );
      const project = await client.query(
        "SELECT id FROM vs01_projects WHERE source_task_id = $1 AND tenant_id = $2",
        [taskId, tenantId],
      );
      if (project.rowCount)
        await appendProjectEvent(
          client,
          project.rows[0]?.id,
          "FORMAL_EXPERIENCE_REFERENCE_WITHDRAWN",
          "PMC",
          body.data.reason,
          {
            before: { referenceId, status: "ACTIVE" },
            after: {
              referenceId,
              status: "WITHDRAWN",
              reason: body.data.reason,
            },
          },
        );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.task(taskId);
  }

  async retractExperience(
    id: string,
    input: unknown,
  ): Promise<FormalExperience> {
    const body = formalExperienceRetractInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的正式经验撤回请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const formalResult = await client.query(
        "SELECT * FROM vs01_formal_experiences WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (
        formalResult.rowCount !== 1 ||
        formalResult.rows[0]?.status !== "PUBLISHED"
      )
        throw new BadRequestException("当前正式经验不能撤回");
      const formal = formalResult.rows[0];
      if (formal.source_version_id !== body.data.expectedExperienceVersionId)
        throw new BadRequestException("正式经验已变化，请刷新后再撤回");
      const references = await client.query(
        "SELECT task_id FROM vs01_experience_references WHERE experience_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'",
        [id, tenantId],
      );
      if (references.rowCount)
        throw new BadRequestException(
          `正式经验仍被 ${references.rows.map((row) => row.task_id).join("、")} 引用；请先逐条撤回引用`,
        );
      await client.query(
        "UPDATE vs01_formal_experiences SET status = 'RETRACTED', retracted_at = now(), retracted_reason = $3 WHERE id = $1 AND tenant_id = $2",
        [id, tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_experience_candidates SET status = 'RETURNED', returned_reason = $3, reviewed_by = 'EXPERT_REVIEWER', reviewed_at = now(), formal_experience_id = NULL WHERE id = $1 AND tenant_id = $2",
        [formal.candidate_id, tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [formal.source_project_id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [formal.source_project_id, tenantId, body.data.reason],
      );
      await appendProjectEvent(
        client,
        formal.source_project_id,
        "FORMAL_EXPERIENCE_RETRACTED",
        "EXPERT_REVIEWER",
        body.data.reason,
        {
          before: { formalExperienceId: id, status: "PUBLISHED" },
          after: {
            status: "RETRACTED",
            candidateStatus: "RETURNED",
            projectStatus: "KNOWLEDGE_CAPTURE",
          },
        },
      );
      if (!this.commandTransaction) await client.query("COMMIT");
      return {
        ...formalExperienceView(formal),
        status: "RETRACTED",
        retractedAt: new Date().toISOString(),
        retractedReason: body.data.reason,
      };
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  async reset(input: unknown): Promise<EmployeeDashboard> {
    assertProjectAction(input, "PMC");
    await resetAndSeed(this.pool);
    return this.employee();
  }

  private sourceTaskSuffix(sourceTaskId: string): string {
    return sourceTaskId.replace(/^SO-/, "");
  }

  private async createExperienceSource(
    client: PoolClient,
    reference: string,
  ): Promise<{
    sourceObjectId: string;
    sourceVersionId: string;
    reference: string;
  }> {
    const suffix = randomUUID();
    const sourceObjectId = `SRC-EXPERIENCE-${suffix}`;
    const sourceVersionId = `SRC-EXPERIENCE-VERSION-${suffix}`;
    await client.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1, $2, $3)",
      [sourceObjectId, tenantId, reference],
    );
    await client.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, 1)",
      [sourceVersionId, sourceObjectId, tenantId],
    );
    return { sourceObjectId, sourceVersionId, reference };
  }

  private async assertStructuredCardEvidence(
    client: PoolClient,
    projectId: string,
    structuredCard:
      | {
          evidenceRefs: Array<{
            sourceObjectId: string;
            sourceVersionId: string;
          }>;
          claims: Array<{ evidenceIds: string[] }>;
        }
      | undefined,
  ): Promise<void> {
    if (!structuredCard) return;
    const requested = structuredCard.evidenceRefs;
    if (!requested.length)
      throw new BadRequestException("候选经验结构卡缺少证据定位");
    const allowed = await client.query(
      `SELECT DISTINCT source_object_id, source_version_id FROM (
        SELECT o.id AS source_object_id, sv.id AS source_version_id
          FROM vs01_projects p
          JOIN vs01_source_versions sv ON sv.tenant_id = p.tenant_id AND (($3::boolean=false AND sv.id IN ('SRC-ORDERS-V1','SRC-BOM-V1','SRC-PURCHASES-V1')) OR ($3::boolean=true AND sv.id IN (SELECT v FROM production_project_snapshots ps CROSS JOIN LATERAL unnest(ARRAY[ps.order_facts->>'order_source_version_id',ps.order_facts->>'bom_source_version_id',ps.order_facts->>'purchase_source_version_id']) v WHERE ps.project_id=p.id AND ps.tenant_id=p.tenant_id)))
          JOIN vs01_source_objects o ON o.id = sv.source_object_id AND o.tenant_id = p.tenant_id
          WHERE p.id = $1 AND p.tenant_id = $2
        UNION ALL
        SELECT rv.source_object_id, rv.source_version_id
          FROM vs01_result_validations rv WHERE rv.project_id = $1 AND rv.tenant_id = $2 AND rv.status = 'ACCEPTED'
        UNION ALL
        SELECT m.source_object_id, m.source_version_id
          FROM vs01_task_materials m JOIN vs01_projects p ON p.source_task_id = m.task_id
          WHERE p.id = $1 AND p.tenant_id = $2 AND m.tenant_id = $2 AND m.status = 'ACTIVE' AND m.source_object_id IS NOT NULL AND m.source_version_id IS NOT NULL
        UNION ALL
        SELECT o.id, v.source_version_id
          FROM vs16_root_cause_workpapers w JOIN vs16_root_cause_workpaper_versions v ON v.id = w.latest_confirmed_version_id
          JOIN vs01_source_versions sv ON sv.id = v.source_version_id JOIN vs01_source_objects o ON o.id = sv.source_object_id
          WHERE w.project_id = $1 AND w.tenant_id = $2 AND w.status = 'CONFIRMED'
        UNION ALL
        SELECT o.id, e.source_version_id
          FROM vs16_root_cause_workpapers w JOIN vs16_root_cause_workpaper_versions v ON v.id = w.latest_confirmed_version_id
          JOIN vs16_root_cause_workpaper_evidence e ON e.version_id = v.id
          JOIN vs01_source_versions sv ON sv.id = e.source_version_id JOIN vs01_source_objects o ON o.id = sv.source_object_id
          WHERE w.project_id = $1 AND w.tenant_id = $2 AND w.status = 'CONFIRMED'
      ) refs`,
      [projectId, tenantId, isProduction()],
    );
    const available = new Set(
      allowed.rows.map(
        (row) => `${row.source_object_id}:${row.source_version_id}`,
      ),
    );
    if (
      requested.some(
        (ref) => !available.has(`${ref.sourceObjectId}:${ref.sourceVersionId}`),
      )
    )
      throw new BadRequestException(
        "候选经验结构卡包含无效、跨项目或不可追溯的证据定位",
      );
    const sourceTask = await client.query(
      "SELECT source_task_id FROM vs01_projects WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [projectId, tenantId],
    );
    const taskId = String(sourceTask.rows[0]?.source_task_id ?? "");
    const suffix = taskId.replace(/^SO-/, "");
    const evidenceIds = new Set([
      `E-ORDER-${suffix}`,
      `E-BOM-${suffix}`,
      `E-PURCHASE-${suffix}`,
    ]);
    if (
      structuredCard.claims.some((claim) =>
        claim.evidenceIds.some((id) => !evidenceIds.has(id)),
      )
    )
      throw new BadRequestException(
        "候选经验结构卡包含不属于当前任务的事实证据",
      );
  }
}
