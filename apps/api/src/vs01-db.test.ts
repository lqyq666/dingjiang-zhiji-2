import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createPool, localDatabaseUrl, migrate, resetAndSeed } from "./vs01-db";

describe("VS01 local database seam", () => {
  it("accepts only loopback PostgreSQL hosts", () => {
    expect(
      localDatabaseUrl("postgres://demo:demo@localhost:5432/vs01"),
    ).toContain("localhost");
    expect(
      localDatabaseUrl("postgres://demo:demo@127.0.0.1:5432/vs01"),
    ).toContain("127.0.0.1");
    expect(() =>
      localDatabaseUrl("postgres://demo:demo@database.example.com:5432/vs01"),
    ).toThrow("local loopback host");
  });

  it("keeps the withdrawal event in a new immutable constraint repair migration", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0007_vs02_event_constraint_repair.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS vs01_project_events_event_type_check",
    );
    expect(sql).toContain("EXPERIENCE_CANDIDATE_WITHDRAWN");
  });

  it("adds experience review tables and event constraints in append-only migration 0008", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0008_vs05_experience_review_and_reuse.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("vs01_experience_candidate_revisions");
    expect(sql).toContain("vs01_formal_experiences");
    expect(sql).toContain("vs01_experience_references");
    expect(sql).toContain("EXPERT_REVIEWER");
    expect(sql).toContain("EXPERIENCE_RESUBMITTED");
    expect(sql).toContain("FORMAL_EXPERIENCE_PUBLISHED");
  });

  it("allows a corrected candidate revision to be republished without overwriting a retracted experience", async () => {
    const initialSql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0008_vs05_experience_review_and_reuse.sql",
      ),
      "utf8",
    );
    const repairSql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0009_vs05_republish_after_retraction.sql",
      ),
      "utf8",
    );
    expect(initialSql).not.toContain("candidate_id text NOT NULL UNIQUE");
    expect(repairSql).toContain(
      "DROP CONSTRAINT IF EXISTS vs01_formal_experiences_candidate_id_key",
    );
  });

  it("stores every reference action with a durable note in append-only migrations", async () => {
    const eventSql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0010_vs05_experience_reference_events.sql",
      ),
      "utf8",
    );
    const noteSql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0011_vs05_reference_event_notes.sql",
      ),
      "utf8",
    );
    expect(eventSql).toContain("vs01_experience_reference_events");
    expect(eventSql).toContain("'RESTORED'");
    expect(eventSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(noteSql).toContain("ADD COLUMN note text NOT NULL");
  });

  it("records employee-owned execution and outcome transitions in an append-only migration", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0015_vs07_employee_owned_progression.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("EXECUTION_CONFIRMED_BY_EMPLOYEE");
    expect(sql).toContain("OUTCOME_CONFIRMED_BY_EMPLOYEE");
    expect(sql).toContain("EXECUTION_REVIEW_APPROVED");
  });

  it("stores Teach feedback as a tenant-isolated candidate with append-only events", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0016_vs11_guided_agent_analysis.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("vs01_assistant_feedback_candidates");
    expect(sql).toContain("vs01_assistant_feedback_events");
    expect(sql).toContain("'PENDING_REVIEW'");
    expect(sql).toContain("'WITHDRAWN'");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("repairs already-applied VS06 status and progress-event constraints append-only", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0013_vs06_confirmation_constraint_repair.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("'IN_PROGRESS'");
    expect(sql).toContain("'PROGRESS_SAVED'");
    expect(sql).toContain("vs01_project_subtask_events_event_type_check");
  });

  it("adds a tenant-isolated VS12 outbox, assistant state, and project-event trigger", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../migrations/0017_vs12_runtime_copilot.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE vs12_work_events");
    expect(sql).toContain("CREATE TABLE vs12_assistant_sessions");
    expect(sql).toContain("CREATE TABLE vs12_assistant_runs");
    expect(sql).toContain("CREATE TABLE vs12_assistant_stream_events");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("CREATE TRIGGER vs12_project_event_outbox_trigger");
    expect(sql).toContain("WORK_ITEM_CONFIRMED");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("UNIQUE (source_project_event_id)");
  });

  it("repairs the existing task material table with forced demo-tenant RLS", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../migrations/0020_vs15_task_material_rls.sql"),
      "utf8",
    );
    expect(sql).toContain(
      "ALTER TABLE vs01_task_materials FORCE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "DROP POLICY IF EXISTS task_material_tenant_isolation",
    );
    expect(sql).toContain("tenant_id = 'tenant-demo'");
  });

  it("adds the governed command receipt and immutable audit foundation", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../migrations/0027_governed_command_kernel.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE governed_command_receipts");
    expect(sql).toContain("CREATE TABLE governed_command_audit_events");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).toContain("history is append-only");
  });

  it("extends the existing VS16 history for governed PMC proposals", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../migrations/0028_workpaper_proposal.sql"),
      "utf8",
    );
    expect(sql).toContain("PMC_PROPOSAL");
    expect(sql).toContain("proposal_context");
    expect(sql).toContain("created_by_subject");
    expect(sql).toContain("vs16_workpaper_proposal_shape_check");
  });

  it("allows Evidence-only proposals without weakening the Evidence requirement", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0029_workpaper_proposal_optional_materials.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(
      "jsonb_array_length(proposal_context -> 'evidenceReferences') > 0",
    );
    expect(sql).toContain(
      "jsonb_typeof(proposal_context -> 'materialReferences') = 'array'",
    );
    expect(sql).not.toContain(
      "jsonb_array_length(proposal_context -> 'materialReferences') > 0",
    );
  });

  it("adds append-only governed material versions without weakening VS15 RLS", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0030_governed_material_create.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE vs15_governed_material_versions");
    expect(sql).toContain("REGISTERED");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("material versions are append-only");
    expect(sql).toContain(
      "SourceObject and SourceVersion identity is append-only",
    );
    expect(sql).toContain("vs15_task_material_locator_immutable");
  });

  it("adds one durable PMC employee assignment per project and preserves only unambiguous credentials", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0037_employee_project_assignments.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE app_project_assignments");
    expect(sql).toContain("PRIMARY KEY (tenant_id, project_id)");
    expect(sql).toContain("HAVING count(DISTINCT c.user_id) = 1");
    expect(sql).toContain(
      "ALTER TABLE app_project_assignments FORCE ROW LEVEL SECURITY",
    );
  });

  it("adds tenant-isolated Feishu employee bindings and idempotent notification receipts", async () => {
    const sql = await readFile(
      path.resolve(
        __dirname,
        "../migrations/0038_feishu_employee_notifications.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE app_feishu_user_bindings");
    expect(sql).toContain("UNIQUE (tenant_id, open_id)");
    expect(sql).toContain("CREATE TABLE app_feishu_work_notifications");
    expect(sql).toContain("UNIQUE (tenant_id, request_id)");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("indexes the three hot project reads without touching table shape", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../migrations/0039_project_read_indexes.sql"),
      "utf8",
    );
    expect(sql).toContain(
      "vs01_project_subtasks (tenant_id, node_id, phase_code)",
    );
    expect(sql).toContain("vs01_project_events (tenant_id, project_id, id)");
    expect(sql).toContain(
      "vs01_task_materials (tenant_id, task_id, created_at, id)",
    );
    // A read-path fix must not turn into a schema change.
    expect(sql).not.toMatch(/\b(ALTER TABLE|DROP|UPDATE|DELETE)\b/);
  });
});

