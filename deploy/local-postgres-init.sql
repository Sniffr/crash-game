-- Local-dev Postgres bootstrap (docker compose --profile local up -d postgres).
--
-- Runs once, on first initialisation of the data volume.
--
-- The app uses the `casino` database (POSTGRES_DB). The wallet/server test
-- suites connect to a separate `crashtest` database — see
-- packages/wallet/src/pg-test-support.ts, which expects it to already exist and
-- does not create it. Without this file every Postgres-backed test fails with
-- 'database "crashtest" does not exist'.
CREATE DATABASE crashtest;
