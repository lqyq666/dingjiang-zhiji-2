import type { Pool, PoolClient, QueryResultRow } from "pg";
import { sha256 } from "./source-bundle";

/** Explicit, tenant-scoped joins. No fixture source alias is accepted here. */
export const productionFactsSql = `SELECT t.id, o.order_id, o.customer, o.promised_date, o.forecast_date,
 o.status AS order_status,o.source_row AS order_source_row,o.source_version_id AS order_source_version_id,ov.source_object_id AS order_source_object_id,
 b.planned_bom_date,b.actual_bom_date,b.completion_status,b.source_row AS bom_source_row,b.source_version_id AS bom_source_version_id,bv.source_object_id AS bom_source_object_id,
 GREATEST((b.actual_bom_date-b.planned_bom_date),0)::int AS bom_delay,
 p.planned_start_date,p.actual_start_date,p.arrival_risk,p.source_row AS purchase_source_row,p.source_version_id AS purchase_source_version_id,pv.source_object_id AS purchase_source_object_id,
 GREATEST((p.actual_start_date-p.planned_start_date),0)::int AS purchase_delay
 FROM vs01_tasks t JOIN vs01_orders o ON o.order_id=t.order_id AND o.tenant_id=t.tenant_id
 JOIN vs01_bom b ON b.order_id=o.order_id AND b.tenant_id=o.tenant_id
 JOIN vs01_purchases p ON p.order_id=o.order_id AND p.tenant_id=o.tenant_id
 JOIN production_source_files ofile ON ofile.source_version_id=o.source_version_id AND ofile.tenant_id=o.tenant_id
 JOIN production_source_files bfile ON bfile.source_version_id=b.source_version_id AND bfile.tenant_id=b.tenant_id AND bfile.batch_id=ofile.batch_id
 JOIN production_source_files pfile ON pfile.source_version_id=p.source_version_id AND pfile.tenant_id=p.tenant_id AND pfile.batch_id=ofile.batch_id
 JOIN vs01_source_versions ov ON ov.id=o.source_version_id AND ov.tenant_id=o.tenant_id
 JOIN vs01_source_versions bv ON bv.id=b.source_version_id AND bv.tenant_id=b.tenant_id
 JOIN vs01_source_versions pv ON pv.id=p.source_version_id AND pv.tenant_id=p.tenant_id
 WHERE t.id=$1 AND t.tenant_id=$2`;
export async function productionTaskFacts(
  db: Pool | PoolClient,
  taskId: string,
  tenant: string,
  pinExisting = true,
): Promise<QueryResultRow> {
  if (pinExisting) {
    const existing = await db.query(
      "SELECT s.order_facts FROM vs01_projects p LEFT JOIN production_project_snapshots s ON s.project_id=p.id AND s.tenant_id=p.tenant_id WHERE p.source_task_id=$1 AND p.tenant_id=$2",
      [taskId, tenant],
    );
    if (existing.rows[0]) {
      if (!existing.rows[0].order_facts)
        throw new Error(
          "Production project lacks a verified immutable source snapshot; migrate explicitly, never infer history",
        );
      return existing.rows[0].order_facts as QueryResultRow;
    }
  }
  const result = await db.query(productionFactsSql, [taskId, tenant]);
  if (result.rowCount !== 1)
    throw new Error("Task requires a complete versioned source import");
  return result.rows[0]!;
}
export function sourceLocator(
  row: QueryResultRow,
  kind: "order" | "bom" | "purchase",
) {
  const sourceObjectId = row[`${kind}_source_object_id`];
  const sourceVersionId = row[`${kind}_source_version_id`];
  const record = row[`${kind}_source_row`];
  if (
    typeof sourceObjectId !== "string" ||
    typeof sourceVersionId !== "string" ||
    !Number.isInteger(Number(record)) ||
    Number(record) < 2
  )
    throw new Error("Source locator is incomplete");
  return {
    sourceObjectId,
    sourceVersionId,
    reference: `${sourceVersionId} · CSV 逻辑记录 ${record}`,
  };
}
export async function pinProjectSnapshot(
  db: PoolClient,
  tenant: string,
  projectId: string,
  facts: QueryResultRow,
  cohort: QueryResultRow[],
  baseline: number,
): Promise<void> {
  for (const kind of ["order", "bom", "purchase"] as const)
    sourceLocator(facts, kind);
  if (!cohort.length || cohort.some((row) => !row.source_version_id))
    throw new Error("Metric cohort requires versioned source rows");
  const formula = "FORECAST_OTD_ALL_ORDERS_V1";
  const digest = sha256(JSON.stringify({ facts, cohort, formula, baseline }));
  await db.query(
    "INSERT INTO production_project_snapshots(tenant_id,project_id,order_facts,metric_cohort,metric_formula,metric_before,snapshot_sha256) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)",
    [
      tenant,
      projectId,
      JSON.stringify(facts),
      JSON.stringify(cohort),
      formula,
      baseline,
      digest,
    ],
  );
}
