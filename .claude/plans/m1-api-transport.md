# Slice Plan — m1-api-transport

**Owning executor:** api-transport  
**Plan status:** Ready for implementation  
**Depends on:** all previous slices (foundation, data-persistence, chunking-embedding, ingestion-orchestration, retrieval-rag)

---

## 1. Slice + linked spec/PRD sections

| PLAN.md section                   | Relevance                                                |
| --------------------------------- | -------------------------------------------------------- |
| §API Routes                       | All document and chat endpoints                          |
| §Milestone 1 deliverables #11–#16 | Upload, list/get, delete, retry, chat sessions, RAG SSE  |
| §M1 Key Technical Considerations  | Streaming upload, single Postgres transaction for upload |
| §{data,error} envelope            | All non-SSE responses use this shape                     |

---

## 2. Acceptance criteria, verbatim

- **AC-A1.** `POST /api/documents/upload` — streams file to S3, creates document + ingestion_job in one Postgres transaction, enqueues BullMQ job
- **AC-A2.** `GET /api/documents` — list all documents with status
- **AC-A3.** `GET /api/documents/:id` — single document + full job history
- **AC-A4.** `DELETE /api/documents/:id` — delete from Qdrant, cascade Postgres delete, delete S3 object
- **AC-A5.** `POST /api/documents/:id/retry` — re-queue failed document; validates status = 'failed'
- **AC-A6.** `POST /api/chat/sessions` — create session
- **AC-A7.** `GET /api/chat/sessions` — list all sessions
- **AC-A8.** `GET /api/chat/sessions/:id` — session detail with messages
- **AC-A9.** `DELETE /api/chat/sessions/:id` — delete session (messages cascade)
- **AC-A10.** `POST /api/chat/sessions/:id/messages` — streams SSE response from RAG pipeline
- **AC-A11.** All non-SSE responses use `{data, error}` envelope
- **AC-A12.** Routes registered in `src/server.ts` under `/api` prefix

---

## 3. Design overview

Two Fastify plugin files under `src/routes/documents/` and `src/routes/chat/`. Each file exports a Fastify plugin registered with a prefix. Routes use Zod schemas for request validation via `fastify-type-provider-zod`. All non-SSE responses use `sendSuccess`/`sendError` from `src/lib/errors.ts`.

**Upload route**: Reads the multipart stream via `@fastify/multipart`, pipes the file part directly to `storage.uploadStream()` without buffering. Then in a single Postgres transaction: `INSERT documents` + `INSERT ingestion_jobs`. Then calls `ingestionQueue.add()` outside the transaction (BullMQ enqueue; `ingestion_jobs.bullJobId` is the durable receipt).

**Delete route**: Must delete Qdrant points before the Postgres cascade delete. Steps: (1) query `chunks WHERE document_id = $1` to get all `qdrantId` values, (2) call `qdrant.deletePoints(ids)`, (3) `DELETE documents WHERE id = $1` (cascades chunks and jobs), (4) if `document.storageKey` is not null, call `storage.deleteObject(storageKey)`.

**Retry route**: Validates `documents.status === 'failed'`; generates a new BullMQ job ID; `INSERT ingestion_jobs`; enqueues new BullMQ job.

**SSE route**: Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` on the reply, then calls `chat.streamChatResponse(sessionId, message, reply)` which writes SSE events directly to `reply.raw`.

---

## 4. Affected files

| Action | Path                             | Owner         |
| ------ | -------------------------------- | ------------- |
| create | `src/routes/documents/upload.ts` | api-transport |
| create | `src/routes/documents/list.ts`   | api-transport |
| create | `src/routes/chat/sessions.ts`    | api-transport |
| create | `src/routes/chat/messages.ts`    | api-transport |
| modify | `src/server.ts`                  | api-transport |

`src/server.ts` modification: uncomment/add the route registration calls in `buildApp()`.

---

## 5. Signatures & data structures

### `src/routes/documents/upload.ts`

```typescript
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { documents, ingestionJobs } from '../../db/schema.js';
import { uploadStream } from '../../services/storage.js';
import { ingestionQueue } from '../../queue/index.js';
import { sendSuccess, AppError } from '../../lib/errors.js';
import { randomUUID } from 'node:crypto';

