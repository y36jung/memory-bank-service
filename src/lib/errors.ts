import type { FastifyReply, FastifyRequest } from 'fastify';

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

// Fastify v5: reply.send() returns FastifyReply, not Promise<void>.
// The plan's Promise<void> return type is adjusted to void to match the actual Fastify v5 API.
export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  reply.status(statusCode).send({ data, error: null });
}

export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AppError) {
    reply
      .status(err.statusCode)
      .send({ data: null, error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  reply.status(500).send({ data: null, error: { code: 'INTERNAL_ERROR', message } });
}

// Fastify error handler — register with app.setErrorHandler(fastifyErrorHandler)
export function fastifyErrorHandler(
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    reply
      .status(error.statusCode)
      .send({ data: null, error: { code: error.code, message: error.message } });
    return;
  }
  // Log the real error server-side; never expose raw library messages to clients.
  request.log.error({ err: error }, 'Unhandled error');
  reply
    .status(500)
    .send({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
