import type { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { sourceNames, type SourceBundle } from "./source-bundle";

/** Maintenance-only. Callers MUST authenticate a real OWNER/PMC first. This
 * method rechecks the account under a shared lock. No Web/MCP route is exposed.
 * All original bytes, parsed rows, projections and receipt commit together. */
export async function importSourceBundle(
  pool: Pool,
  tenant: string,
  subject: string,
  bundle: SourceBundle,
) {
  const client = await pool.connect();
  let commitStarted = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${tenant}:source-intake`,
    ]);
    const user = await client.query(
      "SELECT role FROM app_users WHERE id=$1 AND tenant_id=$2 AND active=true FOR SHARE",
      [subject, tenant],
    );
    if (!user.rows[0] || !["OWNER", "PMC"].includes(String(user.rows[0].role)))
      throw new Error("Active OWNER/PMC account required");
    const existing = await client.query(
      "SELECT manifest_sha256,order_count FROM production_import_batches WHERE tenant_id=$1 AND batch_id=$2",
      [tenant, bundle.batchId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].manifest_sha256 !== bundle.digest)
        throw new Error("batchId already binds different bytes");
      commitStarted = true;
      await client.query("COMMIT");
      return {
        batchId: bundle.batchId,
        digest: bundle.digest,
        replayed: true,
        orderCount: Number(existing.rows[0].order_count),
      };
    }
    // Full cumulative snapshots, never implicit deletion or lost old orders.
    const oldIds = await client.query(
      "SELECT order_id FROM vs01_orders WHERE tenant_id=$1",
      [tenant],
    );
    const newIds = new Set(
      bundle.files[0]!.records.map((row) => row.values.orderId),
    );
    if (oldIds.rows.some((row) => !newIds.has(String(row.order_id))))
      throw new Error(
        "A full snapshot must retain all existing order IDs; deletion is not supported",
      );
    await client.query(
      "INSERT INTO production_import_batches(tenant_id,batch_id,manifest_sha256,schema_version,actor_subject_id,order_count) VALUES($1,$2,$3,1,$4,$5)",
      [tenant, bundle.batchId, bundle.digest, subject, newIds.size],
    );
    const versions: Record<string, string> = {};
    for (const file of bundle.files) {
      // Stable per-enterprise object, append-only sequential versions.
      const objectId = `SRC-IMPORT-${createHash("sha256").update(`${tenant}:${file.name}`).digest("hex").slice(0, 32)}`;
      await client.query(
        "INSERT INTO vs01_source_objects(id,tenant_id,file_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
        [objectId, tenant, file.name],
      );
      const prior = await client.query(
        "SELECT coalesce(max(version_number),0)::int AS version FROM vs01_source_versions WHERE tenant_id=$1 AND source_object_id=$2",
        [tenant, objectId],
      );
      const versionId = `SRC-IMPORT-V-${randomUUID()}`;
      versions[file.name] = versionId;
      await client.query(
        "INSERT INTO vs01_source_versions(id,source_object_id,tenant_id,version_number) VALUES($1,$2,$3,$4)",
        [versionId, objectId, tenant, Number(prior.rows[0]!.version) + 1],
      );
      await client.query(
        "INSERT INTO production_source_files(tenant_id,source_version_id,batch_id,file_name,sha256,content,row_count) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          tenant,
          versionId,
          bundle.batchId,
          file.name,
          file.sha256,
          file.bytes,
          file.records.length,
        ],
      );
      // One bounded set-based statement per file rather than 30,000 round trips.
      await client.query(
        "INSERT INTO production_source_rows(tenant_id,source_version_id,order_id,source_row,row_data) SELECT $1,$2,x->'values'->>'orderId',(x->>'sourceRow')::int,x->'values' FROM jsonb_array_elements($3::jsonb) x",
        [tenant, versionId, JSON.stringify(file.records)],
      );
    }
    const assignments = [
      {
        table: "vs01_orders",
        fields: ["customer", "promised_date", "forecast_date", "status"],
        keys: ["customer", "promisedDate", "forecastDate", "status"],
        dates: [false, true, true, false],
      },
      {
        table: "vs01_bom",
        fields: ["planned_bom_date", "actual_bom_date", "completion_status"],
        keys: ["plannedBomDate", "actualBomDate", "completionStatus"],
        dates: [true, true, false],
      },
      {
        table: "vs01_purchases",
        fields: ["planned_start_date", "actual_start_date", "arrival_risk"],
        keys: ["plannedStartDate", "actualStartDate", "arrivalRisk"],
        dates: [true, true, false],
      },
    ];
    for (const [i, spec] of assignments.entries()) {
      const projection = spec.keys
        .map(
          (key, n) => `(row_data->>'${key}')${spec.dates[n] ? "::date" : ""}`,
        )
        .join(",");
      const set = [...spec.fields, "source_row", "source_version_id"]
        .map((key) => `${key}=excluded.${key}`)
        .join(",");
      // Table/column identifiers are constants above, never input from files.
      const applied = await client.query(
        `INSERT INTO ${spec.table}(order_id,tenant_id,${spec.fields.join(",")},source_row,source_version_id) SELECT order_id,tenant_id,${projection},source_row,source_version_id FROM production_source_rows WHERE tenant_id=$1 AND source_version_id=$2 ON CONFLICT(order_id) DO UPDATE SET ${set} WHERE ${spec.table}.tenant_id=excluded.tenant_id`,
        [tenant, versions[sourceNames[i]!]],
      );
      if (applied.rowCount !== newIds.size)
        throw new Error(
          "Projection row count mismatch; refusing partial or cross-tenant source application",
        );
    }
    await client.query(
      "INSERT INTO vs01_tasks(id,tenant_id,order_id,status) SELECT o.order_id,o.tenant_id,o.order_id,'OPEN' FROM vs01_orders o WHERE o.tenant_id=$1 AND o.forecast_date>o.promised_date AND NOT EXISTS(SELECT 1 FROM vs01_tasks t WHERE t.tenant_id=o.tenant_id AND t.order_id=o.order_id) ON CONFLICT(tenant_id,order_id) DO NOTHING",
      [tenant],
    );
    await client.query(
      "INSERT INTO app_identity_events(tenant_id,subject_id,event_type,details) VALUES($1,$2,'SOURCE_BUNDLE_IMPORTED',$3::jsonb)",
      [
        tenant,
        subject,
        JSON.stringify({
          batchId: bundle.batchId,
          digest: bundle.digest,
          orderCount: newIds.size,
        }),
      ],
    );
    commitStarted = true;
    await client.query("COMMIT");
    return {
      batchId: bundle.batchId,
      digest: bundle.digest,
      replayed: false,
      orderCount: newIds.size,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* do not mask failure */
    }
    if (commitStarted)
      throw new Error(
        "Import commit result is unknown; retry the SAME batchId and identical files to resolve its receipt",
        { cause: error },
      );
    throw error;
  } finally {
    client.release();
  }
}
