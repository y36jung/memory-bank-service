import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { fastifyErrorHandler } from './lib/errors.js';
import { env } from './config/env.js';
import { documentUploadRoutes } from './routes/documents/upload.js';
import { documentListRoutes } from './routes/documents/list.js';
import { chatSessionRoutes } from './routes/chat/sessions.js';
import { chatMessageRoutes } from './routes/chat/messages.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB
  app.setErrorHandler(fastifyErrorHandler);

  // Route registration
  await app.register(documentUploadRoutes, { prefix: '/api' });
  await app.register(documentListRoutes, { prefix: '/api' });
  await app.register(chatSessionRoutes, { prefix: '/api' });
  await app.register(chatMessageRoutes, { prefix: '/api' });

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
