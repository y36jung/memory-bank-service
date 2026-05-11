# Memory Bank — Project Overview

> For architecture and invariants see `AGENT_CONTEXT.md`.

---

## Key Design Rationale

**Hybrid RAG over GraphRAG** — GraphRAG was evaluated and rejected:

| Factor         | GraphRAG                               | Hybrid RAG (chosen)                                                    |
| -------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Ingestion cost | Hundreds of LLM calls per index pass   | One optional GPT-4o-mini call per item (~$0.000135)                    |
| Re-indexing    | Full/partial re-index on every write   | Appends rows to `links` table only                                     |
| Graph depth    | Deep cross-corpus synthesis            | Shallow (task → topic → document) — captured by keyword + one LLM pass |
| Query-time LLM | Yes (community summarisation)          | No — graph traversal is a fast indexed Postgres recursive query        |
| Use case fit   | "What themes connect all my research?" | "What tasks are related to Atlas?" — retrieval, not synthesis          |

**Outbox pattern over direct Qdrant writes** — true distributed ACID across Postgres and Qdrant is not possible without a two-phase commit coordinator. Writing an outbox event atomically in the same Postgres transaction as the source record guarantees no Qdrant sync is ever silently dropped, even if Qdrant or Redis is temporarily unavailable.

**WAL reader (CDC) over polling** — the outbox worker uses Postgres logical replication (`wal_level=logical`) rather than a polling loop. The replication slot is a durable LSN cursor: if the listener restarts it replays from the last acknowledged position with zero missed events. A polling loop achieves similar throughput but has no replay guarantee — events can be missed during downtime and only recovered by a fallback scan. Delivery is at-least-once; workers are idempotent via `jobId` deduplication in BullMQ and an outbox status guard at the start of each handler. The WAL listener is a critical process and must run under a process manager with auto-restart (PM2 in dev, container restart policy in prod).

**Postgres as source of truth** — Qdrant is fully rebuildable from Postgres at any time. Qdrant stores content text in payload to avoid a second Postgres read at query time.

---

## Implementation Roadmap

Steps 1–6 require no LLM or vector API keys. Steps 7–12 require OpenAI. Steps 13–15 are deferrable — no impact on the core hybrid RAG system.

| #   | Work Item               | Deliverable                                                                                                                                                                                                                   | Depends on |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Infrastructure          | Docker Compose: Postgres 16 + Redis 7 (AOF) + Qdrant running locally                                                                                                                                                          | —          |
| 1a  | Project scaffold        | `package.json` + `tsconfig.json` + `tsconfig.build.json` — all prod/dev deps installed, strict ESM TypeScript config                                                                                                          | 1          |
| 1b  | Dev tooling             | ESLint + Prettier + Vitest wired into Husky pre-commit hook; all four checks run on every commit                                                                                                                              | 1a         |
| 1c  | Fastify app scaffold    | `src/app.ts` + `src/main.ts` + `src/lib/errors.ts` — Fastify instance, `AppError` union, global error handler                                                                                                                 | 1b         |
| 2   | Qdrant setup            | `memory_chunks` collection — dense (1536-dim, Cosine) + sparse vectors + payload indexes                                                                                                                                      | 1          |
| 3   | Postgres schema         | Drizzle schema + first migration; all tables: `users`, `topics`, `tasks`, `documents`, `chunk_index`, `links`, `patterns`, `outbox`                                                                                           | 1          |
| 4   | Auth middleware         | JWT verification; `req.user` attached to request context                                                                                                                                                                      | 3          |
| 5   | Users + Topics CRUD     | Full CRUD with Zod validation; topic write triggers outbox `ingest` event                                                                                                                                                     | 4          |
| 6   | Tasks CRUD              | CRUD + outbox `ingest` trigger + `notify-due` outbox event for due-date reminders                                                                                                                                             | 5          |
| 7   | Ingestion pipeline      | `normalizer` → `rule-based linker` → `chunker` → `embedder` → `chunk_index` write → Qdrant upsert                                                                                                                             | 2, 6       |
| 8   | Documents upload        | S3 upload + PDF/audio (Whisper)/image (GPT-4o Vision) normalisation; feeds into pipeline                                                                                                                                      | 7          |
| 9   | LLM auto-linking        | GPT-4o-mini implicit reference detection added to ingestion pipeline                                                                                                                                                          | 7          |
| 10  | Manual links API        | `POST /links`, `DELETE /links/:id`, `GET /links/:source_id`                                                                                                                                                                   | 3          |
| 11  | Query pipeline          | `POST /query`: intent classify → metadata extract → entity resolve → parallel retrieval → merge + boost → GPT-4o SSE stream                                                                                                   | 2, 7       |
| 12  | Outbox worker + reindex | WAL listener (CDC via logical replication), per-event-type BullMQ workers (ingest/delete/reindex/notify-due), idempotent processing, exponential backoff (5 attempts), weekly reconciliation cron, `POST /ingest/reindex/:id` | 7          |
| 13  | Notification service    | Hourly timezone-aware polling; weekly digest (Mon 8am local), daily overdue check (9am local), `notification_log` dedup                                                                                                       | 6          |
| 14  | Pattern extraction      | Weekly BullMQ cron (Mon 3am UTC); GPT-4o over 6 months completed tasks; upsert `patterns`; prune confidence < 0.4                                                                                                             | 6          |
| 15  | Recommendation agent    | `POST /recommend`: patterns + incomplete tasks → prioritised checklist suggestions                                                                                                                                            | 14         |

