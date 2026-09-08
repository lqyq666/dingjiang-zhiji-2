CREATE TABLE vs32_evidence_proposals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE RESTRICT,
  source_task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE RESTRICT,
  work_item_id text NOT NULL REFERENCES vs01_project_subtasks(id) ON DELETE RESTRICT,
  material_id bigint NOT NULL REFERENCES vs01_task_materials(id) ON DELETE RESTRICT,
  source_object_id text NOT NULL REFERENCES vs01_source_objects(id) ON DELETE RESTRICT,
  source_version_id text NOT NULL REFERENCES vs01_source_versions(id) ON DELETE RESTRICT,
  proposal_version integer NOT NULL CHECK (proposal_version > 0),
  claim text NOT NULL CHECK (char_length(claim) BETWEEN 3 AND 1000),
  evidence_type text NOT NULL CHECK (evidence_type IN ('OBSERVATION', 'METRIC', 'DOCUMENTED_FACT')),
  span_start integer NOT NULL CHECK (span_start >= 0),
  span_end integer NOT NULL CHECK (span_end > span_start),
  exact_text text NOT NULL CHECK (char_length(exact_text) BETWEEN 1 AND 4000),
  reasoning text NOT NULL CHECK (char_length(reasoning) BETWEEN 3 AND 4000),
  limitations text NOT NULL CHECK (char_length(limitations) BETWEEN 3 AND 1000),
  proposed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_version_id, proposal_version)
);

CREATE TABLE vs32_evidence_confirmations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  proposal_id text NOT NULL UNIQUE REFERENCES vs32_evidence_proposals(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('CONFIRMED', 'REJECTED')),
  confirmation_version integer NOT NULL CHECK (confirmation_version = 1),
  reviewed_by text NOT NULL,
  review_note text NOT NULL CHECK (char_length(review_note) BETWEEN 5 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vs32_formal_evidence (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE RESTRICT,
  source_task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE RESTRICT,
  work_item_id text NOT NULL REFERENCES vs01_project_subtasks(id) ON DELETE RESTRICT,
  proposal_id text NOT NULL UNIQUE REFERENCES vs32_evidence_proposals(id) ON DELETE RESTRICT,
  source_object_id text NOT NULL REFERENCES vs01_source_objects(id) ON DELETE RESTRICT,
  source_version_id text NOT NULL REFERENCES vs01_source_versions(id) ON DELETE RESTRICT,
  claim text NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('OBSERVATION', 'METRIC', 'DOCUMENTED_FACT')),
  span_start integer NOT NULL,
  span_end integer NOT NULL,
  exact_text text NOT NULL,
  limitations text NOT NULL,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vs32_evidence_proposals_scope_idx
  ON vs32_evidence_proposals (tenant_id, project_id, created_at DESC);
CREATE INDEX vs32_formal_evidence_scope_idx
  ON vs32_formal_evidence (tenant_id, project_id, confirmed_at DESC);

ALTER TABLE vs32_evidence_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs32_evidence_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE vs32_evidence_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs32_evidence_confirmations FORCE ROW LEVEL SECURITY;
ALTER TABLE vs32_formal_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs32_formal_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY vs32_evidence_proposals_tenant_scope ON vs32_evidence_proposals
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
CREATE POLICY vs32_evidence_confirmations_tenant_scope ON vs32_evidence_confirmations
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
CREATE POLICY vs32_formal_evidence_tenant_scope ON vs32_formal_evidence
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE OR REPLACE FUNCTION vs32_reject_evidence_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VS32 evidence history is append-only';
END;
$$;

CREATE TRIGGER vs32_evidence_proposals_immutable
  BEFORE UPDATE OR DELETE ON vs32_evidence_proposals
  FOR EACH ROW EXECUTE FUNCTION vs32_reject_evidence_history_mutation();
CREATE TRIGGER vs32_evidence_confirmations_immutable
  BEFORE UPDATE OR DELETE ON vs32_evidence_confirmations
  FOR EACH ROW EXECUTE FUNCTION vs32_reject_evidence_history_mutation();
CREATE TRIGGER vs32_formal_evidence_immutable
  BEFORE UPDATE OR DELETE ON vs32_formal_evidence
  FOR EACH ROW EXECUTE FUNCTION vs32_reject_evidence_history_mutation();
