import { BadRequestException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  createProjectInputSchema,
  executionPhaseReviewInputSchema,
  outcomeReopenInputSchema,
  outcomeReturnInputSchema,
  outcomeSubmitInputSchema,
  projectReturnInputSchema,
  projectSubtaskStatusInputSchema,
  type Project,
} from "@dingjiang/contracts";
import {
  pinProjectSnapshot,
  productionTaskFacts,
  sourceLocator,
} from "../intake/source-facts";
import { isProduction, runtimeTargetOtd } from "../runtime-config";
import {
  delay,
  isoDate,
  otdPercentage,
  sourceTaskSuffix,
} from "../vs01-domain";
import {
  initialProductionGate,
  initializeProductionTemplates,
  nextEarlyPhase,
  productionReservationId,
} from "./production-lifecycle";
import type { ReadModelService } from "../read-model/read-model-service";
import { phases } from "../work-stages";
import {
  appendProjectEvent,
  assertProjectAction,
  legacyNodeId,
  legacyProjectId,
  projectNodeId,
} from "./project-primitives";

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

/**
 * The project state machine.
 *
 * These are the commands that decide what gets stored: creating a project,
 * moving it through its gates, confirming an outcome. They write, so they
 * carry the full transaction discipline - a bound instance runs inside the
 * command kernel's transaction and never commits, rolls back or releases its
 * caller's client.
 *
 * Every command ends by reading the project back. That read has to go
 * through the same transaction, or the command would return a state the
 * database has not committed yet, so the read model is a collaborator rather
 * than a convenience.
 */
