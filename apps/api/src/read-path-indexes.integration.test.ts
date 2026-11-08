import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, migrate } from "./vs01-db";

/**
 * Read-path index audit.
 *
 * `0039_project_read_indexes.sql` exists because three hot reads fell back to a
 * sequential scan: the phase-transition subtask count (asked two or three times
 * per user action), the project event timeline, and the task material list.
 * Measured on 300 projects / 100k subtasks / 200k events / 200k materials, the
 * three went from 7-8 ms to 0.05-0.17 ms.
 *
 * A migration can be edited, renamed or dropped later without any behaviour
 * test noticing: the app still answers correctly, just slowly. This audit keeps
 * that decision visible and fails loudly if the indexes disappear.
 *
 * It asserts index shape, not planner output. Index choice is a cost decision
 * that legitimately varies with table size, so asserting "Index Scan" against a
 * small fixture would encode the wrong invariant.
 */
const runAudit =
  process.env.INDEX_AUDIT_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:indexes";

const auditDescribe = runAudit ? describe : describe.skip;

const SOURCE = "migration 0039_project_read_indexes.sql";

type Indexed = { indexname: string; indexdef: string };

auditDescribe("project read-path indexes", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const indexesOf = async (table: string): Promise<Indexed[]> => {
    const result = await pool.query<Indexed>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
      [table],
    );
    return result.rows;
  };

  /** Present the missing index as the failure, not an unrelated type error. */
  const indexNamed = async (table: string, name: string): Promise<Indexed> => {
    const found = (await indexesOf(table)).find(
      (index) => index.indexname === name,
    );
    expect(
      found,
      `缺少索引 ${name}（表 ${table}）。它是 ${SOURCE} 建立的读路径索引；被删除或改名都会让热点查询退回全表扫描。`,
    ).toBeDefined();
    return found as Indexed;
  };

  it("indexes the subtask predicate every phase transition repeats", async () => {
    const index = await indexNamed(
      "vs01_project_subtasks",
      "vs01_project_subtasks_phase_idx",
    );
    expect(index.indexdef).toContain("(tenant_id, node_id, phase_code)");
  });

  it("indexes the project event timeline in id order", async () => {
    const index = await indexNamed(
      "vs01_project_events",
      "vs01_project_events_timeline_idx",
    );
    // `id` must be the last column: that ordering is what removes the Sort.
    expect(index.indexdef).toContain("(tenant_id, project_id, id)");
  });

  it("indexes the task material list without depending on the partial predicate", async () => {
    const index = await indexNamed(
      "vs01_task_materials",
      "vs01_task_materials_task_idx",
    );
    expect(index.indexdef).toContain("(tenant_id, task_id, created_at, id)");
    // The pre-existing partial unique index cannot serve the list reads,
    // because its predicate (`request_id IS NOT NULL`) is not implied.
    expect(index.indexdef).not.toContain("WHERE");
  });

  it("keeps every read-path index tenant-led so row-level security stays usable", async () => {
    for (const [table, name] of [
      ["vs01_project_subtasks", "vs01_project_subtasks_phase_idx"],
      ["vs01_project_events", "vs01_project_events_timeline_idx"],
      ["vs01_task_materials", "vs01_task_materials_task_idx"],
    ] as const) {
      const index = await indexNamed(table, name);
      expect(index.indexdef).toMatch(/\(tenant_id, /);
    }
  });
});