const runVs12Integration = process.env.VS12_INTEGRATION === "1";
const vs12IntegrationDescribe = runVs12Integration ? describe : describe.skip;

vs12IntegrationDescribe("VS12 PostgreSQL transactional outbox", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("adds exactly one outbox event on commit and none on rollback", async () => {
    const createProject = async (id: string) => {
      await pool.query(
        "INSERT INTO vs01_projects (id, tenant_id, source_task_id, name, status, metric_before, metric_current, metric_target) VALUES ($1, 'tenant-demo', 'SO-202608128', 'VS12 测试任务', 'DRAFT', 71, 71, 85)",
        [id],
      );
    };
    const appendCompletedEvent = async (id: string) => {
      await pool.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ('tenant-demo', $1, 'TASK_COMPLETED', 'EXECUTION_CONTROL', '已确认完成测试事项', 'PMC', '{}'::jsonb)",
        [id],
      );
    };

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query(
        "INSERT INTO vs01_projects (id, tenant_id, source_task_id, name, status, metric_before, metric_current, metric_target) VALUES ('PRJ-VS12-ROLLBACK', 'tenant-demo', 'SO-202608128', 'VS12 回滚任务', 'DRAFT', 71, 71, 85)",
      );
      await rollbackClient.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ('tenant-demo', 'PRJ-VS12-ROLLBACK', 'TASK_COMPLETED', 'EXECUTION_CONTROL', '应随事务回滚', 'PMC', '{}'::jsonb)",
      );
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM vs12_work_events WHERE project_id = 'PRJ-VS12-ROLLBACK'",
          )
        ).rows[0]?.count ?? 0,
      ),
    ).toBe(0);

    await createProject("PRJ-VS12-COMMIT");
    await appendCompletedEvent("PRJ-VS12-COMMIT");
    const events = await pool.query(
      "SELECT event_type, source_event_type, correlation_key FROM vs12_work_events WHERE project_id = 'PRJ-VS12-COMMIT'",
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0]?.event_type).toBe("WORK_ITEM_CONFIRMED");
    expect(events.rows[0]?.source_event_type).toBe("TASK_COMPLETED");
    expect(String(events.rows[0]?.correlation_key)).toContain(
      "project:PRJ-VS12-COMMIT:tx:",
    );
  });
});
