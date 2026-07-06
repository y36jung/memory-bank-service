# Slice Plan — m1-ingestion-pipeline

**Owning executor:** ingestion-orchestration  
**Plan status:** Ready for implementation

---

## 1. Slice + linked spec/PRD sections

**Slice**: `m1-ingestion-pipeline` — BullMQ worker, 11-step ingestion pipeline, `withTimeout` helper, and supervisor backstop.

**Owning executor**: `ingestion-orchestration`

| PLAN.md section                                            | Relevance                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| §Data Ingestion Pipeline → steps 1–11                      | Canonical pipeline definition                                               |
| §Data Ingestion Pipeline → `withTimeout` snippet           | Exact signature; do not vary                                                |
| §Data Ingestion Pipeline → ACID Compliance Strategy        | Postgres-first ordering, deterministic IDs, single-transaction step 7       |
| §Database Schema → `documents`, `chunks`, `ingestion_jobs` | Rows this slice reads/writes                                                |
| §Milestone 1 deliverable #5                                | "BullMQ ingestion worker wired to Redis"                                    |
| §Milestone 1 deliverable #10                               | "All ingestion steps wrapped in Postgres transactions with status tracking" |
| §Milestone 1 Key Technical Considerations                  | `withTimeout` and 10-minute supervisor backstop                             |

**Linked orchestration plan**: `implement-milestone-1-of-iridescent-aho.md` → Step 5 (Phase 4). Consumes outputs of Phases 1–3; produces the queue interface that Phase 6 (api-transport) consumes.

---

## 2. Acceptance criteria, verbatim

From PLAN.md §Milestone 1 deliverables:

