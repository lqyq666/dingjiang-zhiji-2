ALTER TABLE vs01_experience_reference_events
  ADD COLUMN note text NOT NULL DEFAULT '';

UPDATE vs01_experience_reference_events
SET note = CASE event_type
  WHEN 'CITED' THEN COALESCE(snapshot ->> 'note', '')
  WHEN 'WITHDRAWN' THEN COALESCE(snapshot #>> '{after,reason}', '')
  ELSE ''
END;
