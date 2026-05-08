# Memory Bank — Project Overview

> For architecture and invariants see `AGENT_CONTEXT.md`. For best practices see `BEST_PRACTICES.md`.

---

## Goal

Personal AI memory service. Users store heterogeneous data (tasks, notes, PDFs, audio, images) and retrieve it via natural language — without needing to remember where it was stored or how it was organised. The system eliminates cognitive overhead by combining semantic vector search with graph-based record linking.

---

## Key Design Rationale

**Hybrid RAG over GraphRAG** — GraphRAG was evaluated and rejected:

| Factor | GraphRAG | Hybrid RAG (chosen) |
|--------|----------|---------------------|
| Ingestion cost | Hundreds of LLM calls per index pass | One optional GPT-4o-mini call per item (~$0.000135) |
| Re-indexing | Full/partial re-index on every write | Appends rows to `links` table only |
| Graph depth | Deep cross-corpus synthesis | Shallow (task → topic → document) — captured by keyword + one LLM pass |
| Query-time LLM | Yes (community summarisation) | No — graph traversal is a fast indexed Postgres recursive query |
| Use case fit | "What themes connect all my research?" | "What tasks are related to Atlas?" — retrieval, not synthesis |

**Outbox pattern over direct Qdrant writes** — true distributed ACID across Postgres and Qdrant is not possible without a two-phase commit coordinator. Writing an outbox event atomically in the same Postgres transaction as the source record guarantees no Qdrant sync is ever silently dropped, even if Qdrant or Redis is temporarily unavailable.

**Postgres as source of truth** — Qdrant is fully rebuildable from Postgres at any time. Qdrant stores content text in payload to avoid a second Postgres read at query time.

---

## Implementation Roadmap

Steps 1–6 require no LLM or vector API keys. Steps 7–12 require OpenAI. Steps 13–15 are deferrable — no impact on the core hybrid RAG system.

| # | Work Item | Deliverable | Depends on |
|---|-----------|-------------|------------|
| 1 | Infrastructure | Docker Compose: Postgres 16 + Redis 7 (AOF) + Qdrant running locally | — |
| 1a | Dev tooling | eslint + tsc --noEmit + vitest wired into husky pre-commit hook; lint-staged for staged-only linting | 1 |
| 2 | Qdrant setup | `memory_chunks` collection — dense (1536-dim, Cosine) + sparse vectors + payload indexes | 1 |
| 3 | Postgres schema | Drizzle schema + first migration; all tables: `users`, `topics`, `tasks`, `documents`, `chunk_index`, `links`, `patterns`, `outbox` | 1 |
| 4 | Auth middleware | JWT verification; `req.user` attached to request context | 3 |
| 5 | Users + Topics CRUD | Full CRUD with Zod validation; topic write triggers outbox `ingest` event | 4 |
| 6 | Tasks CRUD | CRUD + outbox `ingest` trigger + `notify-due` outbox event for due-date reminders | 5 |
| 7 | Ingestion pipeline | `normalizer` → `rule-based linker` → `chunker` → `embedder` → `chunk_index` write → Qdrant upsert | 2, 6 |
| 8 | Documents upload | S3 upload + PDF/audio (Whisper)/image (GPT-4o Vision) normalisation; feeds into pipeline | 7 |
| 9 | LLM auto-linking | GPT-4o-mini implicit reference detection added to ingestion pipeline | 7 |
| 10 | Manual links API | `POST /links`, `DELETE /links/:id`, `GET /links/:source_id` | 3 |
| 11 | Query pipeline | `POST /query`: intent classify → metadata extract → entity resolve → parallel retrieval → merge + boost → GPT-4o SSE stream | 2, 7 |
| 12 | Outbox worker + reindex | Polling loop (10s), exponential backoff (5 attempts), weekly reconciliation cron, `POST /ingest/reindex/:id` | 7 |
| 13 | Notification service | Hourly timezone-aware polling; weekly digest (Mon 8am local), daily overdue check (9am local), `notification_log` dedup | 6 |
| 14 | Pattern extraction | Weekly BullMQ cron (Mon 3am UTC); GPT-4o over 6 months completed tasks; upsert `patterns`; prune confidence < 0.4 | 6 |
| 15 | Recommendation agent | `POST /recommend`: patterns + incomplete tasks → prioritised checklist suggestions | 14 |

---

## API Surface

All routes prefixed `/api/v1`. Auth required on all except `/auth/*`.

| Group | Endpoints |
|-------|-----------|
| Auth | `POST /auth/signup` |
| Topics | `GET /topics` · `POST /topics` · `GET /topics/:id` · `PUT /topics/:id` · `DELETE /topics/:id` |
| Tasks | `GET /tasks` · `POST /tasks` · `PUT /tasks/:id` · `DELETE /tasks/:id` |
| Documents | `POST /documents/upload` · `GET /documents/:id` · `DELETE /documents/:id` |
| Links | `POST /links` · `DELETE /links/:id` · `GET /links/:source_id` |
| Search | `POST /query` (SSE) · `POST /recommend` · `GET /ingest/status/:id` · `POST /ingest/reindex/:id` |

---

## LLM Cost Reference

| Call | Model | Approx cost |
|------|-------|-------------|
| Auto-link detection | GPT-4o-mini | ~$0.000135/item |
| Intent classify | GPT-4o-mini | ~$0.000060/query |
| Metadata extraction | GPT-4o-mini | ~$0.000105/query |
| Answer generation | GPT-4o | ~$0.0080/query |
| Pattern extraction | GPT-4o | ~$0.09/user/month |
| Audio transcription | Whisper | ~$0.006/min |
| Image captioning | GPT-4o Vision | ~$0.005/image |
