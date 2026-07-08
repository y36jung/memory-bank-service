/**
 * Migration 0006_dapper_marauders — slice-3 plan §5.2 schema assertions:
 *   - users.password_hash: nullable text column.
 *   - refresh_tokens table: id/user_id/token_hash/parent_token_id/is_used/
 *     expires_at/created_at columns, with the expected nullability.
 *   - token_hash carries a UNIQUE constraint.
 *   - FKs: user_id -> users(id) ON DELETE CASCADE;
 *          parent_token_id -> refresh_tokens(id) ON DELETE SET NULL (self-ref).
 *   - Indexes: documents_user_id_idx, chat_sessions_user_id_idx,
 *     refresh_tokens_user_id_idx.
 *
 * This complements — does NOT replace — the pre-existing `drizzle-kit
 * generate` empty-diff assertion in migration.test.ts (which already proves
 * 0006 keeps the committed schema/snapshot in sync).
 *
 * Runs against a REAL, throwaway Postgres database (created/dropped per this
 * file, on the same Postgres instance used by docker-compose.yml), migrated
 * via drizzle-orm's programmatic migrator against the real files in
 * src/db/migrations — no mocks. Mirrors the introspection style of the
 * pre-existing migration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const ADMIN_URL = 'postgresql://memory_bank:dev-password@localhost:5432/postgres';
const DB_NAME = 'mb_test_migration_0006';

async function createDb(name: string) {
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name};`);
    await admin.query(`CREATE DATABASE ${name};`);
  } finally {
    await admin.end();
  }
}

async function dropDb(name: string) {
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid();`,
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name};`);
  } finally {
    await admin.end();
  }
}

function dbUrl(name: string) {
  return `postgresql://memory_bank:dev-password@localhost:5432/${name}`;
}

describe('migration 0006_dapper_marauders — refresh_tokens + users.password_hash + indexes (plan §5.2)', () => {
  beforeAll(async () => {
    await createDb(DB_NAME);
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    await pool.end();
  });

  afterAll(async () => {
    await dropDb(DB_NAME);
  });

  it('adds users.password_hash as a nullable text column', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'password_hash';
    `);
    await pool.end();
    expect(rows).toEqual([{ column_name: 'password_hash', data_type: 'text', is_nullable: 'YES' }]);
  });

  it('creates the refresh_tokens table with the expected columns and nullability', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'refresh_tokens'
      ORDER BY ordinal_position;
    `);
    await pool.end();
    expect(rows).toEqual([
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'user_id', is_nullable: 'NO' },
      { column_name: 'token_hash', is_nullable: 'NO' },
      { column_name: 'parent_token_id', is_nullable: 'YES' },
      { column_name: 'is_used', is_nullable: 'NO' },
      { column_name: 'expires_at', is_nullable: 'NO' },
      { column_name: 'created_at', is_nullable: 'NO' },
    ]);
  });

  it('refresh_tokens.token_hash carries a UNIQUE constraint', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query(`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'refresh_tokens'
        AND ccu.column_name = 'token_hash'
        AND tc.constraint_type = 'UNIQUE';
    `);
    await pool.end();
    expect(rows).toHaveLength(1);
  });

  it('refresh_tokens has FKs: user_id -> users(id) ON DELETE CASCADE; parent_token_id -> refresh_tokens(id) ON DELETE SET NULL (self-referential)', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query(`
      SELECT
        tc.table_name,
        ccu.table_name AS foreign_table_name,
        rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'refresh_tokens'
      ORDER BY foreign_table_name;
    `);
    await pool.end();
    expect(rows).toEqual([
      {
        table_name: 'refresh_tokens',
        foreign_table_name: 'refresh_tokens',
        delete_rule: 'SET NULL',
      },
      { table_name: 'refresh_tokens', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]);
  });

  it('creates documents_user_id_idx, chat_sessions_user_id_idx, and refresh_tokens_user_id_idx', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('documents_user_id_idx', 'chat_sessions_user_id_idx', 'refresh_tokens_user_id_idx')
      ORDER BY indexname;
    `);
    await pool.end();
    expect(rows.map((r) => r.indexname)).toEqual([
      'chat_sessions_user_id_idx',
      'documents_user_id_idx',
      'refresh_tokens_user_id_idx',
    ]);
  });
});
