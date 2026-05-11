# Tickets

Abbreviations: TE=TaskEither, PG=Postgres, QD=Qdrant, OB=outbox, tx=transaction

## Overview

| #       | Title                                       | Depends                        |
| ------- | ------------------------------------------- | ------------------------------ |
| MBS-01  | Infrastructure: Docker Compose              | —                              |
| MBS-02  | Project scaffold: deps + tsconfig           | MBS-01                         |
| MBS-02b | Dev tooling: lint + typecheck + pre-commit  | MBS-02                         |
| MBS-02c | Fastify app: error types + app + server     | MBS-02b                        |
| MBS-03  | PG schema + Drizzle setup                   | MBS-02                         |
| MBS-04  | Qdrant client + collection bootstrap        | MBS-01                         |
| MBS-05  | Auth: signup + JWT middleware               | MBS-03                         |
| MBS-06  | Topics CRUD + outbox                        | MBS-05                         |
| MBS-07  | Tasks CRUD + outbox                         | MBS-06                         |
| MBS-08  | Manual Links API                            | MBS-05                         |
| MBS-09  | Normalization + chunking pipeline           | MBS-02c                        |
| MBS-10  | Embedding service                           | MBS-02c                        |
| MBS-11  | Rule-based auto-linker                      | MBS-03                         |
| MBS-12  | LLM auto-linker                             | MBS-10, MBS-11                 |
| MBS-13  | Outbox worker: poll + ingest                | MBS-09, MBS-10, MBS-11, MBS-12 |
| MBS-14  | Outbox worker: delete + reindex + reconcile | MBS-13                         |
| MBS-15  | Document upload: S3 + PDF                   | MBS-13                         |
| MBS-16  | Document normalization: audio + image       | MBS-15                         |
| MBS-17  | Query: intent classify + metadata extract   | MBS-10                         |
| MBS-18  | Query: entity resolve + parallel retrieval  | MBS-04, MBS-17                 |
| MBS-19  | Query: merge + SSE answer                   | MBS-18                         |
| MBS-20  | Notify-due email (Resend)                   | MBS-13                         |
| MBS-21  | Notification cron (BullMQ)                  | MBS-20                         |
| MBS-22  | Pattern extraction worker                   | MBS-07                         |
| MBS-23  | Recommendation agent                        | MBS-22                         |

---

## Tickets

### MBS-01 Infrastructure

Files: `docker-compose.yml`, `.env.example`

- Postgres 16, Redis 7 (AOF persistence), Qdrant
- Expose ports: 5432, 6379, 6333

### MBS-02 Project scaffold

Files: `package.json`, `tsconfig.json`, `tsconfig.build.json`

- Deps: fastify, fp-ts, zod, zod-to-json-schema, drizzle-orm, pg, ioredis, bullmq, @qdrant/js-client-rest, openai, @anthropic-ai/sdk, resend, @fastify/jwt, @fastify/multipart, bcrypt, tiktoken, @xenova/transformers, pdfjs-dist
- `tsconfig.json`: typecheck config — strict, nodenext ESM, path aliases, `include: ["src/**/*", "*.ts"]`
- `tsconfig.build.json`: extends tsconfig.json, adds `rootDir: ./src`, `outDir: ./dist`, `declaration: true`

### MBS-02b Dev tooling

Files: `eslint.config.ts`, `vitest.config.ts`, `prettier.config.ts`, `.husky/pre-commit`, update `package.json`

- devDeps: husky, eslint, @typescript-eslint/eslint-plugin, @typescript-eslint/parser, eslint-config-prettier, prettier, vitest
- `eslint.config.ts`: flat config, strict TS rules, no-explicit-any, no unused vars; eslint-config-prettier last
- `prettier.config.ts`: singleQuote, semi, printWidth 100, trailingComma all
- `vitest.config.ts`: include `tests/unit/**/*.test.ts`, exclude integration/e2e, passWithNoTests true
- `package.json` scripts: `"lint": "eslint src --no-error-on-unmatched-pattern"`, `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`, `"format": "prettier --write ."`
- `.husky/pre-commit`: four sequential checks — `prettier --check .`, `eslint src`, `tsc --noEmit`, `vitest run`; fails fast on first failure

### MBS-02c Fastify app scaffold

Files: `src/app.ts`, `src/main.ts`, `src/lib/errors.ts`

