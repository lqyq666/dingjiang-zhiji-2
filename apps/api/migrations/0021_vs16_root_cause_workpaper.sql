CREATE TABLE vs16_root_cause_workpapers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL UNIQUE REFERENCES vs01_projects(id) ON DELETE CASCADE,
  work_item_id text NOT NULL UNIQUE REFERENCES vs01_project_subtasks(id) ON DELETE CASCADE,
  source_object_id text NOT NULL UNIQUE REFERENCES vs01_source_objects(id),
  status text NOT NULL CHECK (status IN ('DRAFTING', 'CONFIRMED')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  latest_confirmed_version_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vs16_root_cause_workpaper_versions (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  workpaper_id text NOT NULL REFERENCES vs16_root_cause_workpapers(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('AI_CANDIDATE', 'PMC_DRAFT', 'PMC_CONFIRMED')),
  classification text NOT NULL CHECK (classification IN ('PROPOSAL', 'EMPLOYEE_WORK', 'CONFIRMED_OUTPUT')),
  content jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  source_version_id text NOT NULL UNIQUE REFERENCES vs01_source_versions(id),
  based_on_revision integer,
  requested_by text NOT NULL CHECK (requested_by = 'PMC'),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workpaper_id, revision),
  UNIQUE (workpaper_id, request_id)
);

ALTER TABLE vs16_root_cause_workpapers
  ADD CONSTRAINT vs16_root_cause_workpapers_latest_confirmed_fk
  FOREIGN KEY (latest_confirmed_version_id) REFERENCES vs16_root_cause_workpaper_versions(id);

CREATE TABLE vs16_root_cause_workpaper_evidence (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  version_id bigint NOT NULL REFERENCES vs16_root_cause_workpaper_versions(id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  source_version_id text NOT NULL REFERENCES vs01_source_versions(id),
  kind text NOT NULL CHECK (kind IN ('FACT', 'MATERIAL')),
  UNIQUE (version_id, evidence_id, source_version_id)
);

CREATE TABLE vs16_root_cause_workpaper_commands (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  workpaper_id text NOT NULL REFERENCES vs16_root_cause_workpapers(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  command text NOT NULL CHECK (command IN ('CANDIDATE', 'DRAFT', 'COMPLETE', 'REOPEN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workpaper_id, request_id)
);

CREATE OR REPLACE FUNCTION vs16_reject_workpaper_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VS16 workpaper history is append-only';
END;
$$;

CREATE TRIGGER vs16_workpaper_versions_immutable
  BEFORE UPDATE OR DELETE ON vs16_root_cause_workpaper_versions
  FOR EACH ROW EXECUTE FUNCTION vs16_reject_workpaper_history_mutation();
CREATE TRIGGER vs16_workpaper_evidence_immutable
  BEFORE UPDATE OR DELETE ON vs16_root_cause_workpaper_evidence
  FOR EACH ROW EXECUTE FUNCTION vs16_reject_workpaper_history_mutation();

ALTER TABLE vs16_root_cause_workpapers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs16_root_cause_workpapers FORCE ROW LEVEL SECURITY;
CREATE POLICY vs16_root_cause_workpapers_demo_tenant ON vs16_root_cause_workpapers
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs16_root_cause_workpaper_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs16_root_cause_workpaper_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY vs16_root_cause_workpaper_versions_demo_tenant ON vs16_root_cause_workpaper_versions
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs16_root_cause_workpaper_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs16_root_cause_workpaper_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY vs16_root_cause_workpaper_evidence_demo_tenant ON vs16_root_cause_workpaper_evidence
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs16_root_cause_workpaper_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs16_root_cause_workpaper_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY vs16_root_cause_workpaper_commands_demo_tenant ON vs16_root_cause_workpaper_commands
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
