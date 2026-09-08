-- Additive only. Actual raw CSV bytes and immutable versions live in PostgreSQL;
-- a DB backup therefore captures imported data and its provenance atomically.
CREATE UNIQUE INDEX vs01_source_versions_tenant_id_unique ON vs01_source_versions(tenant_id,id);
CREATE UNIQUE INDEX vs01_projects_tenant_id_unique ON vs01_projects(tenant_id,id);
CREATE TABLE production_import_batches (
  tenant_id text NOT NULL,
  batch_id uuid NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version integer NOT NULL CHECK(schema_version=1),
  actor_subject_id uuid NOT NULL,
  order_count integer NOT NULL CHECK(order_count BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,batch_id),
  FOREIGN KEY(tenant_id,actor_subject_id) REFERENCES app_users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE production_source_files (
  tenant_id text NOT NULL,
  source_version_id text NOT NULL,
  batch_id uuid NOT NULL,
  file_name text NOT NULL CHECK(file_name IN ('orders.csv','bom.csv','purchases.csv')),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 5242880),
  row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 10000),
  PRIMARY KEY(tenant_id,source_version_id),
  UNIQUE(tenant_id,batch_id,file_name),
  FOREIGN KEY(tenant_id,batch_id) REFERENCES production_import_batches(tenant_id,batch_id),
  FOREIGN KEY(tenant_id,source_version_id) REFERENCES vs01_source_versions(tenant_id,id)
);
CREATE TABLE production_source_rows (
  tenant_id text NOT NULL,
  source_version_id text NOT NULL,
  order_id text NOT NULL,
  source_row integer NOT NULL CHECK(source_row>=2),
  row_data jsonb NOT NULL CHECK(jsonb_typeof(row_data)='object'),
  PRIMARY KEY(tenant_id,source_version_id,order_id),
  UNIQUE(tenant_id,source_version_id,source_row),
  FOREIGN KEY(tenant_id,source_version_id) REFERENCES production_source_files(tenant_id,source_version_id)
);
ALTER TABLE vs01_orders ADD COLUMN source_version_id text;
ALTER TABLE vs01_bom ADD COLUMN source_version_id text;
ALTER TABLE vs01_purchases ADD COLUMN source_version_id text;
ALTER TABLE vs01_orders ADD CONSTRAINT vs01_orders_source_tenant_fk FOREIGN KEY(tenant_id,source_version_id) REFERENCES vs01_source_versions(tenant_id,id);
ALTER TABLE vs01_bom ADD CONSTRAINT vs01_bom_source_tenant_fk FOREIGN KEY(tenant_id,source_version_id) REFERENCES vs01_source_versions(tenant_id,id);
ALTER TABLE vs01_purchases ADD CONSTRAINT vs01_purchases_source_tenant_fk FOREIGN KEY(tenant_id,source_version_id) REFERENCES vs01_source_versions(tenant_id,id);
CREATE TABLE production_project_snapshots (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  order_facts jsonb NOT NULL CHECK(jsonb_typeof(order_facts)='object'),
  metric_cohort jsonb NOT NULL CHECK(jsonb_typeof(metric_cohort)='array' AND jsonb_array_length(metric_cohort)>0),
  metric_formula text NOT NULL CHECK(metric_formula='FORECAST_OTD_ALL_ORDERS_V1'),
  metric_before integer NOT NULL CHECK(metric_before BETWEEN 0 AND 100),
  snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES vs01_projects(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['production_import_batches','production_source_files','production_source_rows','production_project_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, t);
    EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_governed_command_history_mutation()',t);
  END LOOP;
END $$;
