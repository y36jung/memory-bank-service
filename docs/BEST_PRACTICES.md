# Best Practices Index

Reference these before writing code in any of the areas below.

| File                           | Covers                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| [typescript.md](typescript.md) | Strict config, no-any, error types, fp-ts TaskEither, naming                                 |
| [fastify.md](fastify.md)       | Plugin architecture, Zod validation, route handlers, auth, SSE                               |
| [database.md](database.md)     | Drizzle schema, migrations, transactions, outbox atomicity, Qdrant upsert/search/delete      |
| [bullmq.md](bullmq.md)         | Outbox worker, dispatch, retry/backoff, BullMQ cron jobs, job typing                         |
| [ai.md](ai.md)                 | Model selection, OpenAI/Anthropic clients, embeddings, agent loop, tool design, cost control |
| [testing.md](testing.md)       | Unit vs integration, real DB pattern, mocking LLMs and BullMQ, coverage targets              |

## Key Cross-Cutting Rules

- **All I/O uses `TaskEither`.** Unwrap once at the route handler or worker entry point.
- **All Qdrant writes go through the outbox worker.** Never write to Qdrant directly from a route.
- **All queries are scoped to `user_id`.** Enforce at the service layer, not just the route.
- **Prompts live in `/src/prompts/*.ts`.** No inline prompt strings in service or route files.
- **No mocked databases in integration tests.** Use real Postgres + Qdrant with transaction rollback.
