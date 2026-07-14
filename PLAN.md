# Memory Bank — Technical Architecture Plan

## Overview

Memory Bank is a single-user RAG-powered backend service that lets you chat with your personal knowledge base of uploaded documents. The service ingests content, chunks and embeds it, stores vectors in Qdrant, and answers natural-language questions using GPT-4o with retrieved context.

Email (Gmail, Outlook) and cloud file (Google Drive, OneDrive) ingestion via OAuth was originally scoped as Milestones 3 & 4, but has been deferred — see [Future Additions](#future-additions).

---

## Tech Stack Decisions

| Concern             | Choice                        | Rationale                                                                                                              |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Runtime             | Node.js + TypeScript          | Specified; strong async I/O for streaming LLM responses                                                                |
| Framework           | Fastify                       | Faster than Express, native JSON schema validation, built-in plugin system, first-class TypeScript support             |
| ORM                 | Drizzle                       | Schema-first with typed migrations, excellent TypeScript inference, lighter than Prisma, pairs naturally with Postgres |
| Primary DB          | PostgreSQL                    | Stores documents, chunks metadata, chat history, job state                                                             |
| Vector Store        | Qdrant                        | Dedicated ANN search; payload storage means chunk text lives alongside vectors for fast retrieval                      |
| Object Storage      | AWS S3                        | Raw file storage; presigned URLs for uploads                                                                           |
| Job Queue           | BullMQ + Redis                | Durable async ingestion queue; supports retries, priority, and concurrency limits                                      |
| LLM                 | OpenAI GPT-4o                 | Chat completions with streaming (SSE)                                                                                  |
| Embeddings          | OpenAI text-embedding-3-large | 3072-dim, best retrieval quality in the OpenAI lineup                                                                  |
| Audio Transcription | OpenAI Whisper                | Milestone 2                                                                                                            |
| Vision / OCR        | OpenAI GPT-4o Vision          | Milestone 2                                                                                                            |
| Validation          | Zod                           | Runtime schema validation; integrated with Fastify via `fastify-type-provider-zod`                                     |
| Config              | `dotenv` + `zod` env schema   | Fails fast on missing env vars at startup                                                                              |
| Testing             | Vitest                        | Fast, ESM-native, great TypeScript support                                                                             |

---

## High-Level Architecture

```
Client (HTTP/SSE)
        │
        ▼
   Fastify API
  ┌────────────────────────────────────────────────────┐
  │  Routes: /documents, /chat                          │
  └────────────┬───────────────────────────────────────┘
               │
     ┌─────────┴──────────┐
     │                    │
     ▼                    ▼
Ingestion Path       Query Path
     │                    │
     ▼                    ▼
BullMQ Queue        Embed query
(Redis)             → Qdrant search
     │              → Fetch chunk text
     ▼              → GPT-4o (stream)
Worker Process           │
  ├─ Extract text         ▼
  ├─ Chunk           SSE response
  ├─ Embed               to client
  ├─ Upsert Qdrant
  └─ Update Postgres
        │
   ┌────┴────┐
   │         │
Postgres    Qdrant
(metadata)  (vectors + chunk text payload)
        │
       S3
   (raw files)
```

---

## Database Schema (Drizzle + PostgreSQL)

### `documents`

Tracks every ingested source. Currently only `upload` is active; `gmail` | `gdrive` | `outlook` | `onedrive` are reserved for the deferred OAuth work (see [Future Additions](#future-additions)).

```typescript
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  sourceType: sourceTypeEnum('source_type').notNull(), // 'upload' | 'gmail' | 'gdrive' | 'outlook' | 'onedrive'
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key'), // S3 key; null for OAuth-synced text
  status: statusEnum('status').notNull().default('pending'), // 'pending' | 'processing' | 'indexed' | 'failed'
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').default({}), // source-specific: email thread id, drive file id, etc.
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

### `chunks`

Stores all chunk content and metadata. Postgres is the single source of truth for chunk text — Qdrant holds only the vector and the UUID used to look up this row.

```typescript
export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  qdrantId: uuid('qdrant_id').notNull().unique(), // deterministic: uuidv5(documentId + chunkIndex)
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(), // authoritative chunk text lives here
  tokenCount: integer('token_count').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

> **Why store chunk text in Postgres, not Qdrant?** Postgres is the authoritative store. If the Qdrant collection is ever corrupted or needs to be migrated, it can be fully rebuilt by re-embedding `chunks.content` — no need to touch S3 or re-extract source files. Qdrant is treated as a pure vector index, not a data store.

### `ingestion_jobs`

Audit log for every BullMQ job. Serves three purposes: idempotency checks on retry (was a job already enqueued for this document?), startup reconciliation (detecting documents registered in Postgres with no corresponding BullMQ job), and job history for `GET /documents/:id` (attempt count, timing, error messages per attempt).

```typescript
export const ingestionJobs = pgTable('ingestion_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  bullJobId: text('bull_job_id').notNull().unique(),
  attempt: integer('attempt').notNull().default(1),
  status: jobStatusEnum('status').notNull().default('queued'), // 'queued' | 'running' | 'done' | 'failed'
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### `chat_sessions`

```typescript
export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('New Chat'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

### `messages`

```typescript
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  sources: jsonb('sources').default([]), // [{ chunkId, documentId, documentName, score }]
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

`oauth_tokens` has been removed for now — see [Future Additions](#future-additions) for its schema.

---

## Data Ingestion Pipeline

This is the core of the service. Every source — upload, Gmail, Google Drive, Outlook, OneDrive — converges into a single normalized ingestion pipeline.

### Step-by-step

Each async operation is wrapped in a `withTimeout` helper that races the operation against a rejection timer. When the timer fires it throws a descriptive error (e.g. `Timeout: OpenAI embedding exceeded 30000ms`) which BullMQ catches and treats as a normal job failure, triggering retry with exponential backoff.

```typescript
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms),
    ),
  ]);
