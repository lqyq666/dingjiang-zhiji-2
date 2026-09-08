-- A retracted formal experience remains immutable history. The same candidate
-- may produce a new reviewed revision and a new formal experience record.
ALTER TABLE vs01_formal_experiences
  DROP CONSTRAINT IF EXISTS vs01_formal_experiences_candidate_id_key;