export const documentUploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/documents/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) throw new AppError('NO_FILE', 'No file uploaded', 400);

    const documentId = randomUUID();
    const storageKey = `documents/${documentId}/${data.filename}`;

    // Stream to S3 — no disk buffering
    await uploadStream(storageKey, data.file, data.mimetype);

    // Single Postgres transaction: INSERT document + INSERT ingestion_job
    const bullJobId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        filename: data.filename,
        originalName: data.filename,
        sourceType: 'upload',
        mimeType: data.mimetype,
        storageKey,
        status: 'pending',
        sizeBytes: Number(request.headers['content-length'] ?? 0) || null,
      });
      await tx.insert(ingestionJobs).values({
        documentId,
        bullJobId,
        status: 'queued',
        attempt: 1,
      });
    });

    // BullMQ enqueue (outside transaction; job record is durable receipt)
    await ingestionQueue.add(
      'ingest',
      { documentId, storageKey, attempt: 1 },
      { jobId: bullJobId },
    );

    sendSuccess(reply, { documentId, status: 'pending' }, 201);
  });
};
```

### `src/routes/documents/list.ts`

Handles GET /documents, GET /documents/:id, DELETE /documents/:id, POST /documents/:id/retry.

```typescript
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, chunks, ingestionJobs } from '../../db/schema.js';
import { deleteObject } from '../../services/storage.js';
import { deletePoints } from '../../services/qdrant.js';
import { ingestionQueue } from '../../queue/index.js';
import { sendSuccess, AppError } from '../../lib/errors.js';
import { randomUUID } from 'node:crypto';

export const documentListRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /documents — list all
  app.get('/documents', async (_request, reply) => {
    const docs = await db.select().from(documents).orderBy(documents.createdAt);
    sendSuccess(reply, docs);
  });

  // GET /documents/:id — detail + job history
  app.get(
    '/documents/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.params.id))
        .limit(1);
      if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);
      const jobs = await db
        .select()
        .from(ingestionJobs)
        .where(eq(ingestionJobs.documentId, request.params.id))
        .orderBy(ingestionJobs.createdAt);
      sendSuccess(reply, { ...doc, jobs });
    },
  );

  // DELETE /documents/:id
  app.delete(
    '/documents/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.params.id))
        .limit(1);
      if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);

      // Delete Qdrant points first (before Postgres cascade)
      const chunkRows = await db
        .select({ qdrantId: chunks.qdrantId })
        .from(chunks)
        .where(eq(chunks.documentId, request.params.id));
      if (chunkRows.length > 0) {
        await deletePoints(chunkRows.map((c) => c.qdrantId));
      }

      // Postgres cascade delete (also removes chunks and ingestion_jobs)
      await db.delete(documents).where(eq(documents.id, request.params.id));

      // S3 cleanup
      if (doc.storageKey) {
        await deleteObject(doc.storageKey).catch(() => {
          /* log, don't fail */
        });
      }

      sendSuccess(reply, { deleted: true });
    },
  );

  // POST /documents/:id/retry
  app.post(
    '/documents/:id/retry',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.params.id))
        .limit(1);
      if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);
      if (doc.status !== 'failed')
        throw new AppError('INVALID_STATUS', 'Document is not in failed state', 409);
      if (!doc.storageKey)
        throw new AppError('NO_STORAGE_KEY', 'Document has no S3 file to re-process', 400);

      const bullJobId = randomUUID();
      await db.insert(ingestionJobs).values({
        documentId: request.params.id,
        bullJobId,
        status: 'queued',
        attempt: 1,
      });
      await ingestionQueue.add(
        'ingest',
        { documentId: request.params.id, storageKey: doc.storageKey, attempt: 1 },
        { jobId: bullJobId },
      );

      sendSuccess(reply, { jobId: bullJobId });
    },
  );
};
```

### `src/routes/chat/sessions.ts`

```typescript
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { chatSessions, messages } from '../../db/schema.js';
import { sendSuccess, AppError } from '../../lib/errors.js';

