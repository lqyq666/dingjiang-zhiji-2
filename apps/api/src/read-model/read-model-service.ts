import {
  assistantFeedbackListSchema,
  bossDashboardSchema,
  employeeDashboardSchema,
  experienceLibrarySchema,
  experienceLifecycleHistoryListSchema,
  evidenceProposalReviewListSchema,
  expertDashboardSchema,
  projectSchema,
  taskDetailSchema,
  type AssistantFeedbackRecord,
  type BossDashboard,
  type EmployeeDashboard,
  type ExperienceLibrary,
  type EvidenceProposalReview,
  type ExperienceLifecycleHistoryList,
  type ExpertDashboard,
  type FormalExperience,
  type Project,
  type TaskDetail,
} from "@dingjiang/contracts";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { productionTaskFacts, sourceLocator } from "../intake/source-facts";
import { materialProjection } from "../materials/material-projection";
import { isProduction, runtimeTargetOtd } from "../runtime-config";
import {
  delay,
  isoDate,
  otdPercentage,
  sourceTaskSuffix,
} from "../vs01-domain";
import { workStageNames, workStagePurposes } from "../work-stages";
import { RootCauseWorkpaperService } from "../workpapers/root-cause-workpaper.service";
import { formalExperienceView, materialSituationForInput } from "./projections";

const legacyProjectId = "PRJ-OTD-001";

type OrderRow = QueryResultRow & {
  order_id: string;
  customer: string;
  promised_date: string;
  forecast_date: string;
  bom_delay: number;
  purchase_delay: number;
};

/**
 * Everything that only reads.
 *
 * The domain service grew a second kind of thing: methods that assemble a
 * view of what is already stored and never write. They were interleaved with
 * the commands that decide what gets stored, which made both harder to
 * follow. This class holds the reading half.
 *
 * It shares the domain service's transaction seam. A bound instance reads
 * through the command kernel's transaction and therefore sees the writes
 * that transaction has made so far; a standalone instance reads through the
 * pool. Dropping that distinction would let a read inside a command see a
 * state the command has not committed.
 */
export class ReadModelService {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private readonly tenantId: string;
  private workpapers: RootCauseWorkpaperService | undefined;

  constructor(pool: Pool, tenantId: string, commandTransaction?: PoolClient) {
    this.pool = pool;
    this.tenantId = tenantId;
    this.commandTransaction = commandTransaction;
  }

  private get database() {
    return this.commandTransaction ?? this.pool;
  }

