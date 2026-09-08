ALTER TABLE vs18_task_proposals
  DROP CONSTRAINT IF EXISTS vs18_task_proposals_check;

ALTER TABLE vs18_task_proposals
  ADD CONSTRAINT vs18_task_proposals_money_amount_after_proposal_check
  CHECK (
    (approval_kind <> 'MONEY' AND amount IS NULL)
    OR (approval_kind = 'MONEY' AND (status = 'PROPOSED' OR amount IS NOT NULL))
  );
