ALTER TABLE vs16_root_cause_workpaper_commands
  ADD COLUMN payload_hash text;

ALTER TABLE vs16_root_cause_workpaper_commands
  ADD CONSTRAINT vs16_root_cause_workpaper_commands_payload_hash_check
  CHECK (payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$');
