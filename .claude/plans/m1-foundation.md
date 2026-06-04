# Slice Plan — m1-foundation

**Owning executor:** foundation-infra  
**Plan status:** Ready for implementation

> **Package gaps (executor must install):** `@aws-sdk/client-s3`, `uuid`, `fastify-type-provider-zod` are absent from `package.json`. Run `npm install @aws-sdk/client-s3 uuid fastify-type-provider-zod` before writing any source files.
>
> **Also needed for other slices (install together):** `mammoth`, `csv-parse`, `xlsx` (needed by m1-extraction).

---

## 1. Slice + linked spec/PRD sections

Sub-slice of Milestone 1 (orchestration plan: `implement-milestone-1-of-iridescent-aho.md`, Step 2 Phase 1).

| PLAN.md section                           | Relevance                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| §Technology Stack                         | Fastify v5, TypeScript, Zod, OpenAI, S3, Drizzle, Qdrant, BullMQ                                                               |
| §Project Structure                        | Canonical file paths for config/, lib/, services/storage.ts, server.ts                                                         |
| §Milestone 1 deliverable #1               | "Project scaffold: Fastify + TypeScript + Drizzle + Zod env"                                                                   |
| §Milestone 1 deliverable #4               | "S3 upload service (stream directly from multipart request)"                                                                   |
| §Milestone 1 Key Technical Considerations | "Stream multipart uploads directly to S3 using @fastify/multipart + AWS SDK streaming — never buffer the full file in memory." |
| §Load-bearing invariants                  | chunk text stays in Postgres, tokens counted via tiktoken                                                                      |

---

## 2. Acceptance criteria, verbatim

