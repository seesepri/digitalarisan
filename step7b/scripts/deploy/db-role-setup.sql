-- Run by the migration/database owner, after reviewing this policy for the target database.
-- Provision authentication out of band (IAM/SCRAM/certificate); never commit a password here.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'digital_arisan_app') THEN
    CREATE ROLE digital_arisan_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE digital_arisan_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('REVOKE ALL ON DATABASE %I FROM digital_arisan_app', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO digital_arisan_app', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC, digital_arisan_app;
GRANT USAGE ON SCHEMA public TO digital_arisan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO digital_arisan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO digital_arisan_app;
-- Append-only protections must be privileges too, not just triggers an owner can disable.
REVOKE UPDATE, DELETE, TRUNCATE ON wallet_transactions, financial_transactions, audit_logs FROM digital_arisan_app;
REVOKE ALL ON SCHEMA drizzle FROM digital_arisan_app;
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM digital_arisan_app;
-- No broad future-table default privileges. Reapply this explicit allow-list policy after each reviewed migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE pg_has_role('digital_arisan_app', r.oid, 'MEMBER') AND c.relnamespace IN ('public'::regnamespace,'drizzle'::regnamespace)) THEN
    RAISE EXCEPTION 'BLOCKED: application role owns/inherits a database object owner; use a separate migration owner';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role('digital_arisan_app',datdba,'MEMBER'))
    OR has_schema_privilege('digital_arisan_app','public','CREATE') THEN
    RAISE EXCEPTION 'BLOCKED: application role must not own/inherit database/schema ownership or schema CREATE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('wallet_transactions'::regclass,'financial_transactions'::regclass,'audit_logs'::regclass)
    AND (has_table_privilege('digital_arisan_app',oid,'UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('digital_arisan_app',oid,'UPDATE'))) THEN
    RAISE EXCEPTION 'BLOCKED: inherited/column ledger modification privileges remain; review membership grants';
  END IF;
END $$;
COMMIT;
