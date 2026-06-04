# Slice Plan — m1-data-persistence

**Owning executor:** data-persistence  
**Plan status:** Ready for implementation  
**Depends on:** m1-foundation (env, db URL)

---

## 1. Slice + linked spec/PRD sections

| PLAN.md section             | Relevance                                                                  |
| --------------------------- | -------------------------------------------------------------------------- |
| §Database Schema            | Verbatim table + enum definitions for all 5 M1 tables                      |
| §Milestone 1 deliverable #2 | "Postgres schema + initial migrations"                                     |
| §ACID Compliance Strategy   | Single-transaction chunk inserts; cascade deletes                          |
| §Load-bearing invariants    | `chunks.qdrantId` unique, deterministic; chunk text lives only in Postgres |

---

## 2. Acceptance criteria, verbatim

- **AC-D1.** 4 pgEnum types: `sourceTypeEnum`, `statusEnum`, `jobStatusEnum`, `roleEnum`
- **AC-D2.** `documents` table with all columns per PLAN.md schema
- **AC-D3.** `chunks` table with `qdrant_id` unique constraint and cascade delete from `documents`
- **AC-D4.** `ingestion_jobs` table with `bull_job_id` unique and cascade delete from `documents`
- **AC-D5.** `chat_sessions` table
- **AC-D6.** `messages` table with cascade delete from `chat_sessions`
- **AC-D7.** `src/db/index.ts` exports `db` (Drizzle client) and `pool` (pg.Pool)
- **AC-D8.** `drizzle.config.ts` at project root for `drizzle-kit generate` and `migrate`
- **AC-D9.** Initial migration SQL generated and included in `src/db/migrations/`

---

## 3. Design overview

Drizzle ORM over `pg.Pool`. The schema file is the single source of truth for all table shapes; migrations are generated from it via `drizzle-kit`. The `db` client is a singleton built from `env.DATABASE_URL`.

Enum values match PLAN.md verbatim — no additions. Foreign keys use `{ onDelete: 'cascade' }` to enable single-row document deletion that cleans up chunks, jobs, and messages automatically. The `chunks.qdrant_id` column has a `.unique()` constraint enforced at the DB level, not just application level.

---

## 4. Affected files

| Action | Path                                             | Owner            |
| ------ | ------------------------------------------------ | ---------------- |
| create | `src/db/schema.ts`                               | data-persistence |
| create | `src/db/index.ts`                                | data-persistence |
| create | `src/db/migrations/` (directory + generated SQL) | data-persistence |
| create | `drizzle.config.ts`                              | data-persistence |

---

## 5. Signatures & data structures

### `src/db/schema.ts`

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';

