CREATE TABLE vs01_experience_reference_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  reference_id text NOT NULL REFERENCES vs01_experience_references(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('CITED', 'WITHDRAWN', 'RESTORED')),
  actor text NOT NULL CHECK (actor = 'PMC'),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vs01_experience_reference_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_experience_reference_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_experience_reference_events_demo_tenant ON vs01_experience_reference_events USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
