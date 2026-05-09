import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { FastifyError } from '@fastify/error';
import { type AppError, statusFromKind } from './lib/errors.js';

/**
 * Creates and configures the Fastify application instance.
 * Registers a global error handler that maps AppError kinds to HTTP codes
 * and surfaces Fastify schema validation errors as 400 responses.
 *
 * @param opts - Optional Fastify server options (e.g. logger overrides for tests)
 * @returns Configured Fastify instance, ready to register plugins and listen
 */
export async function buildApp(opts?: FastifyServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, ...opts });

  app.setErrorHandler<FastifyError & { kind?: AppError['kind'] }>((error, _req, reply) => {
    if (error.validation)
      return reply.code(400).send({ error: 'validation', details: error.validation });

    return reply.code(statusFromKind(error.kind)).send({ error: error.kind ?? 'internal' });
  });

  return app;
}
