-- Bind an internal account to one Feishu identity without exposing the mapping
-- to business agents. Notifications are an audited collaboration projection;
-- PostgreSQL remains the business source of truth.
CREATE TABLE app_feishu_user_bindings (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  open_id text NOT NULL CHECK (open_id ~ '^ou_[A-Za-z0-9_-]{8,80}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, open_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE app_feishu_work_notifications (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  project_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('event.start')),
  project_name text NOT NULL CHECK (char_length(project_name) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENDING','SENT','FAILED','NOT_CONFIGURED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX app_feishu_work_notifications_pending_idx
  ON app_feishu_work_notifications (tenant_id, status, created_at);

ALTER TABLE app_feishu_user_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_feishu_user_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_feishu_user_bindings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

ALTER TABLE app_feishu_work_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_feishu_work_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_feishu_work_notifications
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
