import { productionTaskFacts, sourceLocator } from "../intake/source-facts";
import { isProduction, runtimeTenantId } from "../runtime-config";
import type { OnModuleDestroy } from "@nestjs/common";
import {
  validationCandidateRunInputSchema,
  validationWorkpaperCompleteInputSchema,
  validationWorkpaperDraftInputSchema,
  validationWorkpaperReopenInputSchema,
  validationWorkpaperViewSchema,
  type ValidationWorkpaperContent,
  type ValidationWorkpaperVersion,
  type ValidationWorkpaperView,
} from "@dingjiang/contracts";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { createPool } from "../vs01-db";

const tenantId = runtimeTenantId();
const liveSourceTaskId = "SO-202608136";

type MaterialRow = QueryResultRow & {
  id: string;
  requirement_id: string;
  title: string;
  source_version_id: string;
  source_object_id: string;
  extraction_status: "EXTRACTED" | "NEEDS_REVIEW" | "FAILED";
  readable_by_ai: boolean;
  content_preview: string | null;
};

type WorkpaperRow = QueryResultRow & {
  id: string;
  project_id: string;
  work_item_id: string;
  source_object_id: string;
  status: "DRAFTING" | "CONFIRMED";
  revision: number;
  latest_confirmed_version_id: number | null;
};

