import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  taskMaterialImportFieldsSchema,
  taskMaterialInputSchema,
  taskMaterialWithdrawInputSchema,
  type TaskMaterial,
} from "@dingjiang/contracts";
import type {
  MaterialContentStore,
  UploadedMaterialFile,
} from "./content-vault";
import { validateMaterialFile } from "./content-vault";
import { materialProjection, requirementFor } from "./material-projection";

/**
 * The material subdomain: registering a reference, importing an uploaded file,
 * withdrawing one, and reading the file back.
 *
 * It shares the domain service's transaction seam. A bound instance runs
 * inside the command kernel's transaction and therefore never commits,
 * rolls back or releases its caller's client; a standalone instance opens
 * and closes its own. The three-way discipline is the point: dropping the
 * `commandTransaction` branch would double-commit inside the kernel.
 */
export class MaterialService {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private readonly tenantId: string;
  private readonly vault: MaterialContentStore;

  constructor(
    pool: Pool,
    vault: MaterialContentStore,
    tenantId: string,
    commandTransaction?: PoolClient,
  ) {
    this.pool = pool;
    this.vault = vault;
    this.tenantId = tenantId;
    this.commandTransaction = commandTransaction;
  }

  private get database() {
    return this.commandTransaction ?? this.pool;
  }

  async addTaskMaterial(id: string, input: unknown): Promise<void> {
    const body = taskMaterialInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的材料登记");
    const task = await this.database.query(
      "SELECT 1 FROM vs01_tasks WHERE id = $1 AND tenant_id = $2",
      [id, this.tenantId],
    );
    if (task.rowCount === 0) throw new NotFoundException("任务不存在");
    await this.database.query(
      "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, title, source_reference, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'PMC')",
      [
        this.tenantId,
        id,
        body.data.situationCode,
        body.data.title,
        body.data.sourceReference,
        body.data.note,
      ],
    );
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
      [id, this.tenantId],
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
        [`${this.tenantId}:${id}:${body.data.requestId}`],
      );
      const existing = await client.query(
        "SELECT m.id, c.sha256 FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id WHERE m.tenant_id = $1 AND m.task_id = $2 AND m.request_id = $3 FOR UPDATE OF m",
        [this.tenantId, id, body.data.requestId],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.sha256 !== validated.sha256)
          throw new ConflictException("相同请求编号不能对应不同材料内容");
        if (!this.commandTransaction) await client.query("COMMIT");
        return this.materialById(id, String(existing.rows[0]?.id));
      }
      const allowedRequirement = requirementFor(
        body.data.situationCode,
        body.data.requirementId,
      );
      if (!allowedRequirement)
        throw new BadRequestException("材料需求与当前情境不匹配");
      const staged = await this.vault.stage(validated.bytes);
      temporaryKey = staged.temporaryKey;
      const suffix = randomUUID();
      const sourceObjectId = `SRC-MATERIAL-${suffix}`;
      const sourceVersionId = `SRC-MATERIAL-VERSION-${suffix}`;
      await client.query(
        "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1, $2, $3)",
        [sourceObjectId, this.tenantId, validated.originalName],
      );
      await client.query(
        "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, 1)",
        [sourceVersionId, sourceObjectId, this.tenantId],
      );
      const inserted = await client.query(
        "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, requirement_id, title, source_reference, note, kind, status, source_object_id, source_version_id, request_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'UPLOADED_FILE', 'ACTIVE', $8, $9, $10, 'PMC') RETURNING id",
        [
          this.tenantId,
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
          this.tenantId,
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
          this.tenantId,
          materialId,
          JSON.stringify({
            requirementId: body.data.requirementId,
            sourceObjectId,
            sourceVersionId,
            sha256: validated.sha256,
          }),
        ],
      );
      await this.vault.finalize(staged.temporaryKey, staged.storageKey);
      temporaryKey = null;
      finalizedKey = staged.storageKey;
      if (!this.commandTransaction) await client.query("COMMIT");
      committed = true;
      return this.materialById(id, materialId);
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      if (!committed && temporaryKey)
        await this.vault.discard(temporaryKey).catch(() => undefined);
      if (!committed && finalizedKey)
        await this.vault.discard(finalizedKey).catch(() => undefined);
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
        [materialId, id, this.tenantId],
      );
      if (!current.rowCount) throw new NotFoundException("材料不存在");
      if (current.rows[0]?.status !== "ACTIVE")
        throw new BadRequestException("材料当前不能再次停用");
      await client.query(
        "UPDATE vs01_task_materials SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = $4 WHERE id = $1 AND task_id = $2 AND tenant_id = $3",
        [materialId, id, this.tenantId, body.data.reason],
      );
      await client.query(
        "INSERT INTO vs15_material_events (tenant_id, material_id, event_type, actor, reason, snapshot) VALUES ($1, $2, 'WITHDRAWN', 'PMC', $3, $4::jsonb)",
        [
          this.tenantId,
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
      [materialId, id, this.tenantId],
    );
    if (!material.rowCount) throw new NotFoundException("文件材料不存在");
    const row = material.rows[0] as QueryResultRow;
    try {
      return {
        stream: await this.vault.open(String(row.storage_key)),
        mediaType: String(row.media_type),
        originalName: String(row.original_name),
      };
    } catch {
      throw new ServiceUnavailableException(
        "材料文件暂时不可读取，请稍后重试或重新上传",
      );
    }
  }

  private async materialById(
    taskId: string,
    materialId: string,
  ): Promise<TaskMaterial> {
    const result = await this.database.query(
      "SELECT m.id, m.situation_code, m.requirement_id, m.title, m.source_reference, m.note, m.kind, m.status, m.source_object_id, m.source_version_id, m.withdrawn_at, m.withdrawn_reason, m.created_by, m.created_at, c.original_name, c.media_type, c.byte_size, c.sha256, c.extraction_status, c.content_preview, c.readable_by_ai, (g.material_id IS NOT NULL) AS verification_eligible, v.verification_status, v.verification_version, v.verified_by, v.verification_note, v.verified_at FROM vs01_task_materials m LEFT JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id LEFT JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id LEFT JOIN LATERAL (SELECT e.event_type AS verification_status, e.verification_version, e.actor_subject_id AS verified_by, e.reason AS verification_note, e.created_at AS verified_at FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE m.id = $1 AND m.task_id = $2 AND m.tenant_id = $3",
      [materialId, taskId, this.tenantId],
    );
    if (!result.rowCount) throw new NotFoundException("材料不存在");
    return materialProjection(result.rows[0] as QueryResultRow);
  }
}
