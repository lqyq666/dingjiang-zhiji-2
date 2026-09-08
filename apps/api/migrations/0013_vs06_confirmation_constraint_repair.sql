-- 0012 was applied by some local demo instances before its final status/event
-- constraints were added. Keep the repair append-only so those instances upgrade.
ALTER TABLE vs01_project_subtasks DROP CONSTRAINT IF EXISTS vs01_project_subtasks_status_check;
ALTER TABLE vs01_project_subtasks
  ADD CONSTRAINT vs01_project_subtasks_status_check
  CHECK (status IN ('LOCKED', 'READY', 'IN_PROGRESS', 'WAITING_REVIEW', 'DONE', 'RETURNED'));

ALTER TABLE vs01_project_subtask_events DROP CONSTRAINT IF EXISTS vs01_project_subtask_events_event_type_check;
ALTER TABLE vs01_project_subtask_events
  ADD CONSTRAINT vs01_project_subtask_events_event_type_check
  CHECK (event_type IN ('COMPLETED', 'REOPENED', 'PROGRESS_SAVED'));

ALTER TABLE vs01_project_events DROP CONSTRAINT IF EXISTS vs01_project_events_event_type_check;
ALTER TABLE vs01_project_events
  ADD CONSTRAINT vs01_project_events_event_type_check
  CHECK (event_type IN ('PROJECT_SUBMITTED','PROJECT_APPROVED','PROJECT_RETURNED','TASK_COMPLETED','TASK_REOPENED','OUTCOME_SUBMITTED','OUTCOME_ACCEPTED','OUTCOME_RETURNED','EXPERIENCE_CANDIDATE_CREATED','EXPERIENCE_CANDIDATE_WITHDRAWN','EXPERIENCE_RETURNED','EXPERIENCE_RESUBMITTED','EXPERIENCE_APPROVED','FORMAL_EXPERIENCE_PUBLISHED','FORMAL_EXPERIENCE_RETRACTED','FORMAL_EXPERIENCE_CITED','FORMAL_EXPERIENCE_REFERENCE_WITHDRAWN','PROGRESS_SAVED'));
