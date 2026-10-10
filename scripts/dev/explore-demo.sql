\set ON_ERROR_STOP on

BEGIN;
CREATE SCHEMA IF NOT EXISTS "__SCHEMA__";
CREATE TABLE IF NOT EXISTS "__SCHEMA__".branch (
    id text PRIMARY KEY,
    lsid text,
    code text,
    manager text
);
INSERT INTO "__SCHEMA__".branch (id, lsid, code, manager)
SELECT
    'branch-' || lpad(n::text, 3, '0'),
    'location-' || lpad(((n - 1) % 12 + 1)::text, 2, '0'),
    'BR-' || lpad(n::text, 3, '0'),
    CASE WHEN n % 10 = 0 THEN NULL
         ELSE 'Demo Manager ' || ((n - 1) % 8 + 1)::text END
FROM generate_series(1, 150) AS n
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explore_reader') THEN
        CREATE ROLE explore_reader LOGIN PASSWORD '__READER_PASSWORD__'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;
REVOKE ALL ON DATABASE explore_demo FROM PUBLIC;
GRANT CONNECT ON DATABASE explore_demo TO explore_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA "__SCHEMA__" TO explore_reader;
GRANT SELECT ON TABLE "__SCHEMA__".branch TO explore_reader;
ALTER ROLE explore_reader SET default_transaction_read_only = on;
COMMIT;
