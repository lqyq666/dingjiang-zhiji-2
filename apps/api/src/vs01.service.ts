import {
  assistantFeedbackInputSchema,
  assistantFeedbackListSchema,
  assistantFeedbackReceiptSchema,
  assistantFeedbackWithdrawInputSchema,
  bossDashboardSchema,
  createProjectInputSchema,
  decisionInputSchema,
  decisionRevertInputSchema,
  executionPhaseReviewInputSchema,
  employeeDashboardSchema,
  experienceCandidateApproveInputSchema,
  experienceCandidateInputSchema,
  experienceCandidateResubmitInputSchema,
  experienceCandidateReturnInputSchema,
  experienceCandidateWithdrawInputSchema,
  experienceLibrarySchema,
  experienceLifecycleHistoryListSchema,
  experienceReferenceInputSchema,
  experienceReferenceWithdrawInputSchema,
  evidenceProposalReviewListSchema,
  expertDashboardSchema,
  formalExperienceRetractInputSchema,
  outcomeReopenInputSchema,
  outcomeReturnInputSchema,
  outcomeSubmitInputSchema,
  projectActionInputSchema,
  projectAssistantRequestSchema,
  projectAssistantResponseSchema,
  projectSubtaskStatusInputSchema,
  projectReturnInputSchema,
  projectSchema,
  taskDetailSchema,
  taskAssistantRequestSchema,
  taskAssistantResponseSchema,
  taskMaterialInputSchema,
  taskMaterialImportFieldsSchema,
  taskMaterialWithdrawInputSchema,
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
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

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
import {
  isProduction,
  runtimeTenantId,
  runtimeTargetOtd,
} from "./runtime-config";
import { delayDays, isoDate, otdPercentage } from "./vs01-domain";
import {
  productionTaskFacts,
  sourceLocator,
  pinProjectSnapshot,
} from "./intake/source-facts";
import {
  initialProductionGate,
  initializeProductionTemplates,
  nextEarlyPhase,
  productionReservationId,
} from "./projects/production-lifecycle";
import {
  MaterialContentVault,
  type MaterialContentStore,
  type UploadedMaterialFile,
  validateMaterialFile,
} from "./materials/content-vault";
import { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";

const tenantId = runtimeTenantId();
const legacyProjectId = "PRJ-OTD-001";
const legacyNodeId = "NODE-BOM-001";

const workStageNames = {
  PROJECT_SCOPING: "明确要解决的问题",
  BASELINE_FACTS: "核清事实",
  ROOT_CAUSE_VALIDATION: "找到主要原因",
  SOLUTION_APPROVAL: "定下解决方案",
  EXECUTION_CONTROL: "落实解决措施",
  RESULT_ACCEPTANCE: "确认实际结果",
  KNOWLEDGE_CAPTURE: "总结可复用做法",
} as const;
const workStagePurposes = {
  PROJECT_SCOPING: "说清要解决什么、影响谁、目标是什么",
  BASELINE_FACTS: "统一数据口径，核对事实和材料质量",
  ROOT_CAUSE_VALIDATION: "用证据验证候选原因，不把推断当事实",
  SOLUTION_APPROVAL: "比较解决办法，明确责任和验收方式",
  EXECUTION_CONTROL: "按可验证事项落实解决措施",
  RESULT_ACCEPTANCE: "按同一口径确认实际经营结果",
  KNOWLEDGE_CAPTURE: "把经过验证的做法整理为有边界的候选经验",
} as const;

const phases = [
  [
    "PROJECT_SCOPING",
    workStageNames.PROJECT_SCOPING,
    workStagePurposes.PROJECT_SCOPING,
  ],
  [
    "BASELINE_FACTS",
    workStageNames.BASELINE_FACTS,
    workStagePurposes.BASELINE_FACTS,
  ],
  [
    "ROOT_CAUSE_VALIDATION",
    workStageNames.ROOT_CAUSE_VALIDATION,
    workStagePurposes.ROOT_CAUSE_VALIDATION,
  ],
  [
    "SOLUTION_APPROVAL",
    workStageNames.SOLUTION_APPROVAL,
    workStagePurposes.SOLUTION_APPROVAL,
  ],
  [
    "EXECUTION_CONTROL",
    workStageNames.EXECUTION_CONTROL,
    workStagePurposes.EXECUTION_CONTROL,
  ],
  [
    "RESULT_ACCEPTANCE",
    workStageNames.RESULT_ACCEPTANCE,
    workStagePurposes.RESULT_ACCEPTANCE,
  ],
  [
    "KNOWLEDGE_CAPTURE",
    workStageNames.KNOWLEDGE_CAPTURE,
    workStagePurposes.KNOWLEDGE_CAPTURE,
  ],
] as const;

type OrderRow = QueryResultRow & {
  order_id: string;
  customer: string;
  promised_date: string;
  forecast_date: string;
  bom_delay: number;
  purchase_delay: number;
};

type ProjectFactContext = {
  sourceTaskId: string;
  orderDelay: number;
  bomDelay: number;
  purchaseDelay: number;
  orderEvidenceReference: string;
  bomEvidenceReference: string;
  purchaseEvidenceReference: string;
  historicalSnapshotReference: string;
};

@Injectable()
export class Vs01Service implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private get database() {
    return this.commandTransaction ?? this.pool;
  }
  private workpapers: RootCauseWorkpaperService | undefined;

  constructor(
    private readonly materialVault: MaterialContentStore = new MaterialContentVault(),
    workpapers?: RootCauseWorkpaperService,
    transactionScope?: { pool: Pool; client: PoolClient },
  ) {
    this.workpapers = workpapers;
    this.pool = transactionScope?.pool ?? createPool();
    this.commandTransaction = transactionScope?.client;
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
    const projects = await this.projects(false);
    return employeeDashboardSchema.parse({
      role: "PMC",
      highRiskOrders: await this.highRiskOrders(false),
      pendingTaskIds: (
        await this.database.query(
          "SELECT t.id FROM vs01_tasks t JOIN vs01_orders o ON o.order_id = t.id AND o.tenant_id = t.tenant_id WHERE t.tenant_id = $1 AND t.status = 'OPEN' AND o.status <> 'E2E_ACCEPTANCE' ORDER BY t.id",
          [tenantId],
        )
      ).rows.map((row) => String(row.id)),
      projects,
      project: this.currentProject(projects),
    });
  }

  async boss(): Promise<BossDashboard> {
    const [orders, pending, projects, highRiskOrders, dataSources] =
      await Promise.all([
        this.database.query(
          "SELECT promised_date, forecast_date FROM vs01_orders WHERE tenant_id = $1 AND status <> 'E2E_ACCEPTANCE'",
          [tenantId],
        ),
        this.database.query(
          "SELECT count(*)::int AS count FROM vs01_projects p JOIN vs01_orders o ON o.order_id = p.source_task_id AND o.tenant_id = p.tenant_id WHERE p.tenant_id = $1 AND p.status = 'PENDING_APPROVAL' AND o.status <> 'E2E_ACCEPTANCE'",
          [tenantId],
        ),
        this.projects(false),
        this.highRiskOrders(false),
        this.ownerDataSources(),
      ]);
    return bossDashboardSchema.parse({
      role: "OWNER",
      otd: otdPercentage(
        orders.rows.map((row) => ({
          promisedDate: this.date(row.promised_date),
          forecastDate: this.date(row.forecast_date),
        })),
      ),
      targetOtd: runtimeTargetOtd(),
      highRiskOrderCount: highRiskOrders.length,
      highRiskOrders,
      pendingApprovalCount: Number(pending.rows[0]?.count ?? 0),
      dataSources,
      projects,
      project: this.currentProject(projects),
    });
  }

  async task(id: string): Promise<TaskDetail> {
    const row = await this.orderForTask(id);
    // A command transaction uses one PoolClient. Keep its reads sequential so
    // pg never queues concurrent queries on that client (unsupported in pg 9).
    const decision = await this.database.query(
      "SELECT type, note, decided_by, decided_at FROM vs01_decisions WHERE task_id = $1 AND tenant_id = $2",
      [id, tenantId],
    );
    const materialResult = await this.database.query(
      "SELECT m.id, m.situation_code, m.requirement_id, m.title, m.source_reference, m.note, m.kind, m.status, m.source_object_id, m.source_version_id, m.withdrawn_at, m.withdrawn_reason, m.created_by, m.created_at, c.original_name, c.media_type, c.byte_size, c.sha256, c.extraction_status, c.content_preview, c.readable_by_ai, (g.material_id IS NOT NULL) AS verification_eligible, v.verification_status, v.verification_version, v.verified_by, v.verification_note, v.verified_at FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id LEFT JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id LEFT JOIN LATERAL (SELECT e.event_type AS verification_status, e.verification_version, e.actor_subject_id AS verified_by, e.reason AS verification_note, e.created_at AS verified_at FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE m.task_id = $1 AND m.tenant_id = $2 ORDER BY m.created_at, m.id",
      [id, tenantId],
    );
    const referenceResult = await this.database.query(
      "SELECT r.id, r.experience_id, r.status, r.classification, r.note, r.created_at, r.withdrawn_at, r.withdrawn_reason, r.experience_source_object_id, r.experience_source_version_id, f.title, f.applicable_situation, f.limitations FROM vs01_experience_references r JOIN vs01_formal_experiences f ON f.id = r.experience_id WHERE r.task_id = $1 AND r.tenant_id = $2 ORDER BY r.created_at, r.id",
      [id, tenantId],
    );
    const referenceEventResult = await this.database.query(
      "SELECT e.id, e.reference_id, e.task_id, r.experience_id, f.title AS experience_title, e.event_type, e.actor, e.note, e.snapshot, e.created_at FROM vs01_experience_reference_events e JOIN vs01_experience_references r ON r.id = e.reference_id AND r.tenant_id = e.tenant_id JOIN vs01_formal_experiences f ON f.id = r.experience_id AND f.tenant_id = e.tenant_id WHERE e.task_id = $1 AND e.tenant_id = $2 ORDER BY e.id",
      [id, tenantId],
    );
    const formalEvidenceResult = await this.database.query(
      "SELECT f.*, m.title AS material_title FROM vs32_formal_evidence f JOIN vs32_evidence_proposals p ON p.id = f.proposal_id AND p.tenant_id = f.tenant_id JOIN vs01_task_materials m ON m.id = p.material_id AND m.tenant_id = f.tenant_id WHERE f.source_task_id = $1 AND f.tenant_id = $2 ORDER BY f.confirmed_at, f.id",
      [id, tenantId],
    );
    const materials = materialResult.rows.map((material) =>
      this.materialProjection(material),
    );
    const evidenceSuffix = this.sourceTaskSuffix(id);
    const evidence = [
      this.evidence(
        `E-ORDER-${evidenceSuffix}`,
        isProduction()
          ? sourceLocator(row, "order").sourceObjectId
          : "SRC-ORDERS",
        isProduction()
          ? sourceLocator(row, "order").sourceVersionId
          : "SRC-ORDERS-V1",
        "orders.csv",
        "订单明细",
        Number(row.order_source_row),
        "FACT",
        {
          orderId: row.order_id,
          customer: row.customer,
          promisedDate: this.date(row.promised_date),
          forecastDate: this.date(row.forecast_date),
          status: String(row.order_status),
        },
      ),
      this.evidence(
        `E-BOM-${evidenceSuffix}`,
        isProduction() ? sourceLocator(row, "bom").sourceObjectId : "SRC-BOM",
        isProduction()
          ? sourceLocator(row, "bom").sourceVersionId
          : "SRC-BOM-V1",
        "bom.csv",
        "BOM明细",
        Number(row.bom_source_row),
        "FACT",
        {
          orderId: row.order_id,
          plannedBomDate: this.date(row.planned_bom_date),
          actualBomDate: this.date(row.actual_bom_date),
          completionStatus: String(row.completion_status),
        },
      ),
      this.evidence(
        `E-PURCHASE-${evidenceSuffix}`,
        isProduction()
          ? sourceLocator(row, "purchase").sourceObjectId
          : "SRC-PURCHASES",
        isProduction()
          ? sourceLocator(row, "purchase").sourceVersionId
          : "SRC-PURCHASES-V1",
        "purchases.csv",
        "采购明细",
        Number(row.purchase_source_row),
        "FACT",
        {
          orderId: row.order_id,
          plannedStartDate: this.date(row.planned_start_date),
          actualStartDate: this.date(row.actual_start_date),
          arrivalRisk: String(row.arrival_risk),
        },
      ),
      ...formalEvidenceResult.rows.map((formal) => ({
        id: String(formal.id),
        sourceObjectId: String(formal.source_object_id),
        sourceVersionId: String(formal.source_version_id),
        sourceFile: String(formal.material_title),
        sourceSheet: "受控文本",
        sourceRow: 2,
        fields: {
          claim: String(formal.claim),
          exactText: String(formal.exact_text),
          evidenceType: String(formal.evidence_type),
          limitations: String(formal.limitations),
        },
        classification: "FACT" as const,
        origin: "HUMAN_CONFIRMED_MATERIAL" as const,
        claim: String(formal.claim),
        evidenceType: formal.evidence_type as
          "OBSERVATION" | "METRIC" | "DOCUMENTED_FACT",
        exactSpan: {
          kind: "TEXT_SPAN" as const,
          start: Number(formal.span_start),
          end: Number(formal.span_end),
          exactText: String(formal.exact_text),
        },
        limitations: String(formal.limitations),
        proposalId: String(formal.proposal_id),
        confirmedBy: String(formal.confirmed_by),
        confirmedAt: new Date(formal.confirmed_at).toISOString(),
      })),
    ];
    const saved = decision.rows[0];
    return taskDetailSchema.parse({
      id,
      status: saved ? "DECIDED" : "OPEN",
      order: this.orderRisk(row),
      facts: [
        {
          label: "预计延期",
          value: `${this.delay(row.forecast_date, row.promised_date)} 天`,
          evidenceId: `E-ORDER-${evidenceSuffix}`,
        },
        {
          label: "BOM完成",
          value: `晚 ${Number(row.bom_delay)} 天`,
          evidenceId: `E-BOM-${evidenceSuffix}`,
        },
        {
          label: "采购启动",
          value: `晚 ${Number(row.purchase_delay)} 天`,
          evidenceId: `E-PURCHASE-${evidenceSuffix}`,
        },
      ],
      analysis: {
        provider: "DEMO_RULES",
        classification: "PROPOSAL",
        candidateCause: isProduction()
          ? "需结合当前版本的订单、BOM、采购和现场材料核验原因；日期相关性不等于根因。"
          : "BOM准备滞后可能是当前主要原因",
        evidenceIds: [
          `E-BOM-${evidenceSuffix}`,
          `E-PURCHASE-${evidenceSuffix}`,
          `E-ORDER-${evidenceSuffix}`,
        ],
      },
      evidence,
      situations: this.situations(row, materials, id),
      materials,
      experienceReferences: referenceResult.rows.map((reference) => ({
        id: reference.id,
        taskId: id,
        experienceId: reference.experience_id,
        status: reference.status,
        classification: "PROPOSAL",
        title: reference.title,
        applicableSituation: reference.applicable_situation,
        limitations: reference.limitations,
        note: reference.note,
        createdBy: "PMC",
        createdAt: new Date(reference.created_at).toISOString(),
        withdrawnAt: reference.withdrawn_at
          ? new Date(reference.withdrawn_at).toISOString()
          : null,
        withdrawnReason: reference.withdrawn_reason ?? null,
        experienceLocator: {
          sourceObjectId: reference.experience_source_object_id,
          sourceVersionId: reference.experience_source_version_id,
          reference: reference.title,
        },
      })),
      experienceReferenceAuditTrail: referenceEventResult.rows.map((event) => ({
        id: String(event.id),
        referenceId: event.reference_id,
        taskId: event.task_id,
        experienceId: event.experience_id,
        experienceTitle: event.experience_title,
        eventType: event.event_type,
        actor: event.actor,
        note: event.note,
        snapshot: event.snapshot,
        createdAt: new Date(event.created_at).toISOString(),
      })),
      decision: saved
        ? {
            type: saved.type,
            note: saved.note,
            decidedBy: "PMC",
            decidedAt: new Date(saved.decided_at).toISOString(),
          }
        : null,
    });
  }

  async evidenceProposals(
    projectId: string,
  ): Promise<EvidenceProposalReview[]> {
    const result = await this.database.query(
      "SELECT p.*, m.title AS material_title, c.decision, c.confirmation_version, c.reviewed_by, c.review_note, c.created_at AS reviewed_at, f.id AS evidence_id FROM vs32_evidence_proposals p JOIN vs01_task_materials m ON m.id = p.material_id AND m.tenant_id = p.tenant_id LEFT JOIN vs32_evidence_confirmations c ON c.proposal_id = p.id AND c.tenant_id = p.tenant_id LEFT JOIN vs32_formal_evidence f ON f.proposal_id = p.id AND f.tenant_id = p.tenant_id WHERE p.project_id = $1 AND p.tenant_id = $2 ORDER BY p.created_at DESC, p.id",
      [projectId, tenantId],
    );
    return evidenceProposalReviewListSchema.parse(
      result.rows.map((row) => ({
        proposalId: String(row.id),
        projectId: String(row.project_id),
        workItemId: String(row.work_item_id),
        materialId: String(row.material_id),
        materialTitle: String(row.material_title),
        claim: String(row.claim),
        evidenceType: String(row.evidence_type),
        locator: {
          sourceObjectId: String(row.source_object_id),
          sourceVersionId: String(row.source_version_id),
          reference: `${String(row.material_title)} · exact span ${Number(row.span_start)}-${Number(row.span_end)}`,
        },
        exactSpan: {
          kind: "TEXT_SPAN",
          start: Number(row.span_start),
          end: Number(row.span_end),
          exactText: String(row.exact_text),
        },
        reasoning: String(row.reasoning),
        limitations: String(row.limitations),
        proposedBy: String(row.proposed_by),
        proposedAt: new Date(row.created_at).toISOString(),
        review: row.decision
          ? {
              decision: row.decision,
              version: 1,
              reviewedBy: String(row.reviewed_by),
              reviewedAt: new Date(row.reviewed_at).toISOString(),
              reviewNote: String(row.review_note),
              evidenceId: row.evidence_id ? String(row.evidence_id) : null,
            }
          : null,
      })),
    );
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
    const body = taskMaterialInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的材料登记");
    const task = await this.database.query(
      "SELECT 1 FROM vs01_tasks WHERE id = $1 AND tenant_id = $2",
      [id, tenantId],
    );
    if (task.rowCount === 0) throw new NotFoundException("任务不存在");
    await this.database.query(
      "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, title, source_reference, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'PMC')",
      [
        tenantId,
        id,
        body.data.situationCode,
        body.data.title,
        body.data.sourceReference,
        body.data.note,
      ],
    );
    return this.task(id);
  }

  async importTaskMaterial(
    id: string,
    input: unknown,
    file: UploadedMaterialFile | undefined,
  ): Promise<TaskMaterial> {
    const body = taskMaterialImportFieldsSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的材料上传字段");
    // Authorization and task scope are deliberately checked before validation/staging I/O.
    const task = await this.database.query(
      "SELECT 1 FROM vs01_tasks WHERE id = $1 AND tenant_id = $2",
      [id, tenantId],
    );
    if (task.rowCount === 0) throw new NotFoundException("任务不存在");
    if (!file) throw new BadRequestException("请选择要上传的材料文件");
    const validated = validateMaterialFile(file);
    const client = this.commandTransaction ?? (await this.pool.connect());
    let temporaryKey: string | null = null;
    let committed = false;
    let finalizedKey: string | null = null;
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenantId}:${id}:${body.data.requestId}`],
      );
      const existing = await client.query(
        "SELECT m.id, c.sha256 FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id WHERE m.tenant_id = $1 AND m.task_id = $2 AND m.request_id = $3 FOR UPDATE OF m",
        [tenantId, id, body.data.requestId],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.sha256 !== validated.sha256)
          throw new ConflictException("相同请求编号不能对应不同材料内容");
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.materialById(id, String(existing.rows[0]?.id));
      }
      const allowedRequirement = this.requirementFor(
        body.data.situationCode,
        body.data.requirementId,
      );
      if (!allowedRequirement)
        throw new BadRequestException("材料需求与当前情境不匹配");
      const staged = await this.materialVault.stage(validated.bytes);
      temporaryKey = staged.temporaryKey;
      const suffix = randomUUID();
      const sourceObjectId = `SRC-MATERIAL-${suffix}`;
      const sourceVersionId = `SRC-MATERIAL-VERSION-${suffix}`;
      await client.query(
        "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1, $2, $3)",
        [sourceObjectId, tenantId, validated.originalName],
      );
      await client.query(
        "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, 1)",
        [sourceVersionId, sourceObjectId, tenantId],
      );
      const inserted = await client.query(
        "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, requirement_id, title, source_reference, note, kind, status, source_object_id, source_version_id, request_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'UPLOADED_FILE', 'ACTIVE', $8, $9, $10, 'PMC') RETURNING id",
        [
          tenantId,
          id,
          body.data.situationCode,
          body.data.requirementId,
          body.data.title,
          `已入库：${validated.originalName}`,
          body.data.note,
          sourceObjectId,
          sourceVersionId,
          body.data.requestId,
        ],
      );
      const materialId = String(inserted.rows[0]?.id);
      await client.query(
        "INSERT INTO vs15_material_contents (source_version_id, tenant_id, storage_key, sha256, byte_size, media_type, original_name, extraction_status, content_preview, readable_by_ai) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [
          sourceVersionId,
          tenantId,
          staged.storageKey,
          validated.sha256,
          validated.byteSize,
          validated.mediaType,
          validated.originalName,
          validated.extractionStatus,
          validated.contentPreview,
          validated.readableByAi,
        ],
      );
      await client.query(
        "INSERT INTO vs15_material_events (tenant_id, material_id, event_type, actor, reason, snapshot) VALUES ($1, $2, 'IMPORTED', 'PMC', NULL, $3::jsonb)",
        [
          tenantId,
          materialId,
          JSON.stringify({
            requirementId: body.data.requirementId,
            sourceObjectId,
            sourceVersionId,
            sha256: validated.sha256,
          }),
        ],
      );
      await this.materialVault.finalize(staged.temporaryKey, staged.storageKey);
      temporaryKey = null;
      finalizedKey = staged.storageKey;
      if (!this.commandTransaction) await client.query("COMMIT");
      committed = true;
      return this.materialById(id, materialId);
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      if (!committed && temporaryKey)
        await this.materialVault.discard(temporaryKey).catch(() => undefined);
      if (!committed && finalizedKey)
        await this.materialVault.discard(finalizedKey).catch(() => undefined);
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  async withdrawTaskMaterial(
    id: string,
    materialId: string,
    input: unknown,
  ): Promise<TaskMaterial> {
    const body = taskMaterialWithdrawInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("停用材料必须填写原因");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const current = await client.query(
        "SELECT id, status, source_object_id, source_version_id, requirement_id FROM vs01_task_materials WHERE id = $1 AND task_id = $2 AND tenant_id = $3 FOR UPDATE",
        [materialId, id, tenantId],
      );
      if (!current.rowCount) throw new NotFoundException("材料不存在");
      if (current.rows[0]?.status !== "ACTIVE")
        throw new BadRequestException("材料当前不能再次停用");
      await client.query(
        "UPDATE vs01_task_materials SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = $4 WHERE id = $1 AND task_id = $2 AND tenant_id = $3",
        [materialId, id, tenantId, body.data.reason],
      );
      await client.query(
        "INSERT INTO vs15_material_events (tenant_id, material_id, event_type, actor, reason, snapshot) VALUES ($1, $2, 'WITHDRAWN', 'PMC', $3, $4::jsonb)",
        [
          tenantId,
          materialId,
          body.data.reason,
          JSON.stringify({
            sourceObjectId: current.rows[0]?.source_object_id ?? null,
            sourceVersionId: current.rows[0]?.source_version_id ?? null,
            requirementId: current.rows[0]?.requirement_id ?? null,
          }),
        ],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
      return this.materialById(id, materialId);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  async taskMaterialContent(id: string, materialId: string) {
    const material = await this.database.query(
      "SELECT c.storage_key, c.media_type, c.original_name FROM vs01_task_materials m JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id WHERE m.id = $1 AND m.task_id = $2 AND m.tenant_id = $3",
      [materialId, id, tenantId],
    );
    if (!material.rowCount) throw new NotFoundException("文件材料不存在");
    const row = material.rows[0] as QueryResultRow;
    try {
      return {
        stream: await this.materialVault.open(String(row.storage_key)),
        mediaType: String(row.media_type),
        originalName: String(row.original_name),
      };
    } catch {
      throw new ServiceUnavailableException(
        "材料文件暂时不可读取，请稍后重试或重新上传",
      );
    }
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
    const body = createProjectInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的项目创建请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    const createdProjectId =
      reservedProjectId ??
      (isProduction()
        ? productionReservationId(body.data.sourceTaskId)
        : this.projectIdForTask(body.data.sourceTaskId));
    const createdNodeId = this.nodeIdForProject(createdProjectId);
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      if (isProduction())
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${tenantId}:source-intake`],
        );
      const task = await client.query(
        "SELECT id, status FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [body.data.sourceTaskId, tenantId],
      );
      if (task.rowCount === 0) throw new NotFoundException("任务不存在");
      if (task.rows[0]?.status !== "DECIDED")
        throw new BadRequestException("只有已决策任务可以创建项目");
      const existing = await client.query(
        "SELECT id FROM vs01_projects WHERE source_task_id = $1 AND tenant_id = $2 FOR UPDATE",
        [body.data.sourceTaskId, tenantId],
      );
      if (existing.rowCount !== 0)
        throw new BadRequestException("该问题已经建立咨询任务");
      const facts = isProduction()
        ? {
            rowCount: 1,
            rows: [
              await productionTaskFacts(
                client,
                body.data.sourceTaskId,
                tenantId,
                false,
              ),
            ],
          }
        : await client.query<OrderRow>(
            "SELECT o.order_id, o.customer, o.promised_date, o.forecast_date, GREATEST((b.actual_bom_date - b.planned_bom_date), 0)::int AS bom_delay, GREATEST((p.actual_start_date - p.planned_start_date), 0)::int AS purchase_delay FROM vs01_orders o JOIN vs01_bom b ON b.order_id = o.order_id AND b.tenant_id = o.tenant_id JOIN vs01_purchases p ON p.order_id = o.order_id AND p.tenant_id = o.tenant_id WHERE o.order_id = $1 AND o.tenant_id = $2 FOR SHARE",
            [body.data.sourceTaskId, tenantId],
          );
      if (facts.rowCount !== 1)
        throw new NotFoundException("来源订单事实不存在");
      const factContextWithoutSnapshot = this.projectFactContext(
        body.data.sourceTaskId,
        facts.rows[0] as OrderRow,
        "",
      );
      const historicalSnapshot = await this.createProjectSource(
        client,
        `来源事实快照（不代表已核验）：${body.data.sourceTaskId}；${factContextWithoutSnapshot.orderEvidenceReference}；${factContextWithoutSnapshot.bomEvidenceReference}；${factContextWithoutSnapshot.purchaseEvidenceReference}`,
      );
      const factContext = this.projectFactContext(
        body.data.sourceTaskId,
        facts.rows[0] as OrderRow,
        historicalSnapshot.reference,
      );
      const metricRows = await client.query(
        "SELECT order_id,promised_date,forecast_date,source_row,source_version_id FROM vs01_orders WHERE tenant_id=$1 AND status <> 'E2E_ACCEPTANCE' ORDER BY order_id",
        [tenantId],
      );
      const baseline = otdPercentage(
        metricRows.rows.map((row) => ({
          promisedDate: this.date(row.promised_date),
          forecastDate: this.date(row.forecast_date),
        })),
      );
      const targetOtd = runtimeTargetOtd();
      await client.query(
        "INSERT INTO vs01_projects (id, tenant_id, source_task_id, name, status, returned_reason, metric_before, metric_current, metric_target) VALUES ($1, $2, $3, '解决订单延期问题', 'DRAFT', NULL, $4, $4, $5)",
        [
          createdProjectId,
          tenantId,
          body.data.sourceTaskId,
          baseline,
          targetOtd,
        ],
      );
      if (isProduction())
        await pinProjectSnapshot(
          client,
          tenantId,
          createdProjectId,
          facts.rows[0]!,
          metricRows.rows,
          baseline,
        );
      await client.query(
        "INSERT INTO vs01_project_nodes (id, tenant_id, project_id, name, status, progress, latest_update) VALUES ($1, $2, $3, 'BOM治理', 'NOT_STARTED', 0, '尚未更新') ON CONFLICT (project_id) DO NOTHING",
        [createdNodeId, tenantId, createdProjectId],
      );
      for (const [index, phase] of phases.entries()) {
        const rootCauseFirst =
          !isProduction() && body.data.sourceTaskId === "SO-202608136";
        const gate = isProduction()
          ? initialProductionGate(index)
          : rootCauseFirst
            ? index < 2
              ? "APPROVED"
              : index === 2
                ? "OPEN"
                : "LOCKED"
            : index < 3
              ? "APPROVED"
              : index === 3
                ? "OPEN"
                : "LOCKED";
        await client.query(
          "INSERT INTO vs01_project_phases (id, tenant_id, project_id, code, name, purpose, sort_order, gate_status, gate_label) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [
            this.phaseIdForProject(createdProjectId, index + 1),
            tenantId,
            createdProjectId,
            phase[0],
            phase[1],
            phase[2],
            index + 1,
            gate,
            rootCauseFirst && index === 2
              ? "员工核验结论"
              : index === 3
                ? "老板方案批准"
                : "阶段门",
          ],
        );
      }
      const initialTemplates = this.taskTemplates(factContext);
      for (const taskDefinition of isProduction()
        ? initializeProductionTemplates(initialTemplates)
        : initialTemplates) {
        await client.query(
          "INSERT INTO vs01_project_subtasks (id, tenant_id, node_id, title, status, sort_order, phase_code, purpose, owner, origin, inputs, process, expected_output, acceptance, completion_note, output_reference, completed_at, source_recorded_at, output_source_object_id, output_source_version_id, completion_basis, confirmed_by, confirmed_at, confirmed_acceptance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb, $15, $16, CASE WHEN $5 = 'DONE' THEN (SELECT decided_at FROM vs01_decisions WHERE task_id = $17 AND tenant_id = $2) ELSE NULL END, CASE WHEN $5 = 'DONE' THEN (SELECT decided_at FROM vs01_decisions WHERE task_id = $17 AND tenant_id = $2) ELSE NULL END, CASE WHEN $5 = 'DONE' THEN $18 ELSE NULL END, CASE WHEN $5 = 'DONE' THEN $19 ELSE NULL END, CASE WHEN $5 = 'DONE' THEN 'HISTORICAL_SOURCE' ELSE NULL END, CASE WHEN $5 = 'DONE' THEN $9 ELSE NULL END, CASE WHEN $5 = 'DONE' THEN (SELECT decided_at FROM vs01_decisions WHERE task_id = $17 AND tenant_id = $2) ELSE NULL END, CASE WHEN $5 = 'DONE' THEN $14::jsonb ELSE NULL END)",
          [
            this.subtaskIdForProject(createdProjectId, taskDefinition.id),
            tenantId,
            createdNodeId,
            taskDefinition.title,
            taskDefinition.status,
            taskDefinition.sortOrder,
            taskDefinition.phaseCode,
            taskDefinition.purpose,
            taskDefinition.owner,
            taskDefinition.origin,
            JSON.stringify(taskDefinition.inputs),
            JSON.stringify(taskDefinition.process),
            taskDefinition.expectedOutput,
            JSON.stringify(taskDefinition.acceptance),
            taskDefinition.status === "DONE"
              ? "来源任务、人工判断与订单证据生成的历史快照"
              : "",
            taskDefinition.status === "DONE"
              ? taskDefinition.outputReference
              : null,
            body.data.sourceTaskId,
            historicalSnapshot.sourceObjectId,
            historicalSnapshot.sourceVersionId,
          ],
        );
      }
      await client.query(
        "INSERT INTO vs01_result_validations (project_id, tenant_id, baseline, target) VALUES ($1, $2, $3, $4)",
        [createdProjectId, tenantId, baseline, targetOtd],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(createdProjectId);
  }

  async submitProject(id: string, input: unknown): Promise<Project> {
    this.action(input, "PMC");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const rootCauseGate = await client.query(
        "SELECT gate_status FROM vs01_project_phases WHERE project_id = $1 AND tenant_id = $2 AND code = 'ROOT_CAUSE_VALIDATION' FOR UPDATE",
        [id, tenantId],
      );
      if (rootCauseGate.rowCount !== 1)
        throw new NotFoundException("根因核验阶段不存在");
      if (rootCauseGate.rows[0]?.gate_status !== "APPROVED")
        throw new BadRequestException("请先确认根因核验结论");
      const required = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'PMC'",
        [tenantId, scopedNodeId],
      );
      if (
        Number(required.rows[0]?.total) !== Number(required.rows[0]?.completed)
      )
        throw new BadRequestException("请先完成方案设计与任务拆解");
      const before = await client.query(
        "SELECT p.status AS project_status, p.returned_reason AS project_returned_reason, ph.gate_status, ph.returned_reason AS gate_returned_reason FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'SOLUTION_APPROVAL' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph",
        [id, tenantId],
      );
      if (before.rowCount !== 1) throw new NotFoundException("项目不存在");
      const project = await client.query(
        "UPDATE vs01_projects SET status = 'PENDING_APPROVAL', returned_reason = NULL WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT', 'RETURNED')",
        [id, tenantId],
      );
      if (project.rowCount !== 1)
        throw new BadRequestException("项目当前不能提交方案");
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'PENDING', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'SOLUTION_APPROVAL'",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'WAITING_REVIEW' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'OWNER' AND status IN ('LOCKED', 'RETURNED')",
        [tenantId, scopedNodeId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'PROJECT_SUBMITTED', 'SOLUTION_APPROVAL', '', 'PMC', $3::jsonb)",
        [
          tenantId,
          id,
          JSON.stringify({
            before: {
              projectStatus: before.rows[0]?.project_status,
              gateStatus: before.rows[0]?.gate_status,
            },
            after: {
              projectStatus: "PENDING_APPROVAL",
              gateStatus: "PENDING",
              ownerTaskStatus: "WAITING_REVIEW",
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

  async approveProject(id: string, input: unknown): Promise<Project> {
    this.action(input, "OWNER");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const before = await client.query(
        "SELECT p.status AS project_status, p.returned_reason AS project_returned_reason, ph.gate_status, ph.returned_reason, s.status AS approval_task_status, s.completion_note, s.output_reference, s.output_source_object_id, s.output_source_version_id, s.completed_at FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'SOLUTION_APPROVAL' JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.phase_code = 'SOLUTION_APPROVAL' AND s.owner = 'OWNER' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph, s",
        [id, tenantId],
      );
      if (before.rowCount !== 1) throw new NotFoundException("项目不存在");
      const updated = await client.query(
        "UPDATE vs01_projects SET status = 'RUNNING', returned_reason = NULL WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_APPROVAL'",
        [id, tenantId],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("项目当前不能批准");
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'SOLUTION_APPROVAL'",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'EXECUTION_CONTROL' AND status = 'LOCKED'",
        [tenantId, scopedNodeId],
      );
      const approvalLocator = await this.createProjectSource(
        client,
        "项目批准记录",
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'DONE', completion_note = '企业负责人已确认解决方案', output_reference = $3, output_source_object_id = $4, output_source_version_id = $5, completion_basis = 'ROLE_DECISION', confirmed_by = 'OWNER', confirmed_at = now(), confirmed_acceptance = acceptance, completed_at = now() WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'OWNER'",
        [
          tenantId,
          scopedNodeId,
          approvalLocator.reference,
          approvalLocator.sourceObjectId,
          approvalLocator.sourceVersionId,
        ],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'PROJECT_APPROVED', 'SOLUTION_APPROVAL', '', 'OWNER', $3::jsonb)",
        [
          tenantId,
          id,
          JSON.stringify({
            before: this.approvalSnapshot(before.rows[0]),
            after: {
              projectStatus: "RUNNING",
              projectReturnedReason: null,
              gateStatus: "APPROVED",
              gateReturnedReason: null,
              approvalTask: {
                status: "DONE",
                completionNote: "企业负责人已确认解决方案",
                outputReference: approvalLocator.reference,
                locator: approvalLocator,
                completedAt: "recorded_at_event",
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

  async returnProject(id: string, input: unknown): Promise<Project> {
    const body = projectReturnInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的退回请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const before = await client.query(
        "SELECT p.status AS project_status, ph.gate_status FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'SOLUTION_APPROVAL' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph",
        [id, tenantId],
      );
      if (before.rowCount !== 1) throw new NotFoundException("项目不存在");
      const project = await client.query(
        "UPDATE vs01_projects SET status = 'RETURNED', returned_reason = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_APPROVAL'",
        [id, tenantId, body.data.reason],
      );
      if (project.rowCount !== 1)
        throw new BadRequestException("项目当前不能退回方案");
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'SOLUTION_APPROVAL'",
        [id, tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'RETURNED', reopen_reason = $3 WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'OWNER'",
        [tenantId, scopedNodeId, body.data.reason],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'PROJECT_RETURNED', 'SOLUTION_APPROVAL', $3, 'OWNER', $4::jsonb)",
        [
          tenantId,
          id,
          body.data.reason,
          JSON.stringify({
            before: {
              projectStatus: before.rows[0]?.project_status,
              gateStatus: before.rows[0]?.gate_status,
            },
            after: {
              projectStatus: "RETURNED",
              gateStatus: "RETURNED",
              ownerTaskStatus: "RETURNED",
              reason: body.data.reason,
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

  async project(id: string): Promise<Project> {
    const project = await this.findProject(id);
    if (!project) throw new NotFoundException("项目不存在");
    return project;
  }

  /** Stable read seam for authorized Integration API projections. */
  async projectList(): Promise<Project[]> {
    return this.projects();
  }

  /** Safe, contract-shaped projection used by the read-only project assistant. */
  async rootCauseWorkpaper(id: string) {
    this.workpapers ??= new RootCauseWorkpaperService();
    return this.workpapers.view(id);
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
            situationCode: this.materialSituationForInput(item.label),
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
    const result = await this.database.query(
      "SELECT id, project_id, phase_code, status, issue_type, feedback, expected_behavior, created_at, withdrawn_at, withdrawn_reason FROM vs01_assistant_feedback_candidates WHERE project_id = $1 AND tenant_id = $2 ORDER BY created_at DESC",
      [projectIdValue, tenantId],
    );
    if (result.rowCount === 0) {
      const project = await this.database.query(
        "SELECT 1 FROM vs01_projects WHERE id = $1 AND tenant_id = $2",
        [projectIdValue, tenantId],
      );
      if (project.rowCount === 0) throw new NotFoundException("项目不存在");
    }
    return assistantFeedbackListSchema.parse(
      result.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        stageCode: row.phase_code,
        status: row.status,
        issueType: row.issue_type,
        feedback: row.feedback,
        expectedBehavior: row.expected_behavior,
        createdAt: new Date(row.created_at).toISOString(),
        withdrawnAt: row.withdrawn_at
          ? new Date(row.withdrawn_at).toISOString()
          : null,
        withdrawnReason: row.withdrawn_reason ?? null,
      })),
    );
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
    const body = projectSubtaskStatusInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的子任务更新");
    const client = this.commandTransaction ?? (await this.pool.connect());
    let resolvedProjectId: string;
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const subtask = await client.query(
        "SELECT s.status AS subtask_status, s.sort_order, s.node_id, s.phase_code, s.origin, s.owner, s.acceptance, s.progress_note, s.progress_output_reference, s.progress_updated_at, s.completion_note, s.output_reference, s.output_source_object_id, s.output_source_version_id, s.completion_basis, s.confirmed_by, s.confirmed_at, s.confirmed_acceptance, s.completed_at, n.project_id, p.status AS project_status, root_phase.gate_status AS root_gate_status FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id JOIN vs01_projects p ON p.id = n.project_id LEFT JOIN vs01_project_phases root_phase ON root_phase.project_id = p.id AND root_phase.tenant_id = s.tenant_id AND root_phase.code = 'ROOT_CAUSE_VALIDATION' WHERE s.id = $1 AND s.tenant_id = $2 FOR UPDATE OF s, n, p",
        [id, tenantId],
      );
      if (subtask.rowCount === 0)
        throw new NotFoundException("项目子任务不存在");
      // DRAFT includes root-cause validation; its gate determines whether
      // the solution phase is available yet.
      let activePhase =
        subtask.rows[0]?.project_status === "DRAFT" &&
        subtask.rows[0]?.root_gate_status === "OPEN"
          ? "ROOT_CAUSE_VALIDATION"
          : this.activePhaseForProject(String(subtask.rows[0]?.project_status));
      if (isProduction() && subtask.rows[0]?.project_status === "DRAFT") {
        const open = await client.query(
          "SELECT code FROM vs01_project_phases WHERE project_id=$1 AND tenant_id=$2 AND gate_status='OPEN' ORDER BY sort_order LIMIT 1 FOR UPDATE",
          [subtask.rows[0]?.project_id, tenantId],
        );
        activePhase = open.rows[0] ? String(open.rows[0].code) : null;
      }
      const isExecutionRollback =
        body.data.status === "READY" &&
        subtask.rows[0]?.phase_code === "EXECUTION_CONTROL" &&
        subtask.rows[0]?.project_status === "RESULT_VALIDATION";
      if (isExecutionRollback) {
        const downstream = await client.query(
          "SELECT (SELECT count(*) FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE' AND status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS result_done, (SELECT status FROM vs01_result_validations WHERE project_id = $3 AND tenant_id = $1)::text AS outcome_status",
          [tenantId, subtask.rows[0]?.node_id, subtask.rows[0]?.project_id],
        );
        if (Number(downstream.rows[0]?.result_done) > 0)
          throw new BadRequestException(
            "结果节点已有完成事实；请先逐项重开结果任务",
          );
        if (downstream.rows[0]?.outcome_status !== "NOT_MEASURED")
          throw new BadRequestException(
            "结果已提交或签收，存在下游依赖；请先处理结果验收记录",
          );
        await client.query(
          "UPDATE vs01_projects SET status = 'RUNNING' WHERE id = $1 AND tenant_id = $2",
          [subtask.rows[0]?.project_id, tenantId],
        );
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'EXECUTION_CONTROL' THEN 'OPEN' ELSE 'LOCKED' END WHERE project_id = $1 AND tenant_id = $2 AND code IN ('EXECUTION_CONTROL', 'RESULT_ACCEPTANCE')",
          [subtask.rows[0]?.project_id, tenantId],
        );
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'LOCKED' WHERE node_id = $1 AND tenant_id = $2 AND phase_code = 'RESULT_ACCEPTANCE'",
          [subtask.rows[0]?.node_id, tenantId],
        );
      }
      if (
        subtask.rows[0]?.origin === "HISTORICAL" ||
        (subtask.rows[0]?.phase_code !== activePhase && !isExecutionRollback)
      )
        throw new BadRequestException("只能操作当前已解锁节点的小任务");
      if (subtask.rows[0]?.owner !== body.data.actor)
        throw new BadRequestException("只有本事项责任人可以确认完成");
      if (
        subtask.rows[0]?.phase_code === "ROOT_CAUSE_VALIDATION" &&
        (!isProduction() || Number(subtask.rows[0]?.sort_order) === 3) &&
        body.data.status !== "IN_PROGRESS"
      )
        throw new BadRequestException("根因结论请通过核验记录确认或重开");
      const currentStatus = String(subtask.rows[0]?.subtask_status);
      if (
        body.data.status === "IN_PROGRESS" &&
        !["READY", "IN_PROGRESS"].includes(currentStatus)
      )
        throw new BadRequestException("只有待执行或处理中的事项可以保存进展");
      if (
        body.data.status === "DONE" &&
        !["READY", "IN_PROGRESS"].includes(currentStatus)
      )
        throw new BadRequestException("只有待执行或处理中的事项可以确认完成");
      if (body.data.status === "READY" && currentStatus !== "DONE")
        throw new BadRequestException("只有已完成事项可以重新打开");
      if (body.data.status === "DONE") {
        const expected = (subtask.rows[0]?.acceptance ?? []) as string[];
        const confirmed = body.data.confirmedAcceptanceCriteria;
        if (
          expected.length !== confirmed.length ||
          expected.some((item) => !confirmed.includes(item))
        )
          throw new BadRequestException("必须逐项确认本事项全部验收标准");
      }
      if (
        body.data.status !== "IN_PROGRESS" &&
        subtask.rows[0]?.subtask_status === body.data.status
      )
        throw new BadRequestException(
          body.data.status === "DONE"
            ? "子任务已经完成"
            : "子任务已经是待办状态",
        );
      const eventType =
        body.data.status === "DONE"
          ? "COMPLETED"
          : body.data.status === "READY"
            ? "REOPENED"
            : "PROGRESS_SAVED";
      const outputReference =
        "outputReference" in body.data ? body.data.outputReference : "";
      const confirmedAcceptanceCriteria =
        body.data.status === "DONE"
          ? body.data.confirmedAcceptanceCriteria
          : [];
      const locator =
        body.data.status === "DONE"
          ? await this.createProjectSource(client, body.data.outputReference)
          : null;
      await client.query(
        "UPDATE vs01_project_subtasks SET status = $3, progress_note = CASE WHEN $3 = 'IN_PROGRESS' THEN $4 WHEN $3 = 'READY' THEN NULL ELSE progress_note END, progress_output_reference = CASE WHEN $3 = 'IN_PROGRESS' THEN NULLIF($5, '') WHEN $3 = 'READY' THEN NULL ELSE progress_output_reference END, progress_updated_at = CASE WHEN $3 = 'IN_PROGRESS' THEN now() WHEN $3 = 'READY' THEN NULL ELSE progress_updated_at END, completion_note = CASE WHEN $3 = 'DONE' THEN $4 WHEN $3 = 'READY' THEN '' ELSE completion_note END, output_reference = CASE WHEN $3 = 'DONE' THEN $5 ELSE CASE WHEN $3 = 'READY' THEN NULL ELSE output_reference END END, output_source_object_id = CASE WHEN $3 = 'DONE' THEN $6 ELSE CASE WHEN $3 = 'READY' THEN NULL ELSE output_source_object_id END END, output_source_version_id = CASE WHEN $3 = 'DONE' THEN $7 ELSE CASE WHEN $3 = 'READY' THEN NULL ELSE output_source_version_id END END, completion_basis = CASE WHEN $3 = 'DONE' THEN 'ASSIGNEE_CONFIRMED' WHEN $3 = 'READY' THEN NULL ELSE completion_basis END, confirmed_by = CASE WHEN $3 = 'DONE' THEN 'PMC' WHEN $3 = 'READY' THEN NULL ELSE confirmed_by END, confirmed_at = CASE WHEN $3 = 'DONE' THEN now() WHEN $3 = 'READY' THEN NULL ELSE confirmed_at END, confirmed_acceptance = CASE WHEN $3 = 'DONE' THEN $8::jsonb WHEN $3 = 'READY' THEN NULL ELSE confirmed_acceptance END, reopen_reason = CASE WHEN $3 = 'READY' THEN $4 ELSE reopen_reason END, completed_at = CASE WHEN $3 = 'DONE' THEN now() WHEN $3 = 'READY' THEN NULL ELSE completed_at END WHERE id = $1 AND tenant_id = $2",
        [
          id,
          tenantId,
          body.data.status,
          body.data.note,
          outputReference,
          locator?.sourceObjectId ?? null,
          locator?.sourceVersionId ?? null,
          JSON.stringify(confirmedAcceptanceCriteria),
        ],
      );
      await client.query(
        "INSERT INTO vs01_project_subtask_events (tenant_id, subtask_id, event_type, note, actor) VALUES ($1, $2, $3, $4, 'PMC')",
        [tenantId, id, eventType, body.data.note],
      );
      resolvedProjectId = String(subtask.rows[0].project_id);
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, $3, $4, $5, 'PMC', $6::jsonb)",
        [
          tenantId,
          resolvedProjectId,
          eventType === "COMPLETED"
            ? "TASK_COMPLETED"
            : eventType === "REOPENED"
              ? "TASK_REOPENED"
              : "PROGRESS_SAVED",
          subtask.rows[0].phase_code,
          body.data.note,
          JSON.stringify({
            before: {
              status: subtask.rows[0]?.subtask_status,
              progressUpdate: subtask.rows[0]?.progress_updated_at
                ? {
                    note: subtask.rows[0]?.progress_note,
                    outputReference: subtask.rows[0]?.progress_output_reference,
                    updatedAt: subtask.rows[0]?.progress_updated_at,
                  }
                : null,
              completionNote: subtask.rows[0]?.completion_note,
              outputReference: subtask.rows[0]?.output_reference,
              locator: subtask.rows[0]?.output_source_object_id
                ? {
                    sourceObjectId: subtask.rows[0]?.output_source_object_id,
                    sourceVersionId: subtask.rows[0]?.output_source_version_id,
                    reference: subtask.rows[0]?.output_reference,
                  }
                : null,
              completedAt: subtask.rows[0]?.completed_at ?? null,
              completionConfirmation: subtask.rows[0]?.confirmed_at
                ? {
                    basis: subtask.rows[0]?.completion_basis,
                    confirmedBy: subtask.rows[0]?.confirmed_by,
                    confirmedAt: subtask.rows[0]?.confirmed_at,
                    confirmedAcceptanceCriteria:
                      subtask.rows[0]?.confirmed_acceptance ?? [],
                  }
                : null,
            },
            after: {
              status: body.data.status,
              progressUpdate:
                body.data.status === "IN_PROGRESS"
                  ? {
                      note: body.data.note,
                      outputReference: outputReference || null,
                      updatedAt: "recorded_at_event",
                    }
                  : null,
              completionNote: body.data.status === "DONE" ? body.data.note : "",
              outputReference:
                body.data.status === "DONE" ? body.data.outputReference : null,
              locator,
              completedAt:
                body.data.status === "DONE" ? "recorded_at_event" : null,
              completionConfirmation:
                body.data.status === "DONE"
                  ? {
                      basis: "ASSIGNEE_CONFIRMED",
                      confirmedBy: body.data.actor,
                      confirmedAt: "recorded_at_event",
                      confirmedAcceptanceCriteria,
                    }
                  : null,
            },
          }),
        ],
      );
      if (
        isProduction() &&
        ["PROJECT_SCOPING", "BASELINE_FACTS"].includes(
          String(subtask.rows[0].phase_code),
        )
      ) {
        const counts = await client.query(
          "SELECT count(*)::int AS total, count(*) FILTER (WHERE status='DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE node_id=$1 AND tenant_id=$2 AND phase_code=$3 AND owner='PMC'",
          [subtask.rows[0].node_id, tenantId, subtask.rows[0].phase_code],
        );
        const next = nextEarlyPhase(
          String(subtask.rows[0].phase_code),
          Number(counts.rows[0]?.total),
          Number(counts.rows[0]?.completed),
        );
        if (next) {
          await client.query(
            "UPDATE vs01_project_phases SET gate_status='APPROVED' WHERE project_id=$1 AND tenant_id=$2 AND code=$3 AND gate_status='OPEN'",
            [resolvedProjectId, tenantId, subtask.rows[0].phase_code],
          );
          await client.query(
            "UPDATE vs01_project_phases SET gate_status='OPEN' WHERE project_id=$1 AND tenant_id=$2 AND code=$3 AND gate_status='LOCKED'",
            [resolvedProjectId, tenantId, next],
          );
          await client.query(
            "UPDATE vs01_project_subtasks SET status='READY' WHERE node_id=$1 AND tenant_id=$2 AND phase_code=$3 AND owner='PMC' AND status='LOCKED'",
            [subtask.rows[0].node_id, tenantId, next],
          );
          // TASK_COMPLETED above retains before/after and the human command audit.
        }
      }
      const counts = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE node_id = $1 AND phase_code = 'EXECUTION_CONTROL' AND tenant_id = $2",
        [subtask.rows[0].node_id, tenantId],
      );
      const total = Number(counts.rows[0]?.total ?? 0);
      const completed = Number(counts.rows[0]?.completed ?? 0);
      if (total === 0) throw new BadRequestException("节点没有可计算的子任务");
      const progress = Math.round((completed / total) * 100);
      const status =
        progress === 100
          ? "COMPLETED"
          : body.data.status === "IN_PROGRESS"
            ? "IN_PROGRESS"
            : progress === 0
              ? "NOT_STARTED"
              : "IN_PROGRESS";
      if (subtask.rows[0].phase_code === "EXECUTION_CONTROL") {
        await client.query(
          "UPDATE vs01_project_nodes SET progress = $3, status = $4, latest_update = $5 WHERE id = $1 AND tenant_id = $2",
          [subtask.rows[0].node_id, tenantId, progress, status, body.data.note],
        );
        await client.query(
          "INSERT INTO vs01_node_updates (tenant_id, node_id, progress, update_text) VALUES ($1, $2, $3, $4)",
          [tenantId, subtask.rows[0].node_id, progress, body.data.note],
        );
      }
      if (
        subtask.rows[0].phase_code === "EXECUTION_CONTROL" &&
        progress === 100
      ) {
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
          [resolvedProjectId, tenantId],
        );
        await client.query(
          "UPDATE vs01_projects SET status = 'RESULT_VALIDATION' WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'",
          [resolvedProjectId, tenantId],
        );
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
          [resolvedProjectId, tenantId],
        );
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE' AND status = 'LOCKED'",
          [tenantId, subtask.rows[0].node_id],
        );
        await this.appendProjectEvent(
          client,
          resolvedProjectId,
          "EXECUTION_CONFIRMED_BY_EMPLOYEE",
          "PMC",
          "全部落实事项已由责任员工确认完成，进入结果确认",
          {
            before: { projectStatus: "RUNNING", gateStatus: "OPEN" },
            after: {
              projectStatus: "RESULT_VALIDATION",
              gateStatus: "APPROVED",
              resultGateStatus: "OPEN",
            },
          },
          "EXECUTION_CONTROL",
        );
      } else if (
        subtask.rows[0].phase_code === "EXECUTION_CONTROL" &&
        body.data.status === "READY"
      ) {
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL' AND gate_status IN ('PENDING', 'RETURNED')",
          [resolvedProjectId, tenantId],
        );
      }
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(resolvedProjectId!);
  }

  async reviewExecutionPhase(id: string, input: unknown): Promise<Project> {
    const body = executionPhaseReviewInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的执行阶段复核请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const phase = await client.query(
        "SELECT p.status AS project_status, ph.gate_status, ph.returned_reason FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'EXECUTION_CONTROL' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph",
        [id, tenantId],
      );
      if (phase.rowCount !== 1) throw new NotFoundException("项目不存在");
      if (
        phase.rows[0]?.project_status !== "RUNNING" ||
        phase.rows[0]?.gate_status !== "PENDING"
      )
        throw new BadRequestException("执行事项尚未进入待复核状态");
      if (body.data.decision === "APPROVE") {
        const counts = await client.query(
          "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'EXECUTION_CONTROL'",
          [tenantId, scopedNodeId],
        );
        if (Number(counts.rows[0]?.total) !== Number(counts.rows[0]?.completed))
          throw new BadRequestException("请先由事项责任人确认全部执行事项");
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
          [id, tenantId],
        );
        await client.query(
          "UPDATE vs01_projects SET status = 'RESULT_VALIDATION' WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'",
          [id, tenantId],
        );
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
          [id, tenantId],
        );
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE' AND status = 'LOCKED'",
          [tenantId, scopedNodeId],
        );
        await this.appendProjectEvent(
          client,
          id,
          "EXECUTION_REVIEW_APPROVED",
          "PMC",
          body.data.note,
          {
            before: { projectStatus: "RUNNING", gateStatus: "PENDING" },
            after: {
              projectStatus: "RESULT_VALIDATION",
              gateStatus: "APPROVED",
              resultGateStatus: "OPEN",
            },
          },
        );
      } else {
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
          [id, tenantId, body.data.reason],
        );
        await this.appendProjectEvent(
          client,
          id,
          "EXECUTION_REVIEW_RETURNED",
          "PMC",
          body.data.reason,
          {
            before: { projectStatus: "RUNNING", gateStatus: "PENDING" },
            after: {
              projectStatus: "RUNNING",
              gateStatus: "RETURNED",
              reason: body.data.reason,
            },
          },
        );
      }
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.project(id);
  }

  async submitOutcome(id: string, input: unknown): Promise<Project> {
    const body = outcomeSubmitInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的结果确认提交");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const project = await client.query(
        "SELECT status FROM vs01_projects WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (project.rowCount === 0) throw new NotFoundException("项目不存在");
      if (project.rows[0]?.status !== "RESULT_VALIDATION")
        throw new BadRequestException("项目当前不能确认结果");
      const tasks = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE'",
        [tenantId, scopedNodeId],
      );
      if (Number(tasks.rows[0]?.total) !== Number(tasks.rows[0]?.completed))
        throw new BadRequestException("请先由责任员工确认结果步骤的全部事项");
      const before = await client.query(
        "SELECT status, current, conclusion, evidence_reference, note, submitted_at, accepted_at, returned_reason, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (before.rowCount !== 1)
        throw new NotFoundException("结果验收记录不存在");
      const locator = await this.createProjectSource(
        client,
        body.data.evidenceReference,
      );
      const updated = await client.query(
        "UPDATE vs01_result_validations SET current = $3, conclusion = $4, evidence_reference = $5, note = $6, source_object_id = $7, source_version_id = $8, status = 'ACCEPTED', submitted_at = now(), accepted_at = now(), returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND status IN ('NOT_MEASURED', 'RETURNED')",
        [
          id,
          tenantId,
          body.data.currentOtd,
          body.data.conclusion,
          body.data.evidenceReference,
          body.data.note,
          locator.sourceObjectId,
          locator.sourceVersionId,
        ],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("结果已经确认，需先带原因重新打开");
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'RESULT_ACCEPTANCE' THEN 'APPROVED' WHEN code = 'KNOWLEDGE_CAPTURE' THEN 'OPEN' ELSE gate_status END, returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code IN ('RESULT_ACCEPTANCE', 'KNOWLEDGE_CAPTURE')",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE node_id = $1 AND tenant_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE' AND status = 'LOCKED'",
        [scopedNodeId, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'OUTCOME_CONFIRMED_BY_EMPLOYEE', 'RESULT_ACCEPTANCE', $3, 'PMC', $4::jsonb)",
        [
          tenantId,
          id,
          body.data.conclusion,
          JSON.stringify({
            before: this.outcomeSnapshot(before.rows[0]),
            after: {
              status: "ACCEPTED",
              current: body.data.currentOtd,
              conclusion: body.data.conclusion,
              evidenceReference: body.data.evidenceReference,
              note: body.data.note,
              submittedAt: "recorded_at_event",
              acceptedAt: "recorded_at_event",
              returnedReason: null,
              locator,
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

  async approveOutcome(id: string, input: unknown): Promise<Project> {
    this.action(input, "OWNER");
    if (id !== legacyProjectId)
      throw new BadRequestException("结果审批仅用于旧项目历史补偿");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const before = await client.query(
        "SELECT status, current, conclusion, evidence_reference, note, submitted_at, accepted_at, returned_reason, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (before.rowCount !== 1)
        throw new NotFoundException("结果验收记录不存在");
      const updated = await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_RESULT_ACCEPTANCE'",
        [id, tenantId],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("项目当前不能签收结果");
      await client.query(
        "UPDATE vs01_result_validations SET status = 'ACCEPTED', accepted_at = now(), returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'APPROVED' WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'OPEN' WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE node_id = $1 AND tenant_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE' AND status = 'LOCKED'",
        [scopedNodeId, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'OUTCOME_ACCEPTED', 'RESULT_ACCEPTANCE', '', 'OWNER', $3::jsonb)",
        [
          tenantId,
          id,
          JSON.stringify({
            before: this.outcomeSnapshot(before.rows[0]),
            after: {
              ...this.outcomeSnapshot(before.rows[0]),
              status: "ACCEPTED",
              acceptedAt: "recorded_at_event",
              returnedReason: null,
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

  async returnOutcome(id: string, input: unknown): Promise<Project> {
    const body = outcomeReturnInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的结果退回请求");
    if (id !== legacyProjectId)
      throw new BadRequestException("结果审批仅用于旧项目历史补偿");
    return this.reopenConfirmedOutcome(id, body.data.reason, "OWNER");
  }

  async reopenOutcome(id: string, input: unknown): Promise<Project> {
    const body = outcomeReopenInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的结果重新打开请求");
    return this.reopenConfirmedOutcome(id, body.data.reason, "PMC");
  }

  private async reopenConfirmedOutcome(
    id: string,
    reason: string,
    actor: "PMC" | "OWNER",
  ): Promise<Project> {
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await this.projectNodeId(client, id);
      const previous = await client.query(
        "SELECT status, current, conclusion, evidence_reference, note, submitted_at, accepted_at, returned_reason, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (previous.rowCount !== 1)
        throw new NotFoundException("结果验收记录不存在");
      const candidate = await client.query(
        "SELECT status FROM vs01_experience_candidates WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      const formalHistory = await client.query(
        "SELECT 1 FROM vs01_formal_experiences f JOIN vs01_experience_candidates c ON c.id = f.candidate_id WHERE c.project_id = $1 AND f.tenant_id = $2 AND f.status IN ('PUBLISHED', 'RETRACTED') LIMIT 1 FOR UPDATE",
        [id, tenantId],
      );
      if (formalHistory.rowCount)
        throw new BadRequestException(
          "项目已有正式经验发布历史（含已撤回版本）；不能直接更正结果，请通过新版本流程处理",
        );
      if (
        ["PENDING_REVIEW", "APPROVED"].includes(
          String(candidate.rows[0]?.status),
        )
      )
        throw new BadRequestException(
          "候选经验已送审或已发布正式经验；本阶段不能更正其来源结果，请通过后续停用/新版本流程处理",
        );
      const project = await client.query(
        "SELECT status FROM vs01_projects WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, tenantId],
      );
      if (project.rowCount !== 1) throw new NotFoundException("项目不存在");
      if (
        ![
          "PENDING_RESULT_ACCEPTANCE",
          "KNOWLEDGE_CAPTURE",
          "COMPLETED",
        ].includes(String(project.rows[0]?.status))
      )
        throw new BadRequestException("项目当前不能重新打开结果");
      await client.query(
        "UPDATE vs01_projects SET status = 'RESULT_VALIDATION' WHERE id = $1 AND tenant_id = $2",
        [id, tenantId],
      );
      await client.query(
        "UPDATE vs01_result_validations SET status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2",
        [id, tenantId, reason],
      );
      const knowledgeTasks = await client.query(
        "SELECT id, status, completion_note, output_reference, output_source_object_id, output_source_version_id, completed_at FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE' AND status = 'DONE' FOR UPDATE",
        [tenantId, scopedNodeId],
      );
      for (const task of knowledgeTasks.rows) {
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'READY', reopen_reason = $3, completed_at = NULL WHERE id = $1 AND tenant_id = $2",
          [task.id, tenantId, reason],
        );
        await client.query(
          "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'TASK_REOPENED', 'KNOWLEDGE_CAPTURE', $3, $4, $5::jsonb)",
          [
            tenantId,
            id,
            reason,
            actor,
            JSON.stringify({
              before: {
                status: task.status,
                completionNote: task.completion_note,
                outputReference: task.output_reference,
                locator: task.output_source_object_id
                  ? {
                      sourceObjectId: task.output_source_object_id,
                      sourceVersionId: task.output_source_version_id,
                      reference: task.output_reference,
                    }
                  : null,
                completedAt: task.completed_at,
              },
              after: { status: "READY", reopenReason: reason },
            }),
          ],
        );
      }
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'RESULT_ACCEPTANCE' THEN 'RETURNED' WHEN code = 'KNOWLEDGE_CAPTURE' THEN 'LOCKED' ELSE gate_status END, returned_reason = CASE WHEN code = 'RESULT_ACCEPTANCE' THEN $3 ELSE NULL END WHERE project_id = $1 AND tenant_id = $2 AND code IN ('RESULT_ACCEPTANCE', 'KNOWLEDGE_CAPTURE')",
        [id, tenantId, reason],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
        [id, tenantId, reason],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'OUTCOME_RETURNED', 'RESULT_ACCEPTANCE', $3, $4, $5::jsonb)",
        [
          tenantId,
          id,
          reason,
          actor,
          JSON.stringify({
            before: this.outcomeSnapshot(previous.rows[0]),
            after: {
              ...this.outcomeSnapshot(previous.rows[0]),
              status: "RETURNED",
              returnedReason: reason,
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
      const scopedNodeId = await this.projectNodeId(client, id);
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
      await this.appendProjectEvent(
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
    const result = await this.database.query(
      "SELECT c.id AS candidate_id, c.project_id, c.title, c.applicable_situation, c.business_problem, c.practice, c.result_summary, c.evidence_reference, c.limitations, c.status, c.revision, c.created_at, cr.created_at AS candidate_submitted_at, c.returned_reason, c.reviewed_by, c.reviewed_at, c.formal_experience_id, c.feishu_record_id, c.feishu_synced_revision, c.feishu_sync_status, c.feishu_synced_at, c.source_object_id AS evidence_source_object_id, c.source_version_id AS evidence_source_version_id, cr.source_object_id AS candidate_source_object_id, cr.source_version_id AS candidate_source_version_id, cr.structured_card, p.name AS project_name, rv.current, rv.conclusion FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions cr ON cr.candidate_id = c.id AND cr.revision = c.revision JOIN vs01_projects p ON p.id = c.project_id JOIN vs01_result_validations rv ON rv.project_id = c.project_id WHERE c.tenant_id = $1 AND c.status = 'PENDING_REVIEW' ORDER BY cr.created_at, c.id",
      [tenantId],
    );
    return expertDashboardSchema.parse({
      role: "EXPERT_REVIEWER",
      pendingReviewCount: result.rows.length,
      candidates: result.rows.map((row) => ({
        candidate: this.candidateView(row),
        project: { id: row.project_id, name: row.project_name },
        outcome: {
          current: row.current,
          conclusion: row.conclusion,
          locator: {
            sourceObjectId: row.evidence_source_object_id,
            sourceVersionId: row.evidence_source_version_id,
            reference: row.evidence_reference,
          },
        },
      })),
    });
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
      await this.appendProjectEvent(
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
      await this.appendProjectEvent(
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
    const dashboard = await this.expertExperienceReviews();
    const item = dashboard.candidates.find(
      (entry) => entry.candidate.id === candidateId,
    );
    if (!item) throw new NotFoundException("待审核候选经验不存在");
    return item;
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
      await this.appendProjectEvent(
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
    const result = await this.database.query(
      "SELECT * FROM vs01_formal_experiences WHERE tenant_id = $1 AND status = 'PUBLISHED' AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR applicable_situation ILIKE '%' || $2 || '%' OR business_problem ILIKE '%' || $2 || '%') ORDER BY published_at DESC, id",
      [tenantId, query.trim()],
    );
    return experienceLibrarySchema.parse({
      query: query.trim(),
      items: result.rows.map((row) => this.formalExperienceView(row)),
    });
  }

  async expertExperienceHistory(): Promise<ExperienceLifecycleHistoryList> {
    const result = await this.database.query(
      "SELECT c.id, c.status, c.revision, p.id AS project_id, p.name AS project_name FROM vs01_experience_candidates c JOIN vs01_projects p ON p.id = c.project_id WHERE c.tenant_id = $1 ORDER BY c.created_at DESC",
      [tenantId],
    );
    return experienceLifecycleHistoryListSchema.parse({
      items: await Promise.all(
        result.rows.map(async (candidate) => {
          const [revisions, publications, events] = await Promise.all([
            this.database.query(
              "SELECT revision, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, structured_card, created_at FROM vs01_experience_candidate_revisions WHERE candidate_id = $1 AND tenant_id = $2 ORDER BY revision",
              [candidate.id, tenantId],
            ),
            this.database.query(
              "SELECT * FROM vs01_formal_experiences WHERE candidate_id = $1 AND tenant_id = $2 ORDER BY published_at, id",
              [candidate.id, tenantId],
            ),
            this.database.query(
              "SELECT event_type, actor, note, snapshot, created_at FROM vs01_project_events WHERE project_id = $1 AND tenant_id = $2 AND event_type IN ('EXPERIENCE_CANDIDATE_CREATED', 'EXPERIENCE_CANDIDATE_WITHDRAWN', 'EXPERIENCE_RETURNED', 'EXPERIENCE_RESUBMITTED', 'EXPERIENCE_APPROVED', 'FORMAL_EXPERIENCE_PUBLISHED', 'FORMAL_EXPERIENCE_RETRACTED') ORDER BY id",
              [candidate.project_id, tenantId],
            ),
          ]);
          return {
            candidateId: candidate.id,
            project: { id: candidate.project_id, name: candidate.project_name },
            status: candidate.status,
            currentRevision: Number(candidate.revision),
            revisions: revisions.rows.map((r) => ({
              revision: Number(r.revision),
              title: r.title,
              applicableSituation: r.applicable_situation,
              businessProblem: r.business_problem,
              practice: r.practice,
              resultSummary: r.result_summary,
              evidenceReference: r.evidence_reference,
              limitations: r.limitations,
              locator: {
                sourceObjectId: r.source_object_id,
                sourceVersionId: r.source_version_id,
                reference: `候选经验 ${candidate.id} 第${r.revision}版：${r.title}`,
              },
              submittedAt: new Date(r.created_at).toISOString(),
              structuredCard: r.structured_card ?? null,
            })),
            publications: publications.rows.map((row) =>
              this.formalExperienceView(row),
            ),
            events: events.rows.map((e) => ({
              eventType: e.event_type,
              actor: e.actor,
              note: e.note,
              snapshot: e.snapshot,
              createdAt: new Date(e.created_at).toISOString(),
            })),
          };
        }),
      ),
    });
  }

  async experience(id: string): Promise<FormalExperience> {
    const result = await this.database.query(
      "SELECT * FROM vs01_formal_experiences WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED'",
      [id, tenantId],
    );
    if (result.rowCount !== 1)
      throw new NotFoundException("正式经验不存在或已撤回");
    return this.formalExperienceView(result.rows[0]);
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
        await this.appendProjectEvent(
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
        await this.appendProjectEvent(
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
      await this.appendProjectEvent(
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
        ...this.formalExperienceView(formal),
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
    this.action(input, "PMC");
    await resetAndSeed(this.pool);
    return this.employee();
  }

  private action(input: unknown, actor: "PMC" | "OWNER"): void {
    const parsed = projectActionInputSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("无效的操作请求");
    if (parsed.data.actor !== actor)
      throw new ForbiddenException("当前角色无权执行此操作");
  }

  private projectIdForTask(sourceTaskId: string): string {
    return sourceTaskId === "SO-202608128"
      ? legacyProjectId
      : `PRJ-${randomUUID()}`;
  }

  private nodeIdForProject(id: string): string {
    return id === legacyProjectId ? legacyNodeId : `NODE-${id}`;
  }

  private phaseIdForProject(id: string, position: number): string {
    return id === legacyProjectId
      ? `PHASE-${position}`
      : `${id}-PHASE-${position}`;
  }

  private subtaskIdForProject(id: string, templateId: string): string {
    return id === legacyProjectId ? templateId : `${id}-${templateId}`;
  }

  private sourceTaskSuffix(sourceTaskId: string): string {
    return sourceTaskId.replace(/^SO-/, "");
  }

  private currentProject(projects: Project[]): Project | null {
    return (
      projects.find((project) => project.status === "PENDING_APPROVAL") ??
      projects.find((project) => project.status !== "COMPLETED") ??
      projects[0] ??
      null
    );
  }

  private async projects(includeAcceptance = true): Promise<Project[]> {
    const result = await this.database.query(
      "SELECT p.id FROM vs01_projects p JOIN vs01_orders o ON o.order_id = p.source_task_id AND o.tenant_id = p.tenant_id WHERE p.tenant_id = $1 AND ($2::boolean OR o.status <> 'E2E_ACCEPTANCE') ORDER BY p.id",
      [tenantId, includeAcceptance],
    );
    return Promise.all(result.rows.map((row) => this.project(String(row.id))));
  }

  private async projectNodeId(client: PoolClient, id: string): Promise<string> {
    const result = await client.query(
      "SELECT id FROM vs01_project_nodes WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
      [id, tenantId],
    );
    if (result.rowCount !== 1) throw new NotFoundException("项目节点不存在");
    return String(result.rows[0]?.id);
  }

  private async highRiskOrders(includeAcceptance = true) {
    const result = await this.database.query<OrderRow>(
      "SELECT o.order_id, o.customer, o.promised_date, o.forecast_date, GREATEST((b.actual_bom_date - b.planned_bom_date), 0)::int AS bom_delay, GREATEST((p.actual_start_date - p.planned_start_date), 0)::int AS purchase_delay FROM vs01_orders o JOIN vs01_bom b ON b.order_id = o.order_id AND b.tenant_id = o.tenant_id JOIN vs01_purchases p ON p.order_id = o.order_id AND p.tenant_id = o.tenant_id WHERE o.tenant_id = $1 AND ($2::boolean OR o.status <> 'E2E_ACCEPTANCE') AND o.forecast_date > o.promised_date ORDER BY o.order_id",
      [tenantId, includeAcceptance],
    );
    return result.rows.map((row) => this.orderRisk(row));
  }

  private async ownerDataSources() {
    if (isProduction()) {
      const latest = await this.database.query(
        `SELECT DISTINCT ON(f.file_name) f.file_name,f.row_count,sv.id AS source_version_id,sv.source_object_id,sv.version_number
        FROM production_source_files f JOIN vs01_source_versions sv ON sv.id=f.source_version_id AND sv.tenant_id=f.tenant_id
        WHERE f.tenant_id=$1 ORDER BY f.file_name,sv.version_number DESC`,
        [tenantId],
      );
      return latest.rows.map((row) => ({
        sourceObjectId: String(row.source_object_id),
        sourceVersionId: String(row.source_version_id),
        fileName: String(row.file_name),
        category:
          row.file_name === "orders.csv"
            ? ("ORDER" as const)
            : row.file_name === "bom.csv"
              ? ("BOM" as const)
              : ("PURCHASE" as const),
        versionNumber: Number(row.version_number),
        recordCount: Number(row.row_count),
        status: "AVAILABLE" as const,
      }));
    }
    const result = await this.database.query(
      `SELECT o.id AS source_object_id,
              o.file_name,
              sv.id AS source_version_id,
              sv.version_number,
              CASE o.id
                WHEN 'SRC-ORDERS' THEN (SELECT count(*)::int FROM vs01_orders WHERE tenant_id = $1 AND status <> 'E2E_ACCEPTANCE')
                WHEN 'SRC-BOM' THEN (SELECT count(*)::int FROM vs01_bom b JOIN vs01_orders ord ON ord.order_id = b.order_id AND ord.tenant_id = b.tenant_id WHERE b.tenant_id = $1 AND ord.status <> 'E2E_ACCEPTANCE')
                WHEN 'SRC-PURCHASES' THEN (SELECT count(*)::int FROM vs01_purchases p JOIN vs01_orders ord ON ord.order_id = p.order_id AND ord.tenant_id = p.tenant_id WHERE p.tenant_id = $1 AND ord.status <> 'E2E_ACCEPTANCE')
                ELSE 0
              END AS record_count
         FROM vs01_source_objects o
         JOIN LATERAL (
           SELECT id, version_number
             FROM vs01_source_versions
            WHERE tenant_id = o.tenant_id AND source_object_id = o.id
            ORDER BY version_number DESC
            LIMIT 1
         ) sv ON true
        WHERE o.tenant_id = $1
          AND o.id = ANY($2::text[])
        ORDER BY CASE o.id
          WHEN 'SRC-ORDERS' THEN 1
          WHEN 'SRC-BOM' THEN 2
          WHEN 'SRC-PURCHASES' THEN 3
          ELSE 4
        END`,
      [tenantId, ["SRC-ORDERS", "SRC-BOM", "SRC-PURCHASES"]],
    );
    return result.rows.map((row) => ({
      sourceObjectId: String(row.source_object_id),
      sourceVersionId: String(row.source_version_id),
      fileName: String(row.file_name),
      category:
        row.source_object_id === "SRC-ORDERS"
          ? ("ORDER" as const)
          : row.source_object_id === "SRC-BOM"
            ? ("BOM" as const)
            : ("PURCHASE" as const),
      versionNumber: Number(row.version_number),
      recordCount: Number(row.record_count),
      status: "AVAILABLE" as const,
    }));
  }

  private async orderForTask(id: string): Promise<QueryResultRow> {
    if (isProduction()) return productionTaskFacts(this.database, id, tenantId);
    const result = await this.database.query(
      "SELECT t.id, o.order_id, o.customer, o.promised_date, o.forecast_date, o.status AS order_status, o.source_row AS order_source_row, b.planned_bom_date, b.actual_bom_date, b.completion_status, b.source_row AS bom_source_row, GREATEST((b.actual_bom_date - b.planned_bom_date), 0)::int AS bom_delay, p.planned_start_date, p.actual_start_date, p.arrival_risk, p.source_row AS purchase_source_row, GREATEST((p.actual_start_date - p.planned_start_date), 0)::int AS purchase_delay FROM vs01_tasks t JOIN vs01_orders o ON o.order_id = t.order_id JOIN vs01_bom b ON b.order_id = o.order_id JOIN vs01_purchases p ON p.order_id = o.order_id WHERE t.id = $1 AND t.tenant_id = $2",
      [id, tenantId],
    );
    if (result.rowCount === 0) throw new NotFoundException("任务不存在");
    return result.rows[0] as QueryResultRow;
  }

  private async findProject(id = legacyProjectId): Promise<Project | null> {
    const result = await this.database.query(
      "SELECT p.id, p.source_task_id, p.name, p.status, p.returned_reason, p.metric_before, p.metric_target, n.id AS node_id, n.name AS node_name, n.latest_update, rv.baseline, rv.target, rv.current AS outcome_current, rv.status AS outcome_status, rv.conclusion, rv.evidence_reference, rv.note AS outcome_note, rv.submitted_at, rv.accepted_at, rv.source_object_id, rv.source_version_id FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_result_validations rv ON rv.project_id = p.id WHERE p.id = $1 AND p.tenant_id = $2",
      [id, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const phaseResult = await this.database.query(
      "SELECT id, code, name, purpose, gate_status, gate_label, returned_reason FROM vs01_project_phases WHERE project_id = $1 AND tenant_id = $2 ORDER BY sort_order",
      [id, tenantId],
    );
    const subtaskResult = await this.database.query(
      "SELECT id, title, status, sort_order, phase_code, purpose, owner, origin, inputs, process, expected_output, output_reference, output_source_object_id, output_source_version_id, acceptance, completion_note, completed_at, source_recorded_at, reopen_reason, progress_note, progress_output_reference, progress_updated_at, completion_basis, confirmed_by, confirmed_at, confirmed_acceptance FROM vs01_project_subtasks WHERE node_id = $1 AND tenant_id = $2 ORDER BY phase_code, sort_order, id",
      [row.node_id, tenantId],
    );
    const experienceResult = await this.database.query(
      "SELECT c.id, c.title, c.applicable_situation, c.business_problem, c.practice, c.result_summary, c.evidence_reference, c.limitations, c.status, c.revision, c.created_at, r.created_at AS candidate_submitted_at, c.returned_reason, c.reviewed_by, c.reviewed_at, c.formal_experience_id, c.feishu_record_id, c.feishu_synced_revision, c.feishu_sync_status, c.feishu_synced_at, c.source_object_id AS evidence_source_object_id, c.source_version_id AS evidence_source_version_id, r.source_object_id AS candidate_source_object_id, r.source_version_id AS candidate_source_version_id, r.structured_card FROM vs01_experience_candidates c LEFT JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision WHERE c.project_id = $1 AND c.tenant_id = $2",
      [id, tenantId],
    );
    const eventResult = await this.database.query(
      "SELECT event_type, phase_code, note, actor, created_at, snapshot FROM vs01_project_events WHERE project_id = $1 AND tenant_id = $2 ORDER BY id",
      [id, tenantId],
    );
    const materialResult = await this.database.query(
      "SELECT m.id, m.situation_code, m.requirement_id, m.title, m.source_reference, m.note, m.kind, m.status, m.source_object_id, m.source_version_id, m.withdrawn_at, m.withdrawn_reason, m.created_by, m.created_at, c.original_name, c.media_type, c.byte_size, c.sha256, c.extraction_status, c.content_preview, c.readable_by_ai, (g.material_id IS NOT NULL) AS verification_eligible, v.verification_status, v.verification_version, v.verified_by, v.verification_note, v.verified_at FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id LEFT JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id LEFT JOIN LATERAL (SELECT e.event_type AS verification_status, e.verification_version, e.actor_subject_id AS verified_by, e.reason AS verification_note, e.created_at AS verified_at FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE m.task_id = $1 AND m.tenant_id = $2 AND m.status = 'ACTIVE' ORDER BY m.created_at DESC, m.id DESC",
      [row.source_task_id, tenantId],
    );
    const projectReferenceResult = await this.database.query(
      "SELECT r.id, r.task_id, r.experience_id, r.status, r.note, r.created_at, r.withdrawn_at, r.withdrawn_reason, r.experience_source_object_id, r.experience_source_version_id, f.title, f.applicable_situation, f.limitations FROM vs01_experience_references r JOIN vs01_formal_experiences f ON f.id = r.experience_id WHERE r.task_id = $1 AND r.tenant_id = $2 ORDER BY r.created_at, r.id",
      [row.source_task_id, tenantId],
    );
    const taskFor = (subtask: QueryResultRow) => ({
      id: String(subtask.id),
      title: String(subtask.title),
      purpose: String(subtask.purpose),
      owner: subtask.owner,
      origin: subtask.origin,
      status: subtask.status,
      inputs: (
        subtask.inputs as Project["phases"][number]["tasks"][number]["inputs"]
      ).map((input) => {
        const requirementId =
          input.requirementId ?? this.requirementForInput(input.label);
        if (input.status === "AVAILABLE") return { ...input, requirementId };
        const situationCode = this.materialSituationForInput(input.label);
        const material = materialResult.rows.find(
          (item) =>
            item.situation_code === situationCode &&
            item.requirement_id === requirementId,
        );
        return material
          ? {
              ...input,
              requirementId,
              status: "AVAILABLE" as const,
              reference: `${String(material.title)}：${String(material.source_reference)}`,
            }
          : { ...input, requirementId };
      }),
      process: (
        subtask.process as Array<{ label: string; completed: boolean }>
      ).map((step) => ({
        ...step,
        completed: subtask.status === "DONE" || step.completed,
      })),
      output: {
        expected: String(subtask.expected_output),
        reference: subtask.output_reference ?? null,
        locator: subtask.output_source_object_id
          ? {
              sourceObjectId: subtask.output_source_object_id,
              sourceVersionId: subtask.output_source_version_id,
              reference: subtask.output_reference,
            }
          : null,
      },
      acceptance: subtask.acceptance,
      completionNote: String(subtask.completion_note),
      completedAt: subtask.completed_at
        ? new Date(subtask.completed_at).toISOString()
        : null,
      sourceRecordedAt: subtask.source_recorded_at
        ? new Date(subtask.source_recorded_at).toISOString()
        : null,
      progressUpdate: subtask.progress_updated_at
        ? {
            note: String(subtask.progress_note),
            outputReference: subtask.progress_output_reference ?? null,
            updatedBy: "PMC" as const,
            updatedAt: new Date(subtask.progress_updated_at).toISOString(),
          }
        : null,
      completionConfirmation: subtask.confirmed_at
        ? {
            basis: subtask.completion_basis as
              "HISTORICAL_SOURCE" | "ASSIGNEE_CONFIRMED" | "ROLE_DECISION",
            confirmedBy: subtask.confirmed_by as "PMC" | "OWNER",
            confirmedAt: new Date(subtask.confirmed_at).toISOString(),
            confirmedAcceptanceCriteria: subtask.confirmed_acceptance ?? [],
          }
        : null,
      reopenReason: subtask.reopen_reason ?? null,
    });
    const phasesView: Project["phases"] = phaseResult.rows.map((phase) => {
      const tasks = subtaskResult.rows
        .filter((task) => task.phase_code === phase.code)
        .map(taskFor);
      const completedTaskCount = tasks.filter(
        (task) => task.status === "DONE" && task.completionConfirmation,
      ).length;
      const progress = tasks.length
        ? Math.round((completedTaskCount / tasks.length) * 100)
        : 0;
      const phaseStatus =
        phase.gate_status === "RETURNED"
          ? "RETURNED"
          : tasks.every((task) => task.status === "LOCKED")
            ? "LOCKED"
            : phase.gate_status === "PENDING" && progress === 100
              ? "WAITING_REVIEW"
              : phase.gate_status === "APPROVED" && progress === 100
                ? "COMPLETED"
                : tasks.some((task) => task.status === "IN_PROGRESS")
                  ? "IN_PROGRESS"
                  : progress === 0
                    ? "READY"
                    : "IN_PROGRESS";
      return {
        id: phase.id,
        code: phase.code,
        name: workStageNames[phase.code as keyof typeof workStageNames],
        purpose:
          workStagePurposes[phase.code as keyof typeof workStagePurposes],
        status: phaseStatus,
        progress,
        completedTaskCount,
        totalTaskCount: tasks.length,
        gate: {
          status: phase.gate_status,
          label: phase.gate_label,
          returnedReason: phase.returned_reason ?? null,
        },
        tasks,
      };
    });
    const execution = phasesView.find(
      (phase) => phase.code === "EXECUTION_CONTROL",
    );
    if (!execution) throw new BadRequestException("执行节点不存在");
    const truthfulnessStatus =
      row.outcome_status === "ACCEPTED"
        ? "ACCEPTED"
        : row.outcome_status === "PENDING_ACCEPTANCE"
          ? "PENDING_ACCEPTANCE"
          : "BASELINE_ONLY";
    const candidate = experienceResult.rows[0];
    const publishedExperienceHistory = await this.database.query(
      "SELECT 1 FROM vs01_formal_experiences WHERE source_project_id = $1 AND tenant_id = $2 LIMIT 1",
      [id, tenantId],
    );
    return projectSchema.parse({
      id: row.id,
      sourceTaskId: row.source_task_id,
      name:
        row.source_task_id === "SO-202608128" ? "解决订单延期问题" : row.name,
      status: row.status,
      progress: execution.progress,
      returnedReason: row.returned_reason,
      publishedExperienceHistory:
        (publishedExperienceHistory.rowCount ?? 0) > 0,
      metric: {
        name: "OTD",
        before: row.metric_before,
        current:
          truthfulnessStatus === "BASELINE_ONLY"
            ? row.metric_before
            : row.outcome_current,
        target: row.metric_target,
        truthfulnessStatus,
      },
      outcome: {
        baseline: row.baseline,
        target: row.target,
        current: row.outcome_current ?? null,
        status: row.outcome_status,
        conclusion: row.conclusion ?? null,
        evidenceReference: row.evidence_reference ?? null,
        note: row.outcome_note ?? null,
        submittedAt: row.submitted_at
          ? new Date(row.submitted_at).toISOString()
          : null,
        acceptedAt: row.accepted_at
          ? new Date(row.accepted_at).toISOString()
          : null,
        locator: row.source_object_id
          ? {
              sourceObjectId: row.source_object_id,
              sourceVersionId: row.source_version_id,
              reference: row.evidence_reference,
            }
          : null,
      },
      experienceCandidate: candidate
        ? {
            id: candidate.id,
            title: candidate.title,
            applicableSituation: candidate.applicable_situation,
            businessProblem: candidate.business_problem,
            practice: candidate.practice,
            resultSummary: candidate.result_summary,
            evidenceReference: candidate.evidence_reference,
            limitations: candidate.limitations,
            status: candidate.status,
            revision: Number(candidate.revision),
            createdAt: new Date(candidate.created_at).toISOString(),
            submittedAt: new Date(
              candidate.candidate_submitted_at ?? candidate.created_at,
            ).toISOString(),
            returnedReason: candidate.returned_reason ?? null,
            reviewedBy: candidate.reviewed_by ?? null,
            reviewedAt: candidate.reviewed_at
              ? new Date(candidate.reviewed_at).toISOString()
              : null,
            formalExperienceId: candidate.formal_experience_id ?? null,
            candidateLocator: {
              sourceObjectId: candidate.candidate_source_object_id,
              sourceVersionId: candidate.candidate_source_version_id,
              reference: candidate.title,
            },
            evidenceLocator: {
              sourceObjectId: candidate.evidence_source_object_id,
              sourceVersionId: candidate.evidence_source_version_id,
              reference: candidate.evidence_reference,
            },
            structuredCard: candidate.structured_card ?? null,
            feishuSync: {
              recordId: candidate.feishu_record_id ?? null,
              revision: candidate.feishu_synced_revision
                ? Number(candidate.feishu_synced_revision)
                : null,
              status: candidate.feishu_sync_status ?? null,
              syncedAt: candidate.feishu_synced_at
                ? new Date(candidate.feishu_synced_at).toISOString()
                : null,
            },
          }
        : null,
      experienceReferences: projectReferenceResult.rows.map((reference) => ({
        id: reference.id,
        taskId: reference.task_id,
        experienceId: reference.experience_id,
        status: reference.status,
        classification: "PROPOSAL",
        title: reference.title,
        applicableSituation: reference.applicable_situation,
        limitations: reference.limitations,
        note: reference.note,
        createdBy: "PMC",
        createdAt: new Date(reference.created_at).toISOString(),
        withdrawnAt: reference.withdrawn_at
          ? new Date(reference.withdrawn_at).toISOString()
          : null,
        withdrawnReason: reference.withdrawn_reason ?? null,
        experienceLocator: {
          sourceObjectId: reference.experience_source_object_id,
          sourceVersionId: reference.experience_source_version_id,
          reference: reference.title,
        },
      })),
      node: {
        id: row.node_id,
        name: row.node_name,
        status:
          execution.progress === 100
            ? "COMPLETED"
            : execution.tasks.some((task) => task.status === "IN_PROGRESS")
              ? "IN_PROGRESS"
              : execution.progress === 0
                ? "NOT_STARTED"
                : "IN_PROGRESS",
        progress: execution.progress,
        latestUpdate: row.latest_update,
        completedSubtaskCount: execution.completedTaskCount,
        totalSubtaskCount: execution.totalTaskCount,
        subtasks: execution.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status === "DONE" ? "DONE" : "TODO",
          completionNote: task.completionNote,
          completedAt: task.completedAt,
        })),
      },
      phases: phasesView,
      auditTrail: eventResult.rows.map((event) => ({
        eventType: event.event_type,
        phaseCode: event.phase_code ?? null,
        note: event.note,
        actor: event.actor,
        createdAt: new Date(event.created_at).toISOString(),
        snapshot: event.snapshot ?? {},
      })),
    });
  }

  private activePhaseForProject(status: string): string | null {
    if (status === "DRAFT" || status === "RETURNED") return "SOLUTION_APPROVAL";
    if (status === "RUNNING") return "EXECUTION_CONTROL";
    if (status === "RESULT_VALIDATION") return "RESULT_ACCEPTANCE";
    if (status === "KNOWLEDGE_CAPTURE") return "KNOWLEDGE_CAPTURE";
    return null;
  }

  private materialSituationForInput(
    label: string,
  ): TaskDetail["situations"][number]["code"] | null {
    if (/产能|工时/.test(label)) return "CAPACITY_RISK";
    if (/BOM|变更/.test(label)) return "BOM_DELAY";
    if (/采购|供应商|到货/.test(label)) return "PURCHASE_DELAY";
    return null;
  }

  private requirementForInput(label: string): string | null {
    if (/产能|工时/.test(label)) return "REQ-CAPACITY-LOAD";
    if (/BOM|变更/.test(label)) return "REQ-BOM-CHANGE";
    if (/采购|供应商|到货/.test(label)) return "REQ-PURCHASE-CONFIRM";
    return null;
  }

  private requirementFor(
    situationCode: TaskMaterial["situationCode"],
    requirementId: string,
  ): boolean {
    return (
      (situationCode === "BOM_DELAY" && requirementId === "REQ-BOM-CHANGE") ||
      (situationCode === "PURCHASE_DELAY" &&
        requirementId === "REQ-PURCHASE-CONFIRM") ||
      (situationCode === "CAPACITY_RISK" &&
        requirementId === "REQ-CAPACITY-LOAD")
    );
  }

  private async materialById(
    taskId: string,
    materialId: string,
  ): Promise<TaskMaterial> {
    const result = await this.database.query(
      "SELECT m.id, m.situation_code, m.requirement_id, m.title, m.source_reference, m.note, m.kind, m.status, m.source_object_id, m.source_version_id, m.withdrawn_at, m.withdrawn_reason, m.created_by, m.created_at, c.original_name, c.media_type, c.byte_size, c.sha256, c.extraction_status, c.content_preview, c.readable_by_ai, (g.material_id IS NOT NULL) AS verification_eligible, v.verification_status, v.verification_version, v.verified_by, v.verification_note, v.verified_at FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id LEFT JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id LEFT JOIN LATERAL (SELECT e.event_type AS verification_status, e.verification_version, e.actor_subject_id AS verified_by, e.reason AS verification_note, e.created_at AS verified_at FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE m.id = $1 AND m.task_id = $2 AND m.tenant_id = $3",
      [materialId, taskId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundException("材料不存在");
    return this.materialProjection(result.rows[0] as QueryResultRow);
  }

  private materialProjection(material: QueryResultRow): TaskMaterial {
    const uploaded = material.kind === "UPLOADED_FILE";
    return {
      id: String(material.id),
      situationCode: material.situation_code,
      requirementId: material.requirement_id ?? null,
      title: material.title,
      sourceReference: material.source_reference,
      note: material.note,
      kind: uploaded ? "UPLOADED_FILE" : "MANUAL_REFERENCE",
      status: material.status ?? "ACTIVE",
      locator:
        material.source_object_id && material.source_version_id
          ? {
              sourceObjectId: String(material.source_object_id),
              sourceVersionId: String(material.source_version_id),
              reference: `${String(material.title)} · v1`,
            }
          : null,
      file: uploaded
        ? {
            originalName: String(material.original_name),
            mediaType: String(material.media_type),
            byteSize: Number(material.byte_size),
            sha256: String(material.sha256),
            extractionStatus: material.extraction_status,
            contentPreview: material.content_preview ?? null,
            readableByAi: Boolean(material.readable_by_ai),
          }
        : null,
      withdrawnAt: material.withdrawn_at
        ? new Date(material.withdrawn_at).toISOString()
        : null,
      withdrawnReason: material.withdrawn_reason ?? null,
      createdBy: "PMC",
      createdAt: new Date(material.created_at).toISOString(),
      verification: {
        status: material.verification_status ?? "UNVERIFIED",
        version: Number(material.verification_version ?? 0),
        note: material.verification_note ?? "",
        verifiedBy: material.verified_by ?? null,
        verifiedAt: material.verified_at
          ? new Date(material.verified_at).toISOString()
          : null,
      },
      verificationEligible: Boolean(material.verification_eligible),
    };
  }

  private approvalSnapshot(row: QueryResultRow) {
    return {
      projectStatus: row.project_status,
      projectReturnedReason: row.project_returned_reason ?? null,
      gateStatus: row.gate_status,
      gateReturnedReason: row.returned_reason ?? null,
      approvalTask: {
        status: row.approval_task_status,
        completionNote: row.completion_note ?? "",
        outputReference: row.output_reference ?? null,
        locator: row.output_source_object_id
          ? {
              sourceObjectId: row.output_source_object_id,
              sourceVersionId: row.output_source_version_id,
              reference: row.output_reference,
            }
          : null,
        completedAt: row.completed_at ?? null,
      },
    };
  }

  private outcomeSnapshot(row: QueryResultRow | undefined) {
    return {
      status: row?.status ?? null,
      current: row?.current ?? null,
      conclusion: row?.conclusion ?? null,
      evidenceReference: row?.evidence_reference ?? null,
      note: row?.note ?? null,
      submittedAt: row?.submitted_at ?? null,
      acceptedAt: row?.accepted_at ?? null,
      returnedReason: row?.returned_reason ?? null,
      locator: row?.source_object_id
        ? {
            sourceObjectId: row.source_object_id,
            sourceVersionId: row.source_version_id,
            reference: row.evidence_reference,
          }
        : null,
    };
  }

  private async createProjectSource(
    client: PoolClient,
    reference: string,
  ): Promise<{
    sourceObjectId: string;
    sourceVersionId: string;
    reference: string;
  }> {
    const suffix = randomUUID();
    const sourceObjectId = `SRC-PROJECT-${suffix}`;
    const sourceVersionId = `SRC-PROJECT-VERSION-${suffix}`;
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

  private candidateView(row: QueryResultRow) {
    return {
      id: row.candidate_id ?? row.id,
      title: row.title,
      applicableSituation: row.applicable_situation,
      businessProblem: row.business_problem,
      practice: row.practice,
      resultSummary: row.result_summary,
      evidenceReference: row.evidence_reference,
      limitations: row.limitations,
      status: row.status,
      revision: Number(row.revision),
      createdAt: new Date(row.created_at).toISOString(),
      submittedAt: new Date(
        row.candidate_submitted_at ?? row.created_at,
      ).toISOString(),
      returnedReason: row.returned_reason ?? null,
      reviewedBy: row.reviewed_by ?? null,
      reviewedAt: row.reviewed_at
        ? new Date(row.reviewed_at).toISOString()
        : null,
      formalExperienceId: row.formal_experience_id ?? null,
      candidateLocator: {
        sourceObjectId: row.candidate_source_object_id,
        sourceVersionId: row.candidate_source_version_id,
        reference: row.title,
      },
      evidenceLocator: {
        sourceObjectId: row.evidence_source_object_id ?? row.source_object_id,
        sourceVersionId:
          row.evidence_source_version_id ?? row.source_version_id,
        reference: row.evidence_reference,
      },
      structuredCard: row.structured_card ?? null,
      feishuSync: {
        recordId: row.feishu_record_id ?? null,
        revision: row.feishu_synced_revision
          ? Number(row.feishu_synced_revision)
          : null,
        status: row.feishu_sync_status ?? null,
        syncedAt: row.feishu_synced_at
          ? new Date(row.feishu_synced_at).toISOString()
          : null,
      },
    };
  }

  private formalExperienceView(row: QueryResultRow): FormalExperience {
    return {
      id: row.id,
      candidateId: row.candidate_id,
      sourceProjectId: row.source_project_id,
      sourceTaskId: row.source_task_id,
      status: row.status,
      title: row.title,
      applicableSituation: row.applicable_situation,
      businessProblem: row.business_problem,
      practice: row.practice,
      resultSummary: row.result_summary,
      limitations: row.limitations,
      publishedBy: "EXPERT_REVIEWER",
      publishedAt: new Date(row.published_at).toISOString(),
      retractedAt: row.retracted_at
        ? new Date(row.retracted_at).toISOString()
        : null,
      retractedReason: row.retracted_reason ?? null,
      locator: {
        sourceObjectId: row.source_object_id,
        sourceVersionId: row.source_version_id,
        reference: row.title,
      },
      candidateLocator: {
        sourceObjectId: row.candidate_source_object_id,
        sourceVersionId: row.candidate_source_version_id,
        reference: row.title,
      },
      evidenceLocator: {
        sourceObjectId: row.evidence_source_object_id,
        sourceVersionId: row.evidence_source_version_id,
        reference: row.result_summary,
      },
      structuredCard: row.structured_card ?? null,
      cozeIndex: {
        status: row.coze_index_status ?? "INDEX_PENDING",
        executeId: row.coze_execute_id ?? null,
        debugUrl: row.coze_debug_url ?? null,
        indexedAt: row.coze_indexed_at
          ? new Date(row.coze_indexed_at).toISOString()
          : null,
      },
    };
  }

  private async appendProjectEvent(
    client: PoolClient,
    id: string,
    eventType: string,
    actor: "PMC" | "OWNER" | "EXPERT_REVIEWER",
    note: string,
    snapshot: Record<string, unknown>,
    phaseCode: Project["phases"][number]["code"] = "KNOWLEDGE_CAPTURE",
  ): Promise<void> {
    await client.query(
      "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        tenantId,
        id,
        eventType,
        phaseCode,
        note,
        actor,
        JSON.stringify(snapshot),
      ],
    );
  }

  private projectFactContext(
    sourceTaskId: string,
    row: Pick<
      OrderRow,
      "promised_date" | "forecast_date" | "bom_delay" | "purchase_delay"
    >,
    historicalSnapshotReference: string,
  ): ProjectFactContext {
    const suffix = this.sourceTaskSuffix(sourceTaskId);
    return {
      sourceTaskId,
      orderDelay: this.delay(row.forecast_date, row.promised_date),
      bomDelay: Number(row.bom_delay),
      purchaseDelay: Number(row.purchase_delay),
      orderEvidenceReference: `订单 E-ORDER-${suffix}（${isProduction() ? sourceLocator(row, "order").reference : "SRC-ORDERS-V1"}）`,
      bomEvidenceReference: `BOM E-BOM-${suffix}（${isProduction() ? sourceLocator(row, "bom").reference : "SRC-BOM-V1"}）`,
      purchaseEvidenceReference: `采购 E-PURCHASE-${suffix}（${isProduction() ? sourceLocator(row, "purchase").reference : "SRC-PURCHASES-V1"}）`,
      historicalSnapshotReference,
    };
  }

  private legacyProjectFactContext(): ProjectFactContext {
    return this.projectFactContext(
      "SO-202608128",
      {
        promised_date: "2026-08-18",
        forecast_date: "2026-08-23",
        bom_delay: 4,
        purchase_delay: 3,
      },
      "历史事实快照：SO-202608128；订单 E-ORDER-202608128（SRC-ORDERS-V1）；BOM E-BOM-202608128（SRC-BOM-V1）；采购 E-PURCHASE-202608128（SRC-PURCHASES-V1）",
    );
  }

  private taskTemplates(facts = this.legacyProjectFactContext()) {
    const sourceTaskId = facts.sourceTaskId;
    const task = (
      id: string,
      phaseCode: (typeof phases)[number][0],
      title: string,
      purpose: string,
      status: string,
      origin: "LIVE" | "HISTORICAL",
      sortOrder: number,
      inputs: Array<{
        label: string;
        status: "AVAILABLE" | "MISSING" | "UNVERIFIED";
        reference: string | null;
      }>,
      process: string[],
      expectedOutput: string,
      acceptance: string[],
      owner: "PMC" | "OWNER" = "PMC",
      outputReference = origin === "HISTORICAL"
        ? facts.historicalSnapshotReference
        : "来源订单、BOM、采购记录与人工判断",
    ) => ({
      id,
      phaseCode,
      title,
      purpose,
      status,
      origin,
      sortOrder,
      owner,
      outputReference,
      inputs,
      process: process.map((label) => ({
        label,
        completed: origin === "HISTORICAL",
      })),
      expectedOutput,
      acceptance,
    });
    const historical = [
      {
        label: `订单异常任务 ${sourceTaskId}`,
        status: "AVAILABLE" as const,
        reference: sourceTaskId,
      },
      {
        label: "订单、BOM、采购证据",
        status: "AVAILABLE" as const,
        reference: `${facts.orderEvidenceReference}；${facts.bomEvidenceReference}；${facts.purchaseEvidenceReference}`,
      },
      {
        label: "项目历史事实快照",
        status: "AVAILABLE" as const,
        reference: facts.historicalSnapshotReference,
      },
    ];
    const templates = [
      task(
        "SUB-SCOPE-001",
        "PROJECT_SCOPING",
        "确认经营问题与范围",
        "把异常转为可观察的绩效差距",
        "DONE",
        "HISTORICAL",
        1,
        historical,
        ["读取订单承诺与预测交期", "界定 OTD 异常及受影响订单"],
        "订单交付问题界定卡",
        ["问题使用 OTD 口径", "范围指向具体延期订单"],
      ),
      task(
        "SUB-SCOPE-002",
        "PROJECT_SCOPING",
        "确认目标与责任边界",
        "确认项目目标、角色和约束",
        "DONE",
        "HISTORICAL",
        2,
        [
          ...historical,
          {
            label: "PMC 人工判断",
            status: "AVAILABLE",
            reference: "已保存人工判断",
          },
        ],
        [
          `确认目标预计准交率 ${runtimeTargetOtd()}%`,
          "明确 PMC 与老板的决策边界",
        ],
        "目标与责任边界记录",
        ["目标有数值", "责任角色明确"],
      ),
      task(
        "SUB-SCOPE-003",
        "PROJECT_SCOPING",
        "形成项目立项快照",
        "留下可回看的项目界定",
        "DONE",
        "HISTORICAL",
        3,
        historical,
        ["汇总问题、目标与证据", "记录项目创建前的来源时间"],
        "项目立项历史快照",
        ["可回到来源任务", "包含来源记录时间"],
      ),
      task(
        "SUB-BASE-001",
        "BASELINE_FACTS",
        "核对 OTD 计算口径",
        "确认基线口径一致",
        "DONE",
        "HISTORICAL",
        1,
        historical,
        [
          "按承诺交期与实际/预测交期重算",
          `确认该订单预计延期 ${facts.orderDelay} 天`,
        ],
        "OTD 基线口径说明",
        ["分子分母明确", "可与结果阶段同口径比较"],
      ),
      task(
        "SUB-BASE-002",
        "BASELINE_FACTS",
        "核对延期订单事实",
        "确认异常事实与来源",
        "DONE",
        "HISTORICAL",
        2,
        historical,
        ["核对订单延期天数", "核对 BOM 与采购启动滞后"],
        "延期订单事实清单",
        ["每项事实有证据编号", "不把推断当事实"],
      ),
      task(
        "SUB-BASE-003",
        "BASELINE_FACTS",
        "记录数据质量边界",
        "登记缺失和待核验项",
        "DONE",
        "HISTORICAL",
        3,
        [
          ...historical,
          { label: "产能负荷与工时记录", status: "MISSING", reference: null },
        ],
        ["标记产能风险尚未核验", "记录数据边界"],
        "数据质量与待核验清单",
        ["缺失材料被明确标识", "不阻断 BOM 治理路径"],
      ),
      task(
        "SUB-CAUSE-001",
        "ROOT_CAUSE_VALIDATION",
        "列出候选原因",
        "区分候选原因与事实",
        "DONE",
        "HISTORICAL",
        1,
        historical,
        ["比对 BOM 和采购时间差", "形成候选原因，不宣称根因"],
        "候选原因假设清单",
        ["候选原因与事实分开", "含待核验项"],
      ),
      task(
        "SUB-CAUSE-002",
        "ROOT_CAUSE_VALIDATION",
        "关联 BOM 与采购证据",
        "用证据检验候选原因",
        "DONE",
        "HISTORICAL",
        2,
        historical,
        [
          `关联 BOM 完成晚 ${facts.bomDelay} 天`,
          `关联采购启动晚 ${facts.purchaseDelay} 天`,
        ],
        "原因证据链",
        ["至少两条来源证据", "证据能追溯版本"],
      ),
      task(
        "SUB-CAUSE-003",
        "ROOT_CAUSE_VALIDATION",
        "保存人工判断",
        "由 PMC 对候选原因作出判断",
        "DONE",
        "HISTORICAL",
        3,
        [
          ...historical,
          {
            label: "PMC 人工判断",
            status: "AVAILABLE",
            reference: "确认：BOM准备滞后",
          },
        ],
        ["展示 AI 候选建议", "由 PMC 确认或修改"],
        "人工判断记录",
        ["包含判断人与时间", "可以在下游前撤销"],
      ),
      task(
        "SUB-SOLUTION-001",
        "SOLUTION_APPROVAL",
        "形成 BOM 治理方案",
        "把根因转化为可执行方案",
        "READY",
        "LIVE",
        1,
        [
          {
            label: "原因证据链",
            status: "AVAILABLE",
            reference: `${facts.bomEvidenceReference}；${facts.purchaseEvidenceReference}`,
          },
          { label: "产能负荷核验", status: "UNVERIFIED", reference: null },
        ],
        [
          "提出 BOM 分类、补齐与规则两个以上方案",
          "比较预期影响、成本与风险",
          "选择建议方案并说明未核验边界",
        ],
        "BOM 治理方案比较表",
        ["至少两个候选方案", "有取舍理由", "标记产能待核验"],
      ),
      task(
        "SUB-SOLUTION-002",
        "SOLUTION_APPROVAL",
        "拆解执行任务与验收方式",
        "明确任务、依据和验收方式",
        "READY",
        "LIVE",
        2,
        [
          {
            label: "已选 BOM 治理方案",
            status: "AVAILABLE",
            reference: "方案比较表",
          },
        ],
        [
          "拆成分类、补料、责任、规则四项任务",
          "为每项写责任人、完成依据与验收",
          "核对依赖与截止时间",
        ],
        "执行任务、责任与验收清单",
        ["四项任务均有责任人", "每项都有验收依据"],
      ),
      task(
        "SUB-SOLUTION-003",
        "SOLUTION_APPROVAL",
        "企业负责人确认解决方案",
        "由业务负责人决定是否启动",
        "LOCKED",
        "LIVE",
        3,
        [
          {
            label: "方案比较表",
            status: "AVAILABLE",
            reference: "SUB-SOLUTION-001 输出",
          },
          {
            label: "任务、责任与验收清单",
            status: "AVAILABLE",
            reference: "SUB-SOLUTION-002 输出",
          },
        ],
        ["老板核对方案范围、责任与风险", "批准启动或退回补充"],
        "项目批准或退回记录",
        ["老板动作有审计", "批准后才解锁执行"],
        "OWNER",
        "项目批准记录",
      ),
      task(
        "SUB-BOM-001",
        "EXECUTION_CONTROL",
        "完成 BOM 问题分类",
        "识别可治理的 BOM 异常",
        "LOCKED",
        "LIVE",
        1,
        [
          {
            label: "BOM 异常明细",
            status: "AVAILABLE",
            reference: facts.bomEvidenceReference,
          },
        ],
        ["按缺料、变更、编码错误分类", "统计每类数量和影响订单"],
        "BOM 问题分类清单",
        ["分类覆盖异常项", "影响订单可追溯"],
      ),
      task(
        "SUB-BOM-002",
        "EXECUTION_CONTROL",
        "补齐缺失 BOM 材料",
        "让执行依据完整可追溯",
        "LOCKED",
        "LIVE",
        2,
        [
          {
            label: "BOM 问题分类清单",
            status: "AVAILABLE",
            reference: "SUB-BOM-001 输出",
          },
          { label: "缺失 BOM/变更资料", status: "MISSING", reference: null },
        ],
        ["催收缺失 BOM 或变更资料", "复核补齐版本与适用订单"],
        "缺失 BOM 补齐记录",
        ["缺失项有处理结果", "补齐版本可追溯"],
      ),
      task(
        "SUB-BOM-003",
        "EXECUTION_CONTROL",
        "输出治理清单并确认责任人",
        "形成可执行责任清单",
        "LOCKED",
        "LIVE",
        3,
        [
          {
            label: "分类与补齐记录",
            status: "AVAILABLE",
            reference: "SUB-BOM-001 / SUB-BOM-002 输出",
          },
        ],
        ["列出治理动作", "分配责任人和完成期限", "确认复核人"],
        "BOM 治理责任清单",
        ["每个动作有唯一责任人", "有期限和复核人"],
      ),
      task(
        "SUB-BOM-004",
        "EXECUTION_CONTROL",
        "评审并发布治理规则",
        "确认规则被发布并可执行",
        "LOCKED",
        "LIVE",
        4,
        [
          {
            label: "BOM 治理责任清单",
            status: "AVAILABLE",
            reference: "SUB-BOM-003 输出",
          },
        ],
        ["评审分类与补齐规则", "发布规则并通知责任人", "保留评审记录"],
        "BOM 治理规则发布记录",
        ["规则有版本", "责任人已确认接收"],
      ),
      task(
        "SUB-RESULT-001",
        "RESULT_ACCEPTANCE",
        "重新计算同口径 OTD",
        "得到与基线可比较的当前值",
        "LOCKED",
        "LIVE",
        1,
        [
          {
            label: "订单交期记录",
            status: "AVAILABLE",
            reference: facts.orderEvidenceReference,
          },
          {
            label: "OTD 基线口径",
            status: "AVAILABLE",
            reference: "SUB-BASE-001 输出",
          },
        ],
        ["使用同一分子分母重算", "标注计算日期和样本范围"],
        "当前 OTD 重算表",
        ["口径与基线一致", "计算可复查"],
      ),
      task(
        "SUB-RESULT-002",
        "RESULT_ACCEPTANCE",
        "核对结果证据与副作用",
        "验证数据与影响边界",
        "LOCKED",
        "LIVE",
        2,
        [
          {
            label: "当前 OTD 重算表",
            status: "AVAILABLE",
            reference: "SUB-RESULT-001 输出",
          },
          {
            label: "BOM 治理发布记录",
            status: "AVAILABLE",
            reference: "SUB-BOM-004 输出",
          },
        ],
        ["解释 Before、Current、Target 差异", "收集影响与副作用证据"],
        "结果差异与影响证据包",
        ["差异解释不夸大因果", "副作用或边界已记录"],
      ),
      task(
        "SUB-RESULT-003",
        "RESULT_ACCEPTANCE",
        "形成结果验收建议",
        "给老板提供可签收结论",
        "LOCKED",
        "LIVE",
        3,
        [
          {
            label: "OTD 重算表与证据包",
            status: "AVAILABLE",
            reference: "SUB-RESULT-001 / SUB-RESULT-002 输出",
          },
        ],
        ["汇总验收结论", "提出签收或退回建议"],
        "结果验收建议书",
        ["含 Before/Current/Target", "引用证据包"],
      ),
      task(
        "SUB-KNOWLEDGE-001",
        "KNOWLEDGE_CAPTURE",
        "整理有效做法与适用情境",
        "提炼经验的适用边界",
        "LOCKED",
        "LIVE",
        1,
        [
          {
            label: "员工已确认结果",
            status: "AVAILABLE",
            reference: "结果验收 locator",
          },
        ],
        ["描述适用订单和异常情境", "提炼可复用做法"],
        "适用情境与做法草稿",
        ["不泛化为所有订单", "情境可识别"],
      ),
      task(
        "SUB-KNOWLEDGE-002",
        "KNOWLEDGE_CAPTURE",
        "整理结果与证据引用",
        "保证经验有结果依据",
        "LOCKED",
        "LIVE",
        2,
        [
          {
            label: "员工已确认结果证据",
            status: "AVAILABLE",
            reference: "结果验收 locator",
          },
        ],
        ["复用员工已确认结果定位", "核对结果摘要与来源一致"],
        "经验证据引用清单",
        ["不新增或替换结果来源", "版本编号可追溯"],
      ),
      task(
        "SUB-KNOWLEDGE-003",
        "KNOWLEDGE_CAPTURE",
        "记录限制与待验证条件",
        "避免候选经验被当成确定规则",
        "LOCKED",
        "LIVE",
        3,
        [{ label: "未核验产能风险", status: "UNVERIFIED", reference: null }],
        ["记录不适用范围", "记录待验证条件与后续审核点"],
        "经验限制条件清单",
        ["限制条件明确", "候选经验标为待专家审核"],
      ),
    ];
    if (!isProduction() && sourceTaskId === "SO-202608136") {
      const workpaperTask = templates.find(
        (item) => item.id === "SUB-CAUSE-003",
      );
      if (!workpaperTask) throw new BadRequestException("缺少根因核验事项模板");
      workpaperTask.title = "核验主要原因并确认结论";
      workpaperTask.purpose = "基于事实与待核验材料，由 PMC 确认根因结论";
      workpaperTask.status = "READY";
      workpaperTask.origin = "LIVE";
      workpaperTask.inputs = [
        ...workpaperTask.inputs.filter(
          (input) => input.label !== "PMC 人工判断",
        ),
        { label: "产能负荷与工时记录", status: "MISSING", reference: null },
      ];
      workpaperTask.process = [
        { label: "核对来源事实与有效材料", completed: false },
        { label: "区分候选建议与员工结论", completed: false },
        { label: "确认结论并完成事项", completed: false },
      ];
      workpaperTask.expectedOutput = "根因核验工作底稿确认版";
      workpaperTask.acceptance = [
        "事实证据与待核验材料已区分",
        "员工结论说明了支持或不支持理由",
        "结论边界与下一步核验已记录",
      ];
      for (const solutionTask of templates.filter(
        (item) => item.phaseCode === "SOLUTION_APPROVAL",
      ))
        solutionTask.status = "LOCKED";
    }
    return templates;
  }

  private orderRisk(row: OrderRow | QueryResultRow) {
    const bomDelay = Number(row.bom_delay ?? 0);
    return {
      orderId: String(row.order_id),
      customer: String(row.customer),
      promisedDate: this.date(row.promised_date),
      forecastDate: this.date(row.forecast_date),
      delayDays: this.delay(row.forecast_date, row.promised_date),
      primaryException: bomDelay > 0 ? "BOM准备" : "采购到货",
    };
  }

  private situations(
    row: QueryResultRow,
    materials: TaskDetail["materials"],
    sourceTaskId: string,
  ): TaskDetail["situations"] {
    const evidenceSuffix = this.sourceTaskSuffix(sourceTaskId);
    const materialFor = (
      code: TaskDetail["situations"][number]["code"],
      requirementId: string,
    ) =>
      materials.find(
        (material) =>
          material.status === "ACTIVE" &&
          material.situationCode === code &&
          material.requirementId === requirementId,
      ) ?? null;
    const bomMaterial = materialFor("BOM_DELAY", "REQ-BOM-CHANGE");
    const purchaseMaterial = materialFor(
      "PURCHASE_DELAY",
      "REQ-PURCHASE-CONFIRM",
    );
    const capacityMaterial = materialFor("CAPACITY_RISK", "REQ-CAPACITY-LOAD");
    return [
      {
        code: "BOM_DELAY",
        label: "BOM 准备滞后",
        state: Number(row.bom_delay) > 0 ? "MATCHED" : "UNVERIFIED",
        summary: `计划与实际 BOM 完成相差 ${Number(row.bom_delay)} 天。`,
        requirements: [
          {
            id: "REQ-BOM-SCHEDULE",
            label: "BOM 计划与实际完成记录",
            fulfilled: true,
            evidenceId: `E-BOM-${evidenceSuffix}`,
            materialId: null,
          },
          {
            id: "REQ-BOM-CHANGE",
            label: "BOM 差异或变更清单",
            fulfilled: Boolean(bomMaterial),
            evidenceId: null,
            materialId: bomMaterial?.id ?? null,
          },
        ],
        solutions: [
          {
            id: "SOL-BOM-CLASSIFY",
            title: "先分类",
            instruction: "按缺料、设计变更、编码错误和责任部门分类 BOM 异常。",
          },
          {
            id: "SOL-BOM-OWNER",
            title: "再定责",
            instruction: "为每类异常确认责任人、完成期限和复核人。",
          },
        ],
      },
      {
        code: "PURCHASE_DELAY",
        label: "采购启动滞后",
        state: Number(row.purchase_delay) > 0 ? "MATCHED" : "UNVERIFIED",
        summary: `采购实际启动比计划晚 ${Number(row.purchase_delay)} 天。`,
        requirements: [
          {
            id: "REQ-PURCHASE-SCHEDULE",
            label: "采购计划与实际启动记录",
            fulfilled: true,
            evidenceId: `E-PURCHASE-${evidenceSuffix}`,
            materialId: null,
          },
          {
            id: "REQ-PURCHASE-CONFIRM",
            label: "供应商到货承诺或催交记录",
            fulfilled: Boolean(purchaseMaterial),
            evidenceId: null,
            materialId: purchaseMaterial?.id ?? null,
          },
        ],
        solutions: [
          {
            id: "SOL-PURCHASE-CRITICAL",
            title: "锁定关键物料",
            instruction: "识别影响开工的关键物料，并取得供应商确认到货日期。",
          },
          {
            id: "SOL-PURCHASE-ESCALATE",
            title: "升级催交",
            instruction: "对无法满足日期的物料发起替代料或管理升级处理。",
          },
        ],
      },
      {
        code: "CAPACITY_RISK",
        label: "产能负荷风险",
        state: "UNVERIFIED",
        summary: "当前记录未提供已核验的产能负荷事实，需补充并核验材料后判断。",
        requirements: [
          {
            id: "REQ-CAPACITY-LOAD",
            label: "关键产线负荷与工时记录",
            fulfilled: Boolean(capacityMaterial),
            evidenceId: null,
            materialId: capacityMaterial?.id ?? null,
          },
        ],
        solutions: [
          {
            id: "SOL-CAPACITY-CHECK",
            title: "核对负荷",
            instruction:
              "比较订单所需工时、可用工时与排产锁定量，确认是否超出安全区间。",
          },
        ],
      },
    ];
  }

  private evidence(
    id: string,
    sourceObjectId: string,
    sourceVersionId: string,
    sourceFile: string,
    sourceSheet: string,
    sourceRow: number,
    classification: "FACT",
    fields: Record<string, string>,
  ) {
    return {
      id,
      sourceObjectId,
      sourceVersionId,
      sourceFile,
      sourceSheet,
      sourceRow,
      fields,
      classification,
    };
  }

  private date(value: unknown): string {
    return isoDate(value);
  }

  private delay(forecast: unknown, promised: unknown): number {
    return delayDays({
      forecastDate: this.date(forecast),
      promisedDate: this.date(promised),
    });
  }
}
