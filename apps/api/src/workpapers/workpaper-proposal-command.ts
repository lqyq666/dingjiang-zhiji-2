import { isProduction } from "../runtime-config";
import { sourceLocator } from "../intake/source-facts";
import { createHash, randomUUID } from "node:crypto";

import {
  validationWorkpaperContentSchema,
  workpaperProposalContextSchema,
  workpaperProposalPayloadSchema,
  workpaperProposeRequestSchema,
  workpaperProposeResultSchema,
  type GovernedCommandRequest,
  type GovernedPrincipal,
  type WorkpaperProposalContext,
  type WorkpaperProposalPayload,
} from "@dingjiang/contracts";

import {
  GovernedCommandFailure,
  type GovernedCommandKernel,
  type GovernedCommandDefinition,
  type GovernedCommandTransaction,
} from "../command-kernel/governed-command-kernel";

type WorkpaperRow = {
  id: string;
  source_object_id: string;
  revision: number;
};

type WorkItemScope = {
  source_task_id: string;
  work_item_id: string;
};

type MaterialReference = {
  id: string;
  source_object_id: string;
  source_version_id: string;
  title: string;
};

type ExperienceReference = {
  id: string;
  title: string;
  limitations: string;
  source_object_id: string;
  source_version_id: string;
  evidence_source_object_id: string;
  evidence_source_version_id: string;
};

const evidenceFor = (sourceTaskId: string) => {
  const suffix = sourceTaskId.replace(/^SO-/, "");
  return new Map([
    [
      `E-ORDER-${suffix}`,
      {
        sourceObjectId: "SRC-ORDERS",
        sourceVersionId: "SRC-ORDERS-V1",
        reference: "订单交期记录",
      },
    ],
    [
      `E-BOM-${suffix}`,
      {
        sourceObjectId: "SRC-BOM",
        sourceVersionId: "SRC-BOM-V1",
        reference: "BOM 完成记录",
      },
    ],
    [
      `E-PURCHASE-${suffix}`,
      {
        sourceObjectId: "SRC-PURCHASES",
        sourceVersionId: "SRC-PURCHASES-V1",
        reference: "采购启动记录",
      },
    ],
  ]);
};

export class WorkpaperProposalCommand {
  constructor(private readonly kernel: GovernedCommandKernel) {}

  async execute(
    principal: GovernedPrincipal,
    projectId: string,
    input: unknown,
  ) {
    const parsed = workpaperProposeRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "workpaper.propose 请求不符合 contract",
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
    return workpaperProposeResultSchema.parse(result);
  }

