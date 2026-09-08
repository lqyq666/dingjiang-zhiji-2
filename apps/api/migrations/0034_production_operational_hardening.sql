-- Additive upgrade: no historical migrations or business facts are overwritten.
ALTER TABLE app_users ADD CONSTRAINT app_users_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE app_sessions ADD CONSTRAINT app_sessions_tenant_user_fkey
  FOREIGN KEY (tenant_id,user_id) REFERENCES app_users(tenant_id,id);
ALTER TABLE app_mcp_credentials ADD CONSTRAINT app_mcp_credentials_tenant_user_fkey
  FOREIGN KEY (tenant_id,user_id) REFERENCES app_users(tenant_id,id);
ALTER TABLE app_mcp_credentials ADD COLUMN expires_at timestamptz NOT NULL
  DEFAULT (now() + interval '30 days');
CREATE INDEX app_mcp_credentials_user_idx ON app_mcp_credentials (tenant_id,user_id);
CREATE INDEX app_login_limits_expiry_idx ON app_login_limits (resets_at);
CREATE INDEX governed_work_revision_idx ON governed_command_receipts (tenant_id,project_id,command_name);
CREATE INDEX vs01_project_tenant_status_idx ON vs01_projects (tenant_id,status);
CREATE INDEX vs01_task_tenant_status_idx ON vs01_tasks (tenant_id,status);

-- Keep demo reset fixtures compatible, but protect actual enterprise history.
-- Runtime privileges also deny TRUNCATE and source-history modification.
CREATE OR REPLACE FUNCTION reject_production_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id <> 'tenant-demo' THEN
    RAISE EXCEPTION 'Production source and audit history are append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vs01_source_objects_no_delete BEFORE DELETE ON vs01_source_objects
  FOR EACH ROW EXECUTE FUNCTION reject_production_history_mutation();
CREATE TRIGGER vs01_source_versions_no_delete BEFORE DELETE ON vs01_source_versions
  FOR EACH ROW EXECUTE FUNCTION reject_production_history_mutation();
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'vs01_project_events','vs01_decision_events','vs01_project_subtask_events',
    'vs01_node_updates','vs01_experience_reference_events','vs01_assistant_feedback_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER production_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_production_history_mutation()', name);
  END LOOP;
END $$;
