ALTER TABLE vs01_task_materials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_material_tenant_isolation ON vs01_task_materials;
CREATE POLICY task_material_tenant_isolation ON vs01_task_materials
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');