export const sourceTypeEnum = pgEnum('source_type', [
  'upload',
  'gmail',
  'gdrive',
  'outlook',
  'onedrive',
]);
export const statusEnum = pgEnum('status', ['pending', 'processing', 'indexed', 'failed']);
export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'done', 'failed']);
export const roleEnum = pgEnum('role', ['user', 'assistant']);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  sourceType: sourceTypeEnum('source_type').notNull(),
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key'),
  status: statusEnum('status').notNull().default('pending'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').default({}),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  qdrantId: uuid('qdrant_id').notNull().unique(),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const ingestionJobs = pgTable('ingestion_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  bullJobId: text('bull_job_id').notNull().unique(),
  attempt: integer('attempt').notNull().default(1),
  status: jobStatusEnum('status').notNull().default('queued'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('New Chat'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull(),
  content: text('content').notNull(),
  sources: jsonb('sources').default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### `src/db/index.ts`

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export type Database = typeof db;
```

### `drizzle.config.ts`

```typescript
import { defineConfig } from 'drizzle-kit';
import { env } from './src/config/env.js';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: env.DATABASE_URL },
});
```

### Exported types (consumed by other slices)

```typescript
// From schema.ts (Drizzle inference):
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type Message = typeof messages.$inferSelect;
```

---

## 6. Interfaces

### Produced (consumed by all other slices)

| Symbol                                                             | File               | Consumer                                              |
| ------------------------------------------------------------------ | ------------------ | ----------------------------------------------------- |
| `db`                                                               | `src/db/index.ts`  | ingestion-orchestration, retrieval-rag, api-transport |
| `pool`                                                             | `src/db/index.ts`  | server.ts (graceful shutdown: `pool.end()`)           |
| `documents`, `chunks`, `ingestionJobs`, `chatSessions`, `messages` | `src/db/schema.ts` | all slices doing SQL                                  |
| Inferred types (`Document`, `Chunk`, etc.)                         | `src/db/schema.ts` | retrieval-rag, api-transport                          |

### Consumed

| Symbol             | Source                              |
| ------------------ | ----------------------------------- |
| `env.DATABASE_URL` | `src/config/env.ts` (m1-foundation) |

---

## 7. Invariants upheld

| Invariant (PLAN.md)                                                                           | Implementation                                                                                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| "Postgres is the sole source of truth for chunk text; Qdrant stores only vectors + qdrantId." | `chunks.content text NOT NULL` holds authoritative text; no Qdrant-facing columns in schema.                                  |
| "chunks.qdrantId = uuidv5(documentId + chunkIndex). Unique, deterministic."                   | `qdrant_id uuid NOT NULL UNIQUE` enforced at DB level.                                                                        |
| "Ingestion step 7 is one transaction: every chunk lands as `indexed` or none do."             | Schema supports atomic inserts; transaction logic lives in ingestion-orchestration.                                           |
| Cascade deletes                                                                               | `chunks`, `ingestion_jobs` → `onDelete: 'cascade'` from `documents`. `messages` → `onDelete: 'cascade'` from `chat_sessions`. |

---

## 8. Edge cases & failure modes

| #   | Scenario                                         | Behaviour                                                                                                                                                         |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `drizzle-kit generate` run with no DB connection | Config uses `env.DATABASE_URL` at config-file load time; executor must ensure `.env` is populated before running generate                                         |
| 2   | Duplicate `qdrant_id` insert                     | Postgres `UNIQUE` constraint throws; surfaces as an error in Step 7 transaction, rolling everything back                                                          |
| 3   | `bull_job_id` duplicate (retry path)             | `ingestion_jobs.bull_job_id UNIQUE` prevents inserting a second job record with the same BullMQ ID; api-transport's retry route must generate a new BullMQ job ID |
| 4   | `DATABASE_URL` missing                           | `env` module exits process at startup before DB module loads                                                                                                      |

---

## 9. Criterion → implementation → proof table

| Criterion                                             | Implementation                                          | File                 | Proof                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| AC-D1: 4 enums                                        | `pgEnum` calls for all 4 types                          | `schema.ts`          | `tsc --noEmit` passes; migration SQL contains `CREATE TYPE` for each                     |
| AC-D2: documents table                                | Full column list per PLAN.md                            | `schema.ts`          | Migration SQL matches expected columns                                                   |
| AC-D3: chunks with unique qdrantId + cascade          | `.unique()` + `.references(…, { onDelete: 'cascade' })` | `schema.ts`          | Integration: insert duplicate qdrantId → unique violation; delete document → chunks gone |
| AC-D4: ingestion_jobs with unique bullJobId + cascade | `.unique()` + cascade ref                               | `schema.ts`          | Integration: delete document → job gone                                                  |
| AC-D5: chat_sessions                                  | pgTable definition                                      | `schema.ts`          | Migration SQL contains `CREATE TABLE chat_sessions`                                      |
| AC-D6: messages with cascade                          | cascade ref to chat_sessions                            | `schema.ts`          | Integration: delete session → messages gone                                              |
| AC-D7: db + pool exports                              | `drizzle(pool, { schema })`                             | `db/index.ts`        | `tsc --noEmit` passes; integration: `db.select().from(documents)` runs                   |
| AC-D8: drizzle.config.ts                              | Points to schema + migrations dir                       | `drizzle.config.ts`  | `drizzle-kit generate` produces SQL without errors                                       |
| AC-D9: migration SQL                                  | Generated via `drizzle-kit generate`                    | `src/db/migrations/` | SQL file present; `drizzle-kit migrate` applies cleanly to fresh Postgres                |

---

## 10. Completeness self-check

| Check                                                       | Result          |
| ----------------------------------------------------------- | --------------- |
| Every AC mapped in §9                                       | Pass (AC-D1–D9) |
| All 5 tables + 4 enums with exact column names from PLAN.md | Pass            |
| Cascade deletes on all FK relationships                     | Pass            |
| Unique constraints on qdrant_id and bull_job_id             | Pass            |
| `db` and `pool` both exported                               | Pass            |
| No TBDs                                                     | Pass            |

**Completeness self-check passes. Plan is ready for the data-persistence executor.**