1. _"BullMQ ingestion worker wired to Redis"_ (deliverable #5)
2. _"All ingestion steps wrapped in Postgres transactions with status tracking"_ (deliverable #10)

From PLAN.md §Data Ingestion Pipeline:

3. _"WORKER picks up job — CLEANUP FIRST: DELETE chunks WHERE document_id = :id; DELETE Qdrant points WHERE documentId = :id; UPDATE document SET status = 'processing'; UPDATE ingestion_job SET status = 'running', started_at = now(), attempt++"_ (Step 3)
4. _"EXTRACT ← timeout: 60s — withTimeout(extractText(file), 60_000, 'extract')"_ (Step 4)
5. _"CHUNK (synchronous — no timeout needed) — Recursive splitter: ~800 tokens per chunk, 150-token overlap. Preserve sentence boundaries."_ (Step 5)
6. _"EMBED ← timeout: 30s per batch — withTimeout(openai.embeddings.create(...), 30_000, 'embed')"_ (Step 6)
7. _"COMMIT Postgres (transaction) ← timeout: 10s — withTimeout(db.transaction(async tx => { INSERT chunks[]; UPDATE document SET status = 'indexed'; UPDATE ingestion_job SET status = 'done', finished_at = now() }), 10_000, 'postgres commit')"_ (Step 7)
8. _"UPSERT Qdrant (after Postgres commit succeeds) ← timeout: 15s — withTimeout(qdrant.upsert(...), 15_000, 'qdrant upsert'). Collection: 'memory_bank'. Point ID: uuidv5(documentId + chunkIndex). Payload: { qdrantId }. Vector: embedding float[]."_ (Step 8)
9. _"ON TIMEOUT OR ERROR (any step): Throws descriptive, human-readable error message. BullMQ catches error → retries steps 3–8 up to 3× with exponential backoff. Step 3 cleanup ensures each retry starts from a clean slate."_ (Step 9)
10. _"ON ALL RETRIES EXHAUSTED: UPDATE document SET status = 'failed', error_message = <human-readable>; UPDATE ingestion_job SET status = 'failed', error_message = <human-readable>"_ (Step 10)
11. _"SUPERVISOR (backstop only — runs every 10 minutes): SELECT _ FROM ingestion_jobs WHERE status = 'running' AND started_at < now() - interval '20 minutes' → re-queue any found"\* (Step 11)
12. `withTimeout` exact signature (from PLAN.md §withTimeout): _"const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms))]);"\_
13. _"Postgres chunk inserts and document status updates are wrapped in a single transaction (step 7). Either all chunks commit with the `indexed` status, or none do."_
14. _"Postgres is committed before Qdrant is written (step 7 → step 8). If Qdrant is unavailable after the Postgres commit, the document is marked `failed` and the job retries from step 8 — chunk text is already safe in Postgres."_
15. _"Qdrant upserts use deterministic point IDs (`uuidv5(documentId + chunkIndex)`), so retries are always idempotent — never produce duplicates."_

---

## 3. Design overview

The slice implements the durable ingestion path. BullMQ pulls a job off the `ingestion` queue, the processor runs the 11-step pipeline, and a supervisor sweeps stuck jobs every 10 minutes.

**Key decisions:**

- **`src/lib/utils.ts`** is a new shared file owned by this slice for `withTimeout`. PLAN.md does not pin a location; one canonical location prevents drift. foundation-infra retains ownership of `errors.ts`, `tokenizer.ts`, `idgen.ts`.
- **Processor in `src/services/ingestion.ts`, thin binding in `ingestion.worker.ts`**. Enables unit testing the processor without booting BullMQ.
- **Retry policy on queue defaults**, not per-`add()` call, so api-transport's enqueue stays minimal.
- **Cleanup is idempotent and unconditional** — Step 3 DELETEs on first attempt are no-ops; on retries they wipe partial state. Same code path always.
- **Postgres before Qdrant, always** — sequential `await`, no `Promise.all`. If Qdrant fails post-commit, cleanup on retry re-deletes chunks, then re-embeds. More wasteful than step-8-only retry, but strictly correct per §Step 9 (steps 3–8 on each retry).
- **`failed` event only acts when `attemptsMade >= attempts`** — not on every failure.
- **Supervisor uses `setImmediate` for initial tick** so server startup is not blocked; fires an immediate recovery sweep on every restart.
- **Concurrency = 5** (conservative for single-tenant; OpenAI rate-limiting is handled inside embeddings.ts).

---

## 4. Affected files

All files are new.

| Action | Path                                    | Owner                   |
| ------ | --------------------------------------- | ----------------------- |
| create | `src/lib/utils.ts`                      | ingestion-orchestration |
| create | `src/queue/index.ts`                    | ingestion-orchestration |
| create | `src/queue/workers/ingestion.worker.ts` | ingestion-orchestration |
| create | `src/services/ingestion.ts`             | ingestion-orchestration |

**Boundary note on `src/lib/utils.ts`**: This file is purely additive and does not touch foundation-infra-owned files. future changes to `utils.ts` that affect other slices must route back to slice-planner.

---

## 5. Signatures & data structures

### `src/lib/utils.ts`

```typescript
export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms),
    ),
  ]);
```

Verbatim from PLAN.md. No variations. No other exports in this file.

### `src/queue/index.ts`

```typescript
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

export interface IngestionJobPayload {
  documentId: string;
  storageKey: string;
  attempt: number;
}

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // required for BullMQ Worker blocking commands
});

export const ingestionQueue = new Queue<IngestionJobPayload>('ingestion', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
    removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days
  },
});
```

Queue name MUST be the literal string `'ingestion'` — the worker subscribes by name.

### `src/queue/workers/ingestion.worker.ts`

```typescript
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { redisConnection, IngestionJobPayload } from '../index.js';
import { processIngestionJob, handleFailedJob } from '../../services/ingestion.js';

export const ingestionWorker = new Worker<IngestionJobPayload, void>(
  'ingestion',
  async (job: Job<IngestionJobPayload>) => processIngestionJob(job),
  { connection: redisConnection, concurrency: 5 },
);

ingestionWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!attemptsExhausted) return;
  try {
    await handleFailedJob(job, err);
  } catch (handlerErr) {
    job.log(`failed-handler error: ${(handlerErr as Error).message ?? 'unknown'}`);
  }
});

ingestionWorker.on('error', (err) => {
  console.error('[ingestion-worker] error', err);
});
```

### `src/services/ingestion.ts`

```typescript
import { Job, UnrecoverableError } from 'bullmq';
import { eq, and, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, chunks, ingestionJobs } from '../db/schema.js';
import { extractText } from './extractor/index.js';
import { chunkText } from './chunker.js';
import { batchEmbed } from './embeddings.js';
import { upsertPoints, deleteByDocumentId } from './qdrant.js';
import { generateQdrantId } from '../lib/idgen.js';
import { withTimeout } from '../lib/utils.js';
import { ingestionQueue, IngestionJobPayload } from '../queue/index.js';

export async function processIngestionJob(job: Job<IngestionJobPayload>): Promise<void> {
  const { documentId, storageKey } = job.data;
  const bullJobId = job.id!;

  // Step 2 VERIFY: durable receipt must exist.
  const [jobRow] = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.bullJobId, bullJobId))
    .limit(1);
  if (!jobRow) {
    throw new UnrecoverableError(`ingestion_jobs row missing for bullJobId=${bullJobId}`);
  }

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    throw new UnrecoverableError(`document missing for id=${documentId}`);
  }

  // Step 3 CLEANUP: idempotent; no-op on first attempt.
  await db.delete(chunks).where(eq(chunks.documentId, documentId));
  await deleteByDocumentId(documentId);
  await db
    .update(documents)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(documents.id, documentId));
  await db
    .update(ingestionJobs)
    .set({ status: 'running', startedAt: new Date(), attempt: job.attemptsMade + 1 })
    .where(eq(ingestionJobs.bullJobId, bullJobId));

  // Step 4 EXTRACT (60s timeout).
  const text = await withTimeout(extractText(storageKey, doc.mimeType), 60_000, 'extract');

  // Step 5 CHUNK (synchronous; no timeout per PLAN.md).
  const produced = chunkText(text);

  // Step 6 EMBED (30s timeout).
  const vectors = await withTimeout(batchEmbed(produced.map((c) => c.content)), 30_000, 'embed');
  if (vectors.length !== produced.length) {
    throw new Error(`embedding count mismatch: expected ${produced.length}, got ${vectors.length}`);
  }

  // Step 7 POSTGRES COMMIT — single transaction, 10s timeout.
  await withTimeout(
    db.transaction(async (tx) => {
      await tx.insert(chunks).values(
        produced.map((c) => ({
          documentId,
          qdrantId: generateQdrantId(documentId, c.chunkIndex),
          chunkIndex: c.chunkIndex,
          content: c.content,
          tokenCount: c.tokenCount,
        })),
      );
      await tx
        .update(documents)
        .set({ status: 'indexed', updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await tx
        .update(ingestionJobs)
        .set({ status: 'done', finishedAt: new Date() })
        .where(eq(ingestionJobs.bullJobId, bullJobId));
    }),
    10_000,
    'pg-commit',
  );

  // Step 8 QDRANT UPSERT — after Postgres commit, 15s timeout.
  const points = produced.map((c, i) => {
    const qdrantId = generateQdrantId(documentId, c.chunkIndex);
    return { id: qdrantId, vector: vectors[i]!, payload: { qdrantId } };
  });
  await withTimeout(upsertPoints(points), 15_000, 'qdrant-upsert');
}

export async function handleFailedJob(job: Job<IngestionJobPayload>, err: Error): Promise<void> {
  const { documentId } = job.data;
  const bullJobId = job.id!;
  const message = err.message ?? 'unknown error';
  await db
    .update(documents)
    .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
    .where(eq(documents.id, documentId));
  await db
    .update(ingestionJobs)
    .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
    .where(eq(ingestionJobs.bullJobId, bullJobId));
}

export function startSupervisor(): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    const stuckAfter = new Date(Date.now() - 20 * 60 * 1000);
    try {
      const stuck = await db
        .select()
        .from(ingestionJobs)
        .where(and(eq(ingestionJobs.status, 'running'), lt(ingestionJobs.startedAt, stuckAfter)));
      for (const row of stuck) {
        const [doc] = await db
          .select({ storageKey: documents.storageKey })
          .from(documents)
          .where(eq(documents.id, row.documentId))
          .limit(1);
        if (!doc?.storageKey) continue;
        await ingestionQueue.add(
          'ingest',
          { documentId: row.documentId, storageKey: doc.storageKey, attempt: row.attempt + 1 },
          { jobId: row.bullJobId },
        );
      }
    } catch (e) {
      console.error('[ingestion-supervisor] tick error', e);
    }
  };
  setImmediate(() => {
    void tick();
  });
  return setInterval(
    () => {
      void tick();
    },
    10 * 60 * 1000,
  );
}
```

---

## 6. Interfaces

### Produced (consumed by api-transport and server.ts)

```typescript
// api-transport:
import { ingestionQueue, IngestionJobPayload } from '../queue/index.js';
await ingestionQueue.add('ingest', { documentId, storageKey, attempt: 1 }, { jobId: bullJobId });

// server.ts:
import { startSupervisor } from './services/ingestion.js';
import './queue/workers/ingestion.worker.js'; // side-effect: starts worker
const supervisorHandle = startSupervisor();
// shutdown: clearInterval(supervisorHandle); await ingestionWorker.close(); await ingestionQueue.close(); await redisConnection.quit();
```

### Consumed (from other slices)

| Contract                                                                               | Producer              |
| -------------------------------------------------------------------------------------- | --------------------- |
| `env.REDIS_URL: string`                                                                | m1-foundation         |
| `generateQdrantId(documentId, chunkIndex): string`                                     | m1-foundation         |
| `db` + schema tables                                                                   | m1-data-persistence   |
| `extractText(storageKey, mimeType): Promise<string>`                                   | m1-extraction         |
| `chunkText(text): { content; chunkIndex; tokenCount }[]`                               | m1-chunking-embedding |
| `batchEmbed(texts): Promise<number[][]>`                                               | m1-chunking-embedding |
| `upsertPoints(points): Promise<void>`, `deleteByDocumentId(documentId): Promise<void>` | m1-chunking-embedding |

If any imported signature differs from the above, executor HARD STOPs and routes back to slice-planner.

---

## 7. Invariants upheld

| Invariant (PLAN.md verbatim)                                                                  | Implementation                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "Postgres is the sole source of truth for chunk text; Qdrant stores only vectors + qdrantId." | Qdrant point `payload` = `{ qdrantId }` only. No `content`.                                  |
| "Ingestion step 7 is one transaction: every chunk lands as `indexed` or none do."             | All SQL inside single `db.transaction(...)`.                                                 |
| "Qdrant upserts use deterministic point IDs (`uuidv5(documentId + chunkIndex)`)"              | Both `chunks.qdrantId` and Qdrant `point.id` use `generateQdrantId(documentId, chunkIndex)`. |
| "Postgres is committed before Qdrant is written (step 7 → step 8)"                            | Sequential `await`, no `Promise.all`.                                                        |
| `withTimeout` verbatim signature                                                              | Exact copy in `src/lib/utils.ts`.                                                            |
| "Step 3 cleanup ensures each retry starts from a clean slate"                                 | Unconditional DELETE + status reset on every attempt.                                        |
| "retries steps 3–8 up to 3× with exponential backoff"                                         | `attempts: 3, backoff: { type: 'exponential', delay: 5000 }`.                                |
| "SUPERVISOR: 10-minute interval; query running jobs older than 20 minutes"                    | `setInterval(tick, 10*60*1000)`; query with `lt(startedAt, now - 20min)`.                    |

---

## 8. Edge cases & failure modes

| #   | Scenario                                                            | Behaviour                                                                                                                   |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Partial Qdrant upsert after successful Postgres commit              | BullMQ retries from Step 3; cleanup re-deletes chunks + Qdrant points; retry re-inserts identical data (deterministic IDs). |
| 2   | BullMQ retry with same jobId                                        | Step 3 DELETEs are idempotent; duplicate Qdrant point IDs are upserted (not duplicated).                                    |
| 3   | Supervisor fires while a live worker iteration is running (>20 min) | `add({ jobId })` is rejected by BullMQ's jobId-uniqueness guarantee — original job not disturbed.                           |
| 4   | Orphan job (no `ingestion_jobs` row)                                | Step 2 verify throws `UnrecoverableError`; BullMQ skips remaining retries.                                                  |
| 5   | Document deleted mid-flight                                         | Step 7 transaction fails on FK constraint; retried; Step 2 verify throws `UnrecoverableError` on retry.                     |
| 6   | Embedding vector count mismatch                                     | Guard throw triggers BullMQ retry; marks failed after 3 attempts.                                                           |
| 7   | Redis disconnect during processing                                  | Worker's stalled-job mechanism re-delivers; Step 3 cleanup handles state.                                                   |
| 8   | SIGTERM mid-Step-7                                                  | `ingestionWorker.close()` waits for active jobs; BullMQ stalled timeout re-delivers if process exits before completion.     |
| 9   | Supervisor tick takes >10 min                                       | Overlapping ticks possible; second re-enqueue with same jobId is rejected by BullMQ — harmless.                             |

---

## 9. Criterion → implementation → proof table

| Criterion                                                         | Implementation                                                                                      | File                                    | Proof                                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| BullMQ worker wired to Redis                                      | `new Worker('ingestion', …, { connection: redisConnection })`                                       | `ingestion.worker.ts`, `queue/index.ts` | Integration: enqueue job → document reaches `indexed`                                                             |
| Postgres transaction status tracking                              | Step 7 `db.transaction(INSERT chunks + UPDATE documents + UPDATE jobs)`                             | `ingestion.ts`                          | Integration: inject FK violation mid-tx → chunk count = 0, status unchanged                                       |
| Step 3 CLEANUP                                                    | 4 sequential ops: DELETE chunks, deleteByDocumentId, UPDATE processing, UPDATE running              | `ingestion.ts`                          | Unit: seed prior-attempt chunks → assert all 4 mutations occurred                                                 |
| Step 4 EXTRACT 60s timeout                                        | `withTimeout(extractText(…), 60_000, 'extract')`                                                    | `ingestion.ts`, `utils.ts`              | Unit: synthetic extractText resolving at 65s → rejects `Timeout: extract exceeded 60000ms`                        |
| Step 5 CHUNK synchronous                                          | `const produced = chunkText(text)` — no await                                                       | `ingestion.ts`                          | Static: assert `chunkText` called synchronously                                                                   |
| Step 6 EMBED 30s timeout                                          | `withTimeout(batchEmbed(…), 30_000, 'embed')`                                                       | `ingestion.ts`                          | Unit: synthetic batchEmbed resolving at 35s → rejects `Timeout: embed exceeded 30000ms`                           |
| Step 7 single tx 10s timeout                                      | `withTimeout(db.transaction(…), 10_000, 'pg-commit')`                                               | `ingestion.ts`                          | Integration: slow Postgres → rejects `Timeout: pg-commit exceeded 10000ms`, chunks = 0                            |
| Step 8 Qdrant upsert 15s, after Step 7, payload `{qdrantId}` only | Sequential await, `withTimeout(upsertPoints(…), 15_000, 'qdrant-upsert')`, `payload = { qdrantId }` | `ingestion.ts`                          | Unit: spy call order; assert Step 7 resolves before upsertPoints called; `payload` deep-equals `{ qdrantId }`     |
| Step 9 retry 3× exponential backoff 5s                            | `attempts: 3, backoff: { type: 'exponential', delay: 5000 }`                                        | `queue/index.ts`                        | Integration: synthetic processor throws twice, succeeds third → document `indexed`, attempt = 3                   |
| Step 10 failed event marks both rows                              | `on('failed')` → `handleFailedJob` when `attemptsMade >= attempts`                                  | `ingestion.worker.ts`, `ingestion.ts`   | Integration: throw all 3 attempts → `documents.status === 'failed'`, `error_message` set                          |
| Step 11 supervisor 10 min / 20 min query                          | `setInterval(10*60*1000)`; `WHERE status='running' AND started_at < now-20m`                        | `ingestion.ts`                          | Unit (mocked clock): seed running job 25m old → tick → assert `ingestionQueue.add` called with original bullJobId |
| `withTimeout` exact signature + error format                      | Verbatim copy                                                                                       | `utils.ts`                              | Unit: `withTimeout(never, 10, 'x')` rejects ~10ms with `Timeout: x exceeded 10ms`                                 |
| Postgres-first ordering                                           | Sequential `await` Steps 7 then 8                                                                   | `ingestion.ts`                          | Same spy test as Step 8 criterion                                                                                 |
| Single-tx atomicity                                               | All mutations inside one `db.transaction(...)`                                                      | `ingestion.ts`                          | Integration: force UPDATE documents fail inside tx → zero chunks inserted                                         |
| Deterministic IDs                                                 | `generateQdrantId(documentId, chunkIndex)` at both call sites                                       | `ingestion.ts`                          | Unit: two runs same payload → identical `qdrantId` arrays                                                         |

---

## 10. Completeness self-check

| Check                                                                                                                   | Result                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Every AC in §2 mapped in §9                                                                                             | Pass (15/15 mapped)                                                                         |
| Every owned file in §4 has signatures in §5                                                                             | Pass (4 files)                                                                              |
| All interface boundaries in §6                                                                                          | Pass                                                                                        |
| No TBDs                                                                                                                 | Pass                                                                                        |
| No decisions deferred to executor                                                                                       | Pass — PLAN.md §Step 9 ambiguity resolved in §8.1 (cleanup-and-redo over step-8-only retry) |
| Every invariant cites PLAN.md source                                                                                    | Pass                                                                                        |
| Edge cases: Qdrant partial upsert, orphan job, mid-flight delete, supervisor races, Redis disconnect, graceful shutdown | Pass (§8)                                                                                   |
| `src/lib/utils.ts` boundary carve-out documented                                                                        | Pass                                                                                        |

**Completeness self-check passes. Plan is ready for the ingestion-orchestration executor.**
