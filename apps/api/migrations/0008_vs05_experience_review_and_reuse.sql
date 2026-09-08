-- VS05 is deliberately append-only: candidate revisions and formal experience
-- documents are separate immutable source versions.
ALTER TABLE vs01_experience_candidates
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS returned_reason text,
  ADD COLUMN IF NOT EXISTS reviewed_by text CHECK (reviewed_by IN ('EXPERT_REVIEWER')),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS formal_experience_id text;

ALTER TABLE vs01_experience_candidates DROP CONSTRAINT IF EXISTS vs01_experience_candidates_status_check;
ALTER TABLE vs01_experience_candidates
  ADD CONSTRAINT vs01_experience_candidates_status_check
  CHECK (status IN ('PENDING_REVIEW', 'RETURNED', 'WITHDRAWN', 'APPROVED'));

CREATE TABLE vs01_experience_candidate_revisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL REFERENCES vs01_experience_candidates(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  title text NOT NULL,
  applicable_situation text NOT NULL,
  business_problem text NOT NULL,
  practice text NOT NULL,
  result_summary text NOT NULL,
  evidence_reference text NOT NULL,
  limitations text NOT NULL,
  source_object_id text NOT NULL REFERENCES vs01_source_objects(id),
  source_version_id text NOT NULL REFERENCES vs01_source_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, revision),
  UNIQUE (source_version_id)
);

CREATE TABLE vs01_formal_experiences (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL REFERENCES vs01_experience_candidates(id),
  source_project_id text NOT NULL REFERENCES vs01_projects(id),
  source_task_id text NOT NULL REFERENCES vs01_tasks(id),
  status text NOT NULL CHECK (status IN ('PUBLISHED', 'RETRACTED')),
  title text NOT NULL,
  applicable_situation text NOT NULL,
  business_problem text NOT NULL,
  practice text NOT NULL,
  result_summary text NOT NULL,
  limitations text NOT NULL,
  published_by text NOT NULL CHECK (published_by = 'EXPERT_REVIEWER'),
  published_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_reason text,
  source_object_id text NOT NULL REFERENCES vs01_source_objects(id),
  source_version_id text NOT NULL REFERENCES vs01_source_versions(id),
  candidate_source_object_id text NOT NULL REFERENCES vs01_source_objects(id),
  candidate_source_version_id text NOT NULL REFERENCES vs01_source_versions(id),
  evidence_source_object_id text NOT NULL REFERENCES vs01_source_objects(id),
  evidence_source_version_id text NOT NULL REFERENCES vs01_source_versions(id),
  UNIQUE (source_version_id)
);

ALTER TABLE vs01_experience_candidates
  ADD CONSTRAINT vs01_experience_candidates_formal_experience_fk
  FOREIGN KEY (formal_experience_id) REFERENCES vs01_formal_experiences(id);

CREATE TABLE vs01_experience_references (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE CASCADE,
  experience_id text NOT NULL REFERENCES vs01_formal_experiences(id),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  classification text NOT NULL CHECK (classification = 'PROPOSAL'),
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL CHECK (created_by = 'PMC'),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_reason text,
  experience_source_object_id text NOT NULL REFERENCES vs01_source_objects(id),
  experience_source_version_id text NOT NULL REFERENCES vs01_source_versions(id),
  UNIQUE (task_id, experience_id, experience_source_version_id)
);

-- Existing pre-VS05 candidate is given a first immutable snapshot. This does
-- not replace its historical result locator.
INSERT INTO vs01_source_objects (id, tenant_id, file_name)
SELECT 'SRC-EXPERIENCE-CANDIDATE-' || id, tenant_id, '候选经验-' || id || '-v1'
FROM vs01_experience_candidates
ON CONFLICT (id) DO NOTHING;

INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number)
SELECT 'SRC-EXPERIENCE-CANDIDATE-VERSION-' || id || '-1', 'SRC-EXPERIENCE-CANDIDATE-' || id, tenant_id, 1
FROM vs01_experience_candidates
ON CONFLICT (id) DO NOTHING;

INSERT INTO vs01_experience_candidate_revisions (
  id, tenant_id, candidate_id, revision, title, applicable_situation, business_problem,
  practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id
)
SELECT 'EXP-REV-' || id || '-1', tenant_id, id, 1, title, applicable_situation, business_problem,
  practice, result_summary, evidence_reference, limitations,
  'SRC-EXPERIENCE-CANDIDATE-' || id, 'SRC-EXPERIENCE-CANDIDATE-VERSION-' || id || '-1'
FROM vs01_experience_candidates
ON CONFLICT (candidate_id, revision) DO NOTHING;

ALTER TABLE vs01_project_events DROP CONSTRAINT IF EXISTS vs01_project_events_event_type_check;
ALTER TABLE vs01_project_events
  ADD CONSTRAINT vs01_project_events_event_type_check
  CHECK (event_type IN (
    'PROJECT_SUBMITTED', 'PROJECT_APPROVED', 'PROJECT_RETURNED', 'TASK_COMPLETED', 'TASK_REOPENED',
    'OUTCOME_SUBMITTED', 'OUTCOME_ACCEPTED', 'OUTCOME_RETURNED', 'EXPERIENCE_CANDIDATE_CREATED',
    'EXPERIENCE_CANDIDATE_WITHDRAWN', 'EXPERIENCE_RETURNED', 'EXPERIENCE_RESUBMITTED',
    'EXPERIENCE_APPROVED', 'FORMAL_EXPERIENCE_PUBLISHED', 'FORMAL_EXPERIENCE_RETRACTED',
    'FORMAL_EXPERIENCE_CITED', 'FORMAL_EXPERIENCE_REFERENCE_WITHDRAWN'
  ));
ALTER TABLE vs01_project_events DROP CONSTRAINT IF EXISTS vs01_project_events_actor_check;
ALTER TABLE vs01_project_events
  ADD CONSTRAINT vs01_project_events_actor_check CHECK (actor IN ('PMC', 'OWNER', 'EXPERT_REVIEWER'));

ALTER TABLE vs01_experience_candidate_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_experience_candidate_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_experience_candidate_revisions_demo_tenant ON vs01_experience_candidate_revisions
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_formal_experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_formal_experiences FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_formal_experiences_demo_tenant ON vs01_formal_experiences
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_experience_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_experience_references FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_experience_references_demo_tenant ON vs01_experience_references
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
