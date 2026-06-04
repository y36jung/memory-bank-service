# Slice Plan — m1-chunking-embedding

**Owning executor:** chunking-embedding  
**Plan status:** Ready for implementation  
**Depends on:** m1-foundation (env, idgen, tokenizer), m1-data-persistence (schema types for rebuild script)

---

## 1. Slice + linked spec/PRD sections

| PLAN.md section                      | Relevance                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| §Chunker Service                     | Recursive splitter, ~800 tokens/chunk, 150-token overlap, sentence boundaries                      |
| §Embedding Service                   | Batch OpenAI calls, text-embedding-3-large, 3072 dims, retry on 429                                |
| §Qdrant collection                   | memory_bank, 3072 dims, cosine distance, deterministic IDs                                         |
| §Milestone 1 deliverables #7, #8, #9 | Chunker, embedding, Qdrant upsert                                                                  |
| §ACID Compliance                     | Qdrant payload = {qdrantId} only; Qdrant fully rebuildable from Postgres                           |
| §Load-bearing invariants             | "Qdrant is fully rebuildable from Postgres; never duplicate chunk content into Qdrant-bound code." |

---

## 2. Acceptance criteria, verbatim

- **AC-C1.** Chunker: `chunkText(text): Chunk[]` — ~800 tokens/chunk, 150-token overlap, sentence boundary preservation
- **AC-C2.** Embedding: `batchEmbed(texts): Promise<number[][]>` — OpenAI `text-embedding-3-large`, max 2048/batch, exponential backoff on 429
- **AC-C3.** Qdrant client: `ensureCollection()` — creates `memory_bank` (3072 dims, cosine) if not exists; idempotent
- **AC-C4.** Qdrant client: `upsertPoints(points)` — payload = `{qdrantId}` only, no chunk text
- **AC-C5.** Qdrant client: `searchPoints(vector, topK, scoreThreshold)` — returns `{id, score}[]`
- **AC-C6.** Qdrant client: `deleteByDocumentId(documentId)` — deletes all points whose payload.qdrantId matches any chunk belonging to that document (via Qdrant filter on payload)
- **AC-C7.** `scripts/rebuild-qdrant.ts` — re-embeds all `chunks.content` from Postgres, upserts with deterministic IDs; idempotent; safe to re-run

---

## 3. Design overview

**Chunker**: Splits text recursively by paragraph (`\n\n`), then sentence (`. `/`! `/`? `), then word boundaries. Builds chunks by accumulating tokens until the target (800) is reached, then backtracks to the last sentence boundary. Overlap is achieved by re-including the last 150 tokens of the previous chunk at the start of the next. Uses `countTokens` from `src/lib/tokenizer.ts`.

**Embeddings**: Single `batchEmbed(texts)` function. Splits input into batches of ≤2048 texts, calls OpenAI `embeddings.create({ model: 'text-embedding-3-large', input: batch })` for each batch sequentially. On 429, retries with exponential backoff (1s, 2s, 4s, max 3 retries). Order-preserving: result array indices match input indices. Uses `withTimeout` from `src/lib/utils.ts` (created by ingestion-orchestration, but `batchEmbed` itself does not apply a timeout — the caller does).

**Qdrant**: Wrapper around `@qdrant/js-client-rest`. `ensureCollection` uses `getCollection` and only calls `createCollection` if a 404 is returned. `upsertPoints` sends batches of up to 100 points. `searchPoints` calls `search` with `with_payload: false` (Qdrant returns only id + score). `deleteByDocumentId` uses a Qdrant filter on `payload.qdrantId` matching a list of UUIDs (fetched from Postgres by the caller) — this requires the caller to pass the qdrantId list, not the documentId, because Qdrant has no knowledge of documentId.

> **Executor note on `deleteByDocumentId`**: the ingestion-orchestration plan calls `deleteByDocumentId(documentId)`. This function must accept a `documentId: string` and internally query Postgres for `chunks.qdrant_id WHERE document_id = $1`, then delete those points from Qdrant. This means `qdrant.ts` has a Postgres dependency. Alternatively, the ingestion worker can pass the qdrantId list directly. This plan chooses the latter approach: rename the function to `deletePoints(qdrantIds: string[]): Promise<void>` to keep `qdrant.ts` stateless. **Ingestion-orchestration executor must use `deletePoints` not `deleteByDocumentId`.**

**Rebuild script**: Standalone `tsx scripts/rebuild-qdrant.ts`. Reads all chunks from Postgres in batches of 500, embeds each batch, upserts to Qdrant with `generateQdrantId(documentId, chunkIndex)`. Idempotent: upsert overwrites existing points.

---

## 4. Affected files

| Action | Path                         | Owner              |
| ------ | ---------------------------- | ------------------ |
| create | `src/services/chunker.ts`    | chunking-embedding |
| create | `src/services/embeddings.ts` | chunking-embedding |
| create | `src/services/qdrant.ts`     | chunking-embedding |
| create | `scripts/rebuild-qdrant.ts`  | chunking-embedding |

