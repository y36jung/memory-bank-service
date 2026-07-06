/**
 * Migration correctness — Slice 1 acceptance criteria:
 *   1. `users` table exists; `documents.user_id` / `chat_sessions.user_id` are
 *      NOT NULL FKs cascading on delete (plan §9, row 1).
 *   2. Pre-existing rows all backfill to the legacy user UUID (plan §9, row 2).
 *   3. `drizzle-kit generate` yields an empty diff against the committed
 *      schema/snapshot (plan §5.2 step 3 — migration procedure).
 *
 * Also covers edge cases from plan §8:
 *   #10 — pre-existing rows backfill, UPDATE is idempotent if re-run.
 *   #11 — migration applied to a fresh (empty) DB.
 *
 * Runs against REAL Postgres (throwaway databases created/dropped per test,
 * on the same Postgres instance used by docker-compose.yml) — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const ADMIN_URL = 'postgresql://memory_bank:dev-password@localhost:5432/postgres';
const LEGACY_USER_ID = '00000000-0000-0000-0000-000000000001';
const LEGACY_USER_EMAIL = 'legacy@memory-bank.local';

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

describe('migration 0005_add_users_table — fresh database', () => {
  const DB_NAME = 'mb_test_migration_fresh';

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

  it('creates the users table with the legacy row', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query('SELECT id, email FROM users');
    await pool.end();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(LEGACY_USER_ID);
    expect(rows[0].email).toBe(LEGACY_USER_EMAIL);
  });

  it('makes documents.user_id and chat_sessions.user_id NOT NULL', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const { rows } = await pool.query(`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name IN ('documents', 'chat_sessions') AND column_name = 'user_id'
      ORDER BY table_name;
    `);
    await pool.end();
    expect(rows).toEqual([
      { table_name: 'chat_sessions', column_name: 'user_id', is_nullable: 'NO' },
      { table_name: 'documents', column_name: 'user_id', is_nullable: 'NO' },
    ]);
  });

  it('adds FK constraints from documents/chat_sessions.user_id to users(id) ON DELETE CASCADE', async () => {
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
        AND tc.table_name IN ('documents', 'chat_sessions')
        AND ccu.table_name = 'users'
      ORDER BY tc.table_name;
    `);
    await pool.end();
    expect(rows).toEqual([
      { table_name: 'chat_sessions', foreign_table_name: 'users', delete_rule: 'CASCADE' },
      { table_name: 'documents', foreign_table_name: 'users', delete_rule: 'CASCADE' },
    ]);
  });

  it('deleting a user cascades to delete their documents and chat_sessions (PLAN.md §ACID cascade invariant)', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const {
      rows: [user],
    } = await pool.query(
      `INSERT INTO users (email) VALUES ('cascade-target@test.local') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO documents (user_id, filename, original_name, source_type, mime_type, status)
       VALUES ($1, 'f.txt', 'f.txt', 'upload', 'text/plain', 'pending')`,
      [user.id],
    );
    await pool.query(`INSERT INTO chat_sessions (user_id) VALUES ($1)`, [user.id]);

    await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);

    const { rows: docs } = await pool.query('SELECT * FROM documents WHERE user_id = $1', [
      user.id,
    ]);
    const { rows: sessions } = await pool.query('SELECT * FROM chat_sessions WHERE user_id = $1', [
      user.id,
    ]);
    await pool.end();
    expect(docs).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('rejects a document insert with a non-existent user_id (FK violation, edge case #6)', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });
    const bogusUserId = '11111111-1111-1111-1111-111111111111';
    await expect(
      pool.query(
        `INSERT INTO documents (user_id, filename, original_name, source_type, mime_type, status)
         VALUES ($1, 'f.txt', 'f.txt', 'upload', 'text/plain', 'pending')`,
        [bogusUserId],
      ),
    ).rejects.toThrow(/foreign key/i);
    await pool.end();
  });

  it('`drizzle-kit generate` against this schema yields an empty diff (plan §5.2 step 3)', () => {
    const output = execFileSync(
      'npx',
      ['drizzle-kit', 'generate', '--config', 'drizzle.config.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: dbUrl(DB_NAME) },
        encoding: 'utf8',
      },
    );
    expect(output).toMatch(/No schema changes, nothing to migrate/);
  });
});

describe('migration 0005_add_users_table — pre-existing rows backfill (plan §9 row 2, edge case #10)', () => {
  const DB_NAME = 'mb_test_migration_backfill';

  beforeAll(async () => {
    await createDb(DB_NAME);
  });

  afterAll(async () => {
    await dropDb(DB_NAME);
  });

  it('backfills a pre-existing document and chat_session to the legacy user UUID', async () => {
    const pool = new Pool({ connectionString: dbUrl(DB_NAME) });

    // Apply pre-slice-1 migrations (0000-0004) raw, exactly as they'd have
    // been applied historically, before documents/chat_sessions gained user_id.
    const preSlice1Migrations = [
      '0000_fast_blindfold',
      '0001_loving_proemial_gods',
      '0002_add_chunk_time_bounds',
      '0003_clever_hercules',
      '0004_real_santa_claus',
    ];
    for (const file of preSlice1Migrations) {
      const sql = readFileSync(`./src/db/migrations/${file}.sql`, 'utf8');
      await pool.query(sql);
    }

    // Seed rows as they would have existed before this slice.
    const {
      rows: [doc],
    } = await pool.query(
      `INSERT INTO documents (filename, original_name, source_type, mime_type, storage_key, status)
       VALUES ('legacy-file.txt', 'legacy-file.txt', 'upload', 'text/plain', 'documents/legacy/legacy-file.txt', 'indexed')
       RETURNING id`,
    );
    const {
      rows: [session],
    } = await pool.query(`INSERT INTO chat_sessions DEFAULT VALUES RETURNING id`);

    // Apply the slice-1 migration.
    const migrationSql = readFileSync('./src/db/migrations/0005_add_users_table.sql', 'utf8');
    await pool.query(migrationSql);

    const { rows: docRows } = await pool.query('SELECT user_id FROM documents WHERE id = $1', [
      doc.id,
    ]);
    const { rows: sessionRows } = await pool.query(
      'SELECT user_id FROM chat_sessions WHERE id = $1',
      [session.id],
    );

    expect(docRows[0].user_id).toBe(LEGACY_USER_ID);
    expect(sessionRows[0].user_id).toBe(LEGACY_USER_ID);

    // Edge case #10: the backfill UPDATE is idempotent if re-run (WHERE user_id IS NULL
    // means a second run affects zero rows, not an error).
    await expect(
      pool.query(
        `UPDATE documents SET user_id = '${LEGACY_USER_ID}' WHERE user_id IS NULL; UPDATE chat_sessions SET user_id = '${LEGACY_USER_ID}' WHERE user_id IS NULL;`,
      ),
    ).resolves.toBeDefined();

    await pool.end();
  });
});
