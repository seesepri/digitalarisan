-- Run once by a database owner, not by the application role.
-- Keep the application role without CREATE/DROP privileges in production.
CREATE ROLE digital_arisan_app LOGIN PASSWORD 'REPLACE_OUT_OF_BAND';
REVOKE ALL ON DATABASE digital_arisan FROM digital_arisan_app;
GRANT CONNECT ON DATABASE digital_arisan TO digital_arisan_app;
-- After migrations are installed by a dedicated migration role:
GRANT USAGE ON SCHEMA public TO digital_arisan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO digital_arisan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO digital_arisan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO digital_arisan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO digital_arisan_app;