export class ProjectLifecycleService {
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
          [`${this.tenantId}:source-intake`],
        );
      const task = await client.query(
        "SELECT id, status FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [body.data.sourceTaskId, this.tenantId],
      );
      if (task.rowCount === 0) throw new NotFoundException("任务不存在");
      if (task.rows[0]?.status !== "DECIDED")
        throw new BadRequestException("只有已决策任务可以创建项目");
      const existing = await client.query(
        "SELECT id FROM vs01_projects WHERE source_task_id = $1 AND tenant_id = $2 FOR UPDATE",
        [body.data.sourceTaskId, this.tenantId],
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
                this.tenantId,
                false,
              ),
            ],
          }
        : await client.query<OrderRow>(
            "SELECT o.order_id, o.customer, o.promised_date, o.forecast_date, GREATEST((b.actual_bom_date - b.planned_bom_date), 0)::int AS bom_delay, GREATEST((p.actual_start_date - p.planned_start_date), 0)::int AS purchase_delay FROM vs01_orders o JOIN vs01_bom b ON b.order_id = o.order_id AND b.tenant_id = o.tenant_id JOIN vs01_purchases p ON p.order_id = o.order_id AND p.tenant_id = o.tenant_id WHERE o.order_id = $1 AND o.tenant_id = $2 FOR SHARE",
            [body.data.sourceTaskId, this.tenantId],
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
        [this.tenantId],
      );
      const baseline = otdPercentage(
        metricRows.rows.map((row) => ({
          promisedDate: isoDate(row.promised_date),
          forecastDate: isoDate(row.forecast_date),
        })),
      );
      const targetOtd = runtimeTargetOtd();
      await client.query(
        "INSERT INTO vs01_projects (id, tenant_id, source_task_id, name, status, returned_reason, metric_before, metric_current, metric_target) VALUES ($1, $2, $3, '解决订单延期问题', 'DRAFT', NULL, $4, $4, $5)",
        [
          createdProjectId,
          this.tenantId,
          body.data.sourceTaskId,
          baseline,
          targetOtd,
        ],
      );
      if (isProduction())
        await pinProjectSnapshot(
          client,
          this.tenantId,
          createdProjectId,
          facts.rows[0]!,
          metricRows.rows,
          baseline,
        );
      await client.query(
        "INSERT INTO vs01_project_nodes (id, tenant_id, project_id, name, status, progress, latest_update) VALUES ($1, $2, $3, 'BOM治理', 'NOT_STARTED', 0, '尚未更新') ON CONFLICT (project_id) DO NOTHING",
        [createdNodeId, this.tenantId, createdProjectId],
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
            this.tenantId,
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
            this.tenantId,
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
        [createdProjectId, this.tenantId, baseline, targetOtd],
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.readModel.project(createdProjectId);
  }

  async submitProject(id: string, input: unknown): Promise<Project> {
    assertProjectAction(input, "PMC");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const rootCauseGate = await client.query(
        "SELECT gate_status FROM vs01_project_phases WHERE project_id = $1 AND tenant_id = $2 AND code = 'ROOT_CAUSE_VALIDATION' FOR UPDATE",
        [id, this.tenantId],
      );
      if (rootCauseGate.rowCount !== 1)
        throw new NotFoundException("根因核验阶段不存在");
      if (rootCauseGate.rows[0]?.gate_status !== "APPROVED")
        throw new BadRequestException("请先确认根因核验结论");
      const required = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'PMC'",
        [this.tenantId, scopedNodeId],
      );
      if (
        Number(required.rows[0]?.total) !== Number(required.rows[0]?.completed)
      )
        throw new BadRequestException("请先完成方案设计与任务拆解");
      const before = await client.query(
        "SELECT p.status AS project_status, p.returned_reason AS project_returned_reason, ph.gate_status, ph.returned_reason AS gate_returned_reason FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'SOLUTION_APPROVAL' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph",
        [id, this.tenantId],
      );
      if (before.rowCount !== 1) throw new NotFoundException("项目不存在");
      const project = await client.query(
        "UPDATE vs01_projects SET status = 'PENDING_APPROVAL', returned_reason = NULL WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT', 'RETURNED')",
        [id, this.tenantId],
      );
      if (project.rowCount !== 1)
        throw new BadRequestException("项目当前不能提交方案");
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'PENDING', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'SOLUTION_APPROVAL'",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'WAITING_REVIEW' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'OWNER' AND status IN ('LOCKED', 'RETURNED')",
        [this.tenantId, scopedNodeId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'PROJECT_SUBMITTED', 'SOLUTION_APPROVAL', '', 'PMC', $3::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
  }

  async approveProject(id: string, input: unknown): Promise<Project> {
    assertProjectAction(input, "OWNER");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const before = await client.query(
        "SELECT p.status AS project_status, p.returned_reason AS project_returned_reason, ph.gate_status, ph.returned_reason, s.status AS approval_task_status, s.completion_note, s.output_reference, s.output_source_object_id, s.output_source_version_id, s.completed_at FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'SOLUTION_APPROVAL' JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.phase_code = 'SOLUTION_APPROVAL' AND s.owner = 'OWNER' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph, s",
        [id, this.tenantId],
      );
      if (before.rowCount !== 1) throw new NotFoundException("项目不存在");
      const updated = await client.query(
        "UPDATE vs01_projects SET status = 'RUNNING', returned_reason = NULL WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_APPROVAL'",
        [id, this.tenantId],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("项目当前不能批准");
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'SOLUTION_APPROVAL'",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'EXECUTION_CONTROL' AND status = 'LOCKED'",
        [this.tenantId, scopedNodeId],
      );
      const approvalLocator = await this.createProjectSource(
        client,
        "项目批准记录",
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'DONE', completion_note = '企业负责人已确认解决方案', output_reference = $3, output_source_object_id = $4, output_source_version_id = $5, completion_basis = 'ROLE_DECISION', confirmed_by = 'OWNER', confirmed_at = now(), confirmed_acceptance = acceptance, completed_at = now() WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'OWNER'",
        [
          this.tenantId,
          scopedNodeId,
          approvalLocator.reference,
          approvalLocator.sourceObjectId,
          approvalLocator.sourceVersionId,
        ],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'PROJECT_APPROVED', 'SOLUTION_APPROVAL', '', 'OWNER', $3::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
  }

  async returnProject(id: string, input: unknown): Promise<Project> {
    const body = projectReturnInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的退回请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const before = await client.query(
        "SELECT p.status AS project_status, ph.gate_status FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'SOLUTION_APPROVAL' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph",
        [id, this.tenantId],
      );
      if (before.rowCount !== 1) throw new NotFoundException("项目不存在");
      const project = await client.query(
        "UPDATE vs01_projects SET status = 'RETURNED', returned_reason = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_APPROVAL'",
        [id, this.tenantId, body.data.reason],
      );
      if (project.rowCount !== 1)
        throw new BadRequestException("项目当前不能退回方案");
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'SOLUTION_APPROVAL'",
        [id, this.tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'RETURNED', reopen_reason = $3 WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'OWNER'",
        [this.tenantId, scopedNodeId, body.data.reason],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'PROJECT_RETURNED', 'SOLUTION_APPROVAL', $3, 'OWNER', $4::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
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
        [id, this.tenantId],
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
          [subtask.rows[0]?.project_id, this.tenantId],
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
          [
            this.tenantId,
            subtask.rows[0]?.node_id,
            subtask.rows[0]?.project_id,
          ],
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
          [subtask.rows[0]?.project_id, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'EXECUTION_CONTROL' THEN 'OPEN' ELSE 'LOCKED' END WHERE project_id = $1 AND tenant_id = $2 AND code IN ('EXECUTION_CONTROL', 'RESULT_ACCEPTANCE')",
          [subtask.rows[0]?.project_id, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'LOCKED' WHERE node_id = $1 AND tenant_id = $2 AND phase_code = 'RESULT_ACCEPTANCE'",
          [subtask.rows[0]?.node_id, this.tenantId],
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
          this.tenantId,
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
        [this.tenantId, id, eventType, body.data.note],
      );
      resolvedProjectId = String(subtask.rows[0].project_id);
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, $3, $4, $5, 'PMC', $6::jsonb)",
        [
          this.tenantId,
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
          [subtask.rows[0].node_id, this.tenantId, subtask.rows[0].phase_code],
        );
        const next = nextEarlyPhase(
          String(subtask.rows[0].phase_code),
          Number(counts.rows[0]?.total),
          Number(counts.rows[0]?.completed),
        );
        if (next) {
          await client.query(
            "UPDATE vs01_project_phases SET gate_status='APPROVED' WHERE project_id=$1 AND tenant_id=$2 AND code=$3 AND gate_status='OPEN'",
            [resolvedProjectId, this.tenantId, subtask.rows[0].phase_code],
          );
          await client.query(
            "UPDATE vs01_project_phases SET gate_status='OPEN' WHERE project_id=$1 AND tenant_id=$2 AND code=$3 AND gate_status='LOCKED'",
            [resolvedProjectId, this.tenantId, next],
          );
          await client.query(
            "UPDATE vs01_project_subtasks SET status='READY' WHERE node_id=$1 AND tenant_id=$2 AND phase_code=$3 AND owner='PMC' AND status='LOCKED'",
            [subtask.rows[0].node_id, this.tenantId, next],
          );
          // TASK_COMPLETED above retains before/after and the human command audit.
        }
      }
      const counts = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE node_id = $1 AND phase_code = 'EXECUTION_CONTROL' AND tenant_id = $2",
        [subtask.rows[0].node_id, this.tenantId],
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
          [
            subtask.rows[0].node_id,
            this.tenantId,
            progress,
            status,
            body.data.note,
          ],
        );
        await client.query(
          "INSERT INTO vs01_node_updates (tenant_id, node_id, progress, update_text) VALUES ($1, $2, $3, $4)",
          [this.tenantId, subtask.rows[0].node_id, progress, body.data.note],
        );
      }
      if (
        subtask.rows[0].phase_code === "EXECUTION_CONTROL" &&
        progress === 100
      ) {
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
          [resolvedProjectId, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_projects SET status = 'RESULT_VALIDATION' WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'",
          [resolvedProjectId, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
          [resolvedProjectId, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE' AND status = 'LOCKED'",
          [this.tenantId, subtask.rows[0].node_id],
        );
        await appendProjectEvent(
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
          [resolvedProjectId, this.tenantId],
        );
      }
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.readModel.project(resolvedProjectId!);
  }

  async reviewExecutionPhase(id: string, input: unknown): Promise<Project> {
    const body = executionPhaseReviewInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的执行阶段复核请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const phase = await client.query(
        "SELECT p.status AS project_status, ph.gate_status, ph.returned_reason FROM vs01_projects p JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.code = 'EXECUTION_CONTROL' WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p, ph",
        [id, this.tenantId],
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
          [this.tenantId, scopedNodeId],
        );
        if (Number(counts.rows[0]?.total) !== Number(counts.rows[0]?.completed))
          throw new BadRequestException("请先由事项责任人确认全部执行事项");
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
          [id, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_projects SET status = 'RESULT_VALIDATION' WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'",
          [id, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_project_phases SET gate_status = 'OPEN', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
          [id, this.tenantId],
        );
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE' AND status = 'LOCKED'",
          [this.tenantId, scopedNodeId],
        );
        await appendProjectEvent(
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
          [id, this.tenantId, body.data.reason],
        );
        await appendProjectEvent(
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
    return this.readModel.project(id);
  }

  async submitOutcome(id: string, input: unknown): Promise<Project> {
    const body = outcomeSubmitInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的结果确认提交");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const project = await client.query(
        "SELECT status FROM vs01_projects WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      if (project.rowCount === 0) throw new NotFoundException("项目不存在");
      if (project.rows[0]?.status !== "RESULT_VALIDATION")
        throw new BadRequestException("项目当前不能确认结果");
      const tasks = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'RESULT_ACCEPTANCE'",
        [this.tenantId, scopedNodeId],
      );
      if (Number(tasks.rows[0]?.total) !== Number(tasks.rows[0]?.completed))
        throw new BadRequestException("请先由责任员工确认结果步骤的全部事项");
      const before = await client.query(
        "SELECT status, current, conclusion, evidence_reference, note, submitted_at, accepted_at, returned_reason, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
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
          this.tenantId,
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
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'RESULT_ACCEPTANCE' THEN 'APPROVED' WHEN code = 'KNOWLEDGE_CAPTURE' THEN 'OPEN' ELSE gate_status END, returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code IN ('RESULT_ACCEPTANCE', 'KNOWLEDGE_CAPTURE')",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE node_id = $1 AND tenant_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE' AND status = 'LOCKED'",
        [scopedNodeId, this.tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'OUTCOME_CONFIRMED_BY_EMPLOYEE', 'RESULT_ACCEPTANCE', $3, 'PMC', $4::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
  }

  async approveOutcome(id: string, input: unknown): Promise<Project> {
    assertProjectAction(input, "OWNER");
    if (id !== legacyProjectId)
      throw new BadRequestException("结果审批仅用于旧项目历史补偿");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scopedNodeId = await projectNodeId(client, id);
      const before = await client.query(
        "SELECT status, current, conclusion, evidence_reference, note, submitted_at, accepted_at, returned_reason, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      if (before.rowCount !== 1)
        throw new NotFoundException("结果验收记录不存在");
      const updated = await client.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_RESULT_ACCEPTANCE'",
        [id, this.tenantId],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("项目当前不能签收结果");
      await client.query(
        "UPDATE vs01_result_validations SET status = 'ACCEPTED', accepted_at = now(), returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'APPROVED' WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'OPEN' WHERE project_id = $1 AND tenant_id = $2 AND code = 'KNOWLEDGE_CAPTURE'",
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE node_id = $1 AND tenant_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE' AND status = 'LOCKED'",
        [scopedNodeId, this.tenantId],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'OUTCOME_ACCEPTED', 'RESULT_ACCEPTANCE', '', 'OWNER', $3::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
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
      const scopedNodeId = await projectNodeId(client, id);
      const previous = await client.query(
        "SELECT status, current, conclusion, evidence_reference, note, submitted_at, accepted_at, returned_reason, source_object_id, source_version_id FROM vs01_result_validations WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      if (previous.rowCount !== 1)
        throw new NotFoundException("结果验收记录不存在");
      const candidate = await client.query(
        "SELECT status FROM vs01_experience_candidates WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      const formalHistory = await client.query(
        "SELECT 1 FROM vs01_formal_experiences f JOIN vs01_experience_candidates c ON c.id = f.candidate_id WHERE c.project_id = $1 AND f.tenant_id = $2 AND f.status IN ('PUBLISHED', 'RETRACTED') LIMIT 1 FOR UPDATE",
        [id, this.tenantId],
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
        [id, this.tenantId],
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
        [id, this.tenantId],
      );
      await client.query(
        "UPDATE vs01_result_validations SET status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2",
        [id, this.tenantId, reason],
      );
      const knowledgeTasks = await client.query(
        "SELECT id, status, completion_note, output_reference, output_source_object_id, output_source_version_id, completed_at FROM vs01_project_subtasks WHERE tenant_id = $1 AND node_id = $2 AND phase_code = 'KNOWLEDGE_CAPTURE' AND status = 'DONE' FOR UPDATE",
        [this.tenantId, scopedNodeId],
      );
      for (const task of knowledgeTasks.rows) {
        await client.query(
          "UPDATE vs01_project_subtasks SET status = 'READY', reopen_reason = $3, completed_at = NULL WHERE id = $1 AND tenant_id = $2",
          [task.id, this.tenantId, reason],
        );
        await client.query(
          "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'TASK_REOPENED', 'KNOWLEDGE_CAPTURE', $3, $4, $5::jsonb)",
          [
            this.tenantId,
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
        [id, this.tenantId, reason],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = 'RETURNED', returned_reason = $3 WHERE project_id = $1 AND tenant_id = $2 AND code = 'RESULT_ACCEPTANCE'",
        [id, this.tenantId, reason],
      );
      await client.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, 'OUTCOME_RETURNED', 'RESULT_ACCEPTANCE', $3, $4, $5::jsonb)",
        [
          this.tenantId,
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
    return this.readModel.project(id);
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

  private activePhaseForProject(status: string): string | null {
    if (status === "DRAFT" || status === "RETURNED") return "SOLUTION_APPROVAL";
    if (status === "RUNNING") return "EXECUTION_CONTROL";
    if (status === "RESULT_VALIDATION") return "RESULT_ACCEPTANCE";
    if (status === "KNOWLEDGE_CAPTURE") return "KNOWLEDGE_CAPTURE";
    return null;
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
      [sourceObjectId, this.tenantId, reference],
    );
    await client.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, 1)",
      [sourceVersionId, sourceObjectId, this.tenantId],
    );
    return { sourceObjectId, sourceVersionId, reference };
  }

  private projectFactContext(
    sourceTaskId: string,
    row: Pick<
      OrderRow,
      "promised_date" | "forecast_date" | "bom_delay" | "purchase_delay"
    >,
    historicalSnapshotReference: string,
  ): ProjectFactContext {
    const suffix = sourceTaskSuffix(sourceTaskId);
    return {
      sourceTaskId,
      orderDelay: delay(row.forecast_date, row.promised_date),
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
}
