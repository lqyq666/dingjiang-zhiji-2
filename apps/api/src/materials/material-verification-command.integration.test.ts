import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { createTestPool } from "../testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { MaterialCreateCommand } from "./material-create-command";
import { MaterialVerificationCommand } from "./material-verification-command";

const integrationDescribe =
  process.env.MATERIAL_VERIFICATION_INTEGRATION === "1"
    ? describe
    : describe.skip;

integrationDescribe("material verification PostgreSQL command", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_material_verify_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let command: MaterialVerificationCommand;
  let materialCreate: MaterialCreateCommand;
  let projectId: string;
  let workItemId: string;
  let materialId: string;
  let sourceObjectId: string;
  let sourceVersionId: string;
  const principal = {
    tenantId: "tenant-demo",
    subjectId: "human-pmc-material-verifier",
    role: "PMC" as const,
    scopes: ["material:verify"],
    projectIds: [] as string[],
  };
  const request = (
    decision: "VERIFIED" | "NEEDS_REVISION" = "VERIFIED",
    expectedVersion = 0,
  ) => ({
    requestId: randomUUID(),
    expectedVersion,
    reason: "PMC 人工核验材料来源与当前用途",
    correlationId: randomUUID(),
    payload: {
      materialId,
      decision,
      verificationNote:
        decision === "VERIFIED"
          ? "已对照原始记录，当前版本可作为后续 Evidence 创建输入。"
          : "复核发现统计周期不一致，需要提交新版本后重新核验。",
    },
  });

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl());
    adminUrl.pathname = "/postgres";
    admin = createTestPool(adminUrl.toString());
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(databaseUrl());
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    pool = createTestPool(testUrl.toString());
    await migrate(pool);
    await resetAndSeed(pool);
    business = new Vs01Service();
    await business.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立材料核验隔离项目",
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
          "SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id AND n.tenant_id = s.tenant_id WHERE n.project_id = $1 AND s.owner = 'PMC' ORDER BY s.id LIMIT 1",
          [projectId],
        )
      ).rows[0]?.id,
    );
    const kernel = new GovernedCommandKernel(
      new PostgresGovernedCommandStore(pool),
    );
    materialCreate = new MaterialCreateCommand(kernel);
    const created = await materialCreate.execute(
      {
        ...principal,
        scopes: ["material:write"],
        projectIds: [projectId],
      },
      projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "为人工核验建立待核验材料",
        correlationId: randomUUID(),
        payload: {
          workItemId,
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          materialType: "CONTROLLED_TEXT",
          displayName: "待核验产能记录",
          sourceMetadata: {
            sourceType: "HUMAN_PROVIDED",
            sourceName: "PMC 提交记录",
          },
          safeSummary: "该输入仍待 PMC 核验来源和统计口径。",
          controlledTextContent: "产线负荷记录，仅供人工核验。",
        },
      },
    );
    materialId = created.data.materialId;
    sourceObjectId = created.data.locator.sourceObjectId;
    sourceVersionId = created.data.locator.sourceVersionId;
    principal.projectIds = [projectId];
    command = new MaterialVerificationCommand(kernel);
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

  it("authorizes before lookup and fails closed for stale or invalid materials", async () => {
    await expect(
      command.execute(
        { ...principal, scopes: ["material:read"] },
        projectId,
        request(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(
        { ...principal, role: "OWNER" as const },
        projectId,
        request(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(
        { ...principal, projectIds: ["OTHER"] },
        projectId,
        request(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(principal, projectId, {
        ...request(),
        payload: { ...request().payload, materialId: "999999999" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      command.execute(principal, projectId, request("VERIFIED", 1)),
    ).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
  });

  it("appends verification and correction history without business side effects", async () => {
    const before = (
      await pool.query(
        "SELECT p.status, p.metric_current, p.metric_target, ph.gate_status, s.id, s.status, s.completed_at, (SELECT count(*)::int FROM vs16_root_cause_workpaper_evidence) AS evidence_links, (SELECT count(*)::int FROM vs01_formal_experiences) AS experiences FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 ORDER BY ph.id, s.id",
        [projectId],
      )
    ).rows;
    const input = request();
    const first = await command.execute(principal, projectId, input);
    const replay = await command.execute(principal, projectId, input);
    expect(first).toMatchObject({
      version: 1,
      replayed: false,
      data: {
        materialId,
        projectId,
        workItemId,
        verification: {
          status: "VERIFIED",
          version: 1,
          verifiedBy: principal.subjectId,
        },
        locator: { sourceObjectId, sourceVersionId },
        audit: { requestId: input.requestId, eventType: "MATERIAL_VERIFIED" },
      },
    });
    expect(replay).toMatchObject({ replayed: true, data: first.data });
    await expect(
      command.execute(principal, projectId, request("VERIFIED", 1)),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const correctionInput = request("NEEDS_REVISION", 1);
    const correction = await command.execute(
      principal,
      projectId,
      correctionInput,
    );
    expect(correction).toMatchObject({
      version: 2,
      data: {
        verification: { status: "NEEDS_REVISION", version: 2 },
        audit: { eventType: "MATERIAL_REVISION_REQUESTED" },
      },
    });
    expect(
      (await business.task("SO-202608136")).materials.find(
        (material) => material.id === materialId,
      ),
    ).toMatchObject({
      verification: {
        status: "NEEDS_REVISION",
        version: 2,
        verifiedBy: principal.subjectId,
        note: correctionInput.payload.verificationNote,
      },
    });

    const history = (
      await pool.query(
        "SELECT event_type, actor, actor_subject_id, reason, verification_version, snapshot FROM vs15_material_events WHERE material_id = $1 AND event_type IN ('VERIFIED','NEEDS_REVISION') ORDER BY verification_version",
        [materialId],
      )
    ).rows;
    expect(history).toHaveLength(2);
    expect(history.map((event) => event.event_type)).toEqual([
      "VERIFIED",
      "NEEDS_REVISION",
    ]);
    expect(history[0]).toMatchObject({
      actor: "PMC",
      actor_subject_id: principal.subjectId,
      verification_version: 1,
    });
    expect(history[1]).toMatchObject({ verification_version: 2 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM governed_command_audit_events WHERE project_id = $1 AND event_type IN ('MATERIAL_VERIFIED','MATERIAL_REVISION_REQUESTED')",
          [projectId],
        )
      ).rows[0]?.count,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT source_object_id, source_version_id FROM vs01_task_materials WHERE id = $1",
          [materialId],
        )
      ).rows[0],
    ).toEqual({
      source_object_id: sourceObjectId,
      source_version_id: sourceVersionId,
    });
    expect(
      (
        await pool.query(
          "SELECT p.status, p.metric_current, p.metric_target, ph.gate_status, s.id, s.status, s.completed_at, (SELECT count(*)::int FROM vs16_root_cause_workpaper_evidence) AS evidence_links, (SELECT count(*)::int FROM vs01_formal_experiences) AS experiences FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_phases ph ON ph.project_id = p.id AND ph.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 ORDER BY ph.id, s.id",
          [projectId],
        )
      ).rows,
    ).toEqual(before);
    await expect(
      pool.query(
        "UPDATE vs15_material_events SET reason = '覆盖历史' WHERE material_id = $1 AND event_type = 'VERIFIED'",
        [materialId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("rolls back the verification event when immutable Audit cannot be written", async () => {
    const created = await materialCreate.execute(
      { ...principal, scopes: ["material:write"] },
      projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "建立事务回滚核验材料",
        correlationId: randomUUID(),
        payload: {
          workItemId,
          situationCode: "BOM_DELAY",
          requirementId: "REQ-BOM-CHANGE",
          materialType: "CONTROLLED_TEXT",
          displayName: "BOM 核验回滚材料",
          sourceMetadata: { sourceType: "HUMAN_PROVIDED", sourceName: "PMC" },
          safeSummary: "用于核验事务回滚测试。",
          controlledTextContent: "该输入不会在失败事务中留下核验事件。",
        },
      },
    );
    const input = {
      ...request(),
      payload: {
        ...request().payload,
        materialId: created.data.materialId,
      },
    };
    await pool.query(`
      CREATE OR REPLACE FUNCTION material_verification_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = '${input.requestId}'::uuid THEN
          RAISE EXCEPTION 'forced material verification audit rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER material_verification_test_reject_audit_trigger
        BEFORE INSERT ON governed_command_audit_events
        FOR EACH ROW EXECUTE FUNCTION material_verification_test_reject_audit();
    `);
    await expect(
      command.execute(principal, projectId, input),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await pool.query(
      "DROP TRIGGER material_verification_test_reject_audit_trigger ON governed_command_audit_events",
    );
    await pool.query("DROP FUNCTION material_verification_test_reject_audit()");
    expect(
      (
        await pool.query(
          "SELECT (SELECT count(*)::int FROM vs15_material_events WHERE material_id = $1 AND verification_version IS NOT NULL) AS events, (SELECT count(*)::int FROM governed_command_receipts WHERE request_id = $2) AS receipts, (SELECT count(*)::int FROM governed_command_audit_events WHERE request_id = $2) AS audits",
          [created.data.materialId, input.requestId],
        )
      ).rows[0],
    ).toEqual({ events: 0, receipts: 0, audits: 0 });
  });
});