- `AppError` union: `{ kind: 'not_found' | 'validation' | 'upstream'; service?: string; cause?: unknown }`
- `sendError(reply, err)` maps AppError kind → HTTP code (404/400/502)
- `buildApp(opts?)` factory — Fastify instance with global error handler; never expose stack traces
- `main.ts` reads PORT from env, starts listener on 0.0.0.0

### MBS-03 PG schema + Drizzle

Files: `src/db/schema.ts`, `src/db/index.ts`, `drizzle.config.ts`, `migrations/`, `docker-compose.yml`

- Extensions: `pg_trgm`
- Enums: `task_status` (pending/in_progress/done/cancelled), `task_priority` (low/medium/high), `outbox_status` (pending/processing/done/failed), `outbox_event` (ingest/reindex/delete/notify-due), `source_kind` (task/topic/document), `link_origin` (manual/auto-rule/auto-llm), `chunk_index_status` (pending/complete/failed)
- Tables (all have `id uuid PK`, `user_id uuid FK→users cascade`, `created_at`):
  - `users`: email, password_hash, timezone (IANA string)
  - `topics`: name varchar(500)
  - `tasks`: title varchar(500), description text, status, priority, due_date timestamp, completed_at timestamp, reminder_job_id varchar
  - `documents`: title varchar(500), topic_id uuid FK→topics set null, storage_path varchar, content_hash varchar(64), normalized_text text
  - `chunk_index`: source_id uuid, source_kind, qdrant_point_id uuid, index_status chunk_index_status default pending
  - `links`: source_id uuid, target_id uuid, confidence numeric(4,3), origin link_origin
  - `patterns`: title varchar(500), description text, confidence numeric(4,3), extracted_at timestamp
  - `outbox`: event_type outbox_event, source_kind, source_id uuid, status outbox_status default pending, attempts int default 0, last_error text, process_after timestamp default now()
- `src/db/index.ts`: drizzle(pool) singleton; DATABASE_URL guard (throws at startup); SIGTERM handler drains pool
- `docker-compose.yml`: add `wal_level=logical` and `max_slot_wal_keep_size=2GB` to Postgres command (required for CDC outbox worker in MBS-13)
- `migrations/0002_outbox_cdc.sql`: custom migration — creates `outbox_slot` logical replication slot and `outbox_pub` publication

### MBS-04 Qdrant client + collection

Files: `src/lib/qdrant.ts`, `src/scripts/setup-qdrant.ts`

- Client singleton from `QDRANT_URL` env
- Collection `memory_chunks`: named vectors `default` (1536-dim, Cosine) + `bm25` (sparse)
- Payload indexes: `user_id` (keyword), `topic_id` (keyword), `source_kind` (keyword)

### MBS-05 Auth

Files: `src/routes/auth.ts`, `src/services/auth.ts`, `src/plugins/auth.ts`

- `POST /auth/signup`: body `{ email, password, timezone }` → bcrypt hash → insert user → return JWT
- `src/plugins/auth.ts` (fp wrapper): decorates `fastify.jwt`, adds `preHandler` hook calling `req.jwtVerify()`
- Type augment: `FastifyRequest { user: { id: string; email: string } }`
- Protected routes register `src/plugins/auth.ts` via `fastify.register`

### MBS-06 Topics CRUD

Files: `src/routes/topics.ts`, `src/services/topics.ts`

- Endpoints: `GET /topics`, `POST /topics`, `GET /topics/:id`, `PUT /topics/:id`, `DELETE /topics/:id`
- Create/update: OB tx — insert/update topic + insert outbox `ingest` event
- Delete: OB tx — delete topic + insert outbox `delete` event; delete worker queries chunk_index by (source_id, source_kind) to locate Qdrant points
- All queries scoped to `req.user.id`; Zod validation on body

### MBS-07 Tasks CRUD

Files: `src/routes/tasks.ts`, `src/services/tasks.ts`

- Endpoints: `GET /tasks`, `POST /tasks`, `PUT /tasks/:id`, `DELETE /tasks/:id`
- Create: OB tx — insert task + outbox `ingest`; if `due_date` set also insert outbox `notify-due`
- Update: OB tx — update task + outbox `reindex`; if due_date changed, cancel old + insert new `notify-due`
- Delete: OB tx — delete task + outbox `delete`; delete worker queries chunk_index by (source_id, source_kind) to locate Qdrant points
- Zod schemas for body/query (filter by status, priority)

### MBS-08 Manual Links

Files: `src/routes/links.ts`, `src/services/links.ts`

