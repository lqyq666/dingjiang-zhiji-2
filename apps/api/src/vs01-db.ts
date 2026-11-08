import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { Pool, types, type PoolClient } from "pg";
// DATE (OID 1082) must stay YYYY-MM-DD in every host timezone.
types.setTypeParser(1082, (value: string) => value);
import { isProduction, runtimeTenantId } from "./runtime-config";

export const migrations = [
  "0001_vs01",
  "0002_decision_recovery",
  "0003_employee_workbench",
  "0004_vs02_consulting_workbench",
  "0005_vs02_audit_hardening",
  "0006_vs02_recovery_hardening",
  "0007_vs02_event_constraint_repair",
  "0008_vs05_experience_review_and_reuse",
  "0009_vs05_republish_after_retraction",
  "0010_vs05_experience_reference_events",
  "0011_vs05_reference_event_notes",
  "0012_vs06_assignee_confirmations",
  "0013_vs06_confirmation_constraint_repair",
  "0014_vs06_execution_review",
  "0015_vs07_employee_owned_progression",
  "0016_vs11_guided_agent_analysis",
  "0017_vs12_runtime_copilot",
  "0018_vs12_scoped_sessions",
  "0019_vs15_traceable_materials",
  "0020_vs15_task_material_rls",
  "0021_vs16_root_cause_workpaper",
  "0022_vs16_command_payload_fingerprint",
  "0023_vs17_experience_intelligence",
  "0024_vs18_ai_atomic_tasks",
  "0025_vs18_money_proposal_draft",
  "0026_vs18_approval_resubmission",
  "0027_governed_command_kernel",
  "0028_workpaper_proposal",
  "0029_workpaper_proposal_optional_materials",
  "0030_governed_material_create",
  "0031_governed_material_verification",
  "0032_governed_evidence_intake",
  "0033_production_identity_and_tenant_rls",
  "0034_production_operational_hardening",
  "0035_production_source_intake",
  "0036_production_human_authorization",
  "0037_employee_project_assignments",
  "0038_feishu_employee_notifications",
  "0039_project_read_indexes",
  "0040_feishu_delivery_reliability",
] as const;
const tenantId = "tenant-demo";
const sourceDefinitions = [
  ["SRC-ORDERS", "SRC-ORDERS-V1", "orders.csv"],
  ["SRC-BOM", "SRC-BOM-V1", "bom.csv"],
  ["SRC-PURCHASES", "SRC-PURCHASES-V1", "purchases.csv"],
] as const;

type CsvRow = Record<string, string>;

const defaultDatabaseUrl =
  "postgres://dingjiang:local-only-password@127.0.0.1:5432/dingjiang";
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

export const localDatabaseUrl = (candidate: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("DATABASE_URL must be a valid local PostgreSQL URL");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!localHosts.has(host))
    throw new Error("DATABASE_URL must use a local loopback host");
  return candidate;
};

export const databaseUrl = (): string => {
  if (!isProduction())
    return localDatabaseUrl(process.env.DATABASE_URL ?? defaultDatabaseUrl);
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error("Production requires DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    !parsed.password ||
    parsed.password === "local-only-password"
  )
    throw new Error("DATABASE_URL must use explicit PostgreSQL credentials");
  return configured;
};

export const createPool = (connectionString = databaseUrl()): Pool => {
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: `-c app.tenant_id=${runtimeTenantId()} -c statement_timeout=30000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=30000`,
  });
  // An idle connection failure must not become an unhandled EventEmitter error.
  pool.on("error", () => console.error("database_idle_connection_error"));
  return pool;
};

