CREATE TABLE vs17_experience_ai_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text REFERENCES vs01_projects(id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('EXTRACT', 'PUBLISH', 'ANSWER')),
  provider text NOT NULL CHECK (provider IN ('COZE', 'DEMO_RULES')),
  workflow_id text,
  request_id uuid NOT NULL,
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  input_refs jsonb NOT NULL,
  structured_output jsonb,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  execute_id text,
  debug_url text,
  usage jsonb,
  error_code text CHECK (error_code IN ('INVALID_PROVIDER_OUTPUT', 'PROVIDER_TIMEOUT', 'PROVIDER_FAILED', 'INDEX_FAILED')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, request_id),
  CHECK (
    (status = 'RUNNING' AND completed_at IS NULL AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'SUCCEEDED' AND completed_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'FAILED' AND completed_at IS NOT NULL AND error_code IS NOT NULL AND error_message IS NOT NULL AND structured_output IS NULL)
  )
);

CREATE INDEX vs17_experience_ai_runs_project_created_idx
  ON vs17_experience_ai_runs (tenant_id, project_id, created_at DESC);

ALTER TABLE vs17_experience_ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs17_experience_ai_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY vs17_experience_ai_runs_demo_tenant ON vs17_experience_ai_runs
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE TABLE vs17_experience_command_receipts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  route text NOT NULL CHECK (route IN ('VS17_AI_DRAFT', 'VS17_FEISHU_PUSH', 'VS17_FEISHU_PULL', 'VS17_COZE_PUBLISH', 'VS17_ANSWER')),
  request_id uuid NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  response jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, route, request_id),
  CHECK (
    (status = 'RUNNING' AND completed_at IS NULL AND response IS NULL AND error_code IS NULL)
    OR (status = 'SUCCEEDED' AND completed_at IS NOT NULL AND response IS NOT NULL AND error_code IS NULL)
    OR (status = 'FAILED' AND completed_at IS NOT NULL AND response IS NULL AND error_code IS NOT NULL)
  )
);

ALTER TABLE vs17_experience_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs17_experience_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY vs17_experience_command_receipts_demo_tenant ON vs17_experience_command_receipts
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE OR REPLACE FUNCTION vs17_allow_single_ai_run_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VS17 AI run history cannot be deleted';
  END IF;
  IF OLD.status <> 'RUNNING' OR NEW.status NOT IN ('SUCCEEDED', 'FAILED')
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
    OR NEW.input_refs IS DISTINCT FROM OLD.input_refs
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'VS17 AI run only permits one terminal completion';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vs17_experience_ai_runs_completion_once
  BEFORE UPDATE OR DELETE ON vs17_experience_ai_runs
  FOR EACH ROW EXECUTE FUNCTION vs17_allow_single_ai_run_completion();

CREATE OR REPLACE FUNCTION vs17_reject_candidate_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Experience candidate revisions are append-only';
END;
$$;

CREATE TRIGGER vs17_experience_candidate_revisions_immutable
  BEFORE UPDATE OR DELETE ON vs01_experience_candidate_revisions
  FOR EACH ROW EXECUTE FUNCTION vs17_reject_candidate_revision_mutation();

ALTER TABLE vs01_experience_candidate_revisions
  ADD COLUMN structured_card jsonb;

ALTER TABLE vs01_formal_experiences
  ADD COLUMN structured_card jsonb,
  ADD COLUMN coze_index_status text NOT NULL DEFAULT 'INDEX_PENDING'
    CHECK (coze_index_status IN ('INDEX_PENDING', 'INDEXED', 'INDEX_FAILED')),
  ADD COLUMN coze_execute_id text,
  ADD COLUMN coze_debug_url text,
  ADD COLUMN coze_indexed_at timestamptz;

ALTER TABLE vs01_experience_candidates
  ADD COLUMN feishu_record_id text,
  ADD COLUMN feishu_synced_revision integer,
  ADD COLUMN feishu_sync_status text
    CHECK (feishu_sync_status IN ('PENDING', 'SYNCED', 'FAILED')),
  ADD COLUMN feishu_synced_at timestamptz;
