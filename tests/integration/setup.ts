/**
 * Vitest setup file for the integration suite.
 *
 * These tests run against REAL Postgres, Redis, and Qdrant (per PLAN.md §M1
 * Deliverables — no mocks). To avoid touching the shared development database
 * (which, at the time this suite was authored, already contains real seeded
 * documents/chat_sessions from manual dev usage), DATABASE_URL is overridden
 * to point at a dedicated `mb_test_slice1` database on the same Postgres
 * instance BEFORE `src/config/env.ts` (which does `import 'dotenv/config'`)
 * is ever evaluated. dotenv does not clobber already-set process.env vars,
 * so this override sticks and every other var (REDIS_URL, QDRANT_URL, AWS
 * creds, OPENAI_API_KEY, JWT_SECRET) is still sourced from the real `.env`.
 *
 * Provisioning `mb_test_slice1` and applying migrations 0000-0005 against it
 * is done once via `globalSetup.ts` (see vitest.integration.config.ts).
 */
process.env['DATABASE_URL'] = 'postgresql://memory_bank:dev-password@localhost:5432/mb_test_slice1';