/** Read-only startup gate. Migrations belong to the separate release step. */
export async function assertDatabaseReady(pool: Pool): Promise<void> {
  const applied = await pool.query("SELECT id FROM schema_migrations");
  const versions = new Set(applied.rows.map((row) => row.id));
  const known = new Set<string>(migrations);
  if ([...versions].some((id) => !known.has(String(id))))
    throw new Error(
      "Database schema is newer than this application; unverified binary rollback is refused",
    );
  if (migrations.some((id) => !versions.has(id)))
    throw new Error(
      "Database migrations are pending; run the release migration step",
    );
  const privilege = await pool.query(
    "SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'USAGE')) AS owns_tables FROM pg_roles r WHERE r.rolname=current_user",
  );
  const role = privilege.rows[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.owns_tables
  )
    throw new Error(
      "Production database identity must not own tables or bypass RLS",
    );
  const unsafe = await pool.query(
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)",
  );
  if (unsafe.rowCount !== 0)
    throw new Error("Business tables must enforce tenant RLS");
  const broad = await pool.query(
    "SELECT has_schema_privilege(current_user,'public','CREATE') AS schema_create, has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE') AS migration_write, EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'TRUNCATE')) AS can_truncate, current_setting('app.tenant_id',true) AS tenant",
  );
  const permissions = broad.rows[0];
  if (
    !permissions ||
    permissions.schema_create ||
    permissions.migration_write ||
    permissions.can_truncate
  )
    throw new Error(
      "Runtime identity must not modify schemas, migrations, or truncate tables",
    );
  if (permissions.tenant !== runtimeTenantId())
    throw new Error("Runtime database tenant does not match this enterprise");
  const authorizations = await pool.query(
    "SELECT has_table_privilege(current_user,'production_human_approvals','INSERT,DELETE,UPDATE') AS can_forge,has_column_privilege(current_user,'production_human_approvals','approval_digest','UPDATE') AS can_change_digest,has_column_privilege(current_user,'production_human_approvals','consumed_at','UPDATE') AS can_consume,has_table_privilege(current_user,'production_import_batches','INSERT,UPDATE,DELETE') AS can_import",
  );
  const acl = authorizations.rows[0];
  if (
    !acl ||
    acl.can_forge ||
    acl.can_change_digest ||
    !acl.can_consume ||
    acl.can_import
  )
    throw new Error(
      "Runtime must only consume trusted human approvals, never forge approvals/import history",
    );
}

const fixtureDirectory = (): string => {
  const candidates = [
    process.env.VS01_FIXTURES_DIR,
    path.resolve(process.cwd(), "fixtures/vs01"),
    path.resolve(process.cwd(), "../../fixtures/vs01"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("VS01 fixture directory was not found");
  return found;
};

const parseCsv = (text: string): CsvRow[] => {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  if (!headerLine) return [];
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const fields = line.split(",");
    return Object.fromEntries(
      headers.map((header, index) => [header, fields[index] ?? ""]),
    );
  });
};

