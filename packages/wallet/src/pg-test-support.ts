import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { bootstrapCasinoSchema } from './pg.js';

/**
 * Test-only helper: an isolated Postgres schema per test file, on a local
 * throwaway database. Defaults to the `crash-test-pg` docker container
 * (localhost:55432); override with TEST_DATABASE_URL.
 *
 * Each call creates a fresh schema, bootstraps the full casino schema into it
 * (search_path scopes every table + FK), and returns a pool bound to it plus a
 * cleanup that drops the schema. Gives real Postgres semantics (transactions,
 * ON CONFLICT, advisory locks) with per-file isolation and no cross-test bleed.
 */
const TEST_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres:test@localhost:55432/crashtest';

export interface TestDb {
  pool: pg.Pool;
  schema: string;
  cleanup: () => Promise<void>;
}

export async function makeTestDb(): Promise<TestDb> {
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Pool({ connectionString: TEST_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // search_path scopes all subsequent DDL/DML in this pool to the fresh schema.
  const pool = new pg.Pool({ connectionString: TEST_URL, options: `-c search_path=${schema}` });
  await bootstrapCasinoSchema(pool);
  return {
    pool,
    schema,
    cleanup: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
