-- The audit log is append-only (doc 03 §10, doc 07 §4).
--
-- Two independent mechanisms, because this is the record that answers "who
-- looked at this person" after a privacy complaint:
--
--   1. The application database role is granted INSERT and SELECT only. No
--      UPDATE, no DELETE. This is the control the docs require.
--   2. A trigger refuses UPDATE and DELETE outright, so even a connection that
--      somehow holds broader rights cannot quietly rewrite history. Nothing in
--      the product ever legitimately updates or deletes an audit row.
--
-- Migrations run as the owner. The API connects as the application role.

CREATE OR REPLACE FUNCTION vigilo_audit_log_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION vigilo_audit_log_is_append_only();--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_delete ON "audit_log";--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION vigilo_audit_log_is_append_only();--> statement-breakpoint

-- The application role. Created here rather than by hand so a fresh deploy and
-- a fresh test database are identical. The password is set by the deployment;
-- this role cannot log in until one is.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigilo_app') THEN
    CREATE ROLE vigilo_app NOLOGIN;
  END IF;
END;
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO vigilo_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vigilo_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vigilo_app;--> statement-breakpoint

-- and then take back what the audit log must never allow.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM vigilo_app;--> statement-breakpoint

-- Tables added by later phases inherit the same defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vigilo_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vigilo_app;
