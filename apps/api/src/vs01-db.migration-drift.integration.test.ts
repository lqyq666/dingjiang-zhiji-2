import { createTestPool } from "./testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "./vs01-db";

const integrationDescribe =
  process.env.MIGRATION_DRIFT_INTEGRATION === "1" ? describe : describe.skip;

integrationDescribe("migration drift detection", () => {
  const databaseName = `dingjiang_drift_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof createTestPool>;
  let pool: ReturnType<typeof createTestPool>;

  beforeAll(async () => {
    admin = createTestPool(process.env.DATABASE_URL ?? "");
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.pathname = `/${databaseName}`;
    pool = createTestPool(url.toString());
    await migrate(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin
        .query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
          [databaseName],
        )
        .catch(() => undefined);
      await admin
        .query(`DROP DATABASE IF EXISTS ${databaseName}`)
        .catch(() => undefined);
      await admin.end();
    }
  });

  it("refuses a database whose applied migrations no longer exist in the repository", async () => {
    await pool.query(
      "INSERT INTO schema_migrations(id) VALUES ('0099_removed_migration')",
    );
    await expect(migrate(pool)).rejects.toThrow(/0099_removed_migration/);
    await pool.query(
      "DELETE FROM schema_migrations WHERE id = '0099_removed_migration'",
    );
    await expect(migrate(pool)).resolves.toBeUndefined();
  });
});
