-- Additive identity store. No demonstration users or business data are inserted.
CREATE TABLE app_users (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  username text NOT NULL CHECK (username ~ '^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('PMC','OWNER','EXPERT_REVIEWER')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
CREATE TABLE app_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_sessions_user_idx ON app_sessions (tenant_id,user_id);
CREATE INDEX app_sessions_expiry_idx ON app_sessions (expires_at);
CREATE TABLE app_mcp_credentials (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  scopes text[] NOT NULL,
  project_ids text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_login_limits (
  tenant_id text NOT NULL,
  key_hash text NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  resets_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key_hash)
);
CREATE TABLE app_identity_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER app_identity_events_immutable
  BEFORE UPDATE OR DELETE ON app_identity_events
  FOR EACH ROW EXECUTE FUNCTION reject_governed_command_history_mutation();

-- Replace historical demo policies, including their permissive OR behavior.
-- Scope is fixed by the single-enterprise instance, or narrowed by its command
-- transaction. An unset/empty setting reveals no tenant rows.
DO $$
DECLARE t record; p record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind='r'
  LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t.relname
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',p.policyname,t.relname);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t.relname);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),''''))',t.relname);
  END LOOP;
END $$;
