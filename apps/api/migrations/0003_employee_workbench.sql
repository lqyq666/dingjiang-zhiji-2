CREATE TABLE vs01_task_materials (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE CASCADE,
  situation_code text NOT NULL CHECK (situation_code IN ('BOM_DELAY', 'PURCHASE_DELAY', 'CAPACITY_RISK')),
  title text NOT NULL,
  source_reference text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL CHECK (created_by = 'PMC'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vs01_project_subtasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  node_id text NOT NULL REFERENCES vs01_project_nodes(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'DONE')),
  sort_order integer NOT NULL,
  completion_note text NOT NULL DEFAULT '',
  completed_at timestamptz
);

CREATE TABLE vs01_project_subtask_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  subtask_id text NOT NULL REFERENCES vs01_project_subtasks(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('COMPLETED', 'REOPENED')),
  note text NOT NULL,
  actor text NOT NULL CHECK (actor = 'PMC'),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vs01_project_subtasks (id, tenant_id, node_id, title, sort_order)
SELECT seed.id, n.tenant_id, n.id, seed.title, seed.sort_order
FROM vs01_project_nodes n
CROSS JOIN (VALUES
  ('SUB-BOM-001', '完成 BOM 问题分类', 1),
  ('SUB-BOM-002', '补齐缺失 BOM 材料', 2),
  ('SUB-BOM-003', '输出治理清单并确认责任人', 3),
  ('SUB-BOM-004', '评审并发布治理规则', 4)
) AS seed(id, title, sort_order)
WHERE n.id = 'NODE-BOM-001'
ON CONFLICT (id) DO NOTHING;

ALTER TABLE vs01_task_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_project_subtasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_project_subtask_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_material_tenant_isolation ON vs01_task_materials
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY project_subtask_tenant_isolation ON vs01_project_subtasks
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY project_subtask_event_tenant_isolation ON vs01_project_subtask_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
