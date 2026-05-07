# Drizzle ORM + Qdrant

> Sources: [Drizzle Schema](https://orm.drizzle.team/docs/sql-schema-declaration) · [Transactions](https://orm.drizzle.team/docs/transactions) · [Migrations](https://orm.drizzle.team/docs/migrations) · [drizzle-kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate) · [drizzle-kit migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate) · [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/) · [Qdrant Quickstart](https://qdrant.tech/documentation/quickstart/)

## Drizzle Schema

Define schema in `src/db/schema.ts`. Schema is the source of truth for both queries (Drizzle ORM) and migrations (Drizzle Kit).

```typescript
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 500 }).notNull(),
  status: taskStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

- Always define `onDelete` on foreign keys
- Use `pgEnum` for fixed value sets — not unconstrained `varchar`
- Every table needs `user_id` for row-level scoping

## Migrations

```bash
npx drizzle-kit generate   # generates SQL migration file from schema diff
npx drizzle-kit migrate    # applies pending migrations to DB
```

- Never hand-edit generated migration files
- Commit migration files with schema changes in the same PR
- Destructive changes: two-phase migration — add new, backfill, drop old

## Queries

All DB calls return `TE.TaskEither<AppError, A>`. Always scope to `user_id`.

```typescript
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

const fetchUserTasks = (userId: string): TE.TaskEither<AppError, Task[]> =>
  TE.tryCatch(
    () => db.select().from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.status, 'pending')))
      .orderBy(desc(tasks.createdAt)),
    (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
  );
```

Entity resolution — exact then fuzzy (raw SQL acceptable for `pg_trgm`):

```typescript
const resolveEntity = (userId: string, mention: string): TE.TaskEither<AppError, string | null> =>
  pipe(
    TE.tryCatch(
      () => db.select().from(topics)
        .where(and(eq(topics.userId, userId), ilike(topics.name, mention))).limit(1),
      (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
    ),
    TE.flatMap(exact =>
      exact.length > 0
        ? TE.right(exact[0].id)
        : TE.tryCatch(
            () => db.execute(sql`SELECT id FROM topics WHERE user_id = ${userId}
                ORDER BY similarity(name, ${mention}) DESC LIMIT 1`)
              .then(r => r.rows[0]?.id ?? null),
            (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
          )
    ),
  );
```

## Transactions (Outbox Pattern)

Wrap the entire transaction in `TE.tryCatch` — one atomic boundary:

```typescript
const createTaskWithOutbox = (taskData: NewTask): TE.TaskEither<AppError, Task> =>
  TE.tryCatch(
    () => db.transaction(async (tx) => {
      const [task] = await tx.insert(tasks).values(taskData).returning();
      await tx.insert(outbox).values({
        eventType: 'ingest', sourceKind: 'task',
        sourceId: task.id, userId: task.userId, status: 'pending',
      });
      return task;
    }),
    (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
  );
```

Write reciprocal links in one transaction:
```typescript
await tx.insert(links).values([
  { sourceId, targetId, confidence, origin },
  { sourceId: targetId, targetId: sourceId, confidence, origin },
]);
```

## Parallel Retrieval

Use `sequenceT(TE.ApplyPar)` for concurrent operations — not `Promise.all`:

```typescript
import { sequenceT } from 'fp-ts/Apply';

const retrieveParallel = (params: SearchParams) =>
  sequenceT(TE.ApplyPar)(
    hybridSearch(params),    // TE.TaskEither<AppError, QdrantResult[]>
    graphTraversal(params),  // TE.TaskEither<AppError, LinkedChunk[]>
  );

// Returns TE.TaskEither<AppError, [QdrantResult[], LinkedChunk[]]>
// Fails fast if either side fails
```

## Qdrant — Upsert

```typescript
const upsertChunks = (chunks: Chunk[], meta: ChunkMeta): TE.TaskEither<AppError, void> =>
  TE.tryCatch(
    () => qdrant.upsert('memory_chunks', {
      wait: true,
      points: chunks.map((c, i) => ({
        id: c.chunkId,
        vector: { default: c.denseVector, bm25: c.sparseVector },
        payload: { content: c.text, ...meta, chunk_index: i, created_at: new Date().toISOString() },
      })),
    }),
    (cause): AppError => ({ kind: 'upstream', service: 'qdrant', cause })
  );
```

`wait: true` confirms write before marking `chunk_index` complete. Store `content` in payload — avoids a second Postgres read at query time.

## Qdrant — Hybrid Search

Qdrant supports RRF natively via the Query API:

```typescript
const hybridSearch = (params: SearchParams): TE.TaskEither<AppError, QdrantResult[]> =>
  TE.tryCatch(
    () => qdrant.query('memory_chunks', {
      prefetch: [
        { query: params.denseVector, using: 'default', limit: 20 },
        { query: params.sparseVector, using: 'bm25', limit: 20 },
      ],
      query: { fusion: 'rrf' },
      filter: {
        must: [
          { key: 'user_id', match: { value: params.userId } },
          ...(params.topicId ? [{ key: 'topic_id', match: { value: params.topicId } }] : []),
        ],
      },
      limit: 20,
      with_payload: true,
    }),
    (cause): AppError => ({ kind: 'upstream', service: 'qdrant', cause })
  );
```

## Qdrant — Deletes

Delete by chunk IDs from outbox payload — never query-then-delete:

```typescript
const deleteChunks = (chunkIds: string[]): TE.TaskEither<AppError, void> =>
  TE.tryCatch(
    () => qdrant.delete('memory_chunks', { wait: true, points: chunkIds }),
    (cause): AppError => ({ kind: 'upstream', service: 'qdrant', cause })
  );
```

## Ingestion Pipeline (Composition)

```typescript
const ingest = (event: OutboxEvent): TE.TaskEither<AppError, void> =>
  pipe(
    normalize(event),
    TE.flatMap(hashCheck),
    TE.flatMap(chunk),
    TE.flatMap(embedChunks),
    TE.flatMap(chunks => upsertChunks(chunks, toMeta(event))),
    TE.flatMap(() => markComplete(event.id)),
  );
```

## Avoid

- Queries without `user_id` filter
- Writing to Qdrant outside the outbox worker
- `Promise.all` for parallel TE operations — use `sequenceT(TE.ApplyPar)`
- `db.execute()` for queries the typed builder can handle
