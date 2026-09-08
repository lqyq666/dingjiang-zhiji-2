ALTER TABLE vs01_task_materials
  ADD COLUMN IF NOT EXISTS requirement_id text,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'MANUAL_REFERENCE'
    CHECK (kind IN ('MANUAL_REFERENCE', 'UPLOADED_FILE')),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  ADD COLUMN IF NOT EXISTS source_object_id text REFERENCES vs01_source_objects(id),
  ADD COLUMN IF NOT EXISTS source_version_id text REFERENCES vs01_source_versions(id),
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_reason text;

ALTER TABLE vs01_task_materials
  ADD CONSTRAINT vs15_uploaded_material_requires_source
  CHECK (
    kind <> 'UPLOADED_FILE'
    OR (requirement_id IS NOT NULL AND source_object_id IS NOT NULL AND source_version_id IS NOT NULL AND request_id IS NOT NULL)
  );

ALTER TABLE vs01_task_materials
  ADD CONSTRAINT vs15_withdrawn_material_requires_reason
  CHECK (status <> 'WITHDRAWN' OR (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL));

CREATE UNIQUE INDEX vs15_task_material_request_id_unique
  ON vs01_task_materials (tenant_id, task_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE vs15_material_contents (
  source_version_id text PRIMARY KEY REFERENCES vs01_source_versions(id),
  tenant_id text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  media_type text NOT NULL,
  original_name text NOT NULL,
  extraction_status text NOT NULL CHECK (extraction_status IN ('EXTRACTED', 'NEEDS_REVIEW', 'FAILED')),
  content_preview text,
  readable_by_ai boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((readable_by_ai = false) OR (extraction_status = 'EXTRACTED' AND content_preview IS NOT NULL AND length(content_preview) > 0)),
  CHECK (content_preview IS NULL OR length(content_preview) <= 20000)
);

CREATE TABLE vs15_material_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  material_id bigint NOT NULL REFERENCES vs01_task_materials(id),
  event_type text NOT NULL CHECK (event_type IN ('IMPORTED', 'WITHDRAWN')),
  actor text NOT NULL CHECK (actor = 'PMC'),
  reason text,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vs15_material_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs15_material_contents FORCE ROW LEVEL SECURITY;
CREATE POLICY vs15_material_contents_demo_tenant ON vs15_material_contents
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');

ALTER TABLE vs15_material_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs15_material_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs15_material_events_demo_tenant ON vs15_material_events
  USING (tenant_id = 'tenant-demo') WITH CHECK (tenant_id = 'tenant-demo');
