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

// ─── Inferred types ────────────────────────────────────────────────────────────

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type Message = typeof messages.$inferSelect;
