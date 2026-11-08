-- Read-path indexes for the three hottest project queries.
--
-- Evidence (synthetic 300 projects / 100k subtasks / 200k events / 200k
-- materials, measured with EXPLAIN ANALYZE before and after):
--
--   subtask phase count      7.14 ms  Parallel Seq Scan  ->  0.055 ms  Index Scan
--   project event timeline   8.03 ms  Seq Scan + Sort    ->  0.173 ms  Index Scan, no Sort
--   task material list       8.27 ms  Seq Scan + Sort    ->  0.132 ms  Index Scan, no Sort
--
-- The subtask count is not a rare read: every phase transition asks it two or
-- three times (open gate, count PMC subtasks, decide the next phase), so the
-- scan cost is paid per user action, not per page view.

-- Phase transitions filter on the node and the phase, never on the id alone.
-- `owner` stays out of the index: it is a cheap filter on the few rows the
-- index already narrowed down, and including it would tax every write.
CREATE INDEX vs01_project_subtasks_phase_idx
  ON vs01_project_subtasks (tenant_id, node_id, phase_code);

-- The project detail page reads the whole event log ordered by id. Indexing id
-- last keeps the ordering inside the index, which is what removes the Sort.
CREATE INDEX vs01_project_events_timeline_idx
  ON vs01_project_events (tenant_id, project_id, id);

-- Task material lists are read ordered by creation time, both with and without
-- the `status = 'ACTIVE'` filter (withdrawn material stays in the table).
-- The existing partial unique index cannot serve either read: its predicate is
-- `request_id IS NOT NULL`, which the list queries do not imply.
CREATE INDEX vs01_task_materials_task_idx
  ON vs01_task_materials (tenant_id, task_id, created_at, id);