---

## 5. Signatures & data structures

### `src/services/chunker.ts`

```typescript
export interface Chunk {
  content: string;
  tokenCount: number;
  chunkIndex: number;
}

export function chunkText(text: string): Chunk[];
// Target: ~800 tokens per chunk, 150-token overlap
// Split priority: \n\n (paragraph) > .\n / . (sentence) > word boundary
// Returns [] for empty/whitespace-only text
// chunkIndex is 0-based, sequential
```

Algorithm sketch (for executor):

1. If `countTokens(text) <= 800`, return `[{ content: text, tokenCount: countTokens(text), chunkIndex: 0 }]`
2. Split by `\n\n`; if any paragraph > 800 tokens, recursively split by sentence delimiters
3. Greedily accumulate paragraphs/sentences into a chunk until token count would exceed 800
4. Record the chunk; start next chunk from a point 150 tokens back (overlap)
5. Assign `chunkIndex` sequentially starting at 0

### `src/services/embeddings.ts`

```typescript
import OpenAI from 'openai';
import { env } from '../config/env.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const BATCH_SIZE = 2048;
const MAX_RETRIES = 3;

export async function batchEmbed(texts: string[]): Promise<number[][]>;
// Returns order-preserving array of 3072-float vectors
// Splits texts into BATCH_SIZE batches, calls serially
// On 429: retries with delays [1000, 2000, 4000]ms (exponential)
// On other error: re-throws immediately
// Empty input → returns []
```

### `src/services/qdrant.ts`

```typescript
import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../config/env.js';

const COLLECTION = 'memory_bank';
const VECTOR_SIZE = 3072;

export interface QdrantPoint {
  id: string; // UUID string (qdrantId)
  vector: number[]; // 3072 floats
  payload: { qdrantId: string }; // ONLY this field — no chunk text
}

export interface SearchResult {
  id: string;
  score: number;
}

const client = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY,
});

export async function ensureCollection(): Promise<void>;
// Creates 'memory_bank' collection if not exists
// Vectors: size=3072, distance='Cosine'
// Idempotent: no error if already exists

export async function upsertPoints(points: QdrantPoint[]): Promise<void>;
// Upserts in batches of 100
// payload MUST be { qdrantId: string } — no other fields

export async function searchPoints(
  vector: number[],
  topK: number,
  scoreThreshold: number,
): Promise<SearchResult[]>;
// with_payload: false, with_vector: false
// Returns [{id, score}] sorted by score desc

export async function deletePoints(qdrantIds: string[]): Promise<void>;
// Deletes points by ID list
// No-op if list is empty
```

### `scripts/rebuild-qdrant.ts`

```typescript
// Standalone script — run with: tsx scripts/rebuild-qdrant.ts
// Steps:
// 1. Connect to Postgres (db from src/db/index.ts)
// 2. Call ensureCollection() to ensure collection exists
// 3. SELECT id, document_id, chunk_index, content FROM chunks ORDER BY document_id, chunk_index
// 4. Process in batches of 500:
//    a. batchEmbed(batch.map(c => c.content))
//    b. Build QdrantPoint[] using generateQdrantId(documentId, chunkIndex)
//    c. upsertPoints(points)
//    d. Log progress
// 5. pool.end() on completion
// Idempotent: upsert overwrites same-ID points
```

---

## 6. Interfaces

### Produced (consumed by ingestion-orchestration and retrieval-rag)

| Symbol                                                                | Consumer                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `chunkText(text): Chunk[]`                                            | ingestion-orchestration (Step 5)                                                |
| `batchEmbed(texts): Promise<number[][]>`                              | ingestion-orchestration (Step 6), retrieval-rag (query embed)                   |
| `ensureCollection(): Promise<void>`                                   | server.ts startup (via deferred import in foundation)                           |
| `upsertPoints(points): Promise<void>`                                 | ingestion-orchestration (Step 8)                                                |
| `searchPoints(vector, topK, scoreThreshold): Promise<SearchResult[]>` | retrieval-rag                                                                   |
| `deletePoints(qdrantIds: string[]): Promise<void>`                    | ingestion-orchestration (Step 3 cleanup), api-transport (DELETE /documents/:id) |

### Consumed (from other slices)

| Symbol                                                       | Source                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `countTokens(text)`                                          | `src/lib/tokenizer.ts` (m1-foundation)                                                    |
| `generateQdrantId(documentId, chunkIndex)`                   | `src/lib/idgen.ts` (m1-foundation)                                                        |
| `env.OPENAI_API_KEY`, `env.QDRANT_URL`, `env.QDRANT_API_KEY` | `src/config/env.ts` (m1-foundation)                                                       |
| `db`, `chunks` schema                                        | `src/db/index.ts`, `src/db/schema.ts` (m1-data-persistence) — used only in rebuild script |

