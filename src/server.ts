import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { fastifyErrorHandler } from './lib/errors.js';
import { env } from './config/env.js';
import { CORS_ALLOWED_ORIGINS } from './config/cors.js';
import { jwtPlugin } from './plugins/jwt.js';
import { authPlugin } from './plugins/auth.js';
import { documentUploadRoutes } from './routes/documents/upload.js';
import { documentListRoutes } from './routes/documents/list.js';
import { chatSessionRoutes } from './routes/chat/sessions.js';
import { chatMessageRoutes } from './routes/chat/messages.js';
import { documentFileRoutes } from './routes/documents/file.js';
import { accountRoutes } from './routes/account/delete.js';
import { authRoutes, rateLimitEnvelope } from './routes/auth/index.js';

export async function buildApp() {
  const app = Fastify({
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'password',
          'accessToken',
          'refreshToken',
          'token',
          'tokenHash',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB
  app.setErrorHandler(fastifyErrorHandler);
  await app.register(cors, {
    origin: [...CORS_ALLOWED_ORIGINS],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
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

  return app;
}

export async function start() {
  // Import lazily to avoid circular deps at load time.
  // created by chunking-embedding executor
  const { ensureCollection } = await import('./services/qdrant.js');
  await (ensureCollection as () => Promise<void>)();
  console.log('Qdrant collection ready');

  // Supervisor is started here — imported once qdrant/db/queue are ready.
  const { startSupervisor } = await import('./services/ingestion.js');
  const supervisorHandle = (startSupervisor as () => ReturnType<typeof setInterval>)();
  console.log('Ingestion supervisor started');

  // Side-effect: starts the BullMQ worker.
  await import('./queue/workers/ingestion.worker.js');
  console.log('Ingestion worker started');

  const app = await buildApp();

  const shutdown = async () => {
    await app.close();
    clearInterval(supervisorHandle);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
