import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { MaterialVerificationCommand } from "../materials/material-verification-command";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { EvidenceProposalCommand } from "./evidence-proposal-command";
import { EvidenceConfirmationCommand } from "./evidence-confirmation-command";

const integrationDescribe =
  process.env.EVIDENCE_INTAKE_INTEGRATION === "1" ? describe : describe.skip;

integrationDescribe("evidence.propose PostgreSQL command", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_evidence_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let materialCreate: MaterialCreateCommand;
  let materialVerify: MaterialVerificationCommand;
  let command: EvidenceProposalCommand;
  let confirmation: EvidenceConfirmationCommand;
  let projectId: string;
  let workItemId: string;
  let verifiedMaterial: Awaited<ReturnType<MaterialCreateCommand["execute"]>>;
  let revisionMaterial: Awaited<ReturnType<MaterialCreateCommand["execute"]>>;
  let unverifiedMaterial: Awaited<ReturnType<MaterialCreateCommand["execute"]>>;

  const principal = {
    tenantId: "tenant-demo",
    subjectId: "workbuddy-pmc-evidence-test",
    role: "PMC" as const,
    scopes: ["evidence:write"],
    projectIds: [] as string[],
  };

  const proposal = (overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    expectedVersion: 0,
    reason: "登记经人工核验材料中的可追溯事实候选",
    correlationId: randomUUID(),
    payload: {
      workItemId,
      materialId: verifiedMaterial.data.materialId,
      claim: "测试产线在 fixture 周期内负荷率为 82%。",
      evidenceType: "METRIC" as const,
      sourceObjectId: verifiedMaterial.data.locator.sourceObjectId,
      sourceVersionId: verifiedMaterial.data.locator.sourceVersionId,
      exactSpan: {
        kind: "TEXT_SPAN" as const,
        start: 0,
        end: 13,
        exactText: "测试产线负荷率为 82%。",
      },
      reasoning: "受控文本直接给出该 fixture 周期的负荷率。",
      limitations: "仅用于 E2E / ACCEPTANCE / NON_PRODUCTION。",
    },
    ...overrides,
  });

  const createMaterial = async (
    situationCode: "CAPACITY_RISK" | "BOM_DELAY" | "PURCHASE_DELAY",
    requirementId:
      "REQ-CAPACITY-LOAD" | "REQ-BOM-CHANGE" | "REQ-PURCHASE-CONFIRM",
    displayName: string,
    controlledTextContent: string,
  ) =>
    materialCreate.execute(
      {
        ...principal,
        subjectId: "acceptance-fixture-pmc",
        scopes: ["material:write"],
      },
      projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "建立 Evidence intake 隔离材料",
        correlationId: randomUUID(),
        payload: {
          workItemId,
          situationCode,
          requirementId,
          materialType: "CONTROLLED_TEXT",
          displayName,
          sourceMetadata: {
            sourceType: "HUMAN_PROVIDED",
            sourceName: "Evidence Acceptance Fixture",
          },
          safeSummary: "E2E / ACCEPTANCE / NON_PRODUCTION 受控文本材料。",
          controlledTextContent,
        },
      },
    );

  const verify = async (
    material: Awaited<ReturnType<MaterialCreateCommand["execute"]>>,
    decision: "VERIFIED" | "NEEDS_REVISION",
  ) =>
    materialVerify.execute(
      {
        ...principal,
        subjectId: "human-pmc-evidence-fixture",
        scopes: ["material:verify"],
      },
      projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "通过合法人工 gate 建立 Evidence acceptance 前置状态",
        correlationId: randomUUID(),
        payload: {
          materialId: material.data.materialId,
          decision,
          verificationNote:
            decision === "VERIFIED"
              ? "已人工核对 fixture 文本与定位，可用于 Evidence Proposal 验收。"
              : "fixture 文本需补充统计口径，不得进入 Evidence Proposal。",
        },
      },
    );

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl());
    adminUrl.pathname = "/postgres";
    admin = new Pool({ connectionString: adminUrl.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(databaseUrl());
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    pool = new Pool({ connectionString: testUrl.toString() });
    await migrate(pool);
    await resetAndSeed(pool);
    business = new Vs01Service();
    await business.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立 Evidence intake PostgreSQL 隔离项目",
    });
    projectId = (
      await business.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
    workItemId = String(
      (
        await pool.query(
          "SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id AND n.tenant_id = s.tenant_id WHERE n.project_id = $1 AND s.id LIKE '%SUB-SOLUTION-001' LIMIT 1",
          [projectId],
        )
      ).rows[0]?.id,
    );
    principal.projectIds = [projectId];
    const kernel = new GovernedCommandKernel(
      new PostgresGovernedCommandStore(pool),
    );
    materialCreate = new MaterialCreateCommand(kernel);
    materialVerify = new MaterialVerificationCommand(kernel);
    command = new EvidenceProposalCommand(kernel);
    confirmation = new EvidenceConfirmationCommand(kernel);
    verifiedMaterial = await createMaterial(
      "CAPACITY_RISK",
      "REQ-CAPACITY-LOAD",
      "E2E 已核验产能记录",
      "测试产线负荷率为 82%。统计周期为 fixture week 1。",
    );
    revisionMaterial = await createMaterial(
      "BOM_DELAY",
      "REQ-BOM-CHANGE",
      "E2E 待修订 BOM 记录",
      "BOM 记录缺少版本与审批时间。",
    );
    unverifiedMaterial = await createMaterial(
      "PURCHASE_DELAY",
      "REQ-PURCHASE-CONFIRM",
      "E2E 尚未核验采购记录",
      "供应商承诺记录尚未由 PMC 核验。",
    );
    await verify(verifiedMaterial, "VERIFIED");
    await verify(revisionMaterial, "NEEDS_REVISION");
  }, 30_000);

  afterAll(async () => {
    await business?.onModuleDestroy();
    await pool?.end();
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 30_000);

  it("fails closed before reading or writing an unauthorized project", async () => {
    await expect(
      command.execute(
        { ...principal, projectIds: ["OTHER"] },
        projectId,
        proposal(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(
        { ...principal, scopes: ["evidence:read"] },
        projectId,
        proposal(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(
        { ...principal, tenantId: "tenant-other" },
        projectId,
        proposal(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("rejects stale, mismatched, unverified and needs-revision sources", async () => {
    await expect(
      command.execute(principal, projectId, proposal({ expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(
      command.execute(principal, projectId, {
        ...proposal(),
        payload: { ...proposal().payload, sourceVersionId: "SRC-OTHER-V1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      command.execute(principal, projectId, {
        ...proposal(),
        payload: {
          ...proposal().payload,
          exactSpan: {
            kind: "TEXT_SPAN",
            start: 0,
            end: 8,
            exactText: "不存在的文本",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      command.execute(principal, projectId, {
        ...proposal(),
        payload: {
          ...proposal().payload,
          materialId: revisionMaterial.data.materialId,
          sourceObjectId: revisionMaterial.data.locator.sourceObjectId,
          sourceVersionId: revisionMaterial.data.locator.sourceVersionId,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      command.execute(principal, projectId, {
        ...proposal(),
        payload: {
          ...proposal().payload,
          materialId: unverifiedMaterial.data.materialId,
          sourceObjectId: unverifiedMaterial.data.locator.sourceObjectId,
          sourceVersionId: unverifiedMaterial.data.locator.sourceVersionId,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("appends one proposal and audit idempotently without business side effects", async () => {
    const projectBefore = await business.project(projectId);
    const taskBefore = await business.task("SO-202608136");
    const before = await pool.query(
      "SELECT p.status, p.metric_current, s.status AS work_item_status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_project_subtasks s ON s.node_id = n.id WHERE p.id = $1 AND s.id = $2",
      [projectId, workItemId],
    );
    const input = proposal();
    const first = await command.execute(principal, projectId, input);
    const replay = await command.execute(principal, projectId, input);
    expect(first).toMatchObject({
      version: 1,
      replayed: false,
      data: {
        projectId,
        workItemId,
        materialId: verifiedMaterial.data.materialId,
        status: "PROPOSAL",
        classification: "PROPOSAL",
        proposedBy: principal.subjectId,
      },
    });
    expect(replay).toMatchObject({ replayed: true, data: first.data });
    await expect(
      command.execute(principal, projectId, {
        ...input,
        payload: { ...input.payload, claim: "同 requestId 的不同 claim" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const counts = await pool.query(
      "SELECT (SELECT count(*)::int FROM vs32_evidence_proposals WHERE id = $1) AS proposals, (SELECT count(*)::int FROM governed_command_audit_events WHERE command_name = 'evidence.propose' AND request_id = $2) AS audits, (SELECT count(*)::int FROM vs32_formal_evidence WHERE proposal_id = $1) AS formal",
      [first.data.proposalId, input.requestId],
    );
    expect(counts.rows[0]).toEqual({ proposals: 1, audits: 1, formal: 0 });
    await expect(
      pool.query(
        "UPDATE vs01_source_versions SET version_number = 2 WHERE id = $1",
        [verifiedMaterial.data.locator.sourceVersionId],
      ),
    ).rejects.toThrow(/append-only/);
    const after = await pool.query(
      "SELECT p.status, p.metric_current, s.status AS work_item_status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id JOIN vs01_project_subtasks s ON s.node_id = n.id WHERE p.id = $1 AND s.id = $2",
      [projectId, workItemId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await business.project(projectId)).toEqual(projectBefore);
    expect(await business.task("SO-202608136")).toEqual(taskBefore);
  });

  it("requires a real PMC confirmation before projecting formal FACT Evidence", async () => {
    const projectBefore = await business.project(projectId);
    const proposalVersion = Number(
      (
        await pool.query(
          "SELECT count(*)::int AS version FROM vs32_evidence_proposals WHERE tenant_id = 'tenant-demo' AND source_version_id = $1",
          [verifiedMaterial.data.locator.sourceVersionId],
        )
      ).rows[0]?.version,
    );
    const proposed = await command.execute(
      principal,
      projectId,
      proposal({ expectedVersion: proposalVersion }),
    );
    expect((await business.task("SO-202608136")).evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: proposed.data.proposalId }),
      ]),
    );
    const input = {
      requestId: randomUUID(),
      expectedVersion: 0,
      reason: "PMC 核对 claim 与来源定位后确认正式 Evidence",
      correlationId: randomUUID(),
      payload: {
        proposalId: proposed.data.proposalId,
        decision: "CONFIRMED" as const,
        reviewNote:
          "已逐字核对 claim、受控文本 exact span 与限制，确认仅用于 fixture。",
      },
    };
    const human = {
      ...principal,
      subjectId: "human-pmc-evidence-review",
      scopes: ["evidence:confirm"],
    };
    await expect(
      confirmation.execute(
        { ...human, projectIds: ["OTHER"] },
        projectId,
        input,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      confirmation.execute(human, projectId, { ...input, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });

    const first = await confirmation.execute(human, projectId, input);
    const replay = await confirmation.execute(human, projectId, input);
    expect(first).toMatchObject({
      version: 1,
      replayed: false,
      data: {
        proposalId: proposed.data.proposalId,
        projectId,
        decision: "CONFIRMED",
        reviewedBy: human.subjectId,
      },
    });
    expect(first.data.evidenceId).toMatch(/^E-MATERIAL-/);
    expect(replay).toMatchObject({ replayed: true, data: first.data });
    const formal = (await business.task("SO-202608136")).evidence.find(
      (item) => item.id === first.data.evidenceId,
    );
    expect(formal).toMatchObject({
      id: first.data.evidenceId,
      sourceObjectId: verifiedMaterial.data.locator.sourceObjectId,
      sourceVersionId: verifiedMaterial.data.locator.sourceVersionId,
      classification: "FACT",
      claim: proposed.data.claim,
      confirmedBy: human.subjectId,
    });
    const counts = await pool.query(
      "SELECT (SELECT count(*)::int FROM vs32_evidence_confirmations WHERE proposal_id = $1) AS confirmations, (SELECT count(*)::int FROM vs32_formal_evidence WHERE proposal_id = $1) AS formal, (SELECT count(*)::int FROM governed_command_audit_events WHERE command_name = 'evidence.confirm' AND request_id = $2) AS audits",
      [proposed.data.proposalId, input.requestId],
    );
    expect(counts.rows[0]).toEqual({ confirmations: 1, formal: 1, audits: 1 });
    expect(await business.project(projectId)).toEqual(projectBefore);
  });

  it("keeps a rejected proposal and audit without projecting formal Evidence", async () => {
    const proposalVersion = Number(
      (
        await pool.query(
          "SELECT count(*)::int AS version FROM vs32_evidence_proposals WHERE tenant_id = 'tenant-demo' AND source_version_id = $1",
          [verifiedMaterial.data.locator.sourceVersionId],
        )
      ).rows[0]?.version,
    );
    const proposed = await command.execute(
      principal,
      projectId,
      proposal({ expectedVersion: proposalVersion }),
    );
    const rejected = await confirmation.execute(
      {
        ...principal,
        subjectId: "human-pmc-evidence-review",
        scopes: ["evidence:confirm"],
      },
      projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "人工判断 claim 超出 exact span",
        correlationId: randomUUID(),
        payload: {
          proposalId: proposed.data.proposalId,
          decision: "REJECTED",
          reviewNote: "定位只证明 82%，不能证明整个 fixture 周期表现。",
        },
      },
    );
    expect(rejected.data).toMatchObject({
      decision: "REJECTED",
      evidenceId: null,
      version: 1,
    });
    const persisted = await pool.query(
      "SELECT c.decision, f.id AS evidence_id FROM vs32_evidence_confirmations c LEFT JOIN vs32_formal_evidence f ON f.proposal_id = c.proposal_id WHERE c.proposal_id = $1",
      [proposed.data.proposalId],
    );
    expect(persisted.rows[0]).toEqual({
      decision: "REJECTED",
      evidence_id: null,
    });
  });

  it("rolls back both formal Evidence and confirmation when Audit persistence fails", async () => {
    const proposalVersion = Number(
      (
        await pool.query(
          "SELECT count(*)::int AS version FROM vs32_evidence_proposals WHERE tenant_id = 'tenant-demo' AND source_version_id = $1",
          [verifiedMaterial.data.locator.sourceVersionId],
        )
      ).rows[0]?.version,
    );
    const proposed = await command.execute(
      principal,
      projectId,
      proposal({ expectedVersion: proposalVersion }),
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_evidence_confirm_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.command_name = 'evidence.confirm' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_evidence_confirm_audit_trigger
      BEFORE INSERT ON governed_command_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_confirm_audit();
    `);
    try {
      await expect(
        confirmation.execute(
          {
            ...principal,
            subjectId: "human-pmc-evidence-review",
            scopes: ["evidence:confirm"],
          },
          projectId,
          {
            requestId: randomUUID(),
            expectedVersion: 0,
            reason: "验证 Audit 与正式 Evidence 同事务",
            correlationId: randomUUID(),
            payload: {
              proposalId: proposed.data.proposalId,
              decision: "CONFIRMED",
              reviewNote: "该次确认必须因 Audit 写入失败而整体回滚。",
            },
          },
        ),
      ).rejects.toThrow("命令未完成；请检查状态后使用原请求编号重试");
    } finally {
      await pool.query(
        "DROP TRIGGER reject_evidence_confirm_audit_trigger ON governed_command_audit_events; DROP FUNCTION reject_evidence_confirm_audit()",
      );
    }
    const counts = await pool.query(
      "SELECT (SELECT count(*)::int FROM vs32_evidence_confirmations WHERE proposal_id = $1) AS confirmations, (SELECT count(*)::int FROM vs32_formal_evidence WHERE proposal_id = $1) AS formal",
      [proposed.data.proposalId],
    );
    expect(counts.rows[0]).toEqual({ confirmations: 0, formal: 0 });
  });
});
