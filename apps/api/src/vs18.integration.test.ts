import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, migrate, resetAndSeed } from "./vs01-db";

const requested =
  process.env.VS18_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs18";
const dedicatedDatabase = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) return false;
  try {
    return new URL(value).pathname.replace(/^\//, "").endsWith("_vs18_test");
  } catch {
    return false;
  }
})();

if (requested && !dedicatedDatabase)
  throw new Error(
    "VS18 PostgreSQL integration requires DATABASE_URL for a dedicated local database ending in _vs18_test; refusing to reset or mutate demo data.",
  );

const integrationDescribe =
  requested && dedicatedDatabase ? describe : describe.skip;

integrationDescribe("VS18 PostgreSQL migration", () => {
  const pool = createPool();

  beforeAll(async () => {
    await migrate(pool);
    await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records the draft-money and approval-resubmission migrations", async () => {
    const migrations = await pool.query(
      "SELECT id FROM schema_migrations WHERE id IN ('0025_vs18_money_proposal_draft', '0026_vs18_approval_resubmission') ORDER BY id",
    );
    expect(migrations.rows).toEqual([
      { id: "0025_vs18_money_proposal_draft" },
      { id: "0026_vs18_approval_resubmission" },
    ]);
    const constraint = await pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'vs18_task_proposals'::regclass AND conname = 'vs18_task_proposals_money_amount_after_proposal_check'",
    );
    expect(String(constraint.rows[0]?.definition)).toContain("PROPOSED");
    expect(String(constraint.rows[0]?.definition)).toContain(
      "amount IS NOT NULL",
    );
    const index = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'vs18_approval_requests' AND indexname = 'vs18_approval_requests_one_pending_per_proposal_idx'",
    );
    expect(String(index.rows[0]?.indexdef)).toContain(
      "WHERE (status = 'PENDING'::text)",
    );
  });
});
