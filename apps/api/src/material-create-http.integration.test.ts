import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import { createTestPool } from "./testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { databaseUrl, migrate, resetAndSeed } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const integrationDescribe =
  process.env.MATERIAL_CREATE_HTTP_INTEGRATION === "1"
    ? describe
    : describe.skip;

integrationDescribe("material.create Integration HTTP seam", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
  const databaseName = `dingjiang_material_http_${process.pid}_${Date.now()}`;
  const token = "material-http-pmc-token-0001";
  const otherTenantToken = "material-http-other-token-0001";
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication;
  let api: string;
  let projectId: string;
  let workItemId: string;
  const request = () => ({
    requestId: randomUUID(),
    expectedVersion: 0,
    reason: "通过 Integration API 登记待核验材料",
    correlationId: randomUUID(),
    payload: {
      workItemId,
      situationCode: "CAPACITY_RISK",
      requirementId: "REQ-CAPACITY-LOAD",
      materialType: "CONTROLLED_TEXT",
      displayName: "HTTP 产能负荷说明",
      sourceMetadata: {
        sourceType: "HUMAN_PROVIDED",
        sourceName: "PMC 核验记录",
        sourceReference: "HTTP-CAPACITY-01",
      },
      safeSummary: "待核验的产能负荷摘要",
      controlledTextContent: "当前工时统计口径仍需产线负责人复核。",
    },
  });
  const post = (
    authorization: string | undefined,
    body: unknown,
    id = projectId,
  ) =>
    fetch(`${api}/integration/projects/${id}/materials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      },
      body: JSON.stringify(body),
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
    const business = new Vs01Service();
    await business.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立材料 HTTP 隔离测试项目",
    });
    projectId = (
      await business.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
    await business.onModuleDestroy();
    workItemId = String(
      (
        await pool.query(
          "SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id AND n.tenant_id = s.tenant_id WHERE n.project_id = $1 ORDER BY s.id LIMIT 1",
          [projectId],
        )
      ).rows[0]?.id,
    );
    process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
      {
        token,
        tenantId: "tenant-demo",
        subjectId: "workbuddy-pmc-material-http",
        role: "PMC",
        scopes: ["project:read", "material:read", "material:write"],
        projectIds: [projectId],
      },
      {
        token: otherTenantToken,
        tenantId: "tenant-other",
        subjectId: "other-pmc",
        role: "PMC",
        scopes: ["material:write"],
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

  it("fails closed for unauthenticated, wrong tenant and wrong project calls", async () => {
    expect((await post(undefined, request())).status).toBe(401);
    expect((await post(otherTenantToken, request())).status).toBe(403);
    expect((await post(token, request(), "PRJ-NOT-AUTHORIZED")).status).toBe(
      403,
    );
  });

  it("creates and reads back one unverified material through formal HTTP reads", async () => {
    const input = request();
    const created = await post(token, input);
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: { data: { materialId: string; locator: unknown } };
    };
    expect(body).toMatchObject({
      data: {
        version: 1,
        replayed: false,
        data: { verificationStatus: "UNVERIFIED", version: 1 },
      },
    });
    const read = await fetch(
      `${api}/integration/projects/${projectId}/materials`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody).toMatchObject({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            id: body.data.data.materialId,
            requirementId: "REQ-CAPACITY-LOAD",
            locator: body.data.data.locator,
          }),
        ],
      },
    });
    expect(JSON.stringify(readBody)).not.toMatch(
      /HTTP-CAPACITY-01|当前工时统计口径|storageKey|filePath|rawBytes/,
    );
  });
});
