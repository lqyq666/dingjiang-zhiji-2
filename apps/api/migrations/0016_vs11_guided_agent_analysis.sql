-- VS11 keeps "Teach AI" as a reviewable candidate. It never mutates live
-- assistant rules, prompts, skills, or business state.
CREATE TABLE vs01_assistant_feedback_candidates (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  phase_code text NOT NULL CHECK (phase_code IN ('PROJECT_SCOPING','BASELINE_FACTS','ROOT_CAUSE_VALIDATION','SOLUTION_APPROVAL','EXECUTION_CONTROL','RESULT_ACCEPTANCE','KNOWLEDGE_CAPTURE')),
  context_fingerprint text NOT NULL,
  issue_type text NOT NULL CHECK (issue_type IN ('CONTEXT_GAP','WRONG_SUGGESTION','MISSING_ANGLE','OTHER')),
  assistant_answer text NOT NULL,
  feedback text NOT NULL,
  expected_behavior text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','WITHDRAWN')),
  created_by text NOT NULL CHECK (created_by = 'PMC'),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_reason text
);

CREATE TABLE vs01_assistant_feedback_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  feedback_id text NOT NULL REFERENCES vs01_assistant_feedback_candidates(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('SUBMITTED','WITHDRAWN')),
  actor text NOT NULL CHECK (actor = 'PMC'),
  note text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vs01_assistant_feedback_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_assistant_feedback_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_assistant_feedback_candidates_demo_tenant
  ON vs01_assistant_feedback_candidates
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');

ALTER TABLE vs01_assistant_feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs01_assistant_feedback_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs01_assistant_feedback_events_demo_tenant
  ON vs01_assistant_feedback_events
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');
