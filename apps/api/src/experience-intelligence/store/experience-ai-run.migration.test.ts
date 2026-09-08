import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/0023_vs17_experience_intelligence.sql",
);

describe("VS17 AI run migration", () => {
  it("keeps runs tenant-scoped and provider state transitions constrained", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE vs17_experience_ai_runs");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("status IN ('RUNNING', 'SUCCEEDED', 'FAILED')");
    expect(sql).toContain("UNIQUE (tenant_id, request_id)");
    expect(sql).toContain("vs17_allow_single_ai_run_completion");
    expect(sql).toContain("vs17_experience_candidate_revisions_immutable");
    expect(sql).toContain("CREATE TABLE vs17_experience_command_receipts");
    expect(sql).toContain("UNIQUE (tenant_id, route, request_id)");
    expect(sql).toContain("ADD COLUMN structured_card jsonb");
    expect(sql).toContain("coze_index_status");
  });
});
