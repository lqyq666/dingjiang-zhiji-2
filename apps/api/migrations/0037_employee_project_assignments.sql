-- One PMC owns the employee work queue for a project. Project ids may be
-- reserved before project creation, so this intentionally has no project FK.
CREATE TABLE app_project_assignments (
  tenant_id text NOT NULL,
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$'),
  user_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX app_project_assignments_user_idx
  ON app_project_assignments (tenant_id, user_id);

-- Preserve unambiguous active RC2 credentials during an additive upgrade.
-- Ambiguous shared-project credentials are deliberately not guessed.
WITH unique_assignments AS (
  SELECT c.tenant_id,
         project_id,
         (array_agg(DISTINCT c.user_id))[1] AS user_id
  FROM app_mcp_credentials c
  JOIN app_users u
    ON u.tenant_id = c.tenant_id
   AND u.id = c.user_id
   AND u.active
   AND u.role = 'PMC'
  CROSS JOIN LATERAL unnest(c.project_ids) AS assigned(project_id)
  WHERE c.active AND c.expires_at > now()
  GROUP BY c.tenant_id, project_id
  HAVING count(DISTINCT c.user_id) = 1
)
INSERT INTO app_project_assignments (tenant_id, project_id, user_id)
SELECT tenant_id, project_id, user_id
FROM unique_assignments
ON CONFLICT (tenant_id, project_id) DO NOTHING;

ALTER TABLE app_project_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_project_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_project_assignments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
