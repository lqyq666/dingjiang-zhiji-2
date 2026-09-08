import { randomUUID } from "node:crypto";

import {
  evidenceProposalPayloadSchema,
  evidenceProposeRequestSchema,
  evidenceProposeResultSchema,
  type EvidenceProposalPayload,
  type GovernedCommandRequest,
  type GovernedPrincipal,
} from "@dingjiang/contracts";

import {
  GovernedCommandFailure,
  type GovernedCommandDefinition,
  type GovernedCommandKernel,
  type GovernedCommandTransaction,
} from "../command-kernel/governed-command-kernel";

export class EvidenceProposalCommand {
  constructor(private readonly kernel: GovernedCommandKernel) {}

  async execute(
    principal: GovernedPrincipal,
    projectId: string,
    input: unknown,
  ) {
    const parsed = evidenceProposeRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "evidence.propose 请求不符合 contract",
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
    return evidenceProposeResultSchema.parse(result);
  }

  private definition(): GovernedCommandDefinition<EvidenceProposalPayload> {
    return {
      name: "evidence.propose",
      requiredScope: "evidence:write",
      allowedRoles: ["PMC"],
      parsePayload: (payload) => evidenceProposalPayloadSchema.parse(payload),
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
    payload: EvidenceProposalPayload,
  ) {
    const scoped = await transaction.query(
      "SELECT p.source_task_id, s.id AS work_item_id, m.id AS material_id, m.status AS material_status, m.title, m.source_object_id, m.source_version_id, g.controlled_text_content, v.event_type AS verification_status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id JOIN vs15_governed_material_versions g ON g.project_id = p.id AND g.work_item_id = s.id AND g.tenant_id = p.tenant_id JOIN vs01_task_materials m ON m.id = g.material_id AND m.tenant_id = p.tenant_id LEFT JOIN LATERAL (SELECT e.event_type FROM vs15_material_events e WHERE e.tenant_id = m.tenant_id AND e.material_id = m.id AND e.verification_version IS NOT NULL ORDER BY e.verification_version DESC LIMIT 1) v ON true WHERE p.id = $1 AND p.tenant_id = $2 AND s.id = $3 AND m.id = $4 FOR UPDATE OF p, s, m",
      [projectId, principal.tenantId, payload.workItemId, payload.materialId],
    );
    const row = scoped.rows[0];
    if (!row)
      throw new GovernedCommandFailure(
        "PERMISSION_DENIED",
        "Material 或事项不在授权项目范围内",
        request.correlationId,
      );
    if (
      row.source_object_id !== payload.sourceObjectId ||
      row.source_version_id !== payload.sourceVersionId
    )
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "Proposal 来源定位与 Material 当前不可覆盖版本不一致",
        request.correlationId,
      );
    if (row.material_status !== "ACTIVE")
      throw new GovernedCommandFailure(
        "CONFLICT",
        "停用 Material 不能生成 Evidence Proposal",
        request.correlationId,
      );
    if (row.verification_status !== "VERIFIED")
      throw new GovernedCommandFailure(
        "CONFLICT",
        "只有 VERIFIED Material 可以生成 Evidence Proposal",
        request.correlationId,
      );
    const sourceText =
      typeof row.controlled_text_content === "string"
        ? row.controlled_text_content
        : null;
    if (!sourceText)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "首版 Evidence Proposal 仅支持可校验的受控文本 Material",
        request.correlationId,
      );
    const span = payload.exactSpan;
    if (
      span.end > sourceText.length ||
      sourceText.slice(span.start, span.end) !== span.exactText
    )
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "exact span 与不可覆盖 SourceVersion 内容不匹配",
        request.correlationId,
      );

    const latest = await transaction.query(
      "SELECT proposal_version FROM vs32_evidence_proposals WHERE tenant_id = $1 AND source_version_id = $2 ORDER BY proposal_version DESC LIMIT 1",
      [principal.tenantId, payload.sourceVersionId],
    );
    const currentVersion = latest.rows[0]
      ? Number(latest.rows[0].proposal_version)
      : 0;
    if (request.expectedVersion !== currentVersion)
      throw new GovernedCommandFailure(
        "STALE_VERSION",
        "Evidence Proposal 来源版本流已变化",
        request.correlationId,
      );

    const proposalId = `EVP-${randomUUID()}`;
    const version = currentVersion + 1;
    const inserted = await transaction.query(
      "INSERT INTO vs32_evidence_proposals (id, tenant_id, project_id, source_task_id, work_item_id, material_id, source_object_id, source_version_id, proposal_version, claim, evidence_type, span_start, span_end, exact_text, reasoning, limitations, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING created_at",
      [
        proposalId,
        principal.tenantId,
        projectId,
        String(row.source_task_id),
        payload.workItemId,
        payload.materialId,
        payload.sourceObjectId,
        payload.sourceVersionId,
        version,
        payload.claim,
        payload.evidenceType,
        span.start,
        span.end,
        span.exactText,
        payload.reasoning,
        payload.limitations,
        principal.subjectId,
      ],
    );
    const proposedAt = new Date(
      inserted.rows[0]?.created_at as string | Date,
    ).toISOString();
    const data = {
      proposalId,
      projectId,
      workItemId: payload.workItemId,
      materialId: payload.materialId,
      status: "PROPOSAL" as const,
      classification: "PROPOSAL" as const,
      claim: payload.claim,
      evidenceType: payload.evidenceType,
      locator: {
        sourceObjectId: payload.sourceObjectId,
        sourceVersionId: payload.sourceVersionId,
        reference: `${String(row.title)} · exact span ${span.start}-${span.end}`,
      },
      exactSpan: span,
      reasoning: payload.reasoning,
      limitations: payload.limitations,
      proposedBy: principal.subjectId,
      proposedAt,
      audit: {
        requestId: request.requestId,
        eventType: "EVIDENCE_PROPOSED" as const,
      },
    };
    return {
      version,
      data,
      audit: {
        eventType: "EVIDENCE_PROPOSED",
        details: {
          proposalId,
          workItemId: payload.workItemId,
          materialId: payload.materialId,
          sourceVersionId: payload.sourceVersionId,
          proposalVersion: version,
          classification: "PROPOSAL",
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
