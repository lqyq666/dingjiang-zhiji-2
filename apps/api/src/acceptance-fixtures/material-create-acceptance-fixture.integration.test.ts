import type { Pool } from "pg";
import { createTestPool } from "../testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import {
  MaterialCreateAcceptanceFixtureBuilder,
  PostgresAcceptanceSourceTaskRepository,
} from "./material-create-acceptance-fixture";

const integrationDescribe =
  process.env.ACCEPTANCE_FIXTURE_INTEGRATION === "1" ? describe : describe.skip;

integrationDescribe("material.create runtime acceptance fixture", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_acceptance_fixture_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let builder: MaterialCreateAcceptanceFixtureBuilder;

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
    builder = new MaterialCreateAcceptanceFixtureBuilder(
      new PostgresAcceptanceSourceTaskRepository(pool),
      business,
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

  it("creates distinct non-production projects with one eligible gap and no material", async () => {
    const demoBefore = await business.task("SO-202608136");
    const first = await builder.create();
    const second = await builder.create();

    expect(first.classification).toBe("E2E / ACCEPTANCE / NON_PRODUCTION");
    expect(first.sourceTaskId).toMatch(/^SO-E2E-MATERIAL-/);
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.sourceTaskId).not.toBe(second.sourceTaskId);
    expect(first.requirement).toMatchObject({
      id: "REQ-CAPACITY-LOAD",
      status: "UNVERIFIED",
      activeMaterialCount: 0,
      expectedVersion: 0,
      versionTarget: "MATERIAL_REQUIREMENT_AVAILABILITY",
    });
    expect(first.workItemId).toContain("SUB-SOLUTION-001");
    expect(first.readTool).toBe("list_traceable_materials");
    expect(first.repeatStrategy).toBe("CREATE_UNIQUE_PROJECT");

    const [project, task, demoAfter] = await Promise.all([
      business.project(first.projectId),
      business.task(first.sourceTaskId),
      business.task("SO-202608136"),
    ]);
    expect(project.name).toContain("E2E / ACCEPTANCE / NON_PRODUCTION");
    expect(
      project.phases
        .flatMap((phase) => phase.tasks)
        .find((item) => item.id === first.workItemId)
        ?.inputs.find((input) => input.requirementId === first.requirement.id),
    ).toMatchObject({ status: "UNVERIFIED" });
    expect(
      task.situations
        .flatMap((situation) => situation.requirements)
        .find((requirement) => requirement.id === first.requirement.id),
    ).toMatchObject({ fulfilled: false, materialId: null });
    expect(task.materials).toHaveLength(0);
    expect(demoAfter).toEqual(demoBefore);
  });
});
