#!/bin/bash
# Runs once, when the local Docker volume is first initialized.
#
# Creates the least-privilege login the application uses at runtime. The
# migrations (run as the owner) create the `oryn_app_role` group and grant it
# table privileges; this login inherits them. It is NOT a superuser and does
# NOT have BYPASSRLS, so row-level security policies apply to every query the
# web app and worker make.
#
# A second database, oryn_test, is created for the integration test suite.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oryn_app_role') THEN
      CREATE ROLE oryn_app_role NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oryn_app') THEN
      CREATE ROLE oryn_app LOGIN PASSWORD '${ORYN_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE oryn_app_role;
    END IF;
  END
  \$\$;
  CREATE DATABASE oryn_test OWNER $POSTGRES_USER;
SQL
