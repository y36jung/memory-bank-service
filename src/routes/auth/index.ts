import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import fastifyRateLimit from '@fastify/rate-limit';
import { AppError } from '../../lib/errors.js';
import { registerRoute } from './register.js';
import { loginRoute } from './login.js';
import { refreshRoute } from './refresh.js';
import { logoutRoute } from './logout.js';

// Shared errorResponseBuilder (§5.11): both the per-user (protected) and
// per-IP (login/register) rate limiters use this so a 429 still upholds the
// `{ data, error }` envelope. Exported for reuse by src/server.ts.
export function rateLimitEnvelope(_req: FastifyRequest, context: { statusCode: number }): AppError {
  return new AppError('RATE_LIMITED', 'Too many requests', context.statusCode);
}

// Composes the four /auth sub-routes. No extra prefix here — server.ts
// registers this plugin with { prefix: '/api/auth' }. Registers
// @fastify/rate-limit locally with { global: false } so only login/register
// opt in (via route `config.rateLimit`); refresh/logout are unaffected.
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: rateLimitEnvelope,
  });
  await app.register(registerRoute);
  await app.register(loginRoute);
  await app.register(refreshRoute);
  await app.register(logoutRoute);
};
