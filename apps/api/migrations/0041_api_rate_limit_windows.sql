-- Fixed-window request accounting for the Integration API.
--
-- Counting lives in PostgreSQL rather than process memory: a per-process
-- counter would let N API replicas serve N times the limit, which is exactly
-- the failure mode the limit exists to prevent. One row per actor, bucket and
-- minute, updated with a single atomic upsert.
CREATE TABLE api_rate_limit_windows (
  tenant_id text NOT NULL,
  actor_key text NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('read','write')),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (tenant_id, actor_key, bucket, window_start)
);

-- Expired windows are swept by age; without this the sweep scans the table.
CREATE INDEX api_rate_limit_windows_expiry ON api_rate_limit_windows(window_start);