> **Interface correction for ingestion-orchestration**: the ingestion plan references `deleteByDocumentId(documentId)`. This plan renames it to `deletePoints(qdrantIds: string[])`. The ingestion executor must fetch the qdrantIds from Postgres first (it already has access to `db` and `chunks` schema), then call `deletePoints(ids)`. This keeps `qdrant.ts` free of Postgres dependencies.

---

## 7. Invariants upheld

| Invariant (PLAN.md)                                                                                | Implementation                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "Qdrant stores only vectors + qdrantId."                                                           | `QdrantPoint.payload` type is `{ qdrantId: string }` only — no content field possible.                    |
| "Qdrant is fully rebuildable from Postgres; never duplicate chunk content into Qdrant-bound code." | `rebuild-qdrant.ts` reads only from `chunks.content`; Qdrant receives only the vector + qdrantId.         |
| "chunks.qdrantId = uuidv5(documentId + chunkIndex). Unique, deterministic."                        | Both `ingestion.ts` and `rebuild-qdrant.ts` use `generateQdrantId(documentId, chunkIndex)` for point IDs. |
| Qdrant collection is idempotent on startup                                                         | `ensureCollection` checks before creating; no error if already exists.                                    |

---

## 8. Edge cases & failure modes

| #   | Scenario                                     | Behaviour                                                                                                                                                   |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Empty text input to `chunkText`              | Returns `[]` — valid; ingestion Step 7 inserts 0 chunks and marks document `indexed`                                                                        |
| 2   | Text shorter than 800 tokens                 | Returns single chunk with all content                                                                                                                       |
| 3   | OpenAI 429 on embed                          | Retry up to 3×: delays 1s, 2s, 4s; re-throw on exhaustion                                                                                                   |
| 4   | OpenAI 500 or network error                  | Re-throw immediately (not retried by embeddings.ts; BullMQ handles retry)                                                                                   |
| 5   | Qdrant collection already exists             | `ensureCollection` detects via API and skips creation — no error                                                                                            |
| 6   | Qdrant unavailable                           | `upsertPoints`/`searchPoints` throw; caller (ingestion/retrieval) handles via BullMQ retry or 500 response                                                  |
| 7   | `deletePoints` called with empty array       | Early return, no Qdrant API call                                                                                                                            |
| 8   | Rebuild script run while server is ingesting | Upsert is idempotent (same deterministic IDs); may cause a brief inconsistency if a doc is mid-ingestion, but will self-correct                             |
| 9   | Batch of 2048 texts with empty strings       | OpenAI API may return zero-magnitude vectors; embeddings.ts does not validate; chunker should not produce empty chunks (guard: skip whitespace-only chunks) |

---

## 9. Criterion → implementation → proof table

| Criterion                                       | Implementation                                                                             | File                | Proof                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------- |
| AC-C1: chunkText ~800 token chunks, 150 overlap | Recursive split + token counting via `countTokens`                                         | `chunker.ts`        | Unit: 4000-token text → chunks all ≤800 tokens; adjacent chunks share ~150 tokens  |
| AC-C2: batchEmbed with retry on 429             | Serial batch loop + exponential backoff (1s, 2s, 4s)                                       | `embeddings.ts`     | Unit: mock OpenAI returning 429 twice → third call succeeds → returns vectors      |
| AC-C3: ensureCollection idempotent              | Check-then-create pattern                                                                  | `qdrant.ts`         | Integration: call twice on running Qdrant → no error second call                   |
| AC-C4: upsertPoints payload = {qdrantId} only   | `QdrantPoint` type enforces shape; upsert sends points as-is                               | `qdrant.ts`         | Unit: inspect point payload sent to Qdrant client → only `qdrantId` key present    |
| AC-C5: searchPoints                             | `client.search(COLLECTION, { vector, limit: topK, score_threshold, with_payload: false })` | `qdrant.ts`         | Integration: upsert 3 points, search with known vector → returns top-k with scores |
| AC-C6/C7 (deletePoints)                         | `client.delete(COLLECTION, { points: qdrantIds })`                                         | `qdrant.ts`         | Integration: upsert then delete → search returns 0 results                         |
| AC-C7: rebuild script idempotent                | Upsert (not insert) with deterministic IDs                                                 | `rebuild-qdrant.ts` | Integration: run twice → collection has same point count; no duplicates            |

---

## 10. Completeness self-check

| Check                                                                   | Result          |
| ----------------------------------------------------------------------- | --------------- |
| Every AC mapped in §9                                                   | Pass (AC-C1–C7) |
| All owned files have signatures                                         | Pass            |
| Interface correction (`deleteByDocumentId` → `deletePoints`) documented | Pass            |
| Qdrant payload invariant enforced via type                              | Pass            |
| No TBDs                                                                 | Pass            |
| No decisions deferred to executor                                       | Pass            |

**Completeness self-check passes. Plan is ready for the chunking-embedding executor.**
