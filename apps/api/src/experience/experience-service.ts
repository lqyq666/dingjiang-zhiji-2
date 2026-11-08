import { BadRequestException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  experienceCandidateApproveInputSchema,
  experienceCandidateInputSchema,
  experienceCandidateResubmitInputSchema,
  experienceCandidateReturnInputSchema,
  experienceCandidateWithdrawInputSchema,
  experienceReferenceInputSchema,
  experienceReferenceWithdrawInputSchema,
  formalExperienceRetractInputSchema,
  type FormalExperience,
  type Project,
  type TaskDetail,
} from "@dingjiang/contracts";
import { isProduction } from "../runtime-config";
import { formalExperienceView } from "../read-model/projections";
import type { ReadModelService } from "../read-model/read-model-service";
import {
  appendProjectEvent,
  legacyProjectId,
  projectNodeId,
} from "../projects/project-primitives";
import { phases } from "../work-stages";

/**
 * The experience lifecycle: a candidate is proposed, reviewed by an expert,
 * published, cited by tasks and finally retracted.
 *
 * These commands write, so they carry the full transaction discipline - a
 * bound instance runs inside the command kernel's transaction and never
 * commits, rolls back or releases its caller's client.
 *
 * Every command ends by reading the experience or the project back, and that
 * read has to go through the same transaction, so the read model is a
 * collaborator rather than a convenience.
 */
