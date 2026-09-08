ALTER TABLE vs15_material_events
  DROP CONSTRAINT IF EXISTS vs15_material_events_event_type_check;
ALTER TABLE vs15_material_events
  ADD CONSTRAINT vs15_material_events_event_type_check
  CHECK (event_type IN ('IMPORTED', 'REGISTERED', 'WITHDRAWN', 'VERIFIED', 'NEEDS_REVISION'));

ALTER TABLE vs15_material_events
  ADD COLUMN IF NOT EXISTS actor_subject_id text,
  ADD COLUMN IF NOT EXISTS verification_version integer;

ALTER TABLE vs15_material_events
  ADD CONSTRAINT vs15_material_verification_event_shape
  CHECK (
    event_type NOT IN ('VERIFIED', 'NEEDS_REVISION')
    OR (
      actor_subject_id IS NOT NULL
      AND verification_version > 0
      AND reason IS NOT NULL
      AND char_length(reason) BETWEEN 5 AND 1000
    )
  );

CREATE UNIQUE INDEX vs15_material_verification_version_unique
  ON vs15_material_events (tenant_id, material_id, verification_version)
  WHERE verification_version IS NOT NULL;

CREATE OR REPLACE FUNCTION vs15_reject_material_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VS15 material events are append-only';
END;
$$;

CREATE TRIGGER vs15_material_events_immutable
  BEFORE UPDATE OR DELETE ON vs15_material_events
  FOR EACH ROW EXECUTE FUNCTION vs15_reject_material_event_mutation();
