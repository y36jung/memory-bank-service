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
 * registration order and public/protected scope split (slice-3 plan §5.9) —
 * importing only the individual route/plugin modules, which have no
 * import-time side effects beyond constructing lazy service clients
 * (S3Client, QdrantClient, ioredis connection, BullMQ Queue producer) that do
 * not consume queue jobs or open listening sockets.
 *
 * Public/protected split (mirrors src/server.ts §5.9, load-bearing per
 * plan §6 "Test-helper interface consequence"):
 *   - root: cookie + jwtPlugin (app.jwt exists in BOTH zones)
 *   - protectedScope: authPlugin (enforce hook, runs 1st) + per-user
 *     rate-limit (runs after auth) + the five protected route plugins
 *   - public: authRoutes registered at root with prefix '/api/auth'
 * Test app intentionally keeps `logger: false` — the redacting logger is a
 * server.ts-only concern verified by review-security, not by tests.
 */
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { fastifyErrorHandler } from '../../../src/lib/errors.js';
import { CORS_ALLOWED_ORIGINS } from '../../../src/config/cors.js';
import { jwtPlugin } from '../../../src/plugins/jwt.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { documentUploadRoutes } from '../../../src/routes/documents/upload.js';
import { documentListRoutes } from '../../../src/routes/documents/list.js';
import { documentFileRoutes } from '../../../src/routes/documents/file.js';
import { chatSessionRoutes } from '../../../src/routes/chat/sessions.js';
import { chatMessageRoutes } from '../../../src/routes/chat/messages.js';
import { accountRoutes } from '../../../src/routes/account/delete.js';
import { authRoutes, rateLimitEnvelope } from '../../../src/routes/auth/index.js';

export async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  app.setErrorHandler(fastifyErrorHandler);
  await app.register(cors, {
    origin: [...CORS_ALLOWED_ORIGINS],
    credentials: true,
  });

  // Root plugins — both the public and protected zones need cookie read/write
  // and app.jwt (sign in public routes, verify in protected routes).
  await app.register(cookie);
  await app.register(jwtPlugin);

  await app.register(async (protectedScope) => {
    await protectedScope.register(authPlugin); // adds enforce preHandler (runs 1st)
    await protectedScope.register(rateLimit, {
      // adds preHandler AFTER auth
      global: true,
      hook: 'preHandler',
      max: 100,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.user?.id ?? req.ip,
      errorResponseBuilder: rateLimitEnvelope,
    });
    await protectedScope.register(documentUploadRoutes, { prefix: '/api' });
    await protectedScope.register(documentListRoutes, { prefix: '/api' });
    await protectedScope.register(documentFileRoutes, { prefix: '/api' });
    await protectedScope.register(chatSessionRoutes, { prefix: '/api' });
    await protectedScope.register(chatMessageRoutes, { prefix: '/api' });
    await protectedScope.register(accountRoutes, { prefix: '/api' });
  });

  await app.register(authRoutes, { prefix: '/api/auth' }); // PUBLIC (no enforce hook)

  await app.ready();
  return app;
}