- `POST /links`: body `{ source_id, target_id, confidence? }` → insert forward + reverse rows in one tx (origin=manual, confidence default 1.0)
- `DELETE /links/:id`: delete both directions (match source_id↔target_id pair)
- `GET /links/:source_id`: return all links where source_id matches, scoped to user_id

### MBS-09 Normalization + chunking

Files: `src/pipelines/normalizer.ts`, `src/pipelines/chunker.ts`

- `normalize(event: OutboxEvent): TE<AppError, string>` — task: `title + "\n" + description`; text/md: pass-through; PDF/audio/image: stubs (throw `not_implemented`)
- `chunk(text: string): TE<AppError, string[]>` — tiktoken `cl100k_base`, 300-800 tokens, 50-token overlap sliding window

### MBS-10 Embedding service

Files: `src/lib/openai.ts`, `src/pipelines/embedder.ts`

- OpenAI client singleton from `OPENAI_API_KEY`
- `embedDense(texts: string[]): TE<AppError, number[][]>` — batch call `text-embedding-3-small`
- `embedSparse(texts: string[]): TE<AppError, SparseVector[]>` — SPLADE via `@xenova/transformers`, returns `{ indices, values }`

### MBS-11 Rule-based auto-linker

Files: `src/pipelines/rule-linker.ts`

- `ruleLink(userId, sourceId, sourceKind, text): TE<AppError, void>`
- Fetch all topic names for user → scan text for matches (case-insensitive) → for each match: insert forward+reverse links (origin=auto-rule, confidence=0.85) in one tx

### MBS-12 LLM auto-linker

Files: `src/prompts/auto-link.ts`, `src/pipelines/llm-linker.ts`

- Prompt: given `text` + list of `{id, name}` topics, return JSON array `[{ topic_id, confidence }]`
- `llmLink(userId, sourceId, sourceKind, text): TE<AppError, void>`
- GPT-4o-mini structured output; filter by confidence >= 0.6; insert reciprocal links (origin=auto-llm) in one tx

### MBS-13 Outbox worker: WAL listener + ingest

Files: `src/lib/queues.ts`, `src/workers/wal-listener.ts`, `src/workers/ingest-worker.ts`

- `src/lib/queues.ts`: four BullMQ queues (ingest, delete, reindex, notify-due); shared ioredis connection; priority delete(1) > reindex(2) > ingest(3) > notify-due(4); exponential backoff 5 attempts for ingest/delete/reindex, 3 for notify-due
- `src/workers/wal-listener.ts` (critical process — must run under PM2/systemd with auto-restart): subscribes to `outbox_slot` via `pgoutput` plugin; on outbox INSERT reads row from WAL record (no extra DB query); enqueues to appropriate BullMQ queue with `jobId=outbox.id` for deduplication; for `notify-due` passes `delay=processAfter-Date.now()` so BullMQ schedules via Redis; acknowledges LSN only after enqueue; exits on error so process manager restarts it
- `src/workers/ingest-worker.ts`: idempotency guard (skip if outbox.status=done); mark `processing`; pipeline: `normalize → hashCheck (SHA-256 vs documents.content_hash) → ruleLink → llmLink → chunk → embedDense+embedSparse → upsertQdrant(wait:true) → insert chunk_index rows → markDone`; rethrow on error (BullMQ retries with exponential backoff)
- Store `content` in Qdrant payload; never write QD outside workers

### MBS-14 Outbox worker: delete + reindex + reconcile

Files: `src/workers/delete-worker.ts`, `src/workers/reindex-worker.ts`, `src/workers/notify-worker.ts`, `src/routes/ingest.ts`

- `src/workers/delete-worker.ts`: idempotency guard; mark `processing`; query `chunk_index WHERE source_id=outbox.source_id AND source_kind=outbox.source_kind` to get qdrant_point_ids → `qdrant.delete('memory_chunks', { wait:true, points: qdrant_point_ids })` → delete chunk_index rows → mark `done`
- `src/workers/reindex-worker.ts`: idempotency guard; mark `processing`; delete existing QD points + chunk_index rows for source → re-run ingest pipeline → mark `done`
- `src/workers/notify-worker.ts`: idempotency guard; mark `processing`; fetch task + user → send reminder email via Resend → mark `done`
- Weekly reconciliation cron (BullMQ): `UPDATE outbox SET status='pending', process_after=now() WHERE status='processing' AND process_after < now()-interval '10 minutes'`
- `GET /ingest/status/:id`: return outbox row for source_id
- `POST /ingest/reindex/:id`: insert outbox `reindex` event for source_id

