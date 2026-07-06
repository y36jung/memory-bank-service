/**
 * Builds a Fastify instance for API-contract testing without importing
 * src/server.ts directly.
 *
 * src/server.ts unconditionally invokes `start().catch(...)` at module scope
 * (no `if (require.main === module)`-style guard), which would, as a side
 * effect of merely importing the module to reach `buildApp`:
 *   - call `ensureCollection()` against real Qdrant,
 *   - start a real BullMQ Worker consuming the shared `ingestion` Redis queue,
 *   - start the 10-minute supervisor interval,
 *   - call `app.listen()` on the configured PORT.
 * That is unacceptable for an automated test run against shared dev
 * infrastructure (see finding in the handback report: this is a pre-existing
 * testability gap, not introduced by Slice 1).
 *
 * This helper therefore reproduces `buildApp()` verbatim — same plugins, same
 * registration order (auth BEFORE the five route plugins, load-bearing per
 * the slice plan §5.4) — importing only the individual route/plugin modules,
 * which have no import-time side effects beyond constructing lazy service
 * clients (S3Client, QdrantClient, ioredis connection, BullMQ Queue
 * producer) that do not consume queue jobs or open listening sockets.
 */
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { fastifyErrorHandler } from '../../../src/lib/errors.js';
import { env } from '../../../src/config/env.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { documentUploadRoutes } from '../../../src/routes/documents/upload.js';
import { documentListRoutes } from '../../../src/routes/documents/list.js';
import { documentFileRoutes } from '../../../src/routes/documents/file.js';
import { chatSessionRoutes } from '../../../src/routes/chat/sessions.js';
import { chatMessageRoutes } from '../../../src/routes/chat/messages.js';

export async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  app.setErrorHandler(fastifyErrorHandler);
  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? ['http://localhost:3001'] : [],
  });

  // Route registration — order matches src/server.ts exactly.
  await app.register(authPlugin);
  await app.register(documentUploadRoutes, { prefix: '/api' });
  await app.register(documentListRoutes, { prefix: '/api' });
  await app.register(documentFileRoutes, { prefix: '/api' });
  await app.register(chatSessionRoutes, { prefix: '/api' });
  await app.register(chatMessageRoutes, { prefix: '/api' });

  await app.ready();
  return app;
}