export const chatSessionRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /chat/sessions
  app.post(
    '/chat/sessions',
    {
      schema: { body: z.object({ title: z.string().optional() }) },
    },
    async (request, reply) => {
      const [session] = await db
        .insert(chatSessions)
        .values({ title: request.body.title ?? 'New Chat' })
        .returning();
      sendSuccess(reply, session, 201);
    },
  );

  // GET /chat/sessions
  app.get('/chat/sessions', async (_request, reply) => {
    const sessions = await db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt));
    sendSuccess(reply, sessions);
  });

  // GET /chat/sessions/:id
  app.get(
    '/chat/sessions/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, request.params.id))
        .limit(1);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, request.params.id))
        .orderBy(messages.createdAt);
      sendSuccess(reply, { ...session, messages: msgs });
    },
  );

  // DELETE /chat/sessions/:id
  app.delete(
    '/chat/sessions/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, request.params.id))
        .limit(1);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);
      await db.delete(chatSessions).where(eq(chatSessions.id, request.params.id));
      sendSuccess(reply, { deleted: true });
    },
  );
};
```

### `src/routes/chat/messages.ts`

```typescript
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { streamChatResponse } from '../../services/chat.js';
import { AppError } from '../../lib/errors.js';

export const chatMessageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/chat/sessions/:id/messages',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ message: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      await streamChatResponse(request.params.id, request.body.message, reply);
    },
  );
};
```

### `src/server.ts` modification

Add to `buildApp()` after plugin registrations:

```typescript
import { documentUploadRoutes } from './routes/documents/upload.js';
import { documentListRoutes } from './routes/documents/list.js';
import { chatSessionRoutes } from './routes/chat/sessions.js';
import { chatMessageRoutes } from './routes/chat/messages.js';

