\set ON_ERROR_STOP on
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, dingjiang_runtime;
GRANT USAGE ON SCHEMA public TO dingjiang_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO dingjiang_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO dingjiang_runtime;
REVOKE TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA public FROM dingjiang_runtime;
REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM dingjiang_runtime;
REVOKE UPDATE,DELETE ON vs01_source_objects,vs01_source_versions,app_identity_events,governed_command_receipts,governed_command_audit_events FROM dingjiang_runtime;
REVOKE INSERT,UPDATE,DELETE ON production_import_batches,production_source_files,production_source_rows,vs01_orders,vs01_bom,vs01_purchases FROM dingjiang_runtime;
REVOKE UPDATE,DELETE ON production_project_snapshots FROM dingjiang_runtime;
REVOKE INSERT,UPDATE,DELETE ON production_human_approvals FROM dingjiang_runtime;
GRANT UPDATE(consumed_at) ON production_human_approvals TO dingjiang_runtime;
COMMIT;
