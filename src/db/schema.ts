import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Enums

// Lifecycle state of a task
export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'in_progress',
  'done',
  'cancelled',
]);

// User-assigned urgency of a task
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high']);

// Processing state of an outbox event
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'processing',
  'done',
  'failed',
]);

// Type of side-effect the outbox worker must perform
export const outboxEventEnum = pgEnum('outbox_event', [
  'ingest', // embed and upsert into Qdrant
  'reindex', // delete existing vectors and re-ingest
  'delete', // remove vectors from Qdrant
  'notify-due', // send a due-date reminder at runAfter time
]);

// The type of entity that owns a chunk or link
export const sourceKindEnum = pgEnum('source_kind', ['task', 'topic', 'document']);

// How a link between two entities was created
export const linkOriginEnum = pgEnum('link_origin', ['manual', 'auto-rule', 'auto-llm']);

// Qdrant sync state for a chunk; set by the ingest worker
export const chunkIndexStatusEnum = pgEnum('chunk_index_status', ['pending', 'complete', 'failed']);

// Tables

// Registered users; all other tables cascade-delete on user removal
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  timezone: varchar('timezone', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Named knowledge categories a user organises tasks and documents under
export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 500 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index('topics_user_id_idx').on(table.userId),
    index('topics_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  ],
);

// User to-dos with optional due date and reminder scheduling
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('pending'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    dueDate: timestamp('due_date'),
    completedAt: timestamp('completed_at'),
    // BullMQ job ID for the scheduled notify-due reminder; null if no due date
    reminderJobId: varchar('reminder_job_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index('tasks_user_status_idx').on(table.userId, table.status),
    index('tasks_due_date_open_idx')
      .on(table.userId, table.dueDate)
      .where(sql`status NOT IN ('done', 'cancelled')`),
    index('tasks_completed_at_done_idx')
      .on(table.userId, table.completedAt)
      .where(sql`status = 'done'`),
  ],
);

// Uploaded files (PDF, audio, image); normalizedText populated by the ingest pipeline
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 500 }).notNull(),
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    storagePath: varchar('storage_path').notNull(),
    // SHA-256 of the raw file; used by ingest worker to skip unchanged documents
    contentHash: varchar('content_hash', { length: 64 }),
    normalizedText: text('normalized_text'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index('documents_user_topic_idx').on(table.userId, table.topicId)],
);

// Cross-database join table between Postgres source records and Qdrant vector points;
// used by delete and reindex workers to locate and manage Qdrant points by source
export const chunkIndex = pgTable(
  'chunk_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull(),
    sourceKind: sourceKindEnum('source_kind').notNull(),
    qdrantPointId: uuid('qdrant_point_id').notNull(),
    // Pending until Qdrant upsert completes; set to complete/failed by the ingest worker
    indexStatus: chunkIndexStatusEnum('index_status').notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('chunk_index_source_point_unique').on(
      table.sourceId,
      table.sourceKind,
      table.qdrantPointId,
    ),
    index('chunk_index_user_source_idx').on(table.userId, table.sourceKind, table.sourceId),
    index('chunk_index_status_pending_idx')
      .on(table.indexStatus)
      .where(sql`index_status != 'complete'`),
  ],
);

// Directed edges between any two source entities; supports graph traversal at query time
export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull(),
    targetId: uuid('target_id').notNull(),
    // 0.000–1.000; how strongly the two entities are related
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    origin: linkOriginEnum('origin').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('links_user_source_target_unique').on(table.userId, table.sourceId, table.targetId),
    index('links_user_target_idx').on(table.userId, table.targetId),
  ],
);

// Recurring behavioural patterns extracted weekly from completed tasks via GPT-4o
export const patterns = pgTable(
  'patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    extractedAt: timestamp('extracted_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index('patterns_user_confidence_idx').on(table.userId, table.confidence.desc())],
);

// Durable event log written atomically with source record mutations;
// WAL listener reads inserts and enqueues BullMQ jobs for async processing
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: outboxEventEnum('event_type').notNull(),
    sourceKind: sourceKindEnum('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // Worker processes the event at or after this time; future timestamp for notify-due
    processAfter: timestamp('process_after').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index('outbox_pending_idx')
      .on(table.processAfter, table.createdAt)
      .where(sql`status not in ('done', 'failed')`),
  ],
);

// Inferred types (used by service layer)

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type ChunkIndex = typeof chunkIndex.$inferSelect;
export type NewChunkIndex = typeof chunkIndex.$inferInsert;
export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export type Pattern = typeof patterns.$inferSelect;
export type NewPattern = typeof patterns.$inferInsert;
export type Outbox = typeof outbox.$inferSelect;
export type NewOutbox = typeof outbox.$inferInsert;
