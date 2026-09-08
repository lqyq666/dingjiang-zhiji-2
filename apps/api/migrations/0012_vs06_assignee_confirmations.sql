ALTER TABLE vs01_project_subtasks
  ADD COLUMN IF NOT EXISTS progress_note text,
  ADD COLUMN IF NOT EXISTS progress_output_reference text,
  ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_basis text CHECK (completion_basis IN ('HISTORICAL_SOURCE', 'ASSIGNEE_CONFIRMED', 'ROLE_DECISION')),
  ADD COLUMN IF NOT EXISTS confirmed_by text CHECK (confirmed_by IN ('PMC', 'OWNER')),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_acceptance jsonb;

ALTER TABLE vs01_project_subtasks DROP CONSTRAINT IF EXISTS vs01_project_subtasks_status_check;
ALTER TABLE vs01_project_subtasks
  ADD CONSTRAINT vs01_project_subtasks_status_check
  CHECK (status IN ('LOCKED', 'READY', 'IN_PROGRESS', 'WAITING_REVIEW', 'DONE', 'RETURNED'));

ALTER TABLE vs01_project_subtask_events DROP CONSTRAINT IF EXISTS vs01_project_subtask_events_event_type_check;
ALTER TABLE vs01_project_subtask_events
  ADD CONSTRAINT vs01_project_subtask_events_event_type_check
  CHECK (event_type IN ('COMPLETED', 'REOPENED', 'PROGRESS_SAVED'));
UPDATE vs01_project_subtasks
SET completion_basis = CASE WHEN origin = 'HISTORICAL' THEN 'HISTORICAL_SOURCE' WHEN owner = 'OWNER' THEN 'ROLE_DECISION' ELSE 'ASSIGNEE_CONFIRMED' END,
    confirmed_by = owner,
    confirmed_at = completed_at,
    confirmed_acceptance = acceptance
WHERE status = 'DONE' AND completion_basis IS NULL;
ALTER TABLE vs01_project_events DROP CONSTRAINT IF EXISTS vs01_project_events_event_type_check;
ALTER TABLE vs01_project_events ADD CONSTRAINT vs01_project_events_event_type_check CHECK (event_type IN ('PROJECT_SUBMITTED','PROJECT_APPROVED','PROJECT_RETURNED','TASK_COMPLETED','TASK_REOPENED','OUTCOME_SUBMITTED','OUTCOME_ACCEPTED','OUTCOME_RETURNED','EXPERIENCE_CANDIDATE_CREATED','EXPERIENCE_CANDIDATE_WITHDRAWN','EXPERIENCE_RETURNED','EXPERIENCE_RESUBMITTED','EXPERIENCE_APPROVED','FORMAL_EXPERIENCE_PUBLISHED','FORMAL_EXPERIENCE_RETRACTED','FORMAL_EXPERIENCE_CITED','FORMAL_EXPERIENCE_REFERENCE_WITHDRAWN','PROGRESS_SAVED'));