- **AC-F1.** Project scaffold with Fastify + TypeScript + Drizzle + Zod env (M1 deliverable #1)
- **AC-F2.** S3 upload service that streams directly from multipart request — never buffers full file in memory (M1 deliverable #4 + Key Technical Considerations)
- **AC-F3.** `src/config/env.ts` exports a Zod-parsed `env` object; process fails fast with descriptive message on missing required vars
- **AC-F4.** `src/lib/errors.ts` provides `AppError` class and `{ data, error }` JSON envelope helpers used by all routes
- **AC-F5.** `src/lib/idgen.ts` provides `generateQdrantId(documentId, chunkIndex)` using uuidv5 with a fixed namespace
- **AC-F6.** `src/lib/tokenizer.ts` provides `countTokens(text)` using tiktoken cl100k_base encoding, singleton pattern
- **AC-F7.** `src/services/storage.ts` provides `uploadStream`, `getStream`, `deleteObject` using `@aws-sdk/client-s3`
- **AC-F8.** `src/server.ts` bootstraps Fastify v5 with `@fastify/multipart` (50 MB limit) and `fastify-type-provider-zod`; calls `qdrant.ensureCollection()` on startup; handles graceful shutdown

---

## 3. Design overview

This slice delivers the shared infrastructure that all other M1 phases import. No business logic — only configuration, utilities, and service clients.

Key decisions:

- **Zod env fails-fast**: `z.object({...}).parse(process.env)` at module load time. Any missing or malformed var crashes the process immediately with a readable Zod error rather than a runtime null-dereference deep in the stack.
- **`AppError` is the single error type**: all route handlers catch unknown errors and coerce to `AppError`. The `{ data, error }` envelope is enforced at the `sendSuccess` / `sendError` helpers — routes never construct JSON directly.
- **uuidv5 namespace**: fixed UUID constant `'6ba7b810-9dad-11d1-80b4-00c04fd430c8'` (the well-known DNS namespace from RFC 4122). Using a fixed, well-known namespace rather than a random one ensures the same `documentId + chunkIndex` always produces the same output across process restarts and servers.
- **tiktoken singleton**: `getEncoding('cl100k_base')` is called once on first use and cached. Re-calling it is not free.
- **S3 streaming**: `PutObjectCommand` with `Body` set to the `Readable` stream directly. `ContentLength` must be set for multipart — the upload route passes `sizeBytes` extracted from the multipart field headers. `GetObjectCommand` returns a `Readable` via the response `Body` property. No `fs.writeFile` or `Buffer` accumulation.
- **server.ts** registers `@fastify/multipart` globally, then `fastify-type-provider-zod` (calls `setValidatorCompiler` + `setSerializerCompiler`). Route registration is done by calling `app.register(documentRoutes, { prefix: '/api/documents' })` etc. — the specific route plugins are added by api-transport; server.ts just provides the stubs/imports. `qdrant.ensureCollection()` is called before the server starts listening.

---

## 4. Affected files

| Action | Path                      | Owner            |
| ------ | ------------------------- | ---------------- |
| create | `docker-compose.yml`      | foundation-infra |
| create | `src/config/env.ts`       | foundation-infra |
| create | `src/lib/errors.ts`       | foundation-infra |
| create | `src/lib/idgen.ts`        | foundation-infra |
| create | `src/lib/tokenizer.ts`    | foundation-infra |
| create | `src/services/storage.ts` | foundation-infra |
| create | `src/server.ts`           | foundation-infra |

Does **not** create: route files (api-transport), db files (data-persistence), `src/lib/utils.ts` (ingestion-orchestration).

---

## 5. Signatures & data structures

### `docker-compose.yml`

```yaml
# Services: postgres (image: postgres:16, port: 5432), redis (image: redis:7, port: 6379),
# qdrant (image: qdrant/qdrant:latest, port: 6333), pgadmin (image: dpage/pgadmin4, port: 5050).
# All services use named volumes. Postgres and Redis have health checks.
# Environment vars sourced from .env file (env_file: .env).
```

### `src/config/env.ts`

```typescript
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: z.string().optional(),
  REDIS_URL: z.string().url(),
  AWS_REGION: z.string(),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET_NAME: z.string(),
  OPENAI_API_KEY: z.string().startsWith('sk-'),
  JWT_SECRET: z.string().min(32),
  // OAuth vars are optional in M1 (M3-4)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
export const env: Env = envSchema.parse(process.env);
```

### `src/lib/errors.ts`

```typescript
import type { FastifyReply } from 'fastify';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): Promise<void> {
  return reply.status(statusCode).send({ data, error: null });
}

export function sendError(reply: FastifyReply, err: unknown): Promise<void> {
  if (err instanceof AppError) {
    return reply
      .status(err.statusCode)
      .send({ data: null, error: { code: err.code, message: err.message } });
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  return reply.status(500).send({ data: null, error: { code: 'INTERNAL_ERROR', message } });
}

// Fastify error handler — register with app.setErrorHandler(fastifyErrorHandler)
export function fastifyErrorHandler(
  error: Error,
  _request: unknown,
  reply: FastifyReply,
): Promise<void> {
  return sendError(reply, error);
}
```

### `src/lib/idgen.ts`

```typescript
import { v5 as uuidv5 } from 'uuid';

// RFC 4122 DNS namespace — fixed, well-known, deterministic across restarts.
const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function generateQdrantId(documentId: string, chunkIndex: number): string {
  return uuidv5(`${documentId}:${chunkIndex}`, NAMESPACE);
}
```

### `src/lib/tokenizer.ts`

```typescript
import { Tiktoken, getEncoding } from 'tiktoken';

let _encoding: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!_encoding) {
    _encoding = getEncoding('cl100k_base');
  }
  return _encoding;
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}
```

### `src/services/storage.ts`

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { NodeJsRuntimeStreamingBlobPayloadOutputTypes } from '@smithy/types';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

export async function uploadStream(
  key: string,
  stream: NodeJS.ReadableStream,
  contentType: string,
  contentLength?: number,
): Promise<void>;
// PutObjectCommand with Body: stream, ContentType: contentType, ContentLength: contentLength (required for streaming uploads).
// Bucket from env.S3_BUCKET_NAME.

export async function getStream(key: string): Promise<NodeJS.ReadableStream>;
// GetObjectCommand; cast Body to Readable. Throws AppError('S3_NOT_FOUND', ..., 404) if NoSuchKey.

export async function deleteObject(key: string): Promise<void>;
// DeleteObjectCommand. Idempotent (S3 delete of non-existent key is a no-op).
```

### `src/server.ts`

```typescript
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { fastifyErrorHandler } from './lib/errors.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB
  app.setErrorHandler(fastifyErrorHandler);

  // Route registration — populated by api-transport (Phase 6).
  // Placeholder imports so server.ts compiles even before routes exist:
  // await app.register(import('./routes/documents/upload.js'), { prefix: '/api/documents' });
  // await app.register(import('./routes/documents/list.js'), { prefix: '/api/documents' });
  // await app.register(import('./routes/chat/sessions.js'), { prefix: '/api/chat' });
  // await app.register(import('./routes/chat/messages.js'), { prefix: '/api/chat' });

  return app;
}

export async function start() {
  // Import lazily to avoid circular deps at load time.
  const { ensureCollection } = await import('./services/qdrant.js');
  await ensureCollection();

  // Supervisor is started here — imported once qdrant/db/queue are ready.
  const { startSupervisor } = await import('./services/ingestion.js');
  const supervisorHandle = startSupervisor();

  // Side-effect: starts the BullMQ worker.
  await import('./queue/workers/ingestion.worker.js');

  const app = await buildApp();
  const { env } = await import('./config/env.js');

  const shutdown = async () => {
    await app.close();
    clearInterval(supervisorHandle);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}
```

Note: server.ts uses dynamic imports for services that don't exist yet at Phase 1. foundation-infra writes server.ts with these as commented-out stubs; api-transport (Phase 6) uncomments the route registrations.

---

## 6. Interfaces

### Produced (consumed by all other slices)

| Symbol                                                        | Source                    | Consumer                                           |
| ------------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| `env: Env`                                                    | `src/config/env.ts`       | all slices                                         |
| `AppError`, `sendSuccess`, `sendError`, `fastifyErrorHandler` | `src/lib/errors.ts`       | api-transport, extraction, ingestion-orchestration |
| `generateQdrantId(documentId, chunkIndex): string`            | `src/lib/idgen.ts`        | chunking-embedding, ingestion-orchestration        |
| `countTokens(text): number`                                   | `src/lib/tokenizer.ts`    | chunking-embedding (chunker)                       |
| `uploadStream`, `getStream`, `deleteObject`                   | `src/services/storage.ts` | extraction, api-transport                          |
| `buildApp()`, `start()`                                       | `src/server.ts`           | entrypoint (`node src/server.ts`)                  |

### server.ts route registration contract (for api-transport Phase 6)

api-transport will call `app.register(routePlugin, { prefix })` from within `buildApp()`. The server.ts written in Phase 1 includes these as comments; api-transport uncommenting them is the only modification to server.ts.

---

## 7. Invariants upheld

- **"Never buffer the full file in memory"** (PLAN.md §M1 Key Technical Considerations) — `uploadStream` passes the `Readable` stream as `Body` directly to `PutObjectCommand`. No `await streamToBuffer()`.
- **"Zod env schema with `dotenv` config loader that fails fast on missing vars"** (M1 deliverable #1) — `envSchema.parse(process.env)` throws at module load time if any required var is absent.
- **`generateQdrantId` = uuidv5(documentId + chunkIndex)** — fixed namespace ensures the same input always yields the same UUID across all processes.

---

## 8. Edge cases & failure modes

| #   | Scenario                                       | Behaviour                                                                                                                                                 |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Missing required env var                       | `envSchema.parse` throws Zod error at startup; process exits before accepting requests                                                                    |
| 2   | S3 object not found during `getStream`         | Catch `NoSuchKey` error from AWS SDK; throw `AppError('S3_NOT_FOUND', 'Object not found', 404)`                                                           |
| 3   | S3 upload without `contentLength`              | AWS SDK may reject without Content-Length for streaming uploads; upload route must pass the multipart `file.bytesRead` or set `TransferEncoding: chunked` |
| 4   | Fastify fails to start (port in use)           | `app.listen` rejects; process exits with non-zero code — normal crash behaviour                                                                           |
| 5   | SIGTERM during active request                  | `app.close()` drains open connections (Fastify's default close hook); BullMQ worker shutdown handled separately                                           |
| 6   | `countTokens` called on very long text (>1 MB) | tiktoken handles it synchronously; no safeguards in M1 (rate limiting is upstream concern)                                                                |

---

## 9. Criterion → implementation → proof table

| Criterion                                                | Implementation                                                                                             | File              | Proof                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| AC-F1: Fastify + TypeScript + Drizzle + Zod env scaffold | `src/server.ts`, `src/config/env.ts`, `tsconfig.json` (pre-existing)                                       | server.ts, env.ts | `npm run typecheck` passes; `buildApp()` returns a Fastify instance                           |
| AC-F2: S3 streaming, no disk buffer                      | `uploadStream(key, stream, contentType, contentLength)` uses `PutObjectCommand({ Body: stream })`          | storage.ts        | Unit: spy on `PutObjectCommand` — assert `Body` is a Readable, not a Buffer                   |
| AC-F3: env fails fast                                    | `envSchema.parse(process.env)` at module init                                                              | env.ts            | Unit: set `process.env.DATABASE_URL = ''` → `import('./config/env.js')` rejects with ZodError |
| AC-F4: AppError + envelope                               | `AppError`, `sendSuccess`, `sendError`                                                                     | errors.ts         | Unit: `sendSuccess(mockReply, {id:1})` → reply called with `{ data: {id:1}, error: null }`    |
| AC-F5: generateQdrantId deterministic                    | `uuidv5(`${documentId}:${chunkIndex}`, NAMESPACE)`                                                         | idgen.ts          | Unit: same inputs → same UUID on two calls; different `chunkIndex` → different UUID           |
| AC-F6: countTokens via tiktoken                          | `getEncoding('cl100k_base').encode(text).length`                                                           | tokenizer.ts      | Unit: `countTokens('hello world')` returns > 0                                                |
| AC-F7: storage.ts upload/get/delete                      | `PutObjectCommand`, `GetObjectCommand`, `DeleteObjectCommand`                                              | storage.ts        | Unit with AWS SDK mock: each function calls the correct command with correct bucket/key       |
| AC-F8: server.ts Fastify bootstrap                       | `buildApp()` registers multipart + zod type provider + error handler; `start()` calls `ensureCollection()` | server.ts         | Integration: `buildApp()` resolves; `GET /healthz` returns 200 (add a simple health route)    |

---

## 10. Completeness self-check

| Check                                                              | Result |
| ------------------------------------------------------------------ | ------ |
| All ACs (F1–F8) mapped in §9                                       | Pass   |
| All owned files in §4 have signatures in §5                        | Pass   |
| All interface boundaries named in §6                               | Pass   |
| No TBDs                                                            | Pass   |
| Missing packages explicitly listed for executor                    | Pass   |
| server.ts route stubs pattern documented for api-transport handoff | Pass   |
| S3 streaming invariant documented                                  | Pass   |

**Completeness self-check passes. Plan is ready for the foundation-infra executor.**
