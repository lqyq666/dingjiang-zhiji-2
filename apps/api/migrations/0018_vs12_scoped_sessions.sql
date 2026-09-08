-- VS12 sessions are private to an authenticated demo subject and role.
ALTER TABLE vs12_assistant_sessions
  DROP CONSTRAINT IF EXISTS vs12_assistant_sessions_tenant_id_project_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS vs12_assistant_sessions_scope_key
  ON vs12_assistant_sessions (tenant_id, project_id, subject_id, role, policy_version);