@Injectable()
export class RootCauseWorkpaperService implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool = createPool(),
    private readonly commandTransaction?: PoolClient,
  ) {}

  inCommandTransaction<T>(
    client: PoolClient,
    run: (domain: RootCauseWorkpaperService) => Promise<T>,
  ): Promise<T> {
    return run(new RootCauseWorkpaperService(this.pool, client));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async view(projectId: string): Promise<ValidationWorkpaperView> {
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      const scope = await this.scope(client, projectId, false);
      return this.readView(client, scope);
    } finally {
      if (!this.commandTransaction) client.release();
    }
  }

  async candidate(
    projectId: string,
    input: unknown,
  ): Promise<ValidationWorkpaperView> {
    const body = validationCandidateRunInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的候选分析请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scope = await this.scope(client, projectId, true);
      const payloadHash = this.payloadFingerprint(body.data);
      const existing = await this.commandWasHandled(
        client,
        scope.workpaper,
        body.data.requestId,
        "CANDIDATE",
        payloadHash,
      );
      if (existing) {
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.view(projectId);
      }
      this.assertRevision(scope.workpaper, body.data.expectedRevision);
      const materials = await this.materials(
        client,
        scope.sourceTaskId,
        body.data.materialIds,
      );
      if (materials.length !== body.data.materialIds.length)
        throw new BadRequestException("只能使用当前任务中有效的材料");
      const content = this.candidateContent(scope, materials);
      await this.appendVersion(
        client,
        scope,
        "AI_CANDIDATE",
        "PROPOSAL",
        content,
        body.data.requestId,
        materials,
      );
      await this.recordCommand(
        client,
        scope.workpaper!,
        body.data.requestId,
        "CANDIDATE",
        payloadHash,
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.view(projectId);
  }

  async saveDraft(
    projectId: string,
    input: unknown,
  ): Promise<ValidationWorkpaperView> {
    const body = validationWorkpaperDraftInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的工作底稿草稿");
    return this.writeContent(
      projectId,
      body.data,
      "PMC_DRAFT",
      "EMPLOYEE_WORK",
    );
  }

  async complete(
    projectId: string,
    input: unknown,
  ): Promise<ValidationWorkpaperView> {
    const body = validationWorkpaperCompleteInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的确认完成请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scope = await this.scope(client, projectId, true);
      const payloadHash = this.payloadFingerprint(body.data);
      const existing = await this.commandWasHandled(
        client,
        scope.workpaper,
        body.data.requestId,
        "COMPLETE",
        payloadHash,
      );
      if (existing) {
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.view(projectId);
      }
      this.assertRevision(scope.workpaper, body.data.expectedRevision);
      const materials = await this.validateContentInputs(
        client,
        scope,
        body.data.content,
      );
      if (
        body.data.content.materialFindings.some(
          (item) => item.verificationStatus !== "EMPLOYEE_CHECKED",
        )
      )
        throw new BadRequestException("确认完成前必须由员工逐项核验所引用材料");
      if (
        !body.data.content.materialFindings.some(
          (item) =>
            item.assessment === "SUPPORTS" || item.assessment === "CONTRADICTS",
        )
      )
        throw new BadRequestException(
          "确认结论前至少一项材料必须形成支持或矛盾判断",
        );
      if (isProduction()) {
        const prerequisites = await client.query(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE s.status='DONE' AND s.confirmed_at IS NOT NULL AND s.confirmed_by IS NOT NULL)::int AS completed FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id=s.node_id AND n.tenant_id=s.tenant_id WHERE n.project_id=$1 AND s.tenant_id=$2 AND s.phase_code='ROOT_CAUSE_VALIDATION' AND s.id<>$3",
          [projectId, tenantId, scope.workItemId],
        );
        if (
          Number(prerequisites.rows[0]?.total) !== 2 ||
          Number(prerequisites.rows[0]?.completed) !== 2
        )
          throw new BadRequestException(
            "先完成候选原因与证据链核对，再确认根因结论",
          );
      }
      const expected = scope.acceptance;
      if (
        expected.length !== body.data.confirmedAcceptanceCriteria.length ||
        expected.some(
          (item) => !body.data.confirmedAcceptanceCriteria.includes(item),
        )
      )
        throw new BadRequestException("必须逐项确认本事项全部验收标准");
      const appended = await this.appendVersion(
        client,
        scope,
        "PMC_CONFIRMED",
        "CONFIRMED_OUTPUT",
        body.data.content,
        body.data.requestId,
        materials,
      );
      await client.query(
        "UPDATE vs16_root_cause_workpapers SET status = 'CONFIRMED', latest_confirmed_version_id = $2, updated_at = now() WHERE id = $1 AND tenant_id = $3",
        [scope.workpaper!.id, appended.id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'DONE', completion_note = $3, output_reference = $4, output_source_object_id = $5, output_source_version_id = $6, completion_basis = 'ASSIGNEE_CONFIRMED', confirmed_by = 'PMC', confirmed_at = now(), confirmed_acceptance = $7::jsonb, completed_at = now(), reopen_reason = NULL WHERE id = $1 AND tenant_id = $2",
        [
          scope.workItemId,
          tenantId,
          body.data.completionNote,
          appended.locator.reference,
          appended.locator.sourceObjectId,
          appended.locator.sourceVersionId,
          JSON.stringify(expected),
        ],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'ROOT_CAUSE_VALIDATION' THEN 'APPROVED' WHEN code = 'SOLUTION_APPROVAL' THEN 'OPEN' ELSE gate_status END, returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code IN ('ROOT_CAUSE_VALIDATION', 'SOLUTION_APPROVAL')",
        [projectId, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY' WHERE tenant_id = $1 AND phase_code = 'SOLUTION_APPROVAL' AND owner = 'PMC' AND status = 'LOCKED' AND node_id IN (SELECT id FROM vs01_project_nodes WHERE project_id = $2 AND tenant_id = $1)",
        [tenantId, projectId],
      );
      await this.taskEvent(
        client,
        scope,
        "COMPLETED",
        body.data.completionNote,
        appended.locator,
      );
      await this.recordCommand(
        client,
        scope.workpaper!,
        body.data.requestId,
        "COMPLETE",
        payloadHash,
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.view(projectId);
  }

  async reopen(
    projectId: string,
    input: unknown,
  ): Promise<ValidationWorkpaperView> {
    const body = validationWorkpaperReopenInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的重新打开请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scope = await this.scope(client, projectId, true);
      const payloadHash = this.payloadFingerprint(body.data);
      const existing = await this.commandWasHandled(
        client,
        scope.workpaper,
        body.data.requestId,
        "REOPEN",
        payloadHash,
      );
      if (existing) {
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.view(projectId);
      }
      this.assertRevision(scope.workpaper, body.data.expectedRevision);
      if (
        scope.workpaper!.status !== "CONFIRMED" ||
        scope.workItemStatus !== "DONE"
      )
        throw new BadRequestException("只有已确认的核验事项可以重新打开");
      const downstream = await client.query(
        "SELECT count(*)::int AS count FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id WHERE n.project_id = $1 AND s.tenant_id = $2 AND s.phase_code = 'SOLUTION_APPROVAL' AND s.status IN ('IN_PROGRESS', 'DONE', 'WAITING_REVIEW')",
        [projectId, tenantId],
      );
      const submitted = await client.query(
        "SELECT 1 FROM vs01_projects WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('DRAFT', 'RETURNED')",
        [projectId, tenantId],
      );
      if (Number(downstream.rows[0]?.count ?? 0) > 0 || submitted.rowCount)
        throw new ConflictException({
          code: "DOWNSTREAM_DEPENDENCY",
          message: "解决方案已有进展或已提交，不能直接重新打开根因结论",
        });
      const confirmed = await client.query(
        "SELECT content FROM vs16_root_cause_workpaper_versions WHERE id = $1 AND tenant_id = $2",
        [scope.workpaper!.latest_confirmed_version_id, tenantId],
      );
      if (!confirmed.rowCount)
        throw new NotFoundException("已确认底稿版本不存在");
      const confirmedContent = confirmed.rows[0]
        ?.content as ValidationWorkpaperContent;
      const confirmedMaterials = await this.validateContentInputs(
        client,
        scope,
        confirmedContent,
      );
      await this.appendVersion(
        client,
        scope,
        "PMC_DRAFT",
        "EMPLOYEE_WORK",
        confirmedContent,
        body.data.requestId,
        confirmedMaterials,
      );
      await client.query(
        "UPDATE vs16_root_cause_workpapers SET status = 'DRAFTING', updated_at = now() WHERE id = $1 AND tenant_id = $2",
        [scope.workpaper!.id, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'READY', completion_note = '', output_reference = NULL, output_source_object_id = NULL, output_source_version_id = NULL, completion_basis = NULL, confirmed_by = NULL, confirmed_at = NULL, confirmed_acceptance = NULL, completed_at = NULL, reopen_reason = $3 WHERE id = $1 AND tenant_id = $2",
        [scope.workItemId, tenantId, body.data.reason],
      );
      await client.query(
        "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'ROOT_CAUSE_VALIDATION' THEN 'OPEN' WHEN code = 'SOLUTION_APPROVAL' THEN 'LOCKED' ELSE gate_status END WHERE project_id = $1 AND tenant_id = $2 AND code IN ('ROOT_CAUSE_VALIDATION', 'SOLUTION_APPROVAL')",
        [projectId, tenantId],
      );
      await client.query(
        "UPDATE vs01_project_subtasks SET status = 'LOCKED' WHERE tenant_id = $1 AND phase_code = 'SOLUTION_APPROVAL' AND node_id IN (SELECT id FROM vs01_project_nodes WHERE project_id = $2 AND tenant_id = $1)",
        [tenantId, projectId],
      );
      await this.taskEvent(client, scope, "REOPENED", body.data.reason, null);
      await this.recordCommand(
        client,
        scope.workpaper!,
        body.data.requestId,
        "REOPEN",
        payloadHash,
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.view(projectId);
  }

  private async writeContent(
    projectId: string,
    body: {
      requestId: string;
      expectedRevision: number;
      content: ValidationWorkpaperContent;
    },
    kind: "PMC_DRAFT",
    classification: "EMPLOYEE_WORK",
  ): Promise<ValidationWorkpaperView> {
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const scope = await this.scope(client, projectId, true);
      const payloadHash = this.payloadFingerprint(body);
      const existing = await this.commandWasHandled(
        client,
        scope.workpaper,
        body.requestId,
        "DRAFT",
        payloadHash,
      );
      if (existing) {
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.view(projectId);
      }
      this.assertRevision(scope.workpaper, body.expectedRevision);
      const materials = await this.validateContentInputs(
        client,
        scope,
        body.content,
      );
      await this.appendVersion(
        client,
        scope,
        kind,
        classification,
        body.content,
        body.requestId,
        materials,
      );
      await this.recordCommand(
        client,
        scope.workpaper!,
        body.requestId,
        "DRAFT",
        payloadHash,
      );
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.view(projectId);
  }

  private async scope(client: PoolClient, projectId: string, ensure: boolean) {
    const item = isProduction()
      ? await client.query(
          "SELECT p.id AS project_id,p.source_task_id,s.id AS work_item_id,s.title,s.status AS work_item_status,s.acceptance,phase.gate_status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id=p.id AND n.tenant_id=p.tenant_id JOIN vs01_project_subtasks s ON s.node_id=n.id AND s.tenant_id=p.tenant_id JOIN vs01_project_phases phase ON phase.project_id=p.id AND phase.tenant_id=p.tenant_id AND phase.code=s.phase_code WHERE p.id=$1 AND p.tenant_id=$2 AND s.phase_code='ROOT_CAUSE_VALIDATION' AND s.sort_order=3 AND s.owner='PMC' FOR UPDATE OF p,s",
          [projectId, tenantId],
        )
      : ensure
        ? await client.query(
            "SELECT p.id AS project_id, p.source_task_id, s.id AS work_item_id, s.title, s.status AS work_item_status, s.acceptance FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_project_subtasks s ON s.node_id = n.id WHERE p.id = $1 AND p.tenant_id = $2 AND p.source_task_id = $3 AND s.phase_code = 'ROOT_CAUSE_VALIDATION' AND s.origin = 'LIVE' AND s.owner = 'PMC' FOR UPDATE OF p, s",
            [projectId, tenantId, liveSourceTaskId],
          )
        : await client.query(
            "SELECT p.id AS project_id, p.source_task_id, s.id AS work_item_id, s.title, s.status AS work_item_status, s.acceptance FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id LEFT JOIN vs16_root_cause_workpapers w ON w.project_id = p.id AND w.tenant_id = p.tenant_id WHERE p.id = $1 AND p.tenant_id = $2 AND s.phase_code = 'ROOT_CAUSE_VALIDATION' AND s.owner = 'PMC' AND ((w.id IS NOT NULL AND s.id = w.work_item_id) OR (w.id IS NULL AND p.source_task_id = $3 AND s.origin = 'LIVE')) FOR UPDATE OF p, s",
            [projectId, tenantId, liveSourceTaskId],
          );
    if (item.rowCount !== 1)
      throw new NotFoundException("当前咨询任务没有可用的根因核验工作底稿");
    if (
      isProduction() &&
      ensure &&
      !["OPEN", "APPROVED"].includes(String(item.rows[0]?.gate_status))
    )
      throw new BadRequestException(
        "请先完成项目界定和事实核对，根因阶段尚未解锁",
      );
    let workpaper = await client.query<WorkpaperRow>(
      "SELECT * FROM vs16_root_cause_workpapers WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
      [projectId, tenantId],
    );
    if (!workpaper.rowCount && ensure) {
      const id = `WP-${projectId}`;
      const sourceObjectId = `SRC-WORKPAPER-${projectId}`;
      await client.query(
        "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1, $2, $3)",
        [sourceObjectId, tenantId, "根因核验工作底稿"],
      );
      await client.query(
        "INSERT INTO vs16_root_cause_workpapers (id, tenant_id, project_id, work_item_id, source_object_id, status) VALUES ($1, $2, $3, $4, $5, 'DRAFTING')",
        [id, tenantId, projectId, item.rows[0]?.work_item_id, sourceObjectId],
      );
      workpaper = await client.query<WorkpaperRow>(
        "SELECT * FROM vs16_root_cause_workpapers WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
        [projectId, tenantId],
      );
    }
    return {
      projectId,
      sourceTaskId: String(item.rows[0]?.source_task_id),
      workItemId: String(item.rows[0]?.work_item_id),
      title: String(item.rows[0]?.title),
      workItemStatus: String(item.rows[0]?.work_item_status) as
        "LOCKED" | "READY" | "IN_PROGRESS" | "DONE",
      acceptance: (item.rows[0]?.acceptance ?? []) as string[],
      workpaper: workpaper.rows[0] ?? null,
    };
  }

  private async readView(
    client: PoolClient,
    scope: Awaited<ReturnType<RootCauseWorkpaperService["scope"]>>,
  ): Promise<ValidationWorkpaperView> {
    // A pg client is a single ordered connection: keep these reads serial.
    const facts = await this.facts(client, scope.sourceTaskId);
    const materials = await this.materials(client, scope.sourceTaskId);
    const gaps = await this.materialGaps(client, scope.sourceTaskId);
    const workpaper = scope.workpaper;
    const versions = workpaper
      ? await client.query(
          "SELECT v.*, o.id AS source_object_id FROM vs16_root_cause_workpaper_versions v JOIN vs16_root_cause_workpapers w ON w.id = v.workpaper_id JOIN vs01_source_versions sv ON sv.id = v.source_version_id JOIN vs01_source_objects o ON o.id = sv.source_object_id WHERE v.workpaper_id = $1 AND v.tenant_id = $2 ORDER BY v.revision",
          [workpaper.id, tenantId],
        )
      : { rows: [] as QueryResultRow[] };
    const mapped = versions.rows.map((row) => this.versionView(row));
    const latestConfirmed =
      mapped.filter((item) => item.kind === "PMC_CONFIRMED").at(-1) ?? null;
    const current = mapped.at(-1) ?? null;
    return validationWorkpaperViewSchema.parse({
      id: workpaper?.id ?? `WP-${scope.projectId}`,
      projectId: scope.projectId,
      sourceTaskId: scope.sourceTaskId,
      workItem: {
        id: scope.workItemId,
        title: scope.title,
        status: scope.workItemStatus,
        acceptanceCriteria: scope.acceptance,
      },
      status: workpaper?.status ?? "DRAFTING",
      revision: Number(workpaper?.revision ?? 0),
      current,
      latestConfirmed,
      history: mapped,
      context: {
        facts,
        materials: materials.map((row) => this.materialView(row)),
        materialGaps: gaps,
      },
    });
  }

  private async facts(client: PoolClient, sourceTaskId: string) {
    const result = isProduction()
      ? {
          rowCount: 1,
          rows: [await productionTaskFacts(client, sourceTaskId, tenantId)],
        }
      : await client.query(
          "SELECT o.forecast_date, o.promised_date, b.planned_bom_date, b.actual_bom_date, p.planned_start_date, p.actual_start_date FROM vs01_orders o JOIN vs01_bom b ON b.order_id = o.order_id AND b.tenant_id = o.tenant_id JOIN vs01_purchases p ON p.order_id = o.order_id AND p.tenant_id = o.tenant_id WHERE o.order_id = $1 AND o.tenant_id = $2",
          [sourceTaskId, tenantId],
        );
    if (!result.rowCount) throw new NotFoundException("来源订单事实不存在");
    const row = result.rows[0]!;
    const suffix = sourceTaskId.replace(/^SO-/, "");
    return [
      {
        evidenceId: `E-ORDER-${suffix}`,
        label: "订单预计延期",
        value: `${row.forecast_date} 对比承诺 ${row.promised_date}`,
        classification: "FACT",
        locator: {
          sourceObjectId: isProduction()
            ? sourceLocator(row, "order").sourceObjectId
            : "SRC-ORDERS",
          sourceVersionId: isProduction()
            ? sourceLocator(row, "order").sourceVersionId
            : "SRC-ORDERS-V1",
          reference: "订单交期记录",
        },
      },
      {
        evidenceId: `E-BOM-${suffix}`,
        label: "BOM 完成记录",
        value: `${row.actual_bom_date} 对比计划 ${row.planned_bom_date}`,
        classification: "FACT",
        locator: {
          sourceObjectId: isProduction()
            ? sourceLocator(row, "bom").sourceObjectId
            : "SRC-BOM",
          sourceVersionId: isProduction()
            ? sourceLocator(row, "bom").sourceVersionId
            : "SRC-BOM-V1",
          reference: "BOM 完成记录",
        },
      },
      {
        evidenceId: `E-PURCHASE-${suffix}`,
        label: "采购启动记录",
        value: `${row.actual_start_date} 对比计划 ${row.planned_start_date}`,
        classification: "FACT",
        locator: {
          sourceObjectId: isProduction()
            ? sourceLocator(row, "purchase").sourceObjectId
            : "SRC-PURCHASES",
          sourceVersionId: isProduction()
            ? sourceLocator(row, "purchase").sourceVersionId
            : "SRC-PURCHASES-V1",
          reference: "采购启动记录",
        },
      },
    ] as const;
  }

  private async materials(
    client: PoolClient,
    sourceTaskId: string,
    ids?: string[],
  ): Promise<MaterialRow[]> {
    const params: unknown[] = [sourceTaskId, tenantId];
    const filter = ids?.length ? ` AND m.id = ANY($3::bigint[])` : "";
    if (ids?.length) params.push(ids.map((id) => Number(id)));
    const result = await client.query<MaterialRow>(
      `SELECT m.id::text, m.requirement_id, m.title, m.source_version_id, sv.source_object_id, c.extraction_status, c.readable_by_ai, c.content_preview FROM vs01_task_materials m JOIN vs01_source_versions sv ON sv.id = m.source_version_id AND sv.tenant_id = m.tenant_id JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id WHERE m.task_id = $1 AND m.tenant_id = $2 AND m.status = 'ACTIVE' AND m.kind = 'UPLOADED_FILE' ${filter} ORDER BY m.id`,
      params,
    );
    return result.rows;
  }

  private async materialGaps(client: PoolClient, sourceTaskId: string) {
    const active = await this.materials(client, sourceTaskId);
    const activeRequirements = new Set(active.map((row) => row.requirement_id));
    return activeRequirements.has("REQ-CAPACITY-LOAD")
      ? []
      : [
          {
            requirementId: "REQ-CAPACITY-LOAD",
            requirement: "产能负荷与工时记录",
          },
        ];
  }

  private materialView(row: MaterialRow) {
    return {
      materialId: row.id,
      requirementId: row.requirement_id,
      title: row.title,
      classification: "UNVERIFIED_INPUT",
      extractionStatus: row.extraction_status,
      readableByAi: Boolean(row.readable_by_ai),
      contentPreview: row.content_preview,
      locator: {
        sourceObjectId: row.source_object_id,
        sourceVersionId: row.source_version_id,
        reference: `${row.title} · v1`,
      },
    } as const;
  }

  private candidateContent(
    scope: Awaited<ReturnType<RootCauseWorkpaperService["scope"]>>,
    materials: MaterialRow[],
  ): ValidationWorkpaperContent {
    const materialSummary = materials
      .map(
        (material) =>
          material.content_preview?.slice(0, 180) ||
          "材料已入库，需人工查看原件",
      )
      .join("；");
    return {
      problemStatement:
        "订单交期异常是否同时受到产能负荷风险影响，需要基于当前材料核验。",
      factFindings: [
        {
          evidenceId: `E-ORDER-${scope.sourceTaskId.replace(/^SO-/, "")}`,
          assertion: "订单预测交期晚于承诺交期，属于已记录事实。",
        },
        {
          evidenceId: `E-BOM-${scope.sourceTaskId.replace(/^SO-/, "")}`,
          assertion: isProduction()
            ? "请核对上下文中 BOM 计划日期与实际日期，本候选未确认是否构成延期原因。"
            : "BOM 完成时间与计划存在滞后，属于已记录事实。",
        },
      ],
      materialFindings: materials.map((material) => ({
        materialId: material.id,
        assertion: materialSummary || "材料等待人工核验",
        assessment: "INCONCLUSIVE",
        verificationStatus: "UNVERIFIED_INPUT",
        note: "DEMO_RULES 候选：材料是待核验输入，不能自动作为事实。",
      })),
      hypotheses: [
        "产能负荷可能放大了订单延期风险，需要员工结合原始记录核验。",
      ],
      conclusion: {
        result: "INSUFFICIENT_INFORMATION",
        statement:
          "DEMO_RULES 候选：当前材料只能提出待核验假设，不能替代员工结论。",
        limitations: "候选未读取原始附件以外的系统数据，且材料尚未由员工核验。",
        nextChecks: ["核对材料中的产线负荷、工时与订单排期是否同口径。"],
      },
    };
  }

  private async validateContentInputs(
    client: PoolClient,
    scope: Awaited<ReturnType<RootCauseWorkpaperService["scope"]>>,
    content: ValidationWorkpaperContent,
  ) {
    const factIds = new Set<string>(
      (await this.facts(client, scope.sourceTaskId)).map(
        (fact) => fact.evidenceId,
      ),
    );
    if (
      content.factFindings.some((finding) => !factIds.has(finding.evidenceId))
    )
      throw new BadRequestException("工作底稿包含不属于当前任务的事实证据");
    const materialIds = content.materialFindings.map(
      (finding) => finding.materialId,
    );
    const materials = await this.materials(
      client,
      scope.sourceTaskId,
      materialIds,
    );
    if (materials.length !== materialIds.length)
      throw new BadRequestException("工作底稿包含无效、已停用或跨任务材料");
    if (content.conclusion.result === "INSUFFICIENT_INFORMATION")
      return materials;
    return materials;
  }

  private async appendVersion(
    client: PoolClient,
    scope: Awaited<ReturnType<RootCauseWorkpaperService["scope"]>>,
    kind: "AI_CANDIDATE" | "PMC_DRAFT" | "PMC_CONFIRMED",
    classification: "PROPOSAL" | "EMPLOYEE_WORK" | "CONFIRMED_OUTPUT",
    content: ValidationWorkpaperContent,
    requestId: string,
    materials: MaterialRow[],
  ) {
    const workpaper = scope.workpaper!;
    const revision = Number(workpaper.revision) + 1;
    const sourceVersionId = `SRC-WORKPAPER-VERSION-${randomUUID()}`;
    const reference = `根因核验工作底稿 v${revision}`;
    await client.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, $4)",
      [sourceVersionId, workpaper.source_object_id, tenantId, revision],
    );
    const inserted = await client.query(
      "INSERT INTO vs16_root_cause_workpaper_versions (tenant_id, workpaper_id, revision, kind, classification, content, content_hash, source_version_id, based_on_revision, requested_by, request_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'PMC',$10) RETURNING id, created_at",
      [
        tenantId,
        workpaper.id,
        revision,
        kind,
        classification,
        JSON.stringify(content),
        createHash("sha256").update(JSON.stringify(content)).digest("hex"),
        sourceVersionId,
        workpaper.revision === 0 ? null : workpaper.revision,
        requestId,
      ],
    );
    const facts = await this.facts(client, scope.sourceTaskId);
    const factById = new Map<string, (typeof facts)[number]>(
      facts.map((fact) => [fact.evidenceId, fact]),
    );
    for (const finding of content.factFindings) {
      const fact = factById.get(finding.evidenceId)!;
      await client.query(
        "INSERT INTO vs16_root_cause_workpaper_evidence (tenant_id, version_id, evidence_id, source_version_id, kind) VALUES ($1,$2,$3,$4,'FACT')",
        [
          tenantId,
          inserted.rows[0]?.id,
          finding.evidenceId,
          fact.locator.sourceVersionId,
        ],
      );
    }
    for (const material of materials)
      await client.query(
        "INSERT INTO vs16_root_cause_workpaper_evidence (tenant_id, version_id, evidence_id, source_version_id, kind) VALUES ($1,$2,$3,$4,'MATERIAL')",
        [
          tenantId,
          inserted.rows[0]?.id,
          `MATERIAL-${material.id}`,
          material.source_version_id,
        ],
      );
    await client.query(
      "UPDATE vs16_root_cause_workpapers SET revision = $2, updated_at = now() WHERE id = $1 AND tenant_id = $3",
      [workpaper.id, revision, tenantId],
    );
    return {
      id: Number(inserted.rows[0]?.id),
      locator: {
        sourceObjectId: workpaper.source_object_id,
        sourceVersionId,
        reference,
      },
    };
  }

  private versionView(row: QueryResultRow): ValidationWorkpaperVersion {
    return {
      revision: Number(row.revision),
      kind: row.kind,
      classification: row.classification,
      content: row.content,
      locator: {
        sourceObjectId: row.source_object_id,
        sourceVersionId: row.source_version_id,
        reference: `根因核验工作底稿 v${row.revision}`,
      },
      basedOnRevision:
        row.based_on_revision === null ? null : Number(row.based_on_revision),
      requestedBy: "PMC",
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.kind === "PMC_PROPOSAL"
        ? {
            requestId: row.request_id,
            createdBy: row.created_by_subject,
            proposalContext: row.proposal_context,
            audit: {
              requestId: row.request_id,
              eventType: "WORKPAPER_PROPOSED" as const,
            },
          }
        : {}),
    };
  }

  private assertRevision(
    workpaper: WorkpaperRow | null,
    expectedRevision: number,
  ) {
    if (Number(workpaper?.revision ?? 0) !== expectedRevision)
      throw new ConflictException({
        code: "STALE_WORKPAPER",
        message: "工作底稿已被更新，请刷新后重试",
      });
  }

  private async commandWasHandled(
    client: PoolClient,
    workpaper: WorkpaperRow | null,
    requestId: string,
    command: "CANDIDATE" | "DRAFT" | "COMPLETE" | "REOPEN",
    payloadHash: string,
  ) {
    if (!workpaper) return false;
    const result = await client.query(
      "SELECT command, payload_hash FROM vs16_root_cause_workpaper_commands WHERE workpaper_id = $1 AND tenant_id = $2 AND request_id = $3",
      [workpaper.id, tenantId, requestId],
    );
    if (!result.rowCount) return false;
    if (
      result.rows[0]?.command !== command ||
      (result.rows[0]?.payload_hash !== null &&
        result.rows[0]?.payload_hash !== payloadHash)
    )
      throw new ConflictException({
        code: "REQUEST_ID_REUSED",
        message: "相同请求编号不能对应不同工作底稿内容",
      });
    return true;
  }

  private recordCommand(
    client: PoolClient,
    workpaper: WorkpaperRow,
    requestId: string,
    command: "CANDIDATE" | "DRAFT" | "COMPLETE" | "REOPEN",
    payloadHash: string,
  ) {
    return client.query(
      "INSERT INTO vs16_root_cause_workpaper_commands (tenant_id, workpaper_id, request_id, command, payload_hash) VALUES ($1,$2,$3,$4,$5)",
      [tenantId, workpaper.id, requestId, command, payloadHash],
    );
  }

  private payloadFingerprint(payload: unknown) {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalize(nested)]),
        );
      return value;
    };
    return createHash("sha256")
      .update(JSON.stringify(canonicalize(payload)))
      .digest("hex");
  }

  private async taskEvent(
    client: PoolClient,
    scope: Awaited<ReturnType<RootCauseWorkpaperService["scope"]>>,
    eventType: "COMPLETED" | "REOPENED",
    note: string,
    locator: {
      sourceObjectId: string;
      sourceVersionId: string;
      reference: string;
    } | null,
  ) {
    await client.query(
      "INSERT INTO vs01_project_subtask_events (tenant_id, subtask_id, event_type, note, actor) VALUES ($1,$2,$3,$4,'PMC')",
      [tenantId, scope.workItemId, eventType, note],
    );
    await client.query(
      "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1,$2,$3,'ROOT_CAUSE_VALIDATION',$4,'PMC',$5::jsonb)",
      [
        tenantId,
        scope.projectId,
        eventType === "COMPLETED" ? "TASK_COMPLETED" : "TASK_REOPENED",
        note,
        JSON.stringify({
          workpaperLocator: locator,
          workItemId: scope.workItemId,
        }),
      ],
    );
  }
}