const fixture = async (name: string): Promise<CsvRow[]> =>
  parseCsv(await readFile(path.join(fixtureDirectory(), name), "utf8"));

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(749216003)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)",
    );
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text",
    );
    // A migration file that was rewritten after it had been applied leaves a
    // record behind that no longer matches the repository. The database then
    // keeps tables the current schema never creates, and it silently diverges
    // from a fresh deployment. Refuse instead of running on a schema nobody
    // can reproduce.
    const appliedIds = await client.query("SELECT id FROM schema_migrations");
    const known = new Set<string>(migrations);
    const orphans = appliedIds.rows
      .map((row) => String(row.id))
      .filter((id) => !known.has(id));
    if (orphans.length > 0)
      throw new Error(
        `Database has applied migrations that no longer exist in the repository: ${orphans.join(", ")}. ` +
          "The schema and the migration files have diverged; recreate the database.",
      );
    for (const migrationId of migrations) {
      const sql = await readFile(
        path.resolve(__dirname, `../migrations/${migrationId}.sql`),
        "utf8",
      );
      const checksum = createHash("sha256")
        .update(sql.replace(/\r\n/g, "\n"))
        .digest("hex");
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE id=$1",
        [migrationId],
      );
      if (applied.rowCount !== 0) {
        const previous = applied.rows[0]?.checksum;
        if (previous && previous !== checksum)
          throw new Error(`Migration checksum mismatch: ${migrationId}`);
        if (!previous) {
          if (
            isProduction() &&
            process.env.DINGJIANG_BASELINE_MIGRATIONS !== "backup-verified"
          )
            throw new Error(
              "Legacy migration checksums require a verified backup and DINGJIANG_BASELINE_MIGRATIONS=backup-verified",
            );
          await client.query(
            "UPDATE schema_migrations SET checksum=$2 WHERE id=$1",
            [migrationId, checksum],
          );
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (id,checksum) VALUES ($1,$2)",
        [migrationId, checksum],
      );
    }
    await assertMigrationInvariants(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertMigrationInvariants(client: PoolClient): Promise<void> {
  const projectEventConstraint = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'vs01_project_events'::regclass AND conname = 'vs01_project_events_event_type_check'",
  );
  const projectEventDefinition = String(
    projectEventConstraint.rows[0]?.definition ?? "",
  );
  if (
    !projectEventDefinition.includes("FORMAL_EXPERIENCE_PUBLISHED") ||
    !projectEventDefinition.includes("EXPERIENCE_RESUBMITTED") ||
    !projectEventDefinition.includes("PROGRESS_SAVED") ||
    !projectEventDefinition.includes("OUTCOME_CONFIRMED_BY_EMPLOYEE")
  )
    throw new Error(
      "vs01_project_events constraint is missing required lifecycle events",
    );
  const workItemStatusConstraint = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'vs01_project_subtasks'::regclass AND conname = 'vs01_project_subtasks_status_check'",
  );
  if (
    !String(workItemStatusConstraint.rows[0]?.definition ?? "").includes(
      "IN_PROGRESS",
    )
  )
    throw new Error(
      "vs01_project_subtasks status constraint is missing IN_PROGRESS",
    );
  const workItemEventConstraint = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'vs01_project_subtask_events'::regclass AND conname = 'vs01_project_subtask_events_event_type_check'",
  );
  if (
    !String(workItemEventConstraint.rows[0]?.definition ?? "").includes(
      "PROGRESS_SAVED",
    )
  )
    throw new Error(
      "vs01_project_subtask_events constraint is missing PROGRESS_SAVED",
    );
  const workEventConstraint = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'vs12_work_events'::regclass AND conname = 'vs12_work_events_event_type_check'",
  );
  if (
    !String(workEventConstraint.rows[0]?.definition ?? "").includes(
      "WORK_ITEM_CONFIRMED",
    )
  )
    throw new Error(
      "vs12_work_events constraint is missing WORK_ITEM_CONFIRMED",
    );
  const workEventTrigger = await client.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid = 'vs01_project_events'::regclass AND tgname = 'vs12_project_event_outbox_trigger' AND NOT tgisinternal",
  );
  if (workEventTrigger.rowCount !== 1)
    throw new Error("vs12 project-event outbox trigger is missing");
  const workpaperRls = await client.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('vs16_root_cause_workpapers', 'vs16_root_cause_workpaper_versions', 'vs16_root_cause_workpaper_evidence', 'vs16_root_cause_workpaper_commands')",
  );
  if (
    workpaperRls.rowCount !== 4 ||
    workpaperRls.rows.some(
      (row) => row.relrowsecurity !== true || row.relforcerowsecurity !== true,
    )
  )
    throw new Error("VS16 workpaper tables must enforce row-level security");
  const materialRls = await client.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('vs01_task_materials', 'vs15_material_contents', 'vs15_material_events', 'vs15_governed_material_versions')",
  );
  if (
    materialRls.rowCount !== 4 ||
    materialRls.rows.some(
      (row) => row.relrowsecurity !== true || row.relforcerowsecurity !== true,
    )
  )
    throw new Error("VS15 material tables must enforce row-level security");
  const governedCommandRls = await client.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('governed_command_receipts', 'governed_command_audit_events')",
  );
  if (
    governedCommandRls.rowCount !== 2 ||
    governedCommandRls.rows.some(
      (row) => row.relrowsecurity !== true || row.relforcerowsecurity !== true,
    )
  )
    throw new Error("Governed command history must enforce row-level security");
}

export async function resetAndSeed(pool: Pool): Promise<void> {
  if (isProduction())
    throw new Error("Demo seed/reset is disabled in production");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await clear(client);
    await seed(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Recreate the database from the migration files.
 *
 * `resetAndSeed` only truncates the business tables, so it cannot repair a
 * database whose shape has drifted from the repository - for example one that
 * still carries the tables of a migration file that was later rewritten.
 * This drops the schema instead, which removes every leftover object, and
 * then replays the migrations and the demo seed.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  if (isProduction())
    throw new Error("Demo seed/reset is disabled in production");
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    // A freshly created schema is not the same thing as the one PostgreSQL
    // ships with. The default public schema carries USAGE for PUBLIC, and
    // `CREATE SCHEMA public` does not: without this grant every runtime role
    // loses sight of every table and reports "relation does not exist"
    // instead of the permission error it should report.
    await client.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
    await client.query("ALTER SCHEMA public OWNER TO pg_database_owner");
  } finally {
    client.release();
  }
  await migrate(pool);
  await resetAndSeed(pool);
}