### MBS-15 Document upload: S3 + PDF

Files: `src/routes/documents.ts`, `src/services/documents.ts`, extend `src/pipelines/normalizer.ts`

- `POST /documents/upload`: multipart — upload raw file to S3 (`storage_path`), compute SHA-256, insert document row, insert outbox `ingest`
- `GET /documents/:id`: return document row (scoped to user)
- `DELETE /documents/:id`: OB tx — delete document + insert outbox `delete` event; delete worker queries chunk_index by (source_id, source_kind) to locate Qdrant points
- PDF branch in normalizer: `pdfjs-dist` text extraction → normalized_text

### MBS-16 Document normalization: audio + image

Files: extend `src/pipelines/normalizer.ts`, `src/prompts/image-caption.ts`

- Audio: fetch from S3 → Whisper API → transcript as normalized_text
- Image: fetch from S3 → GPT-4o Vision (prompt in `image-caption.ts`) → caption+OCR text as normalized_text

### MBS-17 Query: intent + metadata

Files: `src/prompts/intent-classify.ts`, `src/prompts/metadata-extract.ts`, `src/pipelines/query/intent-classify.ts`, `src/pipelines/query/metadata-extract.ts`

- `classifyIntent(query): TE<AppError, 'structured'|'semantic'|'hybrid'>` — GPT-4o-mini
- `extractMetadata(query): TE<AppError, { topic_mention?, date_range?, task_status?, semantic_query }>` — GPT-4o-mini json_schema mode

### MBS-18 Query: entity resolve + retrieval

Files: `src/pipelines/query/entity-resolve.ts`, `src/pipelines/query/hybrid-search.ts`, `src/pipelines/query/graph-traversal.ts`

- `resolveEntity(userId, mention): TE<AppError, string|null>` — ILIKE exact → pg_trgm similarity fallback
- `hybridSearch(params): TE<AppError, QdrantResult[]>` — Qdrant Query API, prefetch dense+sparse, RRF fusion, filter by user_id + optional topic_id, limit 20
- `graphTraversal(params): TE<AppError, LinkedChunk[]>` — recursive SQL on `links`, depth<=2, compound confidence
- `retrieveParallel = sequenceT(TE.ApplyPar)(hybridSearch, graphTraversal)`

### MBS-19 Query: merge + SSE answer

Files: `src/pipelines/query/merge.ts`, `src/prompts/answer.ts`, `src/routes/query.ts`

- `merge(qdrantResults, linkedChunks): ChunkWithScore[]` — `final_score = qdrant_score + link_confidence * 0.3`, dedup by chunk id, top 10
- `POST /query`: run MBS-17→MBS-18→merge → GPT-4o SSE stream
- SSE format: `data: {"type":"token","text":"..."}`, `data: {"type":"sources","chunks":[...]}`, `data: {"type":"done"}`
- Set `Content-Type: text/event-stream`, abort LLM stream on `req.raw` close event

### MBS-20 Notify-due email

Files: `src/lib/resend.ts`, extend `src/workers/outbox-worker.ts`

- Resend client singleton from `RESEND_API_KEY`
- `notify-due` handler: fetch task + user → send reminder email via Resend → mark outbox `done`

### MBS-21 Notification cron

Files: `src/workers/notification-cron.ts`

- BullMQ cron jobs (all timezone-aware via user.timezone):
  - Hourly: check tasks with due_date within 24h, skip if already in `notification_log`
  - Weekly digest: Mon 8am user local — summary of pending tasks
  - Daily overdue: 9am user local — tasks past due_date with status != done/cancelled
- Dedup: insert into `notification_log (user_id, task_id, type, sent_at)` before sending; skip if row exists for same day

### MBS-22 Pattern extraction

Files: `src/prompts/pattern-extract.ts`, `src/workers/pattern-worker.ts`

- BullMQ cron: Mon 3am UTC
- Per user: fetch tasks completed in last 6 months → GPT-4o prompt → JSON array `[{ title, description, confidence }]`
- Upsert into `patterns` (match on title); delete rows with confidence < 0.4

### MBS-23 Recommendation agent

Files: `src/prompts/recommend.ts`, `src/services/recommend.ts`, `src/routes/recommend.ts`

- `POST /recommend`: load user's patterns + incomplete tasks → Claude claude-sonnet-4-6 agent loop → prioritised checklist
- Agent tools: `get_patterns(userId)`, `get_tasks(userId, status)` — both return TE, unwrap before passing to agent
- Stream or return full response depending on latency budget
