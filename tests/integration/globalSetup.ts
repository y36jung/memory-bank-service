/**
 * Vitest globalSetup — runs once, in a separate process, before any test file.
 *
 * Creates a dedicated `mb_test_slice1` Postgres database (dropping it first
 * for a clean slate) and applies the real migration files in
 * src/db/migrations via drizzle-orm's programmatic migrator — the same
 * migration files `npm run db:migrate` applies in production. This proves
 * migrations 0000-0005 apply cleanly end-to-end, not just that the SQL is
 * syntactically plausible.
 *
 * IMPORTANT: this deliberately does NOT touch the DATABASE_URL configured in
 * `.env` (the shared dev database already has real seeded rows) — it always
 * targets the fixed `mb_test_slice1` admin connection below.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const ADMIN_URL = 'postgresql://memory_bank:dev-password@localhost:5432/postgres';
const TEST_DB_NAME = 'mb_test_slice1';
const TEST_DB_URL = `postgresql://memory_bank:dev-password@localhost:5432/${TEST_DB_NAME}`;

export async function setup() {
  const adminPool = new Pool({ connectionString: ADMIN_URL });
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminPool.end();
  }

  const testPool = new Pool({ connectionString: TEST_DB_URL });
  try {
    const db = drizzle(testPool);
    await migrate(db, { migrationsFolder: './src/db/migrations' });
  } finally {
    await testPool.end();
  }
}

export async function teardown() {
  // Leave mb_test_slice1 in place after the run for post-mortem inspection;
  // the next `setup()` run drops and recreates it anyway.
}