```

```
1. RECEIVE
   Upload → multipart → S3 (raw file)

2. REGISTER (Postgres transaction)
   INSERT document (status = 'pending')
   INSERT ingestion_job (status = 'queued')
   COMMIT → enqueue BullMQ job (jobId = ingestion_jobs.bullJobId)

3. WORKER picks up job — CLEANUP FIRST
   DELETE chunks WHERE document_id = :id        ← wipes any partial state from prior attempt
   DELETE Qdrant points WHERE documentId = :id  ← wipes any partial vectors
   UPDATE document SET status = 'processing'
   UPDATE ingestion_job SET status = 'running', started_at = now(), attempt++

4. EXTRACT  ← timeout: 60s
   withTimeout(extractText(file), 60_000, 'extract')
   Parse raw content into plain text (see extractor map below)

5. CHUNK  (synchronous — no timeout needed)
   Recursive splitter: ~800 tokens per chunk, 150-token overlap
   Preserve sentence boundaries

6. EMBED  ← timeout: 30s per batch
   withTimeout(openai.embeddings.create(...), 30_000, 'embed')
   Batch OpenAI text-embedding-3-large calls (max 2048 texts/request)
   Exponential backoff on rate-limit errors (separate from timeout)

7. COMMIT Postgres (transaction)  ← timeout: 10s
   withTimeout(db.transaction(async tx => {
     INSERT chunks[] (qdrant_id, content, chunk_index, token_count per chunk)
     UPDATE document SET status = 'indexed'
     UPDATE ingestion_job SET status = 'done', finished_at = now()
   }), 10_000, 'postgres commit')

8. UPSERT Qdrant (after Postgres commit succeeds)  ← timeout: 15s
   withTimeout(qdrant.upsert(...), 15_000, 'qdrant upsert')
   Collection: 'memory_bank'
   Point ID: uuidv5(documentId + chunkIndex)  ← deterministic = safe retries
   Payload: { qdrantId }                       ← UUID only; no text, no content
   Vector: embedding float[]

9. ON TIMEOUT OR ERROR (any step)
   Throws descriptive, human-readable error message
   BullMQ catches error → retries steps 3–8 up to 3× with exponential backoff
   Step 3 cleanup ensures each retry starts from a clean slate
   Error messages describe what timed out (e.g. 'Timeout: OpenAI embedding exceeded 30000ms')
   not raw stack traces, so the user can distinguish infrastructure issues from file issues

10. ON ALL RETRIES EXHAUSTED
    UPDATE document SET status = 'failed', error_message = <human-readable>
    UPDATE ingestion_job SET status = 'failed', error_message = <human-readable>
    User is presented with the error and two options:
      - Retry: POST /documents/:id/retry re-queues the job against the existing S3 file
               (no re-upload needed — the file is already in S3 and is untouched by failed attempts)
      - Delete: DELETE /documents/:id removes the document record, S3 file, and all associated data

