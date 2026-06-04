# Slice Plan — m1-retrieval-rag

**Owning executor:** retrieval-rag  
**Plan status:** Ready for implementation  
**Depends on:** m1-data-persistence, m1-chunking-embedding (qdrant client, embeddings)

---

## 1. Slice + linked spec/PRD sections

| PLAN.md section                    | Relevance                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ |
| §RAG Query Pipeline                | 8-step pipeline: embed → search → fetch → context → GPT-4o stream → save |
| §Chat Service                      | SSE format, system prompt, sources JSON                                  |
| §Milestone 1 deliverables #15, #16 | Chat session/message endpoints; RAG query pipeline with SSE streaming    |
| §Load-bearing invariants           | Chunk text fetched from Postgres only (never from Qdrant payload)        |

---

## 2. Acceptance criteria, verbatim

- **AC-R1.** `retrieveChunks(query, topK?)` — embeds query, searches Qdrant (top_k=10, score_threshold=0.5), fetches chunk text from Postgres by qdrant_id
- **AC-R2.** `streamChatResponse(sessionId, userMessage, reply)` — inserts user message, builds context from chunks, streams GPT-4o response as SSE, inserts assistant message + sources on completion
- **AC-R3.** SSE delta event format: `data: {"type":"delta","content":"..."}\n\n`
- **AC-R4.** SSE done event format: `data: {"type":"done","messageId":"...","sources":[...]}\n\n`
- **AC-R5.** Source type: `{ chunkId, documentId, documentName, score }`
- **AC-R6.** System prompt instructs GPT-4o to cite sources by document name and say "I don't know" when context is insufficient
- **AC-R7.** Chunk text is fetched from Postgres — never from Qdrant payload

---

## 3. Design overview

**retrieval.ts** is a pure data-fetching function. It embeds the query string using `batchEmbed`, calls `searchPoints` on Qdrant, then fetches the matching chunk rows from Postgres using `WHERE qdrant_id = ANY($1)`. It joins with `documents` to get `originalName` for the source label. Returns chunks sorted by score descending.

**chat.ts** orchestrates the full RAG response. It:

1. Calls `retrieveChunks` to get grounded context
2. Inserts the user message to the DB
3. Builds a context string from chunk contents (concatenated, guarded to stay below ~100k tokens total to leave room for system prompt + response)
4. Opens an OpenAI streaming chat completion with GPT-4o
5. Writes SSE `delta` events to the Fastify reply as tokens arrive
6. On stream end: inserts the assistant message with sources JSON, writes the `done` SSE event

