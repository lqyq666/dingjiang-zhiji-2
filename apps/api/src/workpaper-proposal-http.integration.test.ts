import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { databaseUrl, migrate, resetAndSeed } from "./vs01-db";
import { Vs01Service } from "./vs01.service";
import { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";

const run = process.env.WORKPAPER_PROPOSAL_HTTP_INTEGRATION === "1";

(run ? describe : describe.skip)(
  "workpaper.propose Integration HTTP seam",
  () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
    const databaseName = `dingjiang_workpaper_http_${process.pid}_${Date.now()}`;
    const token = "workpaper-http-pmc-token-0001";
    const ownerToken = "workpaper-http-owner-token-0001";
    const otherTenantToken = "workpaper-http-other-token-0001";
    let admin: Pool;
    let pool: Pool;
    let app: INestApplication;
    let api: string;
    let projectId: string;
    let materialId: string;

    const proposal = (overrides: Record<string, unknown> = {}) => ({
      requestId: randomUUID(),
      expectedVersion: 0,
      reason: "通过 Integration API 留存根因核验 Proposal",
      correlationId: randomUUID(),
      payload: {
        proposalType: "ROOT_CAUSE_VALIDATION",
        summary: "订单延期可能与产能负荷风险有关",
        reasoning: "当前 Evidence 与材料提示风险，但不能替代人工确认。",
        evidenceFindings: [
          {
            evidenceId: "E-ORDER-202608136",
            assertion: "预测交期晚于承诺交期",
          },
        ],
        materialFindings: [
          {
            materialId,
            assertion: "产能材料提示负荷风险",
            assessment: "INCONCLUSIVE",
            note: "统计口径仍需人工复核",
          },
        ],
        experienceReferences: [],
        assumptions: ["Evidence 与材料采用相同统计周期"],
        missingInformation: ["缺少班次级工时明细"],
        limitations: "该 Proposal 不表示根因已经确认。",
      },
      ...overrides,
    });

    const post = (authorization: string | undefined, body: unknown) =>
      fetch(`${api}/integration/projects/${projectId}/workpaper/proposals`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization
            ? { authorization: `Bearer ${authorization}` }
            : {}),
        },
        body: JSON.stringify(body),
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

      const workpapers = new RootCauseWorkpaperService();
      const business = new Vs01Service(undefined, workpapers);
      await business.decideTask("SO-202608136", {
        actor: "PMC",
        type: "CONFIRMED",
        note: "建立隔离的 HTTP 测试项目",
      });
      projectId = (
        await business.createProject({
          actor: "PMC",
          sourceTaskId: "SO-202608136",
        })
      ).id;
      await business.onModuleDestroy();
      await workpapers.onModuleDestroy();

      await pool.query(
        "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ('SRC-MATERIAL-WORKPAPER-HTTP','tenant-demo','HTTP 隔离测试材料')",
      );
      await pool.query(
        "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ('SRC-MATERIAL-WORKPAPER-HTTP-V1','SRC-MATERIAL-WORKPAPER-HTTP','tenant-demo',1)",
      );
      materialId = String(
        (
          await pool.query(
            "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, title, source_reference, note, created_by, source_object_id, source_version_id) VALUES ('tenant-demo','SO-202608136','CAPACITY_RISK','HTTP 隔离测试材料','integration-fixture','仅用于隔离数据库测试','PMC','SRC-MATERIAL-WORKPAPER-HTTP','SRC-MATERIAL-WORKPAPER-HTTP-V1') RETURNING id",
          )
        ).rows[0]?.id,
      );
      process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
        {
          token,
          tenantId: "tenant-demo",
          subjectId: "workbuddy-pmc-http",
          role: "PMC",
          scopes: ["project:read", "workpaper:read", "workpaper:write"],
          projectIds: [projectId],
        },
        {
          token: ownerToken,
          tenantId: "tenant-demo",
          subjectId: "owner-http",
          role: "OWNER",
          scopes: ["workpaper:read"],
          projectIds: [projectId],
        },
        {
          token: otherTenantToken,
          tenantId: "tenant-other",
          subjectId: "pmc-other-http",
          role: "PMC",
          scopes: ["workpaper:write"],
          projectIds: [projectId],
        },
      ]);
      app = await NestFactory.create(AppModule, { logger: false });
      app.setGlobalPrefix("api");
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as { port: number };
      api = `http://127.0.0.1:${address.port}/api`;
    }, 30_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await new Promise((resolve) => setTimeout(resolve, 100));
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
      if (originalBindings === undefined)
        delete process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
      else process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = originalBindings;
    }, 30_000);

    it("fails closed before the command for missing, wrong-role, wrong-tenant and wrong-project identities", async () => {
      expect((await post(undefined, proposal())).status).toBe(401);
      expect((await post(ownerToken, proposal())).status).toBe(403);
      expect((await post(otherTenantToken, proposal())).status).toBe(403);
      const response = await fetch(
        `${api}/integration/projects/PRJ-NOT-AUTHORIZED/workpaper/proposals`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(proposal()),
        },
      );
      expect(response.status).toBe(403);

      const invalid = await post(token, {
        ...proposal(),
        payload: { ...proposal().payload, evidenceFindings: [] },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    });

    it("writes once, replays idempotently, exposes a stable read view and structured conflicts", async () => {
      const input = proposal();
      const first = await post(token, input);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as {
        ok: boolean;
        data: {
          version: number;
          replayed: boolean;
          data: { status: string; version: number };
        };
      };
      expect(firstBody).toMatchObject({
        ok: true,
        data: {
          version: 1,
          replayed: false,
          data: { status: "PROPOSAL", version: 1 },
        },
      });
      const replay = await post(token, input);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({
        ok: true,
        data: { version: 1, replayed: true },
      });

      await pool.query(
        "UPDATE vs01_projects SET source_task_id = 'SO-202608128' WHERE id = $1 AND tenant_id = 'tenant-demo'",
        [projectId],
      );
      await pool.query(
        "UPDATE vs01_project_subtasks SET origin = 'HISTORICAL' WHERE tenant_id = 'tenant-demo' AND phase_code = 'ROOT_CAUSE_VALIDATION' AND node_id IN (SELECT id FROM vs01_project_nodes WHERE tenant_id = 'tenant-demo' AND project_id = $1)",
        [projectId],
      );

      const read = await fetch(
        `${api}/integration/projects/${projectId}/workpaper`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        ok: true,
        data: {
          revision: 1,
          current: {
            kind: "PMC_PROPOSAL",
            classification: "PROPOSAL",
            requestId: input.requestId,
            createdBy: "workbuddy-pmc-http",
            audit: {
              requestId: input.requestId,
              eventType: "WORKPAPER_PROPOSED",
            },
          },
        },
      });

      const changed = await post(token, {
        ...input,
        payload: { ...input.payload, summary: "同 requestId 的另一份内容" },
      });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({
        ok: false,
        error: { code: "CONFLICT" },
      });
      const stale = await post(token, proposal());
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        ok: false,
        error: { code: "STALE_VERSION" },
      });
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM governed_command_audit_events WHERE command_name = 'workpaper.propose'",
            )
          ).rows[0]?.count,
        ),
      ).toBe(1);
    });
  },
);
