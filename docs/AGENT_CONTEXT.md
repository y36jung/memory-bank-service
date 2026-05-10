# Memory Bank — Agent Context

Refer to this file before writing any code. Cross-reference `docs/practices/` for per-topic best practices.

---

## What This System Does

Personal AI memory service. Users store heterogeneous data (tasks, notes, PDFs, audio, images) and retrieve it via natural language. Three phases:

1. **Ingestion** — normalize → hash check → auto-link → chunk → embed → write Qdrant via outbox
2. **Query** — intent classify → metadata extract → entity resolve → hybrid search + graph traversal → merge → LLM answer
3. **Background** — pattern extraction (weekly), notifications (timezone-aware), outbox reconciliation

---

## Databases

|              | PostgreSQL                    | Qdrant                          |
| ------------ | ----------------------------- | ------------------------------- |
| Role         | Source of truth               | Search engine                   |
| Written by   | API handlers + outbox worker  | Outbox worker only              |
| Read by      | API handlers, graph traversal | Query pipeline only             |
| Rebuilt from | Always authoritative          | Fully rebuildable from Postgres |

**Never write Qdrant directly from a route handler.** Always go through the outbox.

---

## Critical Invariants

These must never be broken:

1. **Outbox atomicity** — every source record write (create/update/delete) includes an outbox event in the same Postgres transaction. No exceptions.
2. **User scoping** — every DB query and Qdrant filter includes `user_id`. Never trust `user_id` from request body — always use `req.user.id`.
3. **TaskEither pipeline** — all I/O returns `TE.TaskEither<AppError, A>`. No `try/catch` inside pipelines. Unwrap once at the route handler or worker boundary.
4. **Chunk IDs in delete payload** — collect `chunk_index` IDs before deleting source records (cascade removes them). Carry IDs in the outbox payload.
5. **`wait: true` on Qdrant upsert** — confirms write before marking `chunk_index` complete.
6. **Hash check before re-embedding** — compare SHA-256 of normalized content against `documents.content_hash`. Skip pipeline if unchanged.

---

## Schema Summary

| Table         | Purpose                                                               |
| ------------- | --------------------------------------------------------------------- |
| `users`       | Auth, timezone (IANA string), row ownership                           |
| `topics`      | Project containers; entity resolution target                          |
| `tasks`       | Work items — status, priority, due_date, reminder_job_id              |
| `documents`   | Normalized text + content_hash + S3 storage_path for binary           |
| `chunk_index` | Tracks chunk existence and Qdrant sync status (observability only)    |
| `links`       | Relationships between records — powers graph traversal                |
| `patterns`    | Weekly-extracted recurring task patterns — feeds recommendation agent |
| `outbox`      | Pending Qdrant sync events — the durability guarantee                 |

**Required Postgres extensions:** `uuid-ossp` (UUID PKs), `pg_trgm` (fuzzy entity resolution).

---

## Outbox Event Types

| `event_type` | Trigger              | Worker action                                  |
| ------------ | -------------------- | ---------------------------------------------- |
| `ingest`     | Create               | Normalize → chunk → embed → upsert Qdrant      |
| `reindex`    | Update               | Delete old Qdrant points → re-run ingest       |
| `delete`     | Delete               | Delete Qdrant points by `chunk_ids` in payload |
| `notify-due` | Due date approaching | Send email via Resend                          |

Failed events retry with exponential backoff up to 5 attempts, then marked `failed`.

---

## Normalization by Source Type

| Type      | Method                                         |
| --------- | ---------------------------------------------- |
| text / md | Pass-through                                   |
| PDF       | `pdfjs-dist` text extraction                   |
| Audio     | OpenAI Whisper → transcript; raw file in S3    |
| Image     | GPT-4o Vision captioning + OCR; raw file in S3 |
| Task      | `title + "\n" + description`                   |

---

## Query Pipeline

```
User query
  → intent classify (gpt-4o-mini) → structured | semantic | hybrid
  → metadata extract (gpt-4o-mini, json_schema) → topic_mention, date_range, task_status, semantic_query
  → entity resolve (Postgres ILIKE → pg_trgm fallback) → topic_id
  → embed query (text-embedding-3-small + SPLADE)
  → [Qdrant hybrid search || graph traversal] (parallel via sequenceT(TE.ApplyPar))
  → merge: final_score = qdrant_score + (link_confidence × 0.3)
  → top 10 chunks → GPT-4o (SSE stream) → answer
```

Graph traversal: recursive SQL on `links` table, depth ≤ 2, compound confidence across hops.

