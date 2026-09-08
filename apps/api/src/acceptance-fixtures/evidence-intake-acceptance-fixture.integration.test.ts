import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { MaterialVerificationCommand } from "../materials/material-verification-command";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { EvidenceIntakeAcceptanceFixtureBuilder } from "./evidence-intake-acceptance-fixture";
import {
  MaterialCreateAcceptanceFixtureBuilder,
  PostgresAcceptanceSourceTaskRepository,
} from "./material-create-acceptance-fixture";

const integrationDescribe =
  process.env.EVIDENCE_FIXTURE_INTEGRATION === "1" ? describe : describe.skip;

integrationDescribe("evidence intake runtime acceptance fixture", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_evidence_fixture_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let business: Vs01Service;
  let builder: EvidenceIntakeAcceptanceFixtureBuilder;

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
    const kernel = new GovernedCommandKernel(
      new PostgresGovernedCommandStore(pool),
    );
    builder = new EvidenceIntakeAcceptanceFixtureBuilder(
      new MaterialCreateAcceptanceFixtureBuilder(
        new PostgresAcceptanceSourceTaskRepository(pool),
        business,
      ),
      new MaterialCreateCommand(kernel),
      new MaterialVerificationCommand(kernel),
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

  it("creates repeatable isolated verified, rejected-path and unauthorized projects", async () => {
    const demoBefore = await business.task("SO-202608136");
    const first = await builder.create();
    const second = await builder.create();
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.unauthorizedProject.projectId).not.toBe(first.projectId);
    expect(first.requestId).toBeUndefined();
    expect(first.verifiedMaterial).toMatchObject({
      verificationStatus: "VERIFIED",
      verificationVersion: 1,
      proposalExpectedVersion: 0,
      proposalVersionTarget: "SOURCE_VERSION_EVIDENCE_PROPOSAL_STREAM",
      exactSpan: { start: 0, exactText: "测试产线负荷率为 82%。" },
    });
    expect(first.needsRevisionMaterial).toMatchObject({
      verificationStatus: "NEEDS_REVISION",
      verificationVersion: 1,
    });
    const task = await business.task(first.sourceTaskId);
    expect(task.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.verifiedMaterial.materialId,
          verification: {
            status: "VERIFIED",
            version: 1,
            verifiedBy: "human-pmc-evidence-fixture",
            verifiedAt: expect.any(String),
            note: expect.any(String),
          },
        }),
        expect.objectContaining({
          id: first.needsRevisionMaterial.materialId,
          verification: {
            status: "NEEDS_REVISION",
            version: 1,
            verifiedBy: "human-pmc-evidence-fixture",
            verifiedAt: expect.any(String),
            note: expect.any(String),
          },
        }),
      ]),
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM vs32_evidence_proposals WHERE project_id = $1",
          [first.projectId],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(await business.task("SO-202608136")).toEqual(demoBefore);
  }, 30_000);
});
