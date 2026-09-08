ALTER TABLE vs18_approval_requests
  DROP CONSTRAINT IF EXISTS vs18_approval_requests_proposal_id_key;

CREATE UNIQUE INDEX vs18_approval_requests_one_pending_per_proposal_idx
  ON vs18_approval_requests (proposal_id)
  WHERE status = 'PENDING';