  private definition(): GovernedCommandDefinition<WorkpaperProposalPayload> {
    return {
      name: "workpaper.propose",
      requiredScope: "workpaper:write",
      allowedRoles: ["PMC"],
      parsePayload: (payload) => workpaperProposalPayloadSchema.parse(payload),
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
    payload: WorkpaperProposalPayload,
  ) {
    const scope = await transaction.query(
      isProduction()
        ? "SELECT p.source_task_id,s.id AS work_item_id FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id=p.id AND n.tenant_id=p.tenant_id JOIN vs01_project_subtasks s ON s.node_id=n.id AND s.tenant_id=p.tenant_id JOIN vs01_project_phases ph ON ph.project_id=p.id AND ph.tenant_id=p.tenant_id AND ph.code=s.phase_code WHERE p.id=$1 AND p.tenant_id=$2 AND s.phase_code='ROOT_CAUSE_VALIDATION' AND s.sort_order=3 AND s.owner='PMC' AND ph.gate_status='OPEN' AND s.status IN ('READY','IN_PROGRESS') FOR UPDATE OF p,s"
        : "SELECT p.source_task_id, s.id AS work_item_id FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 AND p.tenant_id = $2 AND s.phase_code = 'ROOT_CAUSE_VALIDATION' AND s.owner = 'PMC' ORDER BY CASE WHEN s.origin = 'LIVE' THEN 0 ELSE 1 END, s.id LIMIT 1 FOR UPDATE OF p, s",
      [projectId, principal.tenantId],
    );
    const workItem = scope.rows[0] as WorkItemScope | undefined;
    if (!workItem)
      throw new GovernedCommandFailure(
        "PERMISSION_DENIED",
        "授权项目中没有可写的根因核验事项",
        request.correlationId,
      );

    let workpaper = await this.workpaper(
      transaction,
      principal.tenantId,
      projectId,
    );
    if (!workpaper) {
      workpaper = await this.createWorkpaper(
        transaction,
        principal.tenantId,
        projectId,
        workItem.work_item_id,
      );
    }
    if (Number(workpaper.revision) !== request.expectedVersion)
      throw new GovernedCommandFailure(
        "STALE_VERSION",
        "工作底稿版本已变化",
        request.correlationId,
      );

    let evidence = evidenceFor(workItem.source_task_id);
    if (isProduction()) {
      const snapshot = await transaction.query(
        "SELECT order_facts FROM production_project_snapshots WHERE project_id=$1 AND tenant_id=$2",
        [projectId, principal.tenantId],
      );
      if (!snapshot.rows[0]?.order_facts)
        throw new GovernedCommandFailure(
          "CONFLICT",
          "项目缺少不可变来源快照",
          request.correlationId,
        );
      const facts = snapshot.rows[0].order_facts as Record<string, unknown>;
      const suffix = workItem.source_task_id.replace(/^SO-/, "");
      evidence = new Map([
        [`E-ORDER-${suffix}`, sourceLocator(facts, "order")],
        [`E-BOM-${suffix}`, sourceLocator(facts, "bom")],
        [`E-PURCHASE-${suffix}`, sourceLocator(facts, "purchase")],
      ]);
    }
    const evidenceReferences = payload.evidenceFindings.map((finding) => {
      const locator = evidence.get(finding.evidenceId);
      if (!locator)
        throw new GovernedCommandFailure(
          "INVALID_REQUEST",
          "Proposal 引用了当前项目之外的 Evidence",
          request.correlationId,
        );
      return { evidenceId: finding.evidenceId, locator };
    });
    await this.assertEvidenceVersions(
      transaction,
      principal.tenantId,
      evidenceReferences.map((item) => item.locator),
      request.correlationId,
    );
    const materials = await this.materials(
      transaction,
      principal.tenantId,
      workItem.source_task_id,
      payload,
      request.correlationId,
    );
    const experiences = await this.experiences(
      transaction,
      principal.tenantId,
      payload,
      request.correlationId,
    );
    const proposalContext = workpaperProposalContextSchema.parse({
      proposalType: payload.proposalType,
      summary: payload.summary,
      reasoning: payload.reasoning,
      evidenceReferences,
      materialReferences: materials.map((material) => ({
        materialId: String(material.id),
        locator: {
          sourceObjectId: material.source_object_id,
          sourceVersionId: material.source_version_id,
          reference: material.title,
        },
      })),
      experienceReferences: experiences.map((experience) => {
        const requested = payload.experienceReferences.find(
          (item) => item.experienceId === experience.id,
        )!;
        return {
          experienceId: experience.id,
          applicationNote: requested.applicationNote,
          limitations: experience.limitations,
          locator: {
            sourceObjectId: experience.source_object_id,
            sourceVersionId: experience.source_version_id,
            reference: experience.title,
          },
          evidenceLocator: {
            sourceObjectId: experience.evidence_source_object_id,
            sourceVersionId: experience.evidence_source_version_id,
            reference: experience.title,
          },
        };
      }),
      assumptions: payload.assumptions,
      missingInformation: payload.missingInformation,
      limitations: payload.limitations,
      currentEvidenceTakesPriority: true,
    } satisfies WorkpaperProposalContext);
    const content = validationWorkpaperContentSchema.parse({
      problemStatement: payload.summary,
      factFindings: payload.evidenceFindings,
      materialFindings: payload.materialFindings.map((finding) => ({
        ...finding,
        verificationStatus: "UNVERIFIED_INPUT",
      })),
      hypotheses: payload.assumptions,
      conclusion: {
        result: "INSUFFICIENT_INFORMATION",
        statement: payload.reasoning,
        limitations: payload.limitations,
        nextChecks: payload.missingInformation,
      },
    });
    const version = Number(workpaper.revision) + 1;
    const sourceVersionId = `SRC-WORKPAPER-VERSION-${randomUUID()}`;
    const reference = `根因核验工作底稿 v${version}`;
    await transaction.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1,$2,$3,$4)",
      [
        sourceVersionId,
        workpaper.source_object_id,
        principal.tenantId,
        version,
      ],
    );
    const inserted = await transaction.query(
      "INSERT INTO vs16_root_cause_workpaper_versions (tenant_id, workpaper_id, revision, kind, classification, content, content_hash, source_version_id, based_on_revision, requested_by, request_id, proposal_context, created_by_subject) VALUES ($1,$2,$3,'PMC_PROPOSAL','PROPOSAL',$4::jsonb,$5,$6,$7,'PMC',$8,$9::jsonb,$10) RETURNING id, created_at",
      [
        principal.tenantId,
        workpaper.id,
        version,
        JSON.stringify(content),
        createHash("sha256").update(JSON.stringify(content)).digest("hex"),
        sourceVersionId,
        workpaper.revision === 0 ? null : workpaper.revision,
        request.requestId,
        JSON.stringify(proposalContext),
        principal.subjectId,
      ],
    );
    const versionId = inserted.rows[0]?.id;
    for (const item of evidenceReferences)
      await transaction.query(
        "INSERT INTO vs16_root_cause_workpaper_evidence (tenant_id, version_id, evidence_id, source_version_id, kind) VALUES ($1,$2,$3,$4,'FACT')",
        [
          principal.tenantId,
          versionId,
          item.evidenceId,
          item.locator.sourceVersionId,
        ],
      );
    for (const item of materials)
      await transaction.query(
        "INSERT INTO vs16_root_cause_workpaper_evidence (tenant_id, version_id, evidence_id, source_version_id, kind) VALUES ($1,$2,$3,$4,'MATERIAL')",
        [
          principal.tenantId,
          versionId,
          `MATERIAL-${item.id}`,
          item.source_version_id,
        ],
      );
    for (const item of experiences)
      await transaction.query(
        "INSERT INTO vs16_root_cause_workpaper_evidence (tenant_id, version_id, evidence_id, source_version_id, kind) VALUES ($1,$2,$3,$4,'FORMAL_EXPERIENCE')",
        [principal.tenantId, versionId, item.id, item.source_version_id],
      );
    await transaction.query(
      "UPDATE vs16_root_cause_workpapers SET revision = $2, updated_at = now() WHERE id = $1 AND tenant_id = $3",
      [workpaper.id, version, principal.tenantId],
    );
    const createdAt = new Date(
      inserted.rows[0]?.created_at as string | Date,
    ).toISOString();
    const data = {
      workpaperId: workpaper.id,
      projectId,
      workItemId: workItem.work_item_id,
      status: "PROPOSAL" as const,
      classification: "PROPOSAL" as const,
      version,
      locator: {
        sourceObjectId: workpaper.source_object_id,
        sourceVersionId,
        reference,
      },
      createdBy: principal.subjectId,
      createdAt,
      audit: {
        requestId: request.requestId,
        eventType: "WORKPAPER_PROPOSED" as const,
      },
    };
    return {
      version,
      data,
      audit: {
        eventType: "WORKPAPER_PROPOSED",
        details: {
          workpaperId: workpaper.id,
          workItemId: workItem.work_item_id,
          sourceVersionId,
          classification: "PROPOSAL",
        },
      },
    };
  }

  private async workpaper(
    transaction: GovernedCommandTransaction,
    tenantId: string,
    projectId: string,
  ): Promise<WorkpaperRow | null> {
    const result = await transaction.query(
      "SELECT id, source_object_id, revision FROM vs16_root_cause_workpapers WHERE tenant_id = $1 AND project_id = $2 FOR UPDATE",
      [tenantId, projectId],
    );
    return (result.rows[0] as WorkpaperRow | undefined) ?? null;
  }

  private async createWorkpaper(
    transaction: GovernedCommandTransaction,
    tenantId: string,
    projectId: string,
    workItemId: string,
  ): Promise<WorkpaperRow> {
    const id = `WP-${projectId}`;
    const sourceObjectId = `SRC-WORKPAPER-${projectId}`;
    await transaction.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1,$2,$3)",
      [sourceObjectId, tenantId, "根因核验工作底稿"],
    );
    await transaction.query(
      "INSERT INTO vs16_root_cause_workpapers (id, tenant_id, project_id, work_item_id, source_object_id, status) VALUES ($1,$2,$3,$4,$5,'DRAFTING')",
      [id, tenantId, projectId, workItemId, sourceObjectId],
    );
    return { id, source_object_id: sourceObjectId, revision: 0 };
  }

  private async materials(
    transaction: GovernedCommandTransaction,
    tenantId: string,
    sourceTaskId: string,
    payload: WorkpaperProposalPayload,
    correlationId: string,
  ): Promise<MaterialReference[]> {
    const ids = payload.materialFindings.map((item) => item.materialId);
    if (ids.length === 0) return [];
    if (
      ids.some(
        (id) =>
          !/^\d{1,19}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n,
      )
    )
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "Material 标识不合法",
        correlationId,
      );
    const result = await transaction.query(
      "SELECT m.id::text, m.title, m.source_version_id, sv.source_object_id FROM vs01_task_materials m JOIN vs01_source_versions sv ON sv.id = m.source_version_id AND sv.tenant_id = m.tenant_id WHERE m.tenant_id = $1 AND m.task_id = $2 AND m.status = 'ACTIVE' AND m.id = ANY($3::bigint[])",
      [tenantId, sourceTaskId, ids],
    );
    if (result.rows.length !== ids.length)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "Proposal 引用了无效、停用或跨项目 Material",
        correlationId,
      );
    return result.rows as MaterialReference[];
  }

  private async assertEvidenceVersions(
    transaction: GovernedCommandTransaction,
    tenantId: string,
    locators: Array<{ sourceObjectId: string; sourceVersionId: string }>,
    correlationId: string,
  ): Promise<void> {
    const result = await transaction.query(
      "SELECT id, source_object_id FROM vs01_source_versions WHERE tenant_id = $1 AND id = ANY($2::text[])",
      [tenantId, locators.map((locator) => locator.sourceVersionId)],
    );
    const actual = new Map(
      result.rows.map((row) => [String(row.id), String(row.source_object_id)]),
    );
    if (
      locators.some(
        (locator) =>
          actual.get(locator.sourceVersionId) !== locator.sourceObjectId,
      )
    )
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "Proposal 引用的 Evidence 版本不可追溯",
        correlationId,
      );
  }

  private async experiences(
    transaction: GovernedCommandTransaction,
    tenantId: string,
    payload: WorkpaperProposalPayload,
    correlationId: string,
  ): Promise<ExperienceReference[]> {
    const ids = payload.experienceReferences.map((item) => item.experienceId);
    if (ids.length === 0) return [];
    const result = await transaction.query(
      "SELECT id, title, limitations, source_object_id, source_version_id, evidence_source_object_id, evidence_source_version_id FROM vs01_formal_experiences WHERE tenant_id = $1 AND status = 'PUBLISHED' AND id = ANY($2::text[])",
      [tenantId, ids],
    );
    if (result.rows.length !== ids.length)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "Proposal 只能引用当前 tenant 的已发布 FormalExperience",
        correlationId,
      );
    return result.rows as ExperienceReference[];
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