  async employee(): Promise<EmployeeDashboard> {
    const projects = await this.projects(false);
    return employeeDashboardSchema.parse({
      role: "PMC",
      highRiskOrders: await this.highRiskOrders(false),
      pendingTaskIds: (
        await this.database.query(
          "SELECT t.id FROM vs01_tasks t JOIN vs01_orders o ON o.order_id = t.id AND o.tenant_id = t.tenant_id WHERE t.tenant_id = $1 AND t.status = 'OPEN' AND o.status <> 'E2E_ACCEPTANCE' ORDER BY t.id",
          [this.tenantId],
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
          [this.tenantId],
        ),
        this.database.query(
          "SELECT count(*)::int AS count FROM vs01_projects p JOIN vs01_orders o ON o.order_id = p.source_task_id AND o.tenant_id = p.tenant_id WHERE p.tenant_id = $1 AND p.status = 'PENDING_APPROVAL' AND o.status <> 'E2E_ACCEPTANCE'",
          [this.tenantId],
        ),
        this.projects(false),
        this.highRiskOrders(false),
        this.ownerDataSources(),
      ]);
    return bossDashboardSchema.parse({
      role: "OWNER",
      otd: otdPercentage(
        orders.rows.map((row) => ({
          promisedDate: isoDate(row.promised_date),
          forecastDate: isoDate(row.forecast_date),
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
      [id, this.tenantId],
    );
    const materialResult = await this.database.query(
      "SELECT m.id, m.situation_code, m.requirement_id, m.title, m.source_reference, m.note, m.kind, m.status, m.source_object_id, m.source_version_id, m.withdrawn_at, m.withdrawn_reason, m.created_by, m.created_at, c.original_name, c.media_type, c.byte_size, c.sha256, c.extraction_status, c.content_preview, c.readable_by_ai, (g.material_id IS NOT NULL) AS verification_eligible, v.verification_status, v.verification_version, v.verified_by, v.verification_note, v.verified_at FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id LEFT JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id LEFT JOIN LATERAL (SELECT e.event_type AS verification_status, e.verification_version, e.actor_subject_id AS verified_by, e.reason AS verification_note, e.created_at AS verified_at FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE m.task_id = $1 AND m.tenant_id = $2 ORDER BY m.created_at, m.id",
      [id, this.tenantId],
    );
    const referenceResult = await this.database.query(
      "SELECT r.id, r.experience_id, r.status, r.classification, r.note, r.created_at, r.withdrawn_at, r.withdrawn_reason, r.experience_source_object_id, r.experience_source_version_id, f.title, f.applicable_situation, f.limitations FROM vs01_experience_references r JOIN vs01_formal_experiences f ON f.id = r.experience_id WHERE r.task_id = $1 AND r.tenant_id = $2 ORDER BY r.created_at, r.id",
      [id, this.tenantId],
    );
    const referenceEventResult = await this.database.query(
      "SELECT e.id, e.reference_id, e.task_id, r.experience_id, f.title AS experience_title, e.event_type, e.actor, e.note, e.snapshot, e.created_at FROM vs01_experience_reference_events e JOIN vs01_experience_references r ON r.id = e.reference_id AND r.tenant_id = e.tenant_id JOIN vs01_formal_experiences f ON f.id = r.experience_id AND f.tenant_id = e.tenant_id WHERE e.task_id = $1 AND e.tenant_id = $2 ORDER BY e.id",
      [id, this.tenantId],
    );
    const formalEvidenceResult = await this.database.query(
      "SELECT f.*, m.title AS material_title FROM vs32_formal_evidence f JOIN vs32_evidence_proposals p ON p.id = f.proposal_id AND p.tenant_id = f.tenant_id JOIN vs01_task_materials m ON m.id = p.material_id AND m.tenant_id = f.tenant_id WHERE f.source_task_id = $1 AND f.tenant_id = $2 ORDER BY f.confirmed_at, f.id",
      [id, this.tenantId],
    );
    const materials = materialResult.rows.map((material) =>
      materialProjection(material),
    );
    const evidenceSuffix = sourceTaskSuffix(id);
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
          promisedDate: isoDate(row.promised_date),
          forecastDate: isoDate(row.forecast_date),
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
          plannedBomDate: isoDate(row.planned_bom_date),
          actualBomDate: isoDate(row.actual_bom_date),
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
          plannedStartDate: isoDate(row.planned_start_date),
          actualStartDate: isoDate(row.actual_start_date),
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
          value: `${delay(row.forecast_date, row.promised_date)} 天`,
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
      [projectId, this.tenantId],
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

  async project(id: string): Promise<Project> {
    const project = await this.findProject(id);
    if (!project) throw new NotFoundException("项目不存在");
    return project;
  }

  async projectList(): Promise<Project[]> {
    return this.projects();
  }

  async rootCauseWorkpaper(id: string) {
    this.workpapers ??= new RootCauseWorkpaperService();
    return this.workpapers.view(id);
  }

  async assistantFeedback(
    projectIdValue: string,
  ): Promise<AssistantFeedbackRecord[]> {
    const result = await this.database.query(
      "SELECT id, project_id, phase_code, status, issue_type, feedback, expected_behavior, created_at, withdrawn_at, withdrawn_reason FROM vs01_assistant_feedback_candidates WHERE project_id = $1 AND tenant_id = $2 ORDER BY created_at DESC",
      [projectIdValue, this.tenantId],
    );
    if (result.rowCount === 0) {
      const project = await this.database.query(
        "SELECT 1 FROM vs01_projects WHERE id = $1 AND tenant_id = $2",
        [projectIdValue, this.tenantId],
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

  async expertExperienceReviews(): Promise<ExpertDashboard> {
    const result = await this.database.query(
      "SELECT c.id AS candidate_id, c.project_id, c.title, c.applicable_situation, c.business_problem, c.practice, c.result_summary, c.evidence_reference, c.limitations, c.status, c.revision, c.created_at, cr.created_at AS candidate_submitted_at, c.returned_reason, c.reviewed_by, c.reviewed_at, c.formal_experience_id, c.feishu_record_id, c.feishu_synced_revision, c.feishu_sync_status, c.feishu_synced_at, c.source_object_id AS evidence_source_object_id, c.source_version_id AS evidence_source_version_id, cr.source_object_id AS candidate_source_object_id, cr.source_version_id AS candidate_source_version_id, cr.structured_card, p.name AS project_name, rv.current, rv.conclusion FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions cr ON cr.candidate_id = c.id AND cr.revision = c.revision JOIN vs01_projects p ON p.id = c.project_id JOIN vs01_result_validations rv ON rv.project_id = c.project_id WHERE c.tenant_id = $1 AND c.status = 'PENDING_REVIEW' ORDER BY cr.created_at, c.id",
      [this.tenantId],
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

  async pendingExperienceCandidate(candidateId: string) {
    const dashboard = await this.expertExperienceReviews();
    const item = dashboard.candidates.find(
      (entry) => entry.candidate.id === candidateId,
    );
    if (!item) throw new NotFoundException("待审核候选经验不存在");
    return item;
  }

  async experiences(query = ""): Promise<ExperienceLibrary> {
    const result = await this.database.query(
      "SELECT * FROM vs01_formal_experiences WHERE tenant_id = $1 AND status = 'PUBLISHED' AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR applicable_situation ILIKE '%' || $2 || '%' OR business_problem ILIKE '%' || $2 || '%') ORDER BY published_at DESC, id",
      [this.tenantId, query.trim()],
    );
    return experienceLibrarySchema.parse({
      query: query.trim(),
      items: result.rows.map((row) => formalExperienceView(row)),
    });
  }

  async expertExperienceHistory(): Promise<ExperienceLifecycleHistoryList> {
    const result = await this.database.query(
      "SELECT c.id, c.status, c.revision, p.id AS project_id, p.name AS project_name FROM vs01_experience_candidates c JOIN vs01_projects p ON p.id = c.project_id WHERE c.tenant_id = $1 ORDER BY c.created_at DESC",
      [this.tenantId],
    );
    return experienceLifecycleHistoryListSchema.parse({
      items: await Promise.all(
        result.rows.map(async (candidate) => {
          const [revisions, publications, events] = await Promise.all([
            this.database.query(
              "SELECT revision, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, structured_card, created_at FROM vs01_experience_candidate_revisions WHERE candidate_id = $1 AND tenant_id = $2 ORDER BY revision",
              [candidate.id, this.tenantId],
            ),
            this.database.query(
              "SELECT * FROM vs01_formal_experiences WHERE candidate_id = $1 AND tenant_id = $2 ORDER BY published_at, id",
              [candidate.id, this.tenantId],
            ),
            this.database.query(
              "SELECT event_type, actor, note, snapshot, created_at FROM vs01_project_events WHERE project_id = $1 AND tenant_id = $2 AND event_type IN ('EXPERIENCE_CANDIDATE_CREATED', 'EXPERIENCE_CANDIDATE_WITHDRAWN', 'EXPERIENCE_RETURNED', 'EXPERIENCE_RESUBMITTED', 'EXPERIENCE_APPROVED', 'FORMAL_EXPERIENCE_PUBLISHED', 'FORMAL_EXPERIENCE_RETRACTED') ORDER BY id",
              [candidate.project_id, this.tenantId],
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
              formalExperienceView(row),
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
      [id, this.tenantId],
    );
    if (result.rowCount !== 1)
      throw new NotFoundException("正式经验不存在或已撤回");
    return formalExperienceView(result.rows[0]);
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
      [this.tenantId, includeAcceptance],
    );
    return Promise.all(result.rows.map((row) => this.project(String(row.id))));
  }

  private async highRiskOrders(includeAcceptance = true) {
    const result = await this.database.query<OrderRow>(
      "SELECT o.order_id, o.customer, o.promised_date, o.forecast_date, GREATEST((b.actual_bom_date - b.planned_bom_date), 0)::int AS bom_delay, GREATEST((p.actual_start_date - p.planned_start_date), 0)::int AS purchase_delay FROM vs01_orders o JOIN vs01_bom b ON b.order_id = o.order_id AND b.tenant_id = o.tenant_id JOIN vs01_purchases p ON p.order_id = o.order_id AND p.tenant_id = o.tenant_id WHERE o.tenant_id = $1 AND ($2::boolean OR o.status <> 'E2E_ACCEPTANCE') AND o.forecast_date > o.promised_date ORDER BY o.order_id",
      [this.tenantId, includeAcceptance],
    );
    return result.rows.map((row) => this.orderRisk(row));
  }

  private async ownerDataSources() {
    if (isProduction()) {
      const latest = await this.database.query(
        `SELECT DISTINCT ON(f.file_name) f.file_name,f.row_count,sv.id AS source_version_id,sv.source_object_id,sv.version_number
        FROM production_source_files f JOIN vs01_source_versions sv ON sv.id=f.source_version_id AND sv.tenant_id=f.tenant_id
        WHERE f.tenant_id=$1 ORDER BY f.file_name,sv.version_number DESC`,
        [this.tenantId],
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
      [this.tenantId, ["SRC-ORDERS", "SRC-BOM", "SRC-PURCHASES"]],
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
    if (isProduction())
      return productionTaskFacts(this.database, id, this.tenantId);
    const result = await this.database.query(
      "SELECT t.id, o.order_id, o.customer, o.promised_date, o.forecast_date, o.status AS order_status, o.source_row AS order_source_row, b.planned_bom_date, b.actual_bom_date, b.completion_status, b.source_row AS bom_source_row, GREATEST((b.actual_bom_date - b.planned_bom_date), 0)::int AS bom_delay, p.planned_start_date, p.actual_start_date, p.arrival_risk, p.source_row AS purchase_source_row, GREATEST((p.actual_start_date - p.planned_start_date), 0)::int AS purchase_delay FROM vs01_tasks t JOIN vs01_orders o ON o.order_id = t.order_id JOIN vs01_bom b ON b.order_id = o.order_id JOIN vs01_purchases p ON p.order_id = o.order_id WHERE t.id = $1 AND t.tenant_id = $2",
      [id, this.tenantId],
    );
    if (result.rowCount === 0) throw new NotFoundException("任务不存在");
    return result.rows[0] as QueryResultRow;
  }

  private async findProject(id = legacyProjectId): Promise<Project | null> {
    const result = await this.database.query(
      "SELECT p.id, p.source_task_id, p.name, p.status, p.returned_reason, p.metric_before, p.metric_target, n.id AS node_id, n.name AS node_name, n.latest_update, rv.baseline, rv.target, rv.current AS outcome_current, rv.status AS outcome_status, rv.conclusion, rv.evidence_reference, rv.note AS outcome_note, rv.submitted_at, rv.accepted_at, rv.source_object_id, rv.source_version_id FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_result_validations rv ON rv.project_id = p.id WHERE p.id = $1 AND p.tenant_id = $2",
      [id, this.tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const phaseResult = await this.database.query(
      "SELECT id, code, name, purpose, gate_status, gate_label, returned_reason FROM vs01_project_phases WHERE project_id = $1 AND tenant_id = $2 ORDER BY sort_order",
      [id, this.tenantId],
    );
    const subtaskResult = await this.database.query(
      "SELECT id, title, status, sort_order, phase_code, purpose, owner, origin, inputs, process, expected_output, output_reference, output_source_object_id, output_source_version_id, acceptance, completion_note, completed_at, source_recorded_at, reopen_reason, progress_note, progress_output_reference, progress_updated_at, completion_basis, confirmed_by, confirmed_at, confirmed_acceptance FROM vs01_project_subtasks WHERE node_id = $1 AND tenant_id = $2 ORDER BY phase_code, sort_order, id",
      [row.node_id, this.tenantId],
    );
    const experienceResult = await this.database.query(
      "SELECT c.id, c.title, c.applicable_situation, c.business_problem, c.practice, c.result_summary, c.evidence_reference, c.limitations, c.status, c.revision, c.created_at, r.created_at AS candidate_submitted_at, c.returned_reason, c.reviewed_by, c.reviewed_at, c.formal_experience_id, c.feishu_record_id, c.feishu_synced_revision, c.feishu_sync_status, c.feishu_synced_at, c.source_object_id AS evidence_source_object_id, c.source_version_id AS evidence_source_version_id, r.source_object_id AS candidate_source_object_id, r.source_version_id AS candidate_source_version_id, r.structured_card FROM vs01_experience_candidates c LEFT JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision WHERE c.project_id = $1 AND c.tenant_id = $2",
      [id, this.tenantId],
    );
    const eventResult = await this.database.query(
      "SELECT event_type, phase_code, note, actor, created_at, snapshot FROM vs01_project_events WHERE project_id = $1 AND tenant_id = $2 ORDER BY id",
      [id, this.tenantId],
    );
    const materialResult = await this.database.query(
      "SELECT m.id, m.situation_code, m.requirement_id, m.title, m.source_reference, m.note, m.kind, m.status, m.source_object_id, m.source_version_id, m.withdrawn_at, m.withdrawn_reason, m.created_by, m.created_at, c.original_name, c.media_type, c.byte_size, c.sha256, c.extraction_status, c.content_preview, c.readable_by_ai, (g.material_id IS NOT NULL) AS verification_eligible, v.verification_status, v.verification_version, v.verified_by, v.verification_note, v.verified_at FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id LEFT JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id LEFT JOIN LATERAL (SELECT e.event_type AS verification_status, e.verification_version, e.actor_subject_id AS verified_by, e.reason AS verification_note, e.created_at AS verified_at FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE m.task_id = $1 AND m.tenant_id = $2 AND m.status = 'ACTIVE' ORDER BY m.created_at DESC, m.id DESC",
      [row.source_task_id, this.tenantId],
    );
    const projectReferenceResult = await this.database.query(
      "SELECT r.id, r.task_id, r.experience_id, r.status, r.note, r.created_at, r.withdrawn_at, r.withdrawn_reason, r.experience_source_object_id, r.experience_source_version_id, f.title, f.applicable_situation, f.limitations FROM vs01_experience_references r JOIN vs01_formal_experiences f ON f.id = r.experience_id WHERE r.task_id = $1 AND r.tenant_id = $2 ORDER BY r.created_at, r.id",
      [row.source_task_id, this.tenantId],
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
        const situationCode = materialSituationForInput(input.label);
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
      [id, this.tenantId],
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

  private orderRisk(row: OrderRow | QueryResultRow) {
    const bomDelay = Number(row.bom_delay ?? 0);
    return {
      orderId: String(row.order_id),
      customer: String(row.customer),
      promisedDate: isoDate(row.promised_date),
      forecastDate: isoDate(row.forecast_date),
      delayDays: delay(row.forecast_date, row.promised_date),
      primaryException: bomDelay > 0 ? "BOM准备" : "采购到货",
    };
  }

  private situations(
    row: QueryResultRow,
    materials: TaskDetail["materials"],
    sourceTaskId: string,
  ): TaskDetail["situations"] {
    const evidenceSuffix = sourceTaskSuffix(sourceTaskId);
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

  private requirementForInput(label: string): string | null {
    if (/产能|工时/.test(label)) return "REQ-CAPACITY-LOAD";
    if (/BOM|变更/.test(label)) return "REQ-BOM-CHANGE";
    if (/采购|供应商|到货/.test(label)) return "REQ-PURCHASE-CONFIRM";
    return null;
  }
}