// Inside buildApp():
await app.register(documentUploadRoutes, { prefix: '/api' });
await app.register(documentListRoutes, { prefix: '/api' });
await app.register(chatSessionRoutes, { prefix: '/api' });
await app.register(chatMessageRoutes, { prefix: '/api' });
```

---

## 6. Interfaces

### Produced (the HTTP API surface)

All endpoints described in §2.

### Consumed (imports from other slices)

| Symbol                                      | Source                                      |
| ------------------------------------------- | ------------------------------------------- |
| `db`, schema tables                         | m1-data-persistence                         |
| `uploadStream`, `getStream`, `deleteObject` | m1-foundation (storage.ts)                  |
| `deletePoints`                              | m1-chunking-embedding (qdrant.ts)           |
| `ingestionQueue`, `IngestionJobPayload`     | m1-ingestion-orchestration (queue/index.ts) |
| `streamChatResponse`                        | m1-retrieval-rag (chat.ts)                  |
| `sendSuccess`, `sendError`, `AppError`      | m1-foundation (errors.ts)                   |

---

## 7. Invariants upheld

| Invariant                                                                                        | Implementation                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| "Stream multipart uploads directly to S3 — never buffer the full file in memory."                | `data.file` (a Node Readable) passed directly to `uploadStream`; no `await request.file()` buffering.  |
| "Use a single Postgres transaction for INSERT document + INSERT ingestion_job + BullMQ enqueue." | Upload route: both INSERTs inside `db.transaction(...)`; BullMQ `add` called after transaction commit. |
| `ingestion_jobs.bullJobId` is the durable receipt                                                | On Redis failure after transaction, the `queued` job row allows supervisor/manual re-enqueue.          |
| Delete: Qdrant points removed before Postgres cascade                                            | `deletePoints` called before `db.delete(documents)` in DELETE route.                                   |
| All non-SSE responses use `{data, error}` envelope                                               | Every route uses `sendSuccess`/`sendError`; error handler in server.ts catches all `AppError` throws.  |

---

## 8. Edge cases & failure modes

| #   | Scenario                                               | Behaviour                                                                                                                                                      |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Upload with no file part                               | `request.file()` returns null → `AppError('NO_FILE', 400)`                                                                                                     |
| 2   | Upload with unsupported MIME type                      | Accepted at upload; extraction throws `UNSUPPORTED_FORMAT` during ingestion; document ends as `failed`                                                         |
| 3   | Postgres transaction fails during upload               | S3 object already uploaded; orphaned object. Acceptable in M1: document row not created, so no retry possible. S3 lifecycle rules clean up orphans eventually. |
| 4   | BullMQ enqueue fails after transaction                 | `ingestion_jobs` row with `status='queued'` exists; supervisor scan will re-enqueue on next tick                                                               |
| 5   | DELETE while document is `processing`                  | Allowed: Postgres cascade delete proceeds; ingestion worker's next Postgres call will fail with "document missing" and mark job as `UnrecoverableError`        |
| 6   | Retry of a document in `pending` or `processing` state | `AppError('INVALID_STATUS', 409)` — only `failed` documents can be retried                                                                                     |
| 7   | GET /documents/:id with non-existent ID                | `AppError('NOT_FOUND', 404)`                                                                                                                                   |
| 8   | SSE client disconnects mid-stream                      | Node socket close event fires; `reply.raw.write` throws or returns false; `streamChatResponse` catches and stops; message may not be saved to DB               |
| 9   | Chat session not found on message post                 | `streamChatResponse` throws `AppError('SESSION_NOT_FOUND', 404)` before SSE headers sent; Fastify error handler returns JSON 404                               |

---

## 9. Criterion → implementation → proof table

| Criterion                                  | Implementation                                                                                | File            | Proof                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| AC-A1: streaming upload → S3 → tx → BullMQ | `data.file` → `uploadStream`; `db.transaction(INSERT doc + INSERT job)`; `ingestionQueue.add` | `upload.ts`     | Integration: POST multipart → document row `pending`, job row `queued`, BullMQ job enqueued |
| AC-A2: GET /documents                      | `db.select().from(documents)`                                                                 | `list.ts`       | Integration: seed 2 docs → GET returns array of 2                                           |
| AC-A3: GET /documents/:id with jobs        | Join with `ingestionJobs`                                                                     | `list.ts`       | Integration: seed doc + 2 job rows → response includes `jobs` array                         |
| AC-A4: DELETE cascade + Qdrant + S3        | `deletePoints` → `db.delete(documents)` → `deleteObject`                                      | `list.ts`       | Integration: upload doc, index it, DELETE → chunks gone, Qdrant empty, S3 key removed       |
| AC-A5: retry validation                    | Check `status === 'failed'`; insert new job + enqueue                                         | `list.ts`       | Unit: mock db with `status='processing'` → 409 response                                     |
| AC-A6–A9: chat session CRUD                | Standard Drizzle insert/select/delete                                                         | `sessions.ts`   | Integration: create session → list → get detail → delete                                    |
| AC-A10: SSE messages endpoint              | SSE headers set → `streamChatResponse` writes events                                          | `messages.ts`   | Integration: POST message → receive `delta` + `done` SSE events                             |
| AC-A11: {data,error} envelope              | `sendSuccess`/`sendError` on all non-SSE routes                                               | all route files | Contract test: every endpoint returns `{data,error}` shape                                  |
| AC-A12: routes registered in server.ts     | 4 `app.register(...)` calls in `buildApp()`                                                   | `server.ts`     | `npm run typecheck` passes; integration: server starts and responds to each route           |

---

## 10. Completeness self-check

| Check                                                     | Result |
| --------------------------------------------------------- | ------ |
| All 12 ACs mapped in §9                                   | Pass   |
| All owned files have complete route signatures            | Pass   |
| Upload invariants (streaming, single tx, durable receipt) | Pass   |
| Delete sequence (Qdrant before Postgres)                  | Pass   |
| SSE headers set before `streamChatResponse`               | Pass   |
| session-not-found before SSE headers case handled         | Pass   |
| No TBDs                                                   | Pass   |

**Completeness self-check passes. Plan is ready for the api-transport executor.**
