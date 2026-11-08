-- Delivery reliability for the outbound employee notification queue.
--
-- The queue already survives a crash: a claimed row is leased for one minute
-- and a stale claim is reclaimable. What it lacked was an ending. A permanent
-- failure (unbound account, revoked bot, deleted chat) was retried on every
-- sweep forever, and any attempt that hit Feishu's rate limit was retried
-- immediately, which is the one response that guarantees more of it.
--
-- Three additions, no change to the happy path:
--   DEAD           terminal state after the attempt budget is spent
--   next_attempt_at  durable backoff, so Retry-After is honoured across restarts
--   due index      the claim query stops scanning rows that are waiting

ALTER TABLE app_feishu_work_notifications
  DROP CONSTRAINT app_feishu_work_notifications_status_check;

ALTER TABLE app_feishu_work_notifications
  ADD CONSTRAINT app_feishu_work_notifications_status_check
  CHECK (
    status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED', 'DEAD')
  );

ALTER TABLE app_feishu_work_notifications
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dead_at timestamptz;

-- A dead row must say when it died: an operator triaging the queue needs the
-- timestamp, and a row in DEAD without one is indistinguishable from a bug.
ALTER TABLE app_feishu_work_notifications
  ADD CONSTRAINT app_feishu_work_notifications_dead_at_check
  CHECK ((status = 'DEAD') = (dead_at IS NOT NULL));

-- Only rows that are actually due can be claimed, so the sweep no longer walks
-- rows sitting in backoff.
CREATE INDEX app_feishu_work_notifications_due_idx
  ON app_feishu_work_notifications (tenant_id, next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED', 'NOT_CONFIGURED');
