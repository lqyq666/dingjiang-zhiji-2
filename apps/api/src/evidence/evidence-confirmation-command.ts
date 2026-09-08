import { randomUUID } from "node:crypto";

import {
  evidenceConfirmationPayloadSchema,
  evidenceConfirmationRequestSchema,
  evidenceConfirmationResultSchema,
  type EvidenceConfirmationPayload,
  type GovernedCommandRequest,
  type GovernedPrincipal,
} from "@dingjiang/contracts";

import {
  GovernedCommandFailure,
  type GovernedCommandDefinition,
  type GovernedCommandKernel,
  type GovernedCommandTransaction,
} from "../command-kernel/governed-command-kernel";

export class EvidenceConfirmationCommand {
  constructor(private readonly kernel: GovernedCommandKernel) {}

  async execute(
    principal: GovernedPrincipal,
    projectId: string,
    input: unknown,
  ) {
    const parsed = evidenceConfirmationRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "evidence.confirm 请求不符合 contract",
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
    return evidenceConfirmationResultSchema.parse(result);
  }

  private definition(): GovernedCommandDefinition<EvidenceConfirmationPayload> {
    return {
      name: "evidence.confirm",
      requiredScope: "evidence:confirm",
      allowedRoles: ["PMC"],
      parsePayload: (payload) =>
        evidenceConfirmationPayloadSchema.parse(payload),
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
    payload: EvidenceConfirmationPayload,
  ) {
    const proposal = await transaction.query(
      "SELECT p.*, m.title AS material_title FROM vs32_evidence_proposals p JOIN vs01_task_materials m ON m.id = p.material_id AND m.tenant_id = p.tenant_id WHERE p.id = $1 AND p.tenant_id = $2 AND p.project_id = $3 FOR UPDATE OF p",
      [payload.proposalId, principal.tenantId, projectId],
    );
    const row = proposal.rows[0];
    if (!row)
      throw new GovernedCommandFailure(
        "PERMISSION_DENIED",
        "Evidence Proposal 不在授权项目范围内",
        request.correlationId,
      );
    const existing = await transaction.query(
      "SELECT decision, confirmation_version FROM vs32_evidence_confirmations WHERE tenant_id = $1 AND proposal_id = $2",
      [principal.tenantId, payload.proposalId],
    );
    const currentVersion = existing.rowCount ? 1 : 0;
    if (request.expectedVersion !== currentVersion)
      throw new GovernedCommandFailure(
        "STALE_VERSION",
        "Evidence Proposal 人工审核版本已变化",
        request.correlationId,
      );
    if (currentVersion !== 0)
      throw new GovernedCommandFailure(
        "CONFLICT",
        "Evidence Proposal 已完成人工审核，历史不可覆盖",
        request.correlationId,
      );

    const confirmationId = `EVC-${randomUUID()}`;
    const evidenceId =
      payload.decision === "CONFIRMED" ? `E-MATERIAL-${randomUUID()}` : null;
    const inserted = await transaction.query(
      "INSERT INTO vs32_evidence_confirmations (id, tenant_id, proposal_id, decision, confirmation_version, reviewed_by, review_note) VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING created_at",
      [
        confirmationId,
        principal.tenantId,
        payload.proposalId,
        payload.decision,
        principal.subjectId,
        payload.reviewNote,
      ],
    );
    if (evidenceId)
      await transaction.query(
        "INSERT INTO vs32_formal_evidence (id, tenant_id, project_id, source_task_id, work_item_id, proposal_id, source_object_id, source_version_id, claim, evidence_type, span_start, span_end, exact_text, limitations, confirmed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [
          evidenceId,
          principal.tenantId,
          projectId,
          String(row.source_task_id),
          String(row.work_item_id),
          payload.proposalId,
          String(row.source_object_id),
          String(row.source_version_id),
          String(row.claim),
          String(row.evidence_type),
          Number(row.span_start),
          Number(row.span_end),
          String(row.exact_text),
          String(row.limitations),
          principal.subjectId,
        ],
      );
    const reviewedAt = new Date(
      inserted.rows[0]?.created_at as string | Date,
    ).toISOString();
    const eventType =
      payload.decision === "CONFIRMED"
        ? ("EVIDENCE_CONFIRMED" as const)
        : ("EVIDENCE_REJECTED" as const);
    const data = {
      proposalId: payload.proposalId,
      evidenceId,
      projectId,
      decision: payload.decision,
      version: 1,
      reviewedBy: principal.subjectId,
      reviewedAt,
      audit: { requestId: request.requestId, eventType },
    };
    return {
      version: 1,
      data,
      audit: {
        eventType,
        details: {
          proposalId: payload.proposalId,
          evidenceId,
          sourceVersionId: String(row.source_version_id),
          decision: payload.decision,
          confirmationVersion: 1,
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
