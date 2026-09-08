import { randomUUID } from "node:crypto";

import {
  materialCreatePayloadSchema,
  materialCreateRequestSchema,
  materialCreateResultSchema,
  type GovernedCommandRequest,
  type GovernedPrincipal,
  type MaterialCreatePayload,
} from "@dingjiang/contracts";

import {
  GovernedCommandFailure,
  type GovernedCommandDefinition,
  type GovernedCommandKernel,
  type GovernedCommandTransaction,
} from "../command-kernel/governed-command-kernel";

const requirementBySituation = {
  BOM_DELAY: "REQ-BOM-CHANGE",
  PURCHASE_DELAY: "REQ-PURCHASE-CONFIRM",
  CAPACITY_RISK: "REQ-CAPACITY-LOAD",
} as const;

export class MaterialCreateCommand {
  constructor(private readonly kernel: GovernedCommandKernel) {}

  async execute(
    principal: GovernedPrincipal,
    projectId: string,
    input: unknown,
  ) {
    const parsed = materialCreateRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "material.create 请求不符合 contract",
        this.correlationId(input),
      );
    const result = await this.kernel.execute(
      {
        request: parsed.data,
        principal,
        target: { tenantId: principal.tenantId, projectId },
      },
      this.definition(),
    );
    return materialCreateResultSchema.parse(result);
  }

  private definition(): GovernedCommandDefinition<MaterialCreatePayload> {
    return {
      name: "material.create",
      requiredScope: "material:write",
      allowedRoles: ["PMC"],
      parsePayload: (payload) => materialCreatePayloadSchema.parse(payload),
      handler: (transaction, context) =>
        this.write(
          transaction,
          context.principal,
          context.target.projectId,
          context.request,
          context.payload,
        ),
    };
  }

  private async write(
    transaction: GovernedCommandTransaction,
    principal: GovernedPrincipal,
    projectId: string,
    request: GovernedCommandRequest,
    payload: MaterialCreatePayload,
  ) {
    const scope = await transaction.query(
      "SELECT p.source_task_id, s.id AS work_item_id FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 AND p.tenant_id = $2 AND s.id = $3 FOR UPDATE OF p, s",
      [projectId, principal.tenantId, payload.workItemId],
    );
    const scoped = scope.rows[0];
    if (!scoped)
      throw new GovernedCommandFailure(
        "PERMISSION_DENIED",
        "事项不在授权项目范围内",
        request.correlationId,
      );
    if (requirementBySituation[payload.situationCode] !== payload.requirementId)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "材料需求不属于指定业务情境",
        request.correlationId,
      );

    const existing = await transaction.query(
      "SELECT id FROM vs01_task_materials WHERE tenant_id = $1 AND task_id = $2 AND situation_code = $3 AND requirement_id = $4 AND status = 'ACTIVE' FOR UPDATE",
      [
        principal.tenantId,
        String(scoped.source_task_id),
        payload.situationCode,
        payload.requirementId,
      ],
    );
    const currentVersion = existing.rowCount ? 1 : 0;
    if (request.expectedVersion !== currentVersion)
      throw new GovernedCommandFailure(
        "STALE_VERSION",
        "材料需求版本已变化",
        request.correlationId,
      );
    if (currentVersion !== 0)
      throw new GovernedCommandFailure(
        "CONFLICT",
        "该材料需求已有待核验材料",
        request.correlationId,
      );

    const sourceObjectId = `SRC-MATERIAL-${randomUUID()}`;
    const sourceVersionId = `${sourceObjectId}-V1`;
    await transaction.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1,$2,$3)",
      [sourceObjectId, principal.tenantId, payload.displayName],
    );
    await transaction.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1,$2,$3,1)",
      [sourceVersionId, sourceObjectId, principal.tenantId],
    );
    const inserted = await transaction.query(
      "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, requirement_id, title, source_reference, note, created_by, kind, status, source_object_id, source_version_id, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'PMC','MANUAL_REFERENCE','ACTIVE',$8,$9,$10) RETURNING id, created_at",
      [
        principal.tenantId,
        String(scoped.source_task_id),
        payload.situationCode,
        payload.requirementId,
        payload.displayName,
        payload.sourceMetadata.sourceReference ??
          payload.sourceMetadata.sourceName,
        payload.safeSummary,
        sourceObjectId,
        sourceVersionId,
        request.requestId,
      ],
    );
    const materialId = String(inserted.rows[0]?.id);
    await transaction.query(
      "INSERT INTO vs15_governed_material_versions (source_version_id, tenant_id, material_id, project_id, work_item_id, requirement_id, material_type, source_metadata, safe_summary, controlled_text_content, created_by_subject) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)",
      [
        sourceVersionId,
        principal.tenantId,
        materialId,
        projectId,
        payload.workItemId,
        payload.requirementId,
        payload.materialType,
        JSON.stringify(payload.sourceMetadata),
        payload.safeSummary,
        payload.controlledTextContent ?? null,
        principal.subjectId,
      ],
    );
    await transaction.query(
      "INSERT INTO vs15_material_events (tenant_id, material_id, event_type, actor, reason, snapshot) VALUES ($1,$2,'REGISTERED','PMC',$3,$4::jsonb)",
      [
        principal.tenantId,
        materialId,
        request.reason,
        JSON.stringify({
          projectId,
          workItemId: payload.workItemId,
          requirementId: payload.requirementId,
          sourceVersionId,
          verificationStatus: "UNVERIFIED",
        }),
      ],
    );
    const createdAt = new Date(
      inserted.rows[0]?.created_at as string | Date,
    ).toISOString();
    const data = {
      materialId,
      projectId,
      workItemId: payload.workItemId,
      requirementId: payload.requirementId,
      status: "ACTIVE" as const,
      verificationStatus: "UNVERIFIED" as const,
      version: 1,
      locator: {
        sourceObjectId,
        sourceVersionId,
        reference: `${payload.displayName} · v1`,
      },
      createdBy: principal.subjectId,
      createdAt,
      audit: {
        requestId: request.requestId,
        eventType: "MATERIAL_CREATED" as const,
      },
    };
    return {
      version: 1,
      data,
      audit: {
        eventType: "MATERIAL_CREATED",
        details: {
          materialId,
          workItemId: payload.workItemId,
          requirementId: payload.requirementId,
          sourceVersionId,
          verificationStatus: "UNVERIFIED",
        },
      },
    };
  }

  private correlationId(input: unknown): string {
    if (
      input &&
      typeof input === "object" &&
      "correlationId" in input &&
      typeof input.correlationId === "string"
    )
      return input.correlationId;
    return randomUUID();
  }
}
