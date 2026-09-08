CREATE TABLE vs18_task_proposals (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  phase_code text NOT NULL,
  source_work_item_id text NOT NULL REFERENCES vs01_project_subtasks(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 2 AND 300),
  basis text NOT NULL CHECK (char_length(basis) BETWEEN 2 AND 500),
  approval_kind text NOT NULL CHECK (approval_kind IN ('NONE', 'MONEY', 'DIRECTION')),
  amount numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  status text NOT NULL CHECK (status IN ('PROPOSED', 'ACCEPTED', 'PENDING_APPROVAL', 'SUPERSEDED')),
  provider text NOT NULL DEFAULT 'DEMO_RULES' CHECK (provider = 'DEMO_RULES'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((approval_kind = 'MONEY' AND amount IS NOT NULL) OR (approval_kind <> 'MONEY' AND amount IS NULL))
);

CREATE INDEX vs18_task_proposals_scope_idx ON vs18_task_proposals (tenant_id, project_id, phase_code, created_at DESC);
ALTER TABLE vs18_task_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs18_task_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY vs18_task_proposals_demo_tenant ON vs18_task_proposals USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE TABLE vs18_approval_requests (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  proposal_id uuid NOT NULL UNIQUE REFERENCES vs18_task_proposals(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  approval_kind text NOT NULL CHECK (approval_kind IN ('MONEY', 'DIRECTION')),
  amount numeric(14,2),
  summary text NOT NULL,
  approver_open_id text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED')),
  decision_note text,
  decided_at timestamptz,
  feishu_delivery_status text NOT NULL CHECK (feishu_delivery_status IN ('NOT_CONFIGURED', 'SENT', 'FAILED')),
  feishu_message_id text,
  feishu_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PENDING' AND decided_at IS NULL) OR (status <> 'PENDING' AND decided_at IS NOT NULL))
);

ALTER TABLE vs18_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs18_approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY vs18_approval_requests_demo_tenant ON vs18_approval_requests USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE TABLE vs18_task_proposal_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  proposal_id uuid NOT NULL REFERENCES vs18_task_proposals(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('GENERATED', 'EDITED', 'ACCEPTED', 'APPROVAL_REQUESTED', 'SUPERSEDED', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED')),
  actor text NOT NULL CHECK (actor IN ('PMC', 'OWNER', 'SYSTEM')),
  note text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vs18_task_proposal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs18_task_proposal_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs18_task_proposal_events_demo_tenant ON vs18_task_proposal_events USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE OR REPLACE FUNCTION vs18_reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VS18 task proposal events are append-only';
END;
$$;

CREATE TRIGGER vs18_task_proposal_events_immutable BEFORE UPDATE OR DELETE ON vs18_task_proposal_events
  FOR EACH ROW EXECUTE FUNCTION vs18_reject_event_mutation();
