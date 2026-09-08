ALTER TABLE vs01_projects DROP CONSTRAINT IF EXISTS vs01_projects_status_check;
ALTER TABLE vs01_projects
  ADD CONSTRAINT vs01_projects_status_check
  CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'RUNNING', 'RESULT_VALIDATION', 'PENDING_RESULT_ACCEPTANCE', 'KNOWLEDGE_CAPTURE', 'COMPLETED'));

ALTER TABLE vs01_project_subtasks
  ADD COLUMN IF NOT EXISTS phase_code text NOT NULL DEFAULT 'EXECUTION_CONTROL',
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'PMC' CHECK (owner IN ('PMC', 'OWNER')),
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'LIVE' CHECK (origin IN ('LIVE', 'HISTORICAL')),
  ADD COLUMN IF NOT EXISTS inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS process jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS expected_output text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS output_reference text,
  ADD COLUMN IF NOT EXISTS acceptance jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reopen_reason text;

UPDATE vs01_project_subtasks
SET purpose = title,
    inputs = '[{"label":"已批准的改善项目","status":"AVAILABLE","reference":"项目批准记录"}]'::jsonb,
    process = '[{"label":"按计划执行并保留依据","completed":false}]'::jsonb,
    expected_output = '可追溯的执行记录',
    acceptance = '["完成依据可追溯"]'::jsonb
WHERE purpose = '';

ALTER TABLE vs01_project_subtasks DROP CONSTRAINT IF EXISTS vs01_project_subtasks_status_check;
UPDATE vs01_project_subtasks SET status = 'READY' WHERE status = 'TODO';
ALTER TABLE vs01_project_subtasks
  ADD CONSTRAINT vs01_project_subtasks_status_check
  CHECK (status IN ('LOCKED', 'READY', 'WAITING_REVIEW', 'DONE', 'RETURNED'));

CREATE TABLE vs01_project_phases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code IN ('PROJECT_SCOPING', 'BASELINE_FACTS', 'ROOT_CAUSE_VALIDATION', 'SOLUTION_APPROVAL', 'EXECUTION_CONTROL', 'RESULT_ACCEPTANCE', 'KNOWLEDGE_CAPTURE')),
  name text NOT NULL,
  purpose text NOT NULL,
  sort_order integer NOT NULL,
  gate_status text NOT NULL DEFAULT 'LOCKED' CHECK (gate_status IN ('LOCKED', 'OPEN', 'PENDING', 'APPROVED', 'RETURNED')),
  gate_label text NOT NULL,
  returned_reason text,
  UNIQUE (project_id, code),
  UNIQUE (project_id, sort_order)
);

CREATE TABLE vs01_project_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('PROJECT_SUBMITTED', 'PROJECT_APPROVED', 'PROJECT_RETURNED', 'TASK_COMPLETED', 'TASK_REOPENED', 'OUTCOME_SUBMITTED', 'OUTCOME_ACCEPTED', 'OUTCOME_RETURNED', 'EXPERIENCE_CANDIDATE_CREATED')),
  phase_code text,
  note text NOT NULL DEFAULT '',
  actor text NOT NULL CHECK (actor IN ('PMC', 'OWNER')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vs01_result_validations (
  project_id text PRIMARY KEY REFERENCES vs01_projects(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  baseline integer NOT NULL CHECK (baseline BETWEEN 0 AND 100),
  target integer NOT NULL CHECK (target BETWEEN 0 AND 100),
  current integer CHECK (current BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'NOT_MEASURED' CHECK (status IN ('NOT_MEASURED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'RETURNED')),
  conclusion text,
  evidence_reference text,
  note text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  returned_reason text
);

CREATE TABLE vs01_experience_candidates (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL UNIQUE REFERENCES vs01_projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  applicable_situation text NOT NULL,
  business_problem text NOT NULL,
  practice text NOT NULL,
  result_summary text NOT NULL,
  evidence_reference text NOT NULL,
  limitations text NOT NULL,
  status text NOT NULL CHECK (status = 'PENDING_REVIEW'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vs01_project_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_project_phases FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_project_phases_demo_tenant ON vs01_project_phases USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_project_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_project_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_project_events_demo_tenant ON vs01_project_events USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_result_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_result_validations FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_result_validations_demo_tenant ON vs01_result_validations USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
ALTER TABLE vs01_experience_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_experience_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_experience_candidates_demo_tenant ON vs01_experience_candidates USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
