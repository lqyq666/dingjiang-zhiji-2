import type { Pool } from "pg";
import { createTestPool } from "../testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import {
  MaterialCreateAcceptanceFixtureBuilder,
  MaterialVerificationAcceptanceFixtureBuilder,
  PostgresAcceptanceSourceTaskRepository,
} from "./material-create-acceptance-fixture";

const integrationDescribe =
  process.env.MATERIAL_VERIFICATION_FIXTURE_INTEGRATION === "1"
    ? describe
    : describe.skip;

integrationDescribe("material verification runtime acceptance fixture", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_material_verify_fixture_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let builder: MaterialVerificationAcceptanceFixtureBuilder;

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
    const base = new MaterialCreateAcceptanceFixtureBuilder(
      new PostgresAcceptanceSourceTaskRepository(pool),
      business,
    );
    builder = new MaterialVerificationAcceptanceFixtureBuilder(
      base,
      new MaterialCreateCommand(
        new GovernedCommandKernel(new PostgresGovernedCommandStore(pool)),
      ),
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

  it("creates repeatable unique projects with one active unverified material", async () => {
    const demoBefore = await business.task("SO-202608136");
    const first = await builder.create();
    const second = await builder.create();
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.sourceTaskId).not.toBe(second.sourceTaskId);
    expect(first.material).toMatchObject({
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
      expectedVersion: 0,
      versionTarget: "MATERIAL_VERIFICATION_STREAM",
    });
    expect(first.requirement).toMatchObject({
      status: "AVAILABLE",
      activeMaterialCount: 1,
      materialAvailabilityVersion: 1,
    });
    expect(first.verificationRequestId).toBeUndefined();
    const task = await business.task(first.sourceTaskId);
    expect(task.materials).toHaveLength(1);
    expect(task.materials[0]).toMatchObject({
      id: first.material.id,
      requirementId: first.requirement.id,
      verification: { status: "UNVERIFIED", version: 0 },
      verificationEligible: true,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM vs15_material_events WHERE material_id = $1 AND verification_version IS NOT NULL",
          [first.material.id],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(await business.task("SO-202608136")).toEqual(demoBefore);
  });
});
