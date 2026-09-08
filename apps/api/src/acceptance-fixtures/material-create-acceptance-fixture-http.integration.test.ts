import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  integrationMaterialListSchema,
  integrationSuccessEnvelopeSchema,
} from "@dingjiang/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import {
  MaterialCreateAcceptanceFixtureBuilder,
  PostgresAcceptanceSourceTaskRepository,
  type MaterialCreateAcceptanceFixture,
} from "./material-create-acceptance-fixture";

const integrationDescribe =
  process.env.ACCEPTANCE_FIXTURE_HTTP_INTEGRATION === "1"
    ? describe
    : describe.skip;

integrationDescribe("material.create acceptance fixture HTTP read seam", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
  const databaseName = `dingjiang_acceptance_http_${process.pid}_${Date.now()}`;
  const token = "local-material-acceptance-http-token";
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let app: INestApplication;
  let api: string;
  let fixture: MaterialCreateAcceptanceFixture;

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
    fixture = await new MaterialCreateAcceptanceFixtureBuilder(
      new PostgresAcceptanceSourceTaskRepository(pool),
      business,
    ).create();
    process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
      {
        token,
        tenantId: "tenant-demo",
        subjectId: "acceptance-fixture-reader",
        role: "PMC",
        scopes: [
          "project:read",
          "workitem:read",
          "material:read",
          "evidence:read",
          "workpaper:read",
          "experience:read",
        ],
        projectIds: [fixture.projectId],
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
    if (originalBindings === undefined)
      delete process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
    else process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = originalBindings;
  }, 30_000);

  it("reads the zero-material eligible gap through the authorized Integration API", async () => {
    const response = await fetch(
      `${api}/integration/projects/${fixture.projectId}/materials`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const materials = integrationSuccessEnvelopeSchema(
      integrationMaterialListSchema,
    ).parse(await response.json()).data;
    expect(materials.items).toHaveLength(0);
    expect(materials.gaps).toContainEqual({
      situationCode: fixture.requirement.situationCode,
      requirementId: fixture.requirement.id,
      label: "关键产线负荷与工时记录",
      status: fixture.requirement.status,
    });
  });

  it("keeps the fixture project outside an unrelated project allowlist", async () => {
    const response = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/materials`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(403);
  });
});
