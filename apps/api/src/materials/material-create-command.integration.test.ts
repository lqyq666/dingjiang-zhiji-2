import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { MaterialCreateCommand } from "./material-create-command";

const integrationDescribe =
  process.env.MATERIAL_CREATE_INTEGRATION === "1" ? describe : describe.skip;

integrationDescribe("material.create PostgreSQL command", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_material_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let command: MaterialCreateCommand;
  let projectId: string;
  let workItemId: string;
  const principal = {
    tenantId: "tenant-demo",
    subjectId: "workbuddy-pmc-material-test",
    role: "PMC" as const,
    scopes: ["material:write"],
    projectIds: [] as string[],
  };
  const request = (overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    expectedVersion: 0,
    reason: "登记待核验产能材料",
    correlationId: randomUUID(),
    payload: {
      workItemId,
      situationCode: "CAPACITY_RISK" as const,
      requirementId: "REQ-CAPACITY-LOAD",
      materialType: "CONTROLLED_TEXT" as const,
      displayName: "关键产线负荷说明",
      sourceMetadata: {
        sourceType: "HUMAN_PROVIDED" as const,
        sourceName: "PMC 核验记录",
        sourceReference: "CAPACITY-CHECK-01",
      },
      safeSummary: "待核验的关键产线负荷与工时摘要",
      controlledTextContent: "当前记录仍需由产线负责人核对统计周期与可用工时。",
    },
    ...overrides,
  });

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
      note: "建立材料命令隔离测试项目",
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
          "SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id AND n.tenant_id = s.tenant_id WHERE n.project_id = $1 ORDER BY s.id LIMIT 1",
          [projectId],
        )
      ).rows[0]?.id,
    );
    principal.projectIds = [projectId];
    command = new MaterialCreateCommand(
      new GovernedCommandKernel(new PostgresGovernedCommandStore(pool)),
    );
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

  it("fails closed for authorization, project, requirement and stale version", async () => {
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
        payload: { ...request().payload, requirementId: "REQ-NOT-ALLOWED" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      command.execute(principal, projectId, request({ expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("creates one immutable unverified material and audit, then replays idempotently", async () => {
    const before = (
      await pool.query(
        "SELECT p.status, p.metric_current, s.id, s.status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 ORDER BY s.id",
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
        projectId,
        workItemId,
        requirementId: "REQ-CAPACITY-LOAD",
        verificationStatus: "UNVERIFIED",
        createdBy: principal.subjectId,
      },
    });
    expect(replay).toMatchObject({ replayed: true, data: first.data });
    await expect(
      command.execute(principal, projectId, {
        ...input,
        payload: { ...input.payload, safeSummary: "同 requestId 的不同内容" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const counts = (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM vs01_task_materials WHERE request_id = $1) AS materials, (SELECT count(*)::int FROM vs15_governed_material_versions WHERE source_version_id = $2) AS versions, (SELECT count(*)::int FROM vs15_material_events WHERE material_id = $3 AND event_type = 'REGISTERED') AS events, (SELECT count(*)::int FROM governed_command_audit_events WHERE request_id = $1 AND event_type = 'MATERIAL_CREATED') AS audits",
        [
          input.requestId,
          first.data.locator.sourceVersionId,
          first.data.materialId,
        ],
      )
    ).rows[0];
    expect(counts).toEqual({ materials: 1, versions: 1, events: 1, audits: 1 });
    expect(
      (await business.task("SO-202608136")).materials.find(
        (item) => item.id === first.data.materialId,
      ),
    ).toMatchObject({
      requirementId: "REQ-CAPACITY-LOAD",
      kind: "MANUAL_REFERENCE",
      locator: first.data.locator,
      file: null,
    });
    expect(
      (
        await pool.query(
          "SELECT p.status, p.metric_current, s.id, s.status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 ORDER BY s.id",
          [projectId],
        )
      ).rows,
    ).toEqual(before);
    await expect(
      pool.query(
        "UPDATE vs15_governed_material_versions SET safe_summary = '覆盖历史' WHERE source_version_id = $1",
        [first.data.locator.sourceVersionId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        "UPDATE vs01_source_versions SET version_number = 2 WHERE id = $1",
        [first.data.locator.sourceVersionId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        "UPDATE vs01_task_materials SET source_version_id = 'SRC-ORDERS-V1' WHERE id = $1",
        [first.data.materialId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("rolls back material and SourceVersion when the audit phase fails", async () => {
    const input = request();
    input.payload.situationCode = "BOM_DELAY" as "CAPACITY_RISK";
    input.payload.requirementId = "REQ-BOM-CHANGE";
    input.payload.displayName = "BOM 差异回滚测试材料";
    await pool.query(`
      CREATE OR REPLACE FUNCTION material_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = '${input.requestId}'::uuid THEN
          RAISE EXCEPTION 'forced material audit rollback';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER material_test_reject_audit_trigger
        BEFORE INSERT ON governed_command_audit_events
        FOR EACH ROW EXECUTE FUNCTION material_test_reject_audit();
    `);
    await expect(
      command.execute(principal, projectId, input),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await pool.query(
      "DROP TRIGGER material_test_reject_audit_trigger ON governed_command_audit_events",
    );
    await pool.query("DROP FUNCTION material_test_reject_audit()");
    const counts = (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM vs01_task_materials WHERE request_id = $1) AS materials, (SELECT count(*)::int FROM governed_command_receipts WHERE request_id = $1) AS receipts, (SELECT count(*)::int FROM governed_command_audit_events WHERE request_id = $1) AS audits",
        [input.requestId],
      )
    ).rows[0];
    expect(counts).toEqual({ materials: 0, receipts: 0, audits: 0 });
  });
});