async function clear(client: PoolClient): Promise<void> {
  await client.query(
    "TRUNCATE vs32_formal_evidence, vs32_evidence_confirmations, vs32_evidence_proposals, vs18_task_proposal_events, vs18_approval_requests, vs18_task_proposals, vs17_experience_command_receipts, vs17_experience_ai_runs, vs12_assistant_stream_events, vs12_assistant_runs, vs12_assistant_sessions, vs12_work_events, vs16_root_cause_workpaper_commands, vs16_root_cause_workpaper_evidence, vs16_root_cause_workpaper_versions, vs16_root_cause_workpapers, vs01_assistant_feedback_events, vs01_assistant_feedback_candidates, vs01_project_events, vs01_experience_reference_events, vs01_experience_references, vs01_formal_experiences, vs01_experience_candidate_revisions, vs01_experience_candidates, vs01_result_validations, vs01_project_subtask_events, vs15_governed_material_versions, vs01_project_subtasks, vs01_project_phases, vs15_material_events, vs15_material_contents, vs01_task_materials, vs01_node_updates, vs01_project_nodes, vs01_projects, vs01_decision_events, vs01_decisions, vs01_tasks, vs01_purchases, vs01_bom, vs01_orders RESTART IDENTITY CASCADE",
  );
  await client.query(
    "DELETE FROM vs01_source_versions WHERE tenant_id = $1 AND (source_object_id LIKE 'SRC-PROJECT-%' OR source_object_id LIKE 'SRC-EXPERIENCE-%' OR source_object_id LIKE 'SRC-MATERIAL-%' OR source_object_id LIKE 'SRC-WORKPAPER-%')",
    [tenantId],
  );
  await client.query(
    "DELETE FROM vs01_source_objects WHERE tenant_id = $1 AND (id LIKE 'SRC-PROJECT-%' OR id LIKE 'SRC-EXPERIENCE-%' OR id LIKE 'SRC-MATERIAL-%' OR id LIKE 'SRC-WORKPAPER-%')",
    [tenantId],
  );
}

async function seed(client: PoolClient): Promise<void> {
  const [orders, bom, purchases] = await Promise.all([
    fixture("orders.csv"),
    fixture("bom.csv"),
    fixture("purchases.csv"),
  ]);
  for (const [objectId, versionId, fileName] of sourceDefinitions) {
    await client.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [objectId, tenantId, fileName],
    );
    await client.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ($1, $2, $3, 1) ON CONFLICT (id) DO NOTHING",
      [versionId, objectId, tenantId],
    );
  }
  for (const [index, row] of orders.entries()) {
    await client.query(
      "INSERT INTO vs01_orders (order_id, tenant_id, customer, promised_date, forecast_date, status, source_row) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        row.orderId,
        tenantId,
        row.customer,
        row.promisedDate,
        row.forecastDate,
        row.status,
        index + 2,
      ],
    );
  }
  for (const [index, row] of bom.entries()) {
    await client.query(
      "INSERT INTO vs01_bom (order_id, tenant_id, planned_bom_date, actual_bom_date, completion_status, source_row) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        row.orderId,
        tenantId,
        row.plannedBomDate,
        row.actualBomDate,
        row.completionStatus,
        index + 2,
      ],
    );
  }
  for (const [index, row] of purchases.entries()) {
    await client.query(
      "INSERT INTO vs01_purchases (order_id, tenant_id, planned_start_date, actual_start_date, arrival_risk, source_row) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        row.orderId,
        tenantId,
        row.plannedStartDate,
        row.actualStartDate,
        row.arrivalRisk,
        index + 2,
      ],
    );
  }
  await client.query(
    "INSERT INTO vs01_tasks (id, tenant_id, order_id, status) SELECT order_id, $1, order_id, 'OPEN' FROM vs01_orders WHERE order_id IN ('SO-202608128', 'SO-202608136')",
    [tenantId],
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  // Validation happens before opening a connection or running any DDL.
  if (!["migrate", "seed", "reset"].includes(command ?? ""))
    throw new Error("Use migrate, seed, or reset");
  if (isProduction() && command !== "migrate")
    throw new Error("Demo seed/reset is disabled in production");
  let connectionString = databaseUrl();
  if (isProduction()) {
    const value = process.env.MIGRATION_DATABASE_URL;
    if (!value)
      throw new Error(
        "Production migration requires separate MIGRATION_DATABASE_URL",
      );
    const url = new URL(value);
    const runtime = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      url.username === runtime.username
    )
      throw new Error(
        "Migration identity must be an explicit PostgreSQL identity distinct from runtime",
      );
    if (
      url.hostname !== runtime.hostname ||
      url.port !== runtime.port ||
      url.pathname !== runtime.pathname
    )
      throw new Error(
        "Migration and runtime identities must target the same database",
      );
    connectionString = value;
  }
  const pool = createPool(connectionString);
  try {
    if (command === "reset") await resetDatabase(pool);
    else {
      await migrate(pool);
      if (command === "seed") await resetAndSeed(pool);
    }
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  void main().catch(() => {
    // Detailed SQL / connection strings must not enter deployment logs.
    console.error(
      "Database operation failed; verify configuration, migration checksums and privileges.",
    );
    process.exitCode = 1;
  });