**SSE transport**: Fastify reply headers are set before any data is sent (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`). Each event is `data: <JSON>\n\n`. The route handler (`api-transport`) is responsible for setting headers and must call `reply.raw.write(...)` or use Fastify's `reply.send` with a stream. `streamChatResponse` receives the reply object and writes directly to it.

---

## 4. Affected files

| Action | Path                        | Owner         |
| ------ | --------------------------- | ------------- |
| create | `src/services/retrieval.ts` | retrieval-rag |
| create | `src/services/chat.ts`      | retrieval-rag |

---

## 5. Signatures & data structures

### `src/services/retrieval.ts`

```typescript
import { db } from '../db/index.js';
import { chunks, documents } from '../db/schema.js';
import { batchEmbed } from './embeddings.js';
import { searchPoints } from './qdrant.js';
import { eq, inArray } from 'drizzle-orm';

export interface RetrievedChunk {
  chunkId: string;
  qdrantId: string;
  documentId: string;
  documentName: string; // documents.original_name
  content: string; // chunks.content — from Postgres, not Qdrant
  score: number;
}

export async function retrieveChunks(
  query: string,
  topK = 10,
  scoreThreshold = 0.5,
): Promise<RetrievedChunk[]>;
// 1. const [vector] = await batchEmbed([query])
// 2. const results = await searchPoints(vector, topK, scoreThreshold)  → [{id, score}]
// 3. If results.length === 0 → return []
// 4. SELECT chunks.*, documents.original_name FROM chunks
//    JOIN documents ON chunks.document_id = documents.id
//    WHERE chunks.qdrant_id = ANY(results.map(r => r.id))
// 5. Map to RetrievedChunk[], preserving score from Qdrant results (join on qdrantId)
// 6. Sort by score desc
```

### `src/services/chat.ts`

```typescript
import OpenAI from 'openai';
import type { FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { messages, chatSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { retrieveChunks, type RetrievedChunk } from './retrieval.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const MAX_CONTEXT_TOKENS = 100_000;

export interface Source {
  chunkId: string;
  documentId: string;
  documentName: string;
  score: number;
}

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions based strictly on the provided context documents.
When answering:
- Cite the source document name when referencing specific information.
- If the context does not contain enough information to answer, say "I don't know based on the provided documents."
- Do not hallucinate or add information not present in the context.`;

export async function streamChatResponse(
  sessionId: string,
  userMessage: string,
  reply: FastifyReply,
): Promise<void>;
// Steps:
// 1. Verify session exists → throw AppError('SESSION_NOT_FOUND', ..., 404) if not
// 2. Retrieve chunks: const chunks = await retrieveChunks(userMessage)
// 3. INSERT user message: db.insert(messages).values({ sessionId, role: 'user', content: userMessage })
// 4. Build context: concatenate chunks[].content; trim total to MAX_CONTEXT_TOKENS
// 5. Set SSE reply headers: Content-Type, Cache-Control, Connection
// 6. OpenAI stream: openai.chat.completions.create({ model: 'gpt-4o', stream: true, messages: [...] })
// 7. For each delta: reply.raw.write(`data: ${JSON.stringify({type:'delta',content:delta})}\n\n`)
// 8. Accumulate full response text
// 9. On stream end:
//    a. INSERT assistant message with sources JSON
//    b. Write done event: reply.raw.write(`data: ${JSON.stringify({type:'done',messageId,sources})}\n\n`)
//    c. reply.raw.end()
// 10. On error mid-stream: write error event and end

function buildContextString(chunks: RetrievedChunk[]): string;
// Concatenates chunk contents with source labels; trims to MAX_CONTEXT_TOKENS
// Format: "--- Source: <documentName> ---\n<content>\n\n"
```

---

## 6. Interfaces

### Produced (consumed by api-transport)

| Symbol                                              | Consumer                                      |
| --------------------------------------------------- | --------------------------------------------- |
| `retrieveChunks(query, topK?, scoreThreshold?)`     | api-transport (optionally for standalone use) |
| `streamChatResponse(sessionId, userMessage, reply)` | `src/routes/chat/messages.ts`                 |
| `Source` type                                       | api-transport (for response typing)           |

### Consumed

| Symbol                                                  | Source                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `batchEmbed`                                            | `src/services/embeddings.ts` (m1-chunking-embedding)        |
| `searchPoints`                                          | `src/services/qdrant.ts` (m1-chunking-embedding)            |
| `db`, `chunks`, `documents`, `messages`, `chatSessions` | `src/db/index.ts`, `src/db/schema.ts` (m1-data-persistence) |
| `env.OPENAI_API_KEY`                                    | `src/config/env.ts` (m1-foundation)                         |
| `AppError`                                              | `src/lib/errors.ts` (m1-foundation)                         |

---

## 7. Invariants upheld

| Invariant (PLAN.md)                                             | Implementation                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "Chunk text fetched from Postgres — never from Qdrant payload." | `retrieveChunks` uses Qdrant only for IDs + scores; content fetched via `SELECT chunks.content WHERE qdrant_id = ANY(...)`. |
| Sources stored as JSON                                          | `messages.sources` is `jsonb`; `Source[]` is serialized on insert.                                                          |
| Session must exist before streaming                             | Step 1 validates session before opening SSE stream; avoids orphan SSE connections.                                          |

---

## 8. Edge cases & failure modes

| #   | Scenario                                            | Behaviour                                                                                                |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Session not found                                   | Throw `AppError('SESSION_NOT_FOUND', 'Session not found', 404)` before any SSE headers set               |
| 2   | Qdrant returns 0 results                            | `retrieveChunks` returns `[]`; chat proceeds with empty context; GPT-4o responds "I don't know"          |
| 3   | Qdrant returns IDs with no matching Postgres chunks | `inArray(chunks.qdrantId, ids)` returns fewer rows; missing ones silently excluded; no error             |
| 4   | OpenAI stream error mid-stream (after headers sent) | Write `data: {"type":"error","message":"Stream error"}\n\n` then `reply.raw.end()`                       |
| 5   | Context exceeds MAX_CONTEXT_TOKENS                  | `buildContextString` truncates by dropping lowest-scored chunks until under limit                        |
| 6   | Empty user message                                  | Handled at route validation level (api-transport); retrieval will still work (embeds empty string)       |
| 7   | DB insert of assistant message fails post-stream    | Log error; do not surface to user (SSE already closed); document ends up without assistant message in DB |

---

## 9. Criterion → implementation → proof table

| Criterion                               | Implementation                                                                | File           | Proof                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| AC-R1: retrieveChunks                   | embed → searchPoints → Postgres join                                          | `retrieval.ts` | Unit: mock batchEmbed + searchPoints + db → assert RetrievedChunk[] returned with correct fields          |
| AC-R2: streamChatResponse full pipeline | Session check → retrieve → insert user msg → GPT-4o stream → insert assistant | `chat.ts`      | Integration: mock OpenAI stream → assert SSE events written in order, messages inserted                   |
| AC-R3: delta SSE format                 | `reply.raw.write(`data: ${JSON.stringify({type:'delta',content})}\n\n`)`      | `chat.ts`      | Unit: capture raw writes → assert format matches spec                                                     |
| AC-R4: done SSE format                  | Write done event with messageId + sources                                     | `chat.ts`      | Unit: assert done event shape                                                                             |
| AC-R5: Source type shape                | `{ chunkId, documentId, documentName, score }`                                | `chat.ts`      | Unit: assert sources array in done event matches expected type                                            |
| AC-R6: system prompt                    | `SYSTEM_PROMPT` constant; passed as system message to GPT-4o                  | `chat.ts`      | Unit: inspect messages array sent to OpenAI → system role present with cite + "I don't know" instructions |
| AC-R7: chunk text from Postgres         | `SELECT chunks.content WHERE qdrant_id = ANY(...)` in `retrieveChunks`        | `retrieval.ts` | Unit: assert Qdrant `with_payload` is false; chunk content comes from Postgres query result               |

---

## 10. Completeness self-check

| Check                                       | Result          |
| ------------------------------------------- | --------------- |
| Every AC mapped in §9                       | Pass (AC-R1–R7) |
| All owned files have signatures             | Pass            |
| SSE format fully specified (both events)    | Pass            |
| Source type fully specified                 | Pass            |
| Chunk-text-from-Postgres invariant enforced | Pass            |
| Session validation before SSE headers       | Pass            |
| No TBDs                                     | Pass            |

**Completeness self-check passes. Plan is ready for the retrieval-rag executor.**