---

## API Surface

All routes prefixed `/api/v1`. Auth required on all except `/auth/*`.

| Group     | Endpoints                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------- |
| Auth      | `POST /auth/signup`                                                                             |
| Topics    | `GET /topics` · `POST /topics` · `GET /topics/:id` · `PUT /topics/:id` · `DELETE /topics/:id`   |
| Tasks     | `GET /tasks` · `POST /tasks` · `PUT /tasks/:id` · `DELETE /tasks/:id`                           |
| Documents | `POST /documents/upload` · `GET /documents/:id` · `DELETE /documents/:id`                       |
| Links     | `POST /links` · `DELETE /links/:id` · `GET /links/:source_id`                                   |
| Search    | `POST /query` (SSE) · `POST /recommend` · `GET /ingest/status/:id` · `POST /ingest/reindex/:id` |

---

## LLM Cost Reference

| Call                | Model         | Approx cost       |
| ------------------- | ------------- | ----------------- |
| Auto-link detection | GPT-4o-mini   | ~$0.000135/item   |
| Intent classify     | GPT-4o-mini   | ~$0.000060/query  |
| Metadata extraction | GPT-4o-mini   | ~$0.000105/query  |
| Answer generation   | GPT-4o        | ~$0.0080/query    |
| Pattern extraction  | GPT-4o        | ~$0.09/user/month |
| Audio transcription | Whisper       | ~$0.006/min       |
| Image captioning    | GPT-4o Vision | ~$0.005/image     |

---

## Extensions to Consider

### Multi-turn Conversation (Chatbot)

The current query pipeline (`POST /query`) is single-turn — each request runs independently with no memory of prior exchanges. Adding conversation history transforms it into a stateful assistant over the user's knowledge base.

**Changes required (all additive — no structural changes to existing pipeline):**

- Two new tables: `conversations` (`id uuid PK`, `user_id FK`, `created_at`) and `messages` (`id uuid PK`, `conversation_id FK`, `role varchar`, `content text`, `created_at`)
- One new migration
- `POST /query` accepts an optional `conversation_id`; if provided, loads recent messages and prepends them to the GPT-4o prompt ahead of retrieved chunks; if omitted, behaves exactly as today
- After each answer, appends the user message and assistant response as new rows in `messages`
- One parameter addition to `src/prompts/answer.ts` to inject message history — no redesign of retrieval, merge, or SSE logic

**Further extensions (progressively more involved):**

- **Clarification questions** — add a conditional branch after intent classify; if confidence is below a threshold, return a clarifying question instead of running retrieval
- **Token budget management** — when message history exceeds a token threshold, summarise older turns into a single condensed message before the GPT-4o call
- **Agentic reasoning loop** — replace the linear MBS-17-19 pipeline with an agent loop that can call retrieval as a tool and reason iteratively; MBS-23 already demonstrates this pattern for the recommendation flow