---

## Auto-Linking (Ingestion)

1. **Rule-based** (always runs): scan content for topic name matches → confidence 0.85
2. **LLM-based** (optional, gpt-4o-mini): detects implicit references → confidence 0.7–0.9, threshold ≥ 0.6

Always write reciprocal links (forward + reverse) in the same transaction.

Link confidence weights: manual = 1.0, auto rule-based = 0.85, auto LLM = 0.7–0.9.

---

## Chunking + Embedding

- **Chunks:** 300–800 tokens, 50-token overlap, tiktoken `cl100k_base`
- **Dense vector:** 1536-dim via `text-embedding-3-small` — batch inputs in one API call
- **Sparse vector:** BM25 token weights via SPLADE (`@xenova/transformers`)
- Qdrant collection: `memory_chunks`, named vectors `default` (dense) + `bm25` (sparse), RRF fusion

---

## Background Jobs

| Job                   | Schedule                           | What it does                                                |
| --------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Pattern extraction    | Monday 3am UTC per user's timezone | GPT-4o over 6 months of completed tasks → upsert `patterns` |
| Weekly digest         | Monday 8am user local time         | Summary email via Resend                                    |
| Daily overdue check   | 9am user local time                | Flag overdue tasks                                          |
| Outbox reconciliation | Weekly                             | Reset `processing` rows stuck > 10 min back to `pending`    |

Use BullMQ for cron; outbox for event-driven. Prevent duplicate fires with `notification_log`.

---

## Model Responsibilities

| Task                                            | Model               |
| ----------------------------------------------- | ------------------- |
| Intent classify, metadata extract, auto-linking | `gpt-4o-mini`       |
| Query answer generation                         | `gpt-4o` (SSE)      |
| Pattern extraction                              | `gpt-4o`            |
| Image captioning / OCR                          | `gpt-4o` (Vision)   |
| Audio transcription                             | Whisper             |
| Agent loops (query agent, recommendation agent) | `claude-sonnet-4-6` |

---

## Key Patterns

All code must follow these. See `docs/practices/` for full examples.

**Every I/O function:**

```typescript
const fn = (input: A): TE.TaskEither<AppError, B> =>
  TE.tryCatch(
    () => somePromise(input),
    (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause }),
  );
```

**Pipeline composition:**

```typescript
const pipeline = (input: RawInput) =>
  pipe(normalize(input), TE.flatMap(chunk), TE.flatMap(embed), TE.flatMap(upsert));
```

**Parallel operations — use `sequenceT(TE.ApplyPar)`, not `Promise.all`:**

```typescript
sequenceT(TE.ApplyPar)(hybridSearch(params), graphTraversal(params));
```

**Outbox transaction:**

```typescript
await db.transaction(async (tx) => {
  const [record] = await tx.insert(table).values(data).returning();
  await tx.insert(outbox).values({ eventType, sourceId: record.id, ... });
});
```

**Unwrap at the edge only:**

```typescript
const result = await pipeline(input)();
if (E.isLeft(result)) return sendError(reply, result.left);
return reply.code(201).send(result.right);
```

---

## Module Map

```
src/
  db/
    schema.ts          # Drizzle table definitions — source of truth
    index.ts           # db client singleton
  routes/              # Fastify plugins (thin handlers only)
  services/            # Business logic — all return TaskEither
  pipelines/           # Ingestion + query pipelines
  workers/             # Outbox worker, BullMQ workers
  prompts/             # All LLM prompt strings as named exports
  lib/                 # Shared utilities (openai client, anthropic client, qdrant client)
tests/
  integration/
  e2e/
```

---

## Best Practice Docs

| File                                     | Covers                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| [typescript.md](practices/typescript.md) | tsconfig, error types, fp-ts TaskEither                                       |
| [fastify.md](practices/fastify.md)       | Plugins, Zod validation, auth, SSE                                            |
| [database.md](practices/database.md)     | Drizzle schema, transactions, Qdrant upsert/search/delete, parallel retrieval |
| [bullmq.md](practices/bullmq.md)         | Outbox worker, dispatch, retry/backoff, cron jobs                             |
| [ai.md](practices/ai.md)                 | Model selection, embeddings, structured output, agent loop, tool design       |
| [testing.md](practices/testing.md)       | Unit/integration structure, LLM mocking, TaskEither assertions                |
| [jsdoc.md](practices/jsdoc.md)           | JSDoc for functions, types, schemas, constants, route handlers                |
