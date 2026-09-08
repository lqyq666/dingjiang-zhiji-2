-- VS12 keeps assistant execution separate from business facts. Project events
-- are appended by the existing business transaction; this trigger mirrors only
-- a small, traceable envelope into the transactional outbox.
CREATE TABLE vs12_work_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  source_task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE CASCADE,
  source_project_event_id bigint NOT NULL REFERENCES vs01_project_events(id) ON DELETE RESTRICT,
  correlation_key text NOT NULL,
  source_event_type text NOT NULL,
  event_type text NOT NULL,
  stage_code text,
  work_item_id text,
  actor_role text NOT NULL CHECK (actor_role IN ('PMC', 'OWNER', 'EXPERT_REVIEWER')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT vs12_work_events_event_type_check CHECK (event_type IN ('WORK_ITEM_PROGRESS_SAVED','WORK_ITEM_CONFIRMED','WORK_ITEM_REOPENED','SOLUTION_SUBMITTED','SOLUTION_APPROVED','SOLUTION_RETURNED','STAGE_CHANGED','RESULT_CONFIRMED','EXPERIENCE_SUBMITTED','EXPERIENCE_RETURNED','EXPERIENCE_APPROVED')),
  UNIQUE (source_project_event_id)
);

CREATE INDEX vs12_work_events_pending_idx
  ON vs12_work_events (available_at, id)
  WHERE delivery_status = 'PENDING';
CREATE INDEX vs12_work_events_project_idx
  ON vs12_work_events (tenant_id, project_id, id DESC);

CREATE TABLE vs12_assistant_sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('PMC', 'OWNER', 'EXPERT_REVIEWER')),
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  source_task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id)
);

CREATE TABLE vs12_assistant_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id text NOT NULL REFERENCES vs12_assistant_sessions(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  source_task_id text NOT NULL REFERENCES vs01_tasks(id) ON DELETE CASCADE,
  correlation_key text NOT NULL,
  stage_code text,
  intent text NOT NULL CHECK (intent IN ('ASK','NEXT_ACTION','MATERIAL_GAPS','RISK','WORK_EVENT')),
  question text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','THINKING','COMPLETED','FAILED','FALLBACK')),
  provider text NOT NULL CHECK (provider IN ('PI','DEMO_RULES')),
  classification text NOT NULL DEFAULT 'PROPOSAL' CHECK (classification = 'PROPOSAL'),
  suggestion jsonb,
  fallback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (session_id, correlation_key)
);

CREATE INDEX vs12_assistant_runs_history_idx
  ON vs12_assistant_runs (tenant_id, project_id, created_at DESC);

CREATE TABLE vs12_assistant_stream_events (
  cursor bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  session_id text NOT NULL REFERENCES vs12_assistant_sessions(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES vs12_assistant_runs(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES vs01_projects(id) ON DELETE CASCADE,
  stage_code text,
  type text NOT NULL CHECK (type IN ('STREAM_READY','RUN_STARTED','STATE_CHANGED','TOOL_STARTED','TOOL_COMPLETED','TEXT_DELTA','SUGGESTION','RUN_COMPLETED','RUN_FAILED','HEARTBEAT')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vs12_assistant_stream_replay_idx
  ON vs12_assistant_stream_events (tenant_id, project_id, cursor);

CREATE OR REPLACE FUNCTION vs12_enqueue_project_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mapped_event_type text;
  source_task text;
BEGIN
  mapped_event_type := CASE NEW.event_type
    WHEN 'PROGRESS_SAVED' THEN 'WORK_ITEM_PROGRESS_SAVED'
    WHEN 'TASK_COMPLETED' THEN 'WORK_ITEM_CONFIRMED'
    WHEN 'TASK_REOPENED' THEN 'WORK_ITEM_REOPENED'
    WHEN 'PROJECT_SUBMITTED' THEN 'SOLUTION_SUBMITTED'
    WHEN 'PROJECT_APPROVED' THEN 'SOLUTION_APPROVED'
    WHEN 'PROJECT_RETURNED' THEN 'SOLUTION_RETURNED'
    WHEN 'OUTCOME_CONFIRMED_BY_EMPLOYEE' THEN 'RESULT_CONFIRMED'
    WHEN 'EXPERIENCE_CANDIDATE_CREATED' THEN 'EXPERIENCE_SUBMITTED'
    WHEN 'EXPERIENCE_RESUBMITTED' THEN 'EXPERIENCE_SUBMITTED'
    WHEN 'EXPERIENCE_RETURNED' THEN 'EXPERIENCE_RETURNED'
    WHEN 'EXPERIENCE_APPROVED' THEN 'EXPERIENCE_APPROVED'
    WHEN 'FORMAL_EXPERIENCE_PUBLISHED' THEN 'EXPERIENCE_APPROVED'
    ELSE NULL
  END;
  IF mapped_event_type IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT source_task_id INTO source_task
  FROM vs01_projects
  WHERE id = NEW.project_id AND tenant_id = NEW.tenant_id;

  INSERT INTO vs12_work_events (
    tenant_id,
    project_id,
    source_task_id,
    source_project_event_id,
    correlation_key,
    source_event_type,
    event_type,
    stage_code,
    work_item_id,
    actor_role,
    payload,
    occurred_at
  ) VALUES (
    NEW.tenant_id,
    NEW.project_id,
    source_task,
    NEW.id,
    concat('project:', NEW.project_id, ':tx:', txid_current()),
    NEW.event_type,
    mapped_event_type,
    NEW.phase_code,
    NULL,
    NEW.actor,
    jsonb_build_object(
      'sourceProjectEventId', NEW.id::text,
      'note', left(NEW.note, 500),
      'evidenceIds', '[]'::jsonb
    ),
    NEW.created_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER vs12_project_event_outbox_trigger
AFTER INSERT ON vs01_project_events
FOR EACH ROW EXECUTE FUNCTION vs12_enqueue_project_event();

-- Consumers claim a durable batch while avoiding duplicate delivery by other
-- local workers. A recovered PROCESSING row can be returned to PENDING by the
-- runtime after its lease expires.
CREATE OR REPLACE FUNCTION vs12_claim_pending_work_events(maximum_count integer)
RETURNS SETOF vs12_work_events
LANGUAGE sql
AS $$
  WITH claimed AS (
    SELECT id
    FROM vs12_work_events
    WHERE delivery_status = 'PENDING' AND available_at <= now()
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(maximum_count, 0)
  )
  UPDATE vs12_work_events AS event
  SET delivery_status = 'PROCESSING',
      attempt_count = event.attempt_count + 1,
      locked_at = now()
  FROM claimed
  WHERE event.id = claimed.id
  RETURNING event.*;
$$;

ALTER TABLE vs12_work_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs12_work_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs12_work_events_demo_tenant ON vs12_work_events
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');

ALTER TABLE vs12_assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs12_assistant_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY vs12_assistant_sessions_demo_tenant ON vs12_assistant_sessions
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');

ALTER TABLE vs12_assistant_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs12_assistant_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY vs12_assistant_runs_demo_tenant ON vs12_assistant_runs
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');

ALTER TABLE vs12_assistant_stream_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vs12_assistant_stream_events FORCE ROW LEVEL SECURITY;
CREATE POLICY vs12_assistant_stream_events_demo_tenant ON vs12_assistant_stream_events
  USING (tenant_id = 'tenant-demo')
  WITH CHECK (tenant_id = 'tenant-demo');
