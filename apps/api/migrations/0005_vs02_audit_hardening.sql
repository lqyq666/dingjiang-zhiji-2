ALTER TABLE vs01_project_subtasks
  ADD COLUMN IF NOT EXISTS output_source_object_id text REFERENCES vs01_source_objects(id),
  ADD COLUMN IF NOT EXISTS output_source_version_id text REFERENCES vs01_source_versions(id),
  ADD COLUMN IF NOT EXISTS source_recorded_at timestamptz;

ALTER TABLE vs01_result_validations
  ADD COLUMN IF NOT EXISTS source_object_id text REFERENCES vs01_source_objects(id),
  ADD COLUMN IF NOT EXISTS source_version_id text REFERENCES vs01_source_versions(id);

ALTER TABLE vs01_experience_candidates
  ADD COLUMN IF NOT EXISTS source_object_id text REFERENCES vs01_source_objects(id),
  ADD COLUMN IF NOT EXISTS source_version_id text REFERENCES vs01_source_versions(id);

ALTER TABLE vs01_project_events
  ADD COLUMN IF NOT EXISTS snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
