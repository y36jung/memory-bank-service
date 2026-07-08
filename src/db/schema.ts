import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  real,
  timestamp,
  jsonb,
  boolean,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ─── Enum types ────────────────────────────────────────────────────────────────

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

// ─── Tables ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'), // null ⇒ user cannot log in (synthetic/legacy)
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
  },
  (table) => [index('documents_user_id_idx').on(table.userId)],
);

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  qdrantId: uuid('qdrant_id').notNull().unique(),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull(),
  pageNumber: integer('page_number'),
  startSecs: real('start_secs'),
  endSecs: real('end_secs'),
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

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New Chat'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('chat_sessions_user_id_idx').on(table.userId)],
);

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

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(), // sha256(hex) of the raw token; UNIQUE ⇒ index + single-row lookup
    parentTokenId: uuid('parent_token_id').references((): AnyPgColumn => refreshTokens.id, {
      onDelete: 'set null',
    }), // self-ref; annotation avoids TS circular-inference error
    isUsed: boolean('is_used').notNull().default(false),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('refresh_tokens_user_id_idx').on(table.userId)],
);

// ─── Inferred types ────────────────────────────────────────────────────────────

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
