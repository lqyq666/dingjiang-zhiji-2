import { randomUUID } from "node:crypto";

import type { MaterialCreateCommand } from "../materials/material-create-command";
import type { MaterialVerificationCommand } from "../materials/material-verification-command";
import type { MaterialCreateAcceptanceFixtureBuilder } from "./material-create-acceptance-fixture";

const verifiedText =
  "测试产线负荷率为 82%。统计周期为 fixture week 1；仅供 E2E 验收。";
const exactText = "测试产线负荷率为 82%。";

type AcceptanceMaterial = {
  materialId: string;
  requirementId: string;
  verificationStatus: "VERIFIED" | "NEEDS_REVISION";
  verificationVersion: 1;
  sourceObjectId: string;
  sourceVersionId: string;
};

export type EvidenceIntakeAcceptanceFixture = {
  classification: "E2E / ACCEPTANCE / NON_PRODUCTION";
  tenantId: "tenant-demo";
  sourceTaskId: string;
  projectId: string;
  workItemId: string;
  verifiedMaterial: AcceptanceMaterial & {
    verificationStatus: "VERIFIED";
    controlledText: string;
    exactSpan: {
      kind: "TEXT_SPAN";
      start: 0;
      end: number;
      exactText: string;
    };
    proposalExpectedVersion: 0;
    proposalVersionTarget: "SOURCE_VERSION_EVIDENCE_PROPOSAL_STREAM";
  };
  needsRevisionMaterial: AcceptanceMaterial & {
    verificationStatus: "NEEDS_REVISION";
  };
  unauthorizedProject: {
    sourceTaskId: string;
    projectId: string;
  };
  expectedVersionReadPath: string;
  readTools: ["list_traceable_materials", "get_source_version"];
  repeatStrategy: "CREATE_UNIQUE_PROJECTS";
  retirementStrategy: string;
  requestId?: undefined;
};

export class EvidenceIntakeAcceptanceFixtureBuilder {
  constructor(
    private readonly base: MaterialCreateAcceptanceFixtureBuilder,
    private readonly materialCreate: MaterialCreateCommand,
    private readonly materialVerify: MaterialVerificationCommand,
  ) {}

  async create(): Promise<EvidenceIntakeAcceptanceFixture> {
    const fixture = await this.base.create();
    const unauthorized = await this.base.create();
    const principal = {
      tenantId: fixture.tenantId,
      subjectId: "acceptance-fixture-pmc",
      role: "PMC" as const,
      scopes: ["material:write"],
      projectIds: [fixture.projectId],
    };
    const verified = await this.materialCreate.execute(
      principal,
      fixture.projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "建立 Evidence intake VERIFIED acceptance 来源",
        correlationId: randomUUID(),
        payload: {
          workItemId: fixture.workItemId,
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          materialType: "CONTROLLED_TEXT",
          displayName: "E2E Evidence 已核验来源",
          sourceMetadata: {
            sourceType: "HUMAN_PROVIDED",
            sourceName: "Evidence Acceptance Fixture Builder",
          },
          safeSummary: "E2E / ACCEPTANCE / NON_PRODUCTION 可定位产能记录。",
          controlledTextContent: verifiedText,
        },
      },
    );
    const needsRevision = await this.materialCreate.execute(
      principal,
      fixture.projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "建立 Evidence intake NEEDS_REVISION 拒绝来源",
        correlationId: randomUUID(),
        payload: {
          workItemId: fixture.workItemId,
          situationCode: "BOM_DELAY",
          requirementId: "REQ-BOM-CHANGE",
          materialType: "CONTROLLED_TEXT",
          displayName: "E2E Evidence 待修订来源",
          sourceMetadata: {
            sourceType: "HUMAN_PROVIDED",
            sourceName: "Evidence Acceptance Fixture Builder",
          },
          safeSummary: "E2E / ACCEPTANCE / NON_PRODUCTION 缺少统计口径。",
          controlledTextContent:
            "BOM 记录缺少版本与审批时间，不得形成 Evidence Proposal。",
        },
      },
    );
    const verifyPrincipal = {
      ...principal,
      subjectId: "human-pmc-evidence-fixture",
      scopes: ["material:verify"],
    };
    await this.materialVerify.execute(verifyPrincipal, fixture.projectId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      reason: "人工建立 VERIFIED acceptance 前置状态",
      correlationId: randomUUID(),
      payload: {
        materialId: verified.data.materialId,
        decision: "VERIFIED",
        verificationNote:
          "已人工逐字核对受控 fixture 文本；仅允许用于 NON_PRODUCTION Evidence E2E。",
      },
    });
    await this.materialVerify.execute(verifyPrincipal, fixture.projectId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      reason: "人工建立 NEEDS_REVISION acceptance 拒绝状态",
      correlationId: randomUUID(),
      payload: {
        materialId: needsRevision.data.materialId,
        decision: "NEEDS_REVISION",
        verificationNote: "缺少版本和统计口径，必须 fail closed。",
      },
    });

    const material = <T extends "VERIFIED" | "NEEDS_REVISION">(
      created: typeof verified,
      requirementId: string,
      verificationStatus: T,
    ): Omit<AcceptanceMaterial, "verificationStatus"> & {
      verificationStatus: T;
    } => ({
      materialId: created.data.materialId,
      requirementId,
      verificationStatus,
      verificationVersion: 1,
      sourceObjectId: created.data.locator.sourceObjectId,
      sourceVersionId: created.data.locator.sourceVersionId,
    });
    return {
      classification: fixture.classification,
      tenantId: fixture.tenantId,
      sourceTaskId: fixture.sourceTaskId,
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      verifiedMaterial: {
        ...material(verified, "REQ-CAPACITY-LOAD", "VERIFIED"),
        controlledText: verifiedText,
        exactSpan: {
          kind: "TEXT_SPAN",
          start: 0,
          end: exactText.length,
          exactText,
        },
        proposalExpectedVersion: 0,
        proposalVersionTarget: "SOURCE_VERSION_EVIDENCE_PROPOSAL_STREAM",
      },
      needsRevisionMaterial: material(
        needsRevision,
        "REQ-BOM-CHANGE",
        "NEEDS_REVISION",
      ),
      unauthorizedProject: {
        sourceTaskId: unauthorized.sourceTaskId,
        projectId: unauthorized.projectId,
      },
      expectedVersionReadPath: `list_traceable_materials(projectId=${fixture.projectId}) -> items[id=${verified.data.materialId}].evidenceProposalVersion; this is the expectedVersion for sourceVersionId ${verified.data.locator.sourceVersionId}`,
      readTools: ["list_traceable_materials", "get_source_version"],
      repeatStrategy: "CREATE_UNIQUE_PROJECTS",
      retirementStrategy:
        "Remove both old projectIds from the WorkBuddy token allowlist; retain labelled projects, SourceVersions, proposals, confirmations and Audit history.",
    };
  }
}
