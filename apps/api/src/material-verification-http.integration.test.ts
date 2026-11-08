import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import { createTestPool } from "./testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { GovernedCommandKernel } from "./command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "./command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "./materials/material-create-command";
import { databaseUrl, migrate, resetAndSeed } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const integrationDescribe =
  process.env.MATERIAL_VERIFICATION_HTTP_INTEGRATION === "1"
    ? describe
    : describe.skip;

integrationDescribe("material verification HTTP seam", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
  const databaseName = `dingjiang_material_verify_http_${process.pid}_${Date.now()}`;
  const token = "human-material-verifier-token-0001";
  const deniedToken = "workbuddy-material-reader-token-001";
  const otherTenantToken = "other-tenant-material-verifier-01";
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication;
  let api: string;
  let projectId: string;
  let materialId: string;
  let sourceVersionId: string;
  const request = (expectedVersion = 0) => ({
    requestId: randomUUID(),
    expectedVersion,
    reason: "PMC 人工核验材料来源与用途",
    correlationId: randomUUID(),
    payload: {
      materialId,
      decision: "VERIFIED",
      verificationNote:
        "已核对原始记录，当前版本可进入后续 Evidence 创建流程。",
    },
  });
  const post = (authorization: string, body: unknown, id = projectId) =>
    fetch(
      `${api}/integration/projects/${id}/materials/${materialId}/verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorization}`,
        },
        body: JSON.stringify(body),
      },
    );

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
    const business = new Vs01Service();
    await business.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立材料核验 HTTP 项目",
    });
    projectId = (
      await business.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
    const workItemId = String(
      (
        await pool.query(
          "SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id AND n.tenant_id = s.tenant_id WHERE n.project_id = $1 AND s.owner = 'PMC' ORDER BY s.id LIMIT 1",
          [projectId],
        )
      ).rows[0]?.id,
    );
    const created = await new MaterialCreateCommand(
      new GovernedCommandKernel(new PostgresGovernedCommandStore(pool)),
    ).execute(
      {
        tenantId: "tenant-demo",
        subjectId: "fixture-pmc",
        role: "PMC",
        scopes: ["material:write"],
        projectIds: [projectId],
      },
      projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "建立待核验 HTTP 材料",
        correlationId: randomUUID(),
        payload: {
          workItemId,
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          materialType: "CONTROLLED_TEXT",
          displayName: "HTTP 待核验材料",
          sourceMetadata: { sourceType: "HUMAN_PROVIDED", sourceName: "PMC" },
          safeSummary: "仅用于人工核验 HTTP 验收。",
          controlledTextContent: "内容仍待人核验。",
        },
      },
    );
    materialId = created.data.materialId;
    sourceVersionId = created.data.locator.sourceVersionId;
    await business.onModuleDestroy();
    process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
      {
        token,
        tenantId: "tenant-demo",
        subjectId: "human-pmc-http",
        role: "PMC",
        scopes: ["project:read", "material:read", "material:verify"],
        projectIds: [projectId],
      },
      {
        token: deniedToken,
        tenantId: "tenant-demo",
        subjectId: "workbuddy-pmc",
        role: "PMC",
        scopes: ["project:read", "material:read"],
        projectIds: [projectId],
      },
      {
        token: otherTenantToken,
        tenantId: "tenant-other",
        subjectId: "other-tenant-pmc",
        role: "PMC",
        scopes: ["material:verify"],
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

  it("denies a WorkBuddy read principal and an unauthorized project", async () => {
    expect((await post(deniedToken, request())).status).toBe(403);
    expect((await post(otherTenantToken, request())).status).toBe(403);
    expect((await post(token, request(), "PRJ-NOT-AUTHORIZED")).status).toBe(
      403,
    );
  });

  it("records human verification and reads it through the formal material endpoint", async () => {
    const input = request();
    const response = await post(token, input);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        version: 1,
        data: {
          materialId,
          verification: {
            status: "VERIFIED",
            version: 1,
            verifiedBy: "human-pmc-http",
          },
          locator: { sourceVersionId },
        },
      },
    });
    const read = await fetch(
      `${api}/integration/projects/${projectId}/materials`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(await read.json()).toMatchObject({
      data: {
        items: [
          expect.objectContaining({
            id: materialId,
            verification: expect.objectContaining({
              status: "VERIFIED",
              version: 1,
            }),
            verificationStatus: "VERIFIED",
            latestVerificationAudit: expect.objectContaining({
              eventType: "MATERIAL_VERIFIED",
              version: 1,
              actor: "human-pmc-http",
            }),
          }),
        ],
      },
    });
  });

  it("allows one PMC Web submission to append a revision request", async () => {
    const input = {
      requestId: randomUUID(),
      expectedVersion: 1,
      reason: "PMC 复核后要求修订材料",
      correlationId: randomUUID(),
      payload: {
        materialId,
        decision: "NEEDS_REVISION",
        verificationNote: "统计周期与事项口径不一致，请形成新版本后再次核验。",
      },
    };
    const webPost = (body: unknown) =>
      fetch(
        `${api}/vs01/projects/${projectId}/materials/${materialId}/verification`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vs01-role": "PMC",
          },
          body: JSON.stringify(body),
        },
      );
    const response = await webPost(input);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      materials: [
        expect.objectContaining({
          id: materialId,
          verification: expect.objectContaining({
            status: "NEEDS_REVISION",
            version: 2,
            verifiedBy: "human-pmc-web",
          }),
        }),
      ],
    });

    expect((await webPost(input)).status).toBe(201);
    const conflict = await webPost({
      ...input,
      reason: "同一 requestId 不得改变载荷",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
      correlationId: input.correlationId,
    });
    const staleInput = {
      ...input,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      expectedVersion: 1,
    };
    const stale = await webPost(staleInput);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      ok: false,
      error: { code: "STALE_VERSION" },
      correlationId: staleInput.correlationId,
    });
    const denied = await fetch(
      `${api}/vs01/projects/${projectId}/materials/${materialId}/verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vs01-role": "OWNER",
        },
        body: JSON.stringify(request(2)),
      },
    );
    expect(denied.status).toBe(403);
    const preview = await fetch(
      `${api}/integration/projects/${projectId}/materials/${materialId}/preview`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      data: {
        material: {
          verificationStatus: "NEEDS_REVISION",
          latestVerificationAudit: {
            eventType: "MATERIAL_REVISION_REQUESTED",
            version: 2,
            actor: "human-pmc-web",
            note: "统计周期与事项口径不一致，请形成新版本后再次核验。",
          },
        },
      },
    });
  });
});
