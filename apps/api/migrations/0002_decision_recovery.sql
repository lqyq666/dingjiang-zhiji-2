CREATE TABLE IF NOT EXISTS vs01_decision_events (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES vs01_tasks(id),
  tenant_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('DECIDED', 'REVERTED')),
  decision_type text NOT NULL CHECK (decision_type IN ('CONFIRMED', 'MODIFIED', 'INSUFFICIENT_INFORMATION')),
  decision_note text NOT NULL,
  reason text,
  actor text NOT NULL CHECK (actor = 'PMC'),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vs01_decision_events (
  task_id,
  tenant_id,
  event_type,
  decision_type,
  decision_note,
  reason,
  actor,
  created_at
)
SELECT
  task_id,
  tenant_id,
  'DECIDED',
  type,
  note,
  NULL,
  decided_by,
  decided_at
FROM vs01_decisions current_decision
WHERE NOT EXISTS (
  SELECT 1
  FROM vs01_decision_events event
  WHERE event.task_id = current_decision.task_id
    AND event.tenant_id = current_decision.tenant_id
    AND event.event_type = 'DECIDED'
);

ALTER TABLE vs01_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_decision_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_decision_events_demo_tenant
  ON vs01_decision_events
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');
