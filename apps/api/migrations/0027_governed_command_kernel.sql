CREATE TABLE governed_command_receipts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  command_name text NOT NULL CHECK (command_name ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$'),
  request_id uuid NOT NULL,
  project_id text NOT NULL,
  actor_subject_id text NOT NULL,
  actor_role text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  result_version integer NOT NULL CHECK (result_version > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  correlation_id uuid NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, command_name, request_id)
);

CREATE INDEX governed_command_receipts_scope_idx
  ON governed_command_receipts (tenant_id, project_id, created_at DESC);

ALTER TABLE governed_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY governed_command_receipts_tenant_scope
  ON governed_command_receipts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE governed_command_audit_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  command_receipt_id uuid NOT NULL REFERENCES governed_command_receipts(id) ON DELETE RESTRICT,
  command_name text NOT NULL,
  request_id uuid NOT NULL,
  project_id text NOT NULL,
  actor_subject_id text NOT NULL,
  actor_role text NOT NULL,
  reason text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  result_version integer NOT NULL CHECK (result_version > 0),
  correlation_id uuid NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  audit_kind text NOT NULL DEFAULT 'COMMAND_SUCCEEDED'
    CHECK (audit_kind IN ('COMMAND_SUCCEEDED', 'COMPENSATION_RECORDED')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governed_command_audit_events_scope_idx
  ON governed_command_audit_events (tenant_id, project_id, created_at DESC);

ALTER TABLE governed_command_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_command_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY governed_command_audit_events_tenant_scope
  ON governed_command_audit_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE OR REPLACE FUNCTION reject_governed_command_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Governed command history is append-only';
END;
$$;

CREATE TRIGGER governed_command_receipts_immutable
  BEFORE UPDATE OR DELETE ON governed_command_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_governed_command_history_mutation();

CREATE TRIGGER governed_command_audit_events_immutable
  BEFORE UPDATE OR DELETE ON governed_command_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_governed_command_history_mutation();
