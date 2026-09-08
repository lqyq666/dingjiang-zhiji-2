ALTER TABLE vs15_material_events
  DROP CONSTRAINT IF EXISTS vs15_material_events_event_type_check;
ALTER TABLE vs15_material_events
  ADD CONSTRAINT vs15_material_events_event_type_check
  CHECK (event_type IN ('IMPORTED', 'REGISTERED', 'WITHDRAWN'));

CREATE TABLE vs15_governed_material_versions (
  source_version_id text PRIMARY KEY REFERENCES vs01_source_versions(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  material_id bigint NOT NULL UNIQUE REFERENCES vs01_task_materials(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE RESTRICT,
  work_item_id text NOT NULL REFERENCES vs01_project_subtasks(id) ON DELETE RESTRICT,
  requirement_id text NOT NULL,
  material_type text NOT NULL CHECK (material_type IN ('MANUAL_REFERENCE', 'CONTROLLED_TEXT')),
  source_metadata jsonb NOT NULL CHECK (jsonb_typeof(source_metadata) = 'object'),
  safe_summary text NOT NULL CHECK (char_length(safe_summary) BETWEEN 3 AND 1000),
  controlled_text_content text CHECK (controlled_text_content IS NULL OR char_length(controlled_text_content) BETWEEN 3 AND 20000),
  created_by_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((material_type = 'CONTROLLED_TEXT') = (controlled_text_content IS NOT NULL))
);

ALTER TABLE vs15_governed_material_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs15_governed_material_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY vs15_governed_material_versions_demo_tenant
  ON vs15_governed_material_versions
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

CREATE OR REPLACE FUNCTION vs15_reject_material_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VS15 material versions are append-only';
END;
$$;

CREATE TRIGGER vs15_governed_material_versions_immutable
  BEFORE UPDATE OR DELETE ON vs15_governed_material_versions
  FOR EACH ROW EXECUTE FUNCTION vs15_reject_material_version_mutation();

CREATE OR REPLACE FUNCTION vs01_reject_source_identity_overwrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SourceObject and SourceVersion identity is append-only';
END;
$$;

CREATE TRIGGER vs01_source_objects_no_overwrite
  BEFORE UPDATE ON vs01_source_objects
  FOR EACH ROW EXECUTE FUNCTION vs01_reject_source_identity_overwrite();
CREATE TRIGGER vs01_source_versions_no_overwrite
  BEFORE UPDATE ON vs01_source_versions
  FOR EACH ROW EXECUTE FUNCTION vs01_reject_source_identity_overwrite();

CREATE OR REPLACE FUNCTION vs15_reject_material_locator_overwrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_object_id IS NOT NULL AND
     (NEW.source_object_id IS DISTINCT FROM OLD.source_object_id OR
      NEW.source_version_id IS DISTINCT FROM OLD.source_version_id) THEN
    RAISE EXCEPTION 'VS15 material SourceObject and SourceVersion locator is append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vs15_task_material_locator_immutable
  BEFORE UPDATE ON vs01_task_materials
  FOR EACH ROW EXECUTE FUNCTION vs15_reject_material_locator_overwrite();
