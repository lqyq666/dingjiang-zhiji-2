CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vs01_source_objects (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  file_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vs01_source_versions (
  id text PRIMARY KEY,
  source_object_id text NOT NULL REFERENCES vs01_source_objects(id),
  tenant_id text NOT NULL,
  version_number integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_object_id, version_number)
);

CREATE TABLE IF NOT EXISTS vs01_orders (
  order_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer text NOT NULL,
  promised_date date NOT NULL,
  forecast_date date NOT NULL,
  status text NOT NULL,
  source_row integer NOT NULL CHECK (source_row >= 2)
);

CREATE TABLE IF NOT EXISTS vs01_bom (
  order_id text PRIMARY KEY REFERENCES vs01_orders(order_id),
  tenant_id text NOT NULL,
  planned_bom_date date NOT NULL,
  actual_bom_date date NOT NULL,
  completion_status text NOT NULL,
  source_row integer NOT NULL CHECK (source_row >= 2)
);

CREATE TABLE IF NOT EXISTS vs01_purchases (
  order_id text PRIMARY KEY REFERENCES vs01_orders(order_id),
  tenant_id text NOT NULL,
  planned_start_date date NOT NULL,
  actual_start_date date NOT NULL,
  arrival_risk text NOT NULL,
  source_row integer NOT NULL CHECK (source_row >= 2)
);

CREATE TABLE IF NOT EXISTS vs01_tasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL REFERENCES vs01_orders(order_id),
  status text NOT NULL CHECK (status IN ('OPEN', 'DECIDED')),
  UNIQUE (tenant_id, order_id)
);

CREATE TABLE IF NOT EXISTS vs01_decisions (
  task_id text PRIMARY KEY REFERENCES vs01_tasks(id),
  tenant_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('CONFIRMED', 'MODIFIED', 'INSUFFICIENT_INFORMATION')),
  note text NOT NULL,
  decided_by text NOT NULL CHECK (decided_by = 'PMC'),
  decided_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS vs01_projects (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  source_task_id text NOT NULL UNIQUE REFERENCES vs01_tasks(id),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'RUNNING', 'COMPLETED')),
  returned_reason text,
  metric_before integer NOT NULL CHECK (metric_before BETWEEN 0 AND 100),
  metric_current integer NOT NULL CHECK (metric_current BETWEEN 0 AND 100),
  metric_target integer NOT NULL CHECK (metric_target BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS vs01_project_nodes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL UNIQUE REFERENCES vs01_projects(id),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')),
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  latest_update text NOT NULL
);

CREATE TABLE IF NOT EXISTS vs01_node_updates (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  node_id text NOT NULL REFERENCES vs01_project_nodes(id),
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  update_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vs01_source_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_source_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_source_objects_demo_tenant ON vs01_source_objects USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_source_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_source_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_source_versions_demo_tenant ON vs01_source_versions USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_orders_demo_tenant ON vs01_orders USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_bom ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_bom FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_bom_demo_tenant ON vs01_bom USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_purchases_demo_tenant ON vs01_purchases USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_tasks_demo_tenant ON vs01_tasks USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_decisions_demo_tenant ON vs01_decisions USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_projects_demo_tenant ON vs01_projects USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_project_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_project_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_project_nodes_demo_tenant ON vs01_project_nodes USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_node_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_node_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_node_updates_demo_tenant ON vs01_node_updates USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
