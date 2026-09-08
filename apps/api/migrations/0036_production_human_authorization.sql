-- Nonsecret credential ID lets a confirmation bind to a revocable individual
-- credential without ever carrying the bearer token or its hash in a payload.
ALTER TABLE app_mcp_credentials ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX app_mcp_credentials_tenant_id_unique ON app_mcp_credentials(tenant_id,id);
CREATE TABLE production_human_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  actor_subject_id uuid NOT NULL,
  actor_role text NOT NULL CHECK(actor_role IN ('OWNER','PMC','EXPERT_REVIEWER')),
  credential_id uuid NOT NULL,
  command_name text NOT NULL,
  request_id uuid NOT NULL,
  project_id text NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>=0),
  approval_digest text NOT NULL CHECK(approval_digest ~ '^[0-9a-f]{64}$'),
  display_summary jsonb NOT NULL CHECK(jsonb_typeof(display_summary)='object'),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  consumed_at timestamptz,
  UNIQUE(tenant_id,command_name,request_id),
  CHECK(expires_at>approved_at AND expires_at<=approved_at+interval '11 minutes'),
  FOREIGN KEY(tenant_id,actor_subject_id) REFERENCES app_users(tenant_id,id),
  FOREIGN KEY(tenant_id,credential_id) REFERENCES app_mcp_credentials(tenant_id,id)
);
ALTER TABLE production_human_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_human_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_human_approvals
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),''));
CREATE INDEX production_human_approvals_pending ON production_human_approvals(tenant_id,expires_at) WHERE consumed_at IS NULL;
CREATE FUNCTION guard_human_approval_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Human authorization history cannot be deleted'; END IF;
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR
     (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at') OR
     OLD.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Human authorization is immutable and single-use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER human_approval_immutable BEFORE UPDATE OR DELETE ON production_human_approvals
 FOR EACH ROW EXECUTE FUNCTION guard_human_approval_mutation();