export class ExperienceService {
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
        [id, this.tenantId],
      );
      if (project.rowCount === 0) throw new NotFoundException("项目不存在");
      if (!["KNOWLEDGE_CAPTURE"].includes(String(project.rows[0]?.status)))
        throw new BadRequestException("结果签收后才能沉淀候选经验");
      const tasks = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE'",
        [this.tenantId, scopedNodeId],
      );
      if (Number(tasks.rows[0]?.total) !== Number(tasks.rows[0]?.completed))
        throw new BadRequestException("请先完成经验沉淀节点的全部小任务");
      const outcome = await client.query(
        "SELECT evidence_reference, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 AND status = 'ACCEPTED' FOR UPDATE",
        [id, this.tenantId],
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
          this.tenantId,
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
          this.tenantId,
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
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'PENDING' WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, this.tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'EXPERIENCE_CANDIDATE_CREATED', 'KNOWLEDGE_CAPTURE', $3, 'PMC', $4::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
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
        [id, this.tenantId],
      );
      if (
        candidate.rowCount !== 1 ||
        candidate.rows[0]?.status !== "PENDING_REVIEW"
      )
        throw new BadRequestException("当前没有可撤回的候选经验");
      const project = await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2 AND status = 'KNOWLEDGE_CAPTURE'",
        [id, this.tenantId],
      );
      if (project.rowCount !== 1)
        throw new BadRequestException("项目当前不能撤回候选经验");
      await client.query(
        "UPDATE vs01_experience_candidates SET status = 'WITHDRAWN' WHERE project_id = $1 AND tenant_id = $2 AND status = 'PENDING_REVIEW'",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, this.tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'EXPERIENCE_CANDIDATE_WITHDRAWN', 'KNOWLEDGE_CAPTURE', $3, 'PMC', $4::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
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
        [id, this.tenantId],
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
        [id, this.tenantId],
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
          this.tenantId,
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
          this.tenantId,
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
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'PENDING', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, this.tenantId],
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
    return this.readModel.project(id);
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
        [id, this.tenantId],
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
        [row.project_id, this.tenantId],
      );
      const phaseGates = await client.query(
        "SELECT code, gate_status FROM vs01_project_phases WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [row.project_id, this.tenantId],
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
          this.tenantId,
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
        [id, this.tenantId, formalId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [row.project_id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'COMPLETED' WHERE id = $1 AND tenant_id = $2",
        [row.project_id, this.tenantId],
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
      return this.readModel.experience(formalId);
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  async recordFeishuCandidateSync(
    candidateId: string,
    expectedCandidateVersionId: string,
    recordId: string,
  ): Promise<void> {
    const updated = await this.database.query(
      "UPDATE vs01_experience_candidates c SET feishu_record_id = $3, feishu_synced_revision = c.revision, feishu_sync_status = 'SYNCED', feishu_synced_at = now() FROM vs01_experience_candidate_revisions r WHERE c.id = $1 AND c.tenant_id = $2 AND c.status = 'PENDING_REVIEW' AND r.candidate_id = c.id AND r.revision = c.revision AND r.source_version_id = $4",
      [candidateId, this.tenantId, recordId, expectedCandidateVersionId],
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
      [candidateId, this.tenantId, expectedCandidateVersionId],
    );
    if (updated.rowCount !== 1)
      throw new BadRequestException("候选经验已变化，请刷新后重试");
  }

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

  async feishuReviewCandidate(candidateId: string): Promise<{
    status: "PENDING_REVIEW" | "APPROVED" | "RETURNED" | "WITHDRAWN";
    candidateVersionId: string;
  }> {
    const row = await this.database.query(
      "SELECT c.status, r.source_version_id FROM vs01_experience_candidates c JOIN vs01_experience_candidate_revisions r ON r.candidate_id = c.id AND r.revision = c.revision WHERE c.id = $1 AND c.tenant_id = $2",
      [candidateId, this.tenantId],
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
        this.tenantId,
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
        [id, this.tenantId],
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
        [id, this.tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [row.project_id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [row.project_id, this.tenantId, body.data.reason],
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
    return this.readModel.project(
      (
        await this.database.query(
          "SELECT project_id FROM vs01_experience_candidates WHERE id = $1",
          [id],
        )
      ).rows[0]?.project_id,
    );
  }

  async citeExperience(taskId: string, input: unknown): Promise<TaskDetail> {
    const body = experienceReferenceInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验引用请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const experience = await client.query(
        "SELECT * FROM vs01_formal_experiences WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED' FOR UPDATE",
        [body.data.experienceId, this.tenantId],
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
        [taskId, this.tenantId],
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
          [restoredId, taskId, this.tenantId, body.data.note],
        );
        await client.query(
          "INSERT INTO vs01_experience_reference_events (tenant_id, reference_id, task_id, event_type, actor, note, snapshot) VALUES ($1, $2, $3, 'RESTORED', 'PMC', $4, $5::jsonb)",
          [
            this.tenantId,
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
        return this.readModel.task(taskId);
      }
      if (existingReference.rowCount)
        throw new BadRequestException("这条正式经验已被当前任务引用");
      const inserted = await client.query(
        "INSERT INTO vs01_experience_references (id, tenant_id, task_id, experience_id, status, classification, note, created_by, experience_source_object_id, experience_source_version_id) VALUES ($1, $2, $3, $4, 'ACTIVE', 'PROPOSAL', $5, 'PMC', $6, $7) ON CONFLICT (task_id, experience_id, experience_source_version_id) DO NOTHING",
        [
          referenceId,
          this.tenantId,
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
          this.tenantId,
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
        [taskId, this.tenantId],
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
    return this.readModel.task(taskId);
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
        [referenceId, taskId, this.tenantId],
      );
      if (reference.rowCount !== 1 || reference.rows[0]?.status !== "ACTIVE")
        throw new BadRequestException("当前没有可撤回的经验引用");
      await client.query(
        "UPDATE vs01_experience_references SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = $4 WHERE id = $1 AND task_id = $2 AND tenant_id = $3",
        [referenceId, taskId, this.tenantId, body.data.reason],
      );
      await client.query(
        "INSERT INTO vs01_experience_reference_events (tenant_id, reference_id, task_id, event_type, actor, note, snapshot) VALUES ($1, $2, $3, 'WITHDRAWN', 'PMC', $4, $5::jsonb)",
        [
          this.tenantId,
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
        [taskId, this.tenantId],
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
    return this.readModel.task(taskId);
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
        [id, this.tenantId],
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
        [id, this.tenantId],
      );
      if (references.rowCount)
        throw new BadRequestException(
          `正式经验仍被 ${references.rows.map((row) => row.task_id).join("、")} 引用；请先逐条撤回引用`,
        );
      await client.query(
        "UPDATE vs01_formal_experiences SET status = 'RETRACTED', retracted_at = now(), retracted_reason = $3 WHERE id = $1 AND tenant_id = $2",
        [id, this.tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_experience_candidates SET status = 'RETURNED', returned_reason = $3, reviewed_by = 'EXPERT_REVIEWER', reviewed_at = now(), formal_experience_id = NULL WHERE id = $1 AND tenant_id = $2",
        [formal.candidate_id, this.tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2",
        [formal.source_project_id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [formal.source_project_id, this.tenantId, body.data.reason],
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
      [sourceObjectId, this.tenantId, reference],
    );
    await client.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, 1)",
      [sourceVersionId, sourceObjectId, this.tenantId],
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
      [projectId, this.tenantId, isProduction()],
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
      [projectId, this.tenantId],
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
