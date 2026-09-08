ALTER TABLE vs16_root_cause_workpaper_versions
  DROP CONSTRAINT IF EXISTS vs16_workpaper_proposal_shape_check;

ALTER TABLE vs16_root_cause_workpaper_versions
  ADD CONSTRAINT vs16_workpaper_proposal_shape_check
  CHECK (
    (kind = 'PMC_PROPOSAL'
      AND classification = 'PROPOSAL'
      AND jsonb_typeof(proposal_context) = 'object'
      AND proposal_context ->> 'currentEvidenceTakesPriority' = 'true'
      AND jsonb_typeof(proposal_context -> 'evidenceReferences') = 'array'
      AND jsonb_array_length(proposal_context -> 'evidenceReferences') > 0
      AND jsonb_typeof(proposal_context -> 'materialReferences') = 'array'
      AND char_length(created_by_subject) > 0)
    OR
    (kind <> 'PMC_PROPOSAL' AND proposal_context IS NULL)
  );
