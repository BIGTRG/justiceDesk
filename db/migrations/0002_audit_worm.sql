-- 0002_audit_worm.sql — make audit_log write-once-read-many.
--
-- The spec requires that every document view and download be appended to a WORM audit
-- log. "Append-only" enforced only in application code is not append-only: any process
-- with the app's credentials could rewrite history, which is exactly what an audit log
-- exists to prevent. So the guarantee is enforced in the database, twice:
--
--   1. A BEFORE trigger raises on UPDATE and DELETE, so even a superuser session using
--      the ORM path fails loudly.
--   2. Table privileges withhold UPDATE/DELETE from the application role entirely.
--
-- TRUNCATE is covered too — it bypasses row-level triggers, so it gets a statement-level
-- one of its own.
--
-- Neither of these stops a determined superuser (who can drop the trigger). Genuine
-- tamper-evidence needs off-host shipping of the log; see COMPLIANCE.md for the open item.

BEGIN;

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted (attempted on row id %)',
    TG_OP,
    COALESCE(OLD.id::text, '-')
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct an audit entry by appending a compensating record, never by editing.';
END;
$$;

CREATE OR REPLACE FUNCTION audit_log_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_block_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_block_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_block_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();

-- Second layer: withhold the privileges outright from the application role.
-- The role is created by the operator; guarded so migrations run on a fresh box.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'justicedesk_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM justicedesk_app;
    GRANT INSERT, SELECT ON audit_log TO justicedesk_app;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO justicedesk_app;
  END IF;
END;
$$;

COMMIT;
