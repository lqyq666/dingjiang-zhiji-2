import { randomUUID } from "node:crypto";

import {
  materialVerificationPayloadSchema,
  materialVerificationRequestSchema,
  materialVerificationResultSchema,
  type GovernedCommandRequest,
  type GovernedPrincipal,
  type MaterialVerificationPayload,
} from "@dingjiang/contracts";

import {
  GovernedCommandFailure,
  type GovernedCommandDefinition,
  type GovernedCommandKernel,
  type GovernedCommandTransaction,
} from "../command-kernel/governed-command-kernel";

export class MaterialVerificationCommand {
  constructor(private readonly kernel: GovernedCommandKernel) {}

  async execute(
    principal: GovernedPrincipal,
    projectId: string,
    input: unknown,
  ) {
    const parsed = materialVerificationRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "material.verify 请求不符合 contract",
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
    return materialVerificationResultSchema.parse(result);
  }

  private definition(): GovernedCommandDefinition<MaterialVerificationPayload> {
    return {
      name: "material.verify",
      requiredScope: "material:verify",
      allowedRoles: ["PMC"],
      parsePayload: (payload) =>
        materialVerificationPayloadSchema.parse(payload),
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
    payload: MaterialVerificationPayload,
  ) {
    const material = await transaction.query(
      "SELECT m.id, m.status, m.title, m.source_object_id, m.source_version_id, g.work_item_id FROM vs01_task_materials m JOIN vs15_governed_material_versions g ON g.material_id = m.id AND g.tenant_id = m.tenant_id WHERE m.id = $1 AND m.tenant_id = $2 AND g.project_id = $3 FOR UPDATE OF m",
      [payload.materialId, principal.tenantId, projectId],
    );
    const row = material.rows[0];
    if (!row || !row.source_object_id || !row.source_version_id)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "材料不存在或不在可核验项目范围内",
        request.correlationId,
      );
    if (row.status !== "ACTIVE")
      throw new GovernedCommandFailure(
        "CONFLICT",
        "停用材料不能核验",
        request.correlationId,
      );

    const latest = await transaction.query(
      "SELECT event_type, verification_version FROM vs15_material_events WHERE tenant_id = $1 AND material_id = $2 AND verification_version IS NOT NULL ORDER BY verification_version DESC LIMIT 1",
      [principal.tenantId, payload.materialId],
    );
    const previous = latest.rows[0];
    const currentVersion = previous ? Number(previous.verification_version) : 0;
    if (request.expectedVersion !== currentVersion)
      throw new GovernedCommandFailure(
        "STALE_VERSION",
        "材料核验版本已变化",
        request.correlationId,
      );
    if (previous?.event_type === payload.decision)
      throw new GovernedCommandFailure(
        "CONFLICT",
        "材料当前已是相同核验状态",
        request.correlationId,
      );

    const version = currentVersion + 1;
    const inserted = await transaction.query(
      "INSERT INTO vs15_material_events (tenant_id, material_id, event_type, actor, actor_subject_id, reason, verification_version, snapshot) VALUES ($1,$2,$3,'PMC',$4,$5,$6,$7::jsonb) RETURNING created_at",
      [
        principal.tenantId,
        payload.materialId,
        payload.decision,
        principal.subjectId,
        payload.verificationNote,
        version,
        JSON.stringify({
          projectId,
          workItemId: String(row.work_item_id),
          sourceObjectId: String(row.source_object_id),
          sourceVersionId: String(row.source_version_id),
          previousStatus: previous?.event_type ?? "UNVERIFIED",
          verificationStatus: payload.decision,
        }),
      ],
    );
    const verifiedAt = new Date(
      inserted.rows[0]?.created_at as string | Date,
    ).toISOString();
    const eventType =
      payload.decision === "VERIFIED"
        ? ("MATERIAL_VERIFIED" as const)
        : ("MATERIAL_REVISION_REQUESTED" as const);
    const data = {
      materialId: payload.materialId,
      projectId,
      workItemId: String(row.work_item_id),
      verification: {
        status: payload.decision,
        version,
        note: payload.verificationNote,
        verifiedBy: principal.subjectId,
        verifiedAt,
      },
      locator: {
        sourceObjectId: String(row.source_object_id),
        sourceVersionId: String(row.source_version_id),
        reference: `${String(row.title)} · v1`,
      },
      audit: { requestId: request.requestId, eventType },
    };
    return {
      version,
      data,
      audit: {
        eventType,
        details: {
          materialId: payload.materialId,
          workItemId: String(row.work_item_id),
          sourceVersionId: String(row.source_version_id),
          verificationStatus: payload.decision,
          verificationVersion: version,
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