11. SUPERVISOR (backstop only — runs every 10 minutes)
    SELECT * FROM ingestion_jobs
    WHERE status = 'running' AND started_at < now() - interval '20 minutes'
    → re-queue any found (catches edge cases that timeouts could not anticipate)
```

### ACID Compliance Strategy

The challenge: Postgres and Qdrant are two separate systems with no shared transaction coordinator.

**Pattern used: "Postgres-first, Qdrant-as-derived-index"**

- Postgres is the **single source of truth** for all content: document records, chunk text, job history, and chat messages.
- Qdrant is a **pure vector index** — it stores only float vectors and the `qdrantId` UUID that maps back to `chunks.qdrant_id` in Postgres. No content lives in Qdrant.
- **Qdrant is fully rebuildable** from Postgres at any time: re-embed all `chunks.content` rows and upsert with the same deterministic IDs. No S3 access required.
- **Ordering matters:** Postgres is committed _before_ Qdrant is written (step 7 → step 8). If Qdrant is unavailable after the Postgres commit, the document is marked `failed` and the job retries from step 8 — chunk text is already safe in Postgres.
- The ingestion job record in Postgres acts as a **write-ahead log entry**. Each async operation in the worker is wrapped in a `withTimeout` helper — if a worker hangs, the timeout throws a descriptive error that BullMQ catches and retries. A lightweight supervisor runs every 10 minutes as a last-resort backstop, detecting `status = 'running'` jobs older than 20 minutes that timeouts failed to catch.
- Qdrant upserts use **deterministic point IDs** (`uuidv5(documentId + chunkIndex)`), so retries are always idempotent — never produce duplicates.
- Postgres chunk inserts and document status updates are wrapped in a **single transaction** (step 7). Either all chunks commit with the `indexed` status, or none do.
- Document deletion: (1) delete Postgres rows — cascade removes chunks automatically — then (2) delete Qdrant points by `documentId` filter. If step 2 fails, a background cleanup job can reconcile orphaned Qdrant points by diffing `chunks.qdrant_id` against the Qdrant collection.

### Extractor Map

| MIME type / format  | Extractor                                            |
| ------------------- | ---------------------------------------------------- |
| `text/plain`, `.md` | Direct string read                                   |
| `application/pdf`   | `pdf-parse`                                          |
| `.docx`             | `mammoth`                                            |
| `.xlsx`, `.csv`     | `xlsx` / `csv-parse`                                 |
| `image/*`           | GPT-4o Vision (Milestone 2)                          |
| `audio/*`           | Whisper API (Milestone 2)                            |
| `video/*`           | ffmpeg frame extraction + Whisper (Milestone 2)      |
| Gmail message       | HTML-to-text via `@mozilla/readability` or `cheerio` |
| Google Doc / Slide  | Google Drive export API → PDF or plain text          |
| Outlook message     | Microsoft Graph API `.body.content`                  |

---

## Query Pipeline (RAG)

```
1. User sends message to POST /chat/sessions/:id/messages

2. Embed the query
   OpenAI text-embedding-3-large → 3072-dim vector

3. Search Qdrant
   collection: 'memory_bank'
   top_k: max(final_top_k * 3, 20)  — over-fetched candidate pool for reranking (step 5)
   score_threshold: 0.4  (configurable)
   with_payload: false   (Qdrant returns only vector IDs and scores — no content)

4. Fetch chunk text from Postgres
   SELECT id, content, document_id, chunk_index FROM chunks
   WHERE qdrant_id = ANY([:qdrantIds])
   Single query; results joined with Qdrant scores in application layer

5. Rerank
   Local cross-encoder (ms-marco-MiniLM via @xenova/transformers) scores each
   candidate against the raw query (not the HyDE text used for embedding) and
   truncates the widened candidate pool down to the final top_k.

6. Build context
   Concatenate top chunks with source attribution headers
   Trim to fit within GPT-4o's context window (leaving room for system prompt + response)
   Token counting via `tiktoken`

7. GPT-4o chat completion (streaming)
   System prompt: instructs the model to answer from context only,
                  cite sources, and say "I don't know" when context is insufficient
   Messages: [system, ...recent chat history (last 6), user]

8. Stream SSE response to client
   As tokens arrive from OpenAI, forward them as SSE events

9. On stream completion (Postgres transaction)
   INSERT assistant message with content + sources JSON
   sources reference chunks.id (Postgres PKs), not Qdrant IDs
   COMMIT
```

---

## API Design

All routes are prefixed `/api/v1`. Responses follow `{ data, error }` envelope.

### Auth

| Method | Path             | Description                                                                                       |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------- |
| `POST` | `/auth/register` | Create an account; returns `{ user, accessToken }` (201) + sets refresh cookie                    |
| `POST` | `/auth/login`    | Authenticate with email + password; returns `{ user, accessToken }` (200) + refresh cookie        |
| `POST` | `/auth/refresh`  | Rotate the refresh token (read from cookie); returns `{ accessToken }` (200) + new refresh cookie |
| `POST` | `/auth/logout`   | Revoke the current refresh-token family; clears the refresh cookie (200, idempotent)              |

**Auth flow detail:**

```
POST /auth/register   body: { email, password (min 8) }
  → 201 { data: { user: { id, email }, accessToken } } + Set-Cookie: refresh_token (httpOnly)
  → 409 EMAIL_TAKEN if the email is already registered

POST /auth/login      body: { email, password }
  → 200 { data: { user: { id, email }, accessToken } } + Set-Cookie: refresh_token (httpOnly)
  → 401 INVALID_CREDENTIALS on unknown email or wrong password
  → rate limited: 10 requests/minute per IP

POST /auth/refresh    (no body; reads the refresh_token cookie)
  → 200 { data: { accessToken } } + rotated Set-Cookie: refresh_token
  → 401 UNAUTHORIZED (uniform code) if the cookie is missing, expired, unknown, or reused
     — reuse of an already-used refresh token revokes its entire token family

POST /auth/logout     (no body; reads the refresh_token cookie)
  → 200 { data: { success: true } } always (idempotent); revokes the token family
     server-side and clears the cookie
```

Access tokens are JWTs (`{ sub: userId }`, HS256, 15-minute TTL, signed with the existing
`JWT_SECRET`). Refresh tokens are opaque random values delivered only via an httpOnly
cookie (30-day TTL); the server stores only their SHA-256 hash, never the raw value, and
rotates them on every `/auth/refresh` call. Each rotation links parent → child, so replaying
an already-used refresh token revokes the entire family (all descendants), forcing
re-authentication of that compromised session.

### Documents

| Method   | Path                   | Description                                                        |
| -------- | ---------------------- | ------------------------------------------------------------------ |
| `POST`   | `/documents/upload`    | Multipart upload; returns document record with `status: 'pending'` |
| `GET`    | `/documents`           | List all documents with status                                     |
| `GET`    | `/documents/:id`       | Single document details + job history                              |
| `DELETE` | `/documents/:id`       | Remove document, S3 file, Qdrant vectors, Postgres rows            |
| `POST`   | `/documents/:id/retry` | Re-queue a failed ingestion job                                    |

**Upload flow detail:**

```
Client → POST /documents/upload (multipart)
       → Fastify streams directly to S3 (no temp disk write)
       → Returns { id, status: 'pending' }

Client polls GET /documents/:id until status = 'indexed' | 'failed'
(or subscribes to GET /documents/:id/events via SSE)
```

### Chat

| Method   | Path                          | Description                              |
| -------- | ----------------------------- | ---------------------------------------- |
| `POST`   | `/chat/sessions`              | Create a new chat session                |
| `GET`    | `/chat/sessions`              | List sessions (most recent first)        |
| `GET`    | `/chat/sessions/:id`          | Session details                          |
| `DELETE` | `/chat/sessions/:id`          | Delete session + messages                |
| `GET`    | `/chat/sessions/:id/messages` | Paginated message history                |
| `POST`   | `/chat/sessions/:id/messages` | Send a message; response streams via SSE |

**SSE message stream format:**

```
event: delta
data: {"token": "The "}

event: delta
data: {"token": "answer is..."}

event: done
data: {"messageId": "...", "sources": [{"documentName": "...", "chunkIndex": 0, "score": 0.87}]}
```

OAuth endpoints have been removed for now — see [Future Additions](#future-additions) for the deferred API surface.

---

## Project Structure

```
memory-bank/
├── src/
│   ├── config/
│   │   └── env.ts              # Zod env schema; fails fast on startup
│   ├── db/
│   │   ├── schema.ts           # Drizzle schema (all tables)
│   │   ├── migrations/         # Generated SQL migrations
│   │   └── index.ts            # DB connection singleton
│   ├── queue/
│   │   ├── index.ts            # BullMQ setup
│   │   └── workers/
│   │       └── ingestion.worker.ts
│   ├── services/
│   │   ├── storage.ts          # S3 operations
│   │   ├── qdrant.ts           # Qdrant client wrapper
│   │   ├── embeddings.ts       # OpenAI embedding calls
│   │   ├── chunker.ts          # Text splitting logic
│   │   ├── extractor/
│   │   │   ├── index.ts        # Extractor dispatch by MIME type
│   │   │   ├── pdf.ts
│   │   │   ├── docx.ts
│   │   │   ├── spreadsheet.ts
│   │   │   ├── audio.ts        # Milestone 2
│   │   │   ├── image.ts        # Milestone 2
│   │   │   └── video.ts        # Milestone 2
│   │   ├── ingestion.ts        # Orchestrates steps 3–8 of pipeline
│   │   ├── retrieval.ts        # Qdrant search + context assembly
│   │   └── chat.ts             # RAG query pipeline + GPT-4o streaming
│   ├── routes/
│   │   ├── documents/
│   │   │   ├── upload.ts
│   │   │   ├── list.ts
│   │   │   └── delete.ts
│   │   └── chat/
│   │       ├── sessions.ts
│   │       └── messages.ts
│   ├── lib/
│   │   ├── errors.ts           # AppError class + Fastify error handler
│   │   ├── tokenizer.ts        # tiktoken wrapper
│   │   └── idgen.ts            # uuidv5 deterministic ID helper
│   └── server.ts               # Fastify app bootstrap
├── scripts/
│   └── rebuild-qdrant.ts       # Re-embeds all chunks.content from Postgres and upserts into Qdrant
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

---

## Milestones

### Milestone 1 — Data Ingestion for Text & Documents

**Goal:** End-to-end working service: upload a document, ask a question, get a grounded answer.

**Deliverables:**

1. Project scaffold: Fastify + TypeScript + Drizzle + Zod env
2. Postgres schema + initial migrations
3. Qdrant collection setup (`memory_bank`, 3072 dims, cosine distance)
4. S3 upload service (stream directly from multipart request)
5. BullMQ ingestion worker wired to Redis
6. Extractors: `.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.xlsx`
7. Chunker service (recursive splitter, token-aware)
8. Embedding service (batch OpenAI calls with retry)
9. Qdrant upsert with deterministic IDs
10. All ingestion steps wrapped in Postgres transactions with status tracking
11. `POST /documents/upload` — streams to S3, enqueues job
12. `GET /documents` + `GET /documents/:id` — status polling
13. `DELETE /documents/:id` — full cleanup
14. `POST /documents/:id/retry` — re-queue failed jobs
15. Chat session + message endpoints
16. RAG query pipeline with SSE streaming
17. Vitest unit tests for chunker, extractor, and retrieval logic

**Key technical considerations for M1:**

- Stream multipart uploads directly to S3 using `@fastify/multipart` + AWS SDK streaming — never buffer the full file in memory.
- Use a single Postgres transaction for `INSERT document` + `INSERT ingestion_job` + BullMQ enqueue. BullMQ's Redis write is outside this transaction, but the job record serves as the durable receipt. If the Redis write fails, a startup reconciliation scan can detect `queued` jobs with no corresponding BullMQ entry and re-enqueue.
- Wrap every async operation in the worker (extract, embed, Postgres commit, Qdrant upsert) with a `withTimeout` helper. This ensures hung workers surface a descriptive error to BullMQ's retry mechanism rather than wedging silently. A lightweight supervisor polling every 10 minutes acts as a last-resort backstop for any edge cases timeouts cannot catch.
- Rate-limit OpenAI embedding calls using a token bucket (e.g., `p-limit`) to stay within TPM limits.

---

### Milestone 2 — Data Ingestion for Audio, Images, Videos

**Goal:** Extend the same ingestion pipeline to handle media files.

**Deliverables:**

1. **Audio** (`.mp3`, `.mp4a`, `.wav`, `.m4a`, `.ogg`): Stream file to OpenAI Whisper API → transcript text → standard chunking pipeline. For files > 25 MB (Whisper limit): split with `ffmpeg` into segments before sending.
2. **Images** (`.jpg`, `.png`, `.gif`, `.webp`): Send to GPT-4o Vision with a prompt asking for a rich textual description + any visible text (OCR). Store the description as the extracted text.
3. **Video** (`.mp4`, `.mov`, `.avi`): Two-pass extraction:
   - Audio track → Whisper transcript
   - Keyframe extraction with `ffmpeg` (1 frame/10s) → GPT-4o Vision descriptions
   - Merge transcript + visual descriptions into a single structured text before chunking
4. MIME type detection via `file-type` library (don't trust the client's `Content-Type`)
5. Update extractor dispatch table to route by detected MIME type
6. S3 file size pre-check; reject files above a configurable max (default 500 MB)
7. Progress tracking for long-running media jobs (expose via `GET /documents/:id`)

**Key technical considerations for M2:**

- `ffmpeg` must be available in the deployment environment. Use `fluent-ffmpeg` as the Node wrapper.
- Whisper has a 25 MB per-request limit. The splitter should cut audio at silence boundaries when possible, using `ffmpeg`'s `silencedetect` filter.
- Vision API calls are expensive. Cache extracted descriptions in S3 as a sidecar file (e.g., `{storageKey}.description.txt`) so re-indexing doesn't re-call Vision.

---

Milestones 3 & 4 (Gmail/Drive and Outlook/OneDrive OAuth) were originally scoped here but have been deferred — see [Future Additions](#future-additions).

---

## Future Additions

These are recommended next steps once the core service is stable.

**1. Multi-tenancy — implemented (slices 1–3)**
The single→multi-user conversion has landed across three slices: a `users` table with per-user `user_id` foreign keys and query-level scoping on every resource (documents, chat sessions, chat messages); a global JWT-verify `preHandler` hook gating all protected routes; a per-user `must` filter on `userId` in every Qdrant search; and S3 storage keys namespaced per user. Slice 3 added the identity surface itself: password-based registration/login, short-lived JWT access tokens, and rotating refresh-token families (with reuse detection) issued and verified via the `/auth/*` endpoints — see [API Design](#api-design). Row-level security enforced natively by Postgres (as opposed to the application-layer `user_id` scoping already in place) remains a possible future hardening step.

**2. OAuth Integration (Gmail, Google Drive, Outlook, OneDrive)**
Deferred to reduce initial scope — was originally Milestones 3 & 4. Revisit once the core single-source (upload) pipeline and multi-tenancy are stable, since OAuth tokens and synced documents need to be scoped per-user from the start.

_Schema:_

```typescript
export const oauthTokens = pgTable('oauth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: providerEnum('provider').notNull(), // 'google' | 'microsoft'
  accessToken: text('access_token').notNull(), // encrypted at rest
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at'),
  scope: text('scope'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

_API surface:_

| Method   | Path                        | Description                                        |
| -------- | --------------------------- | -------------------------------------------------- |
| `GET`    | `/oauth/google/init`        | Redirect to Google consent screen                  |
| `GET`    | `/oauth/google/callback`    | Handle code exchange; store tokens                 |
| `POST`   | `/oauth/google/sync`        | Trigger Gmail + Drive sync job                     |
| `GET`    | `/oauth/google/status`      | Token validity + last sync time                    |
| `DELETE` | `/oauth/google/revoke`      | Revoke tokens + optionally delete synced documents |
| `GET`    | `/oauth/microsoft/init`     | Redirect to Microsoft consent screen               |
| `GET`    | `/oauth/microsoft/callback` | Handle code exchange; store tokens                 |
| `POST`   | `/oauth/microsoft/sync`     | Trigger Outlook + OneDrive sync job                |
| `GET`    | `/oauth/microsoft/status`   | Token validity + last sync time                    |
| `DELETE` | `/oauth/microsoft/revoke`   | Revoke tokens                                      |

**Gmail and Google Drive (originally Milestone 3):**

1. Google OAuth 2.0 flow (`googleapis` SDK): consent screen → code exchange → store encrypted tokens in `oauth_tokens`
2. Token refresh middleware: auto-refresh access tokens before expiry on every sync
3. **Gmail sync worker:**
   - List messages by label or search query (configurable; default: all mail)
   - Fetch message body (prefer `text/plain`, fall back to HTML → `cheerio` strip)
   - Deduplicate by Gmail message ID stored in `documents.metadata`
   - Feed into standard ingestion pipeline
4. **Google Drive sync worker:**
   - List files by MIME type (Docs, Sheets, Slides, PDFs, text files)
   - Google Docs/Slides: export via Drive API as plain text or PDF
   - Sheets: export as CSV
   - Deduplicate by Drive file ID + `modifiedTime` stored in `documents.metadata`
   - Feed into standard ingestion pipeline
5. `POST /oauth/google/sync` enqueues a BullMQ sync job
6. Incremental sync: track `lastSyncedAt` in `oauth_tokens`, only fetch items modified since then
7. `DELETE /oauth/google/revoke`: revoke tokens via Google API + optionally delete all sourced documents

Key technical considerations: store tokens encrypted at rest (`node:crypto` AES-256-GCM, key derived from an env secret); request only `gmail.readonly` and `drive.readonly` scopes; run Drive exports in the BullMQ worker, not the request handler; treat Gmail threads as a unit (ingest the full thread as one document to preserve conversational context).

**Outlook and OneDrive (originally Milestone 4):**

1. Microsoft OAuth 2.0 via `@azure/msal-node`: Azure app registration → consent → token storage
2. **Outlook sync worker (Microsoft Graph API):**
   - `GET /me/messages?$select=subject,body,from,receivedDateTime`
   - Prefer `body.contentType = 'text'`; strip HTML otherwise
   - Deduplicate by Outlook message ID in `documents.metadata`
3. **OneDrive sync worker (Microsoft Graph API):**
   - `GET /me/drive/root/children` (recursive)
   - Download files directly; route to extractor by MIME type
   - Deduplicate by OneDrive item ID + `lastModifiedDateTime`
4. Incremental sync via Graph API `$filter=lastModifiedDateTime gt {lastSyncedAt}`
5. `DELETE /oauth/microsoft/revoke`: revoke via Graph API logout endpoint

Key technical considerations: the Graph API uses a different auth endpoint per tenant (use the `common` authority for personal accounts); OneDrive downloads require the Graph API's `/content` endpoint, not `webUrl`; strip quoted-reply threads from Outlook bodies before chunking; `msal-node`'s `acquireTokenSilent` handles token refresh automatically.

**3. Frontend UI**
A Next.js 15 app (App Router) with:

- Chat interface (streaming responses via SSE)
- Document library with upload drag-and-drop and status indicators
- OAuth connection manager
- Source citation viewer (click a source to see the original chunk in context)

**4. Hybrid Search**
Combine dense vector search (Qdrant) with sparse BM25 keyword search. Qdrant supports sparse vectors natively (as of v1.7). Merge results with Reciprocal Rank Fusion (RRF) before the reranking step. Dramatically improves recall for queries with rare keywords, names, and identifiers.

**5. Reranking — implemented.** See Query Pipeline step 5. A local cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2` via `@xenova/transformers`) reranks an over-fetched candidate pool before context assembly. No external vendor/API — first request after a cold start incurs a one-time ONNX model load.

**6. Slack Integration**
Use the Slack Web API to ingest channel messages and thread history. Treat each thread as a document. Useful for teams repurposing this as a shared knowledge base.

**7. Notion Integration**
Notion's public API supports reading pages and databases. Chunk pages as documents; use database row properties as metadata for structured filtering.

**8. GitHub Integration**
Ingest repo contents (READMEs, code files, issues, PR descriptions) via the GitHub REST API. Useful for a developer memory bank. Code files benefit from syntax-aware chunking (split by function/class, not token count).

**9. Webhook-based Incremental Sync**
Replace polling-based Gmail/Drive sync with push notifications:

- Gmail: Pub/Sub topic via `users.watch`
- Google Drive: `files.watch` push notifications
- Microsoft Graph: `subscriptions` change notifications
  Reduces sync latency from minutes to seconds.

**10. Document Versioning**
Track versions of synced documents. When a Drive file is re-synced, diff the new extracted text against the old version. Only re-embed changed chunks. Reduces unnecessary embedding API calls and keeps vector indexes clean.

**11. Conversation Memory (Episodic)**
Store a compressed summary of each chat session and inject it into subsequent sessions as a "memory" context block. Uses GPT-4o to summarize sessions on close. Gives the assistant long-term recall across conversations, not just within one session.

**12. MCP Server Exposure**
Expose the RAG query endpoint as a Model Context Protocol (MCP) server. This lets Claude Desktop, Cursor, and other MCP-compatible tools query your Memory Bank as a tool call — turning it into a personal knowledge layer for any AI assistant you use.
