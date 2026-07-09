import { env } from './env.js';

/**
 * Single source of truth for the CORS allow-list.
 * Development trusts only the local frontend; test and production allow no
 * cross-origin access (empty list) — identical to the @fastify/cors `origin`
 * posture in src/server.ts. Consumed by src/server.ts, the SSE chat-messages
 * route, and the integration test app.
 */
export const CORS_ALLOWED_ORIGINS: readonly string[] =
  env.NODE_ENV === 'development' ? ['http://localhost:3001'] : [];

/**
 * True only when `origin` is present AND an exact-match member of the
 * allow-list. Type-guards to `string` so callers may pass the result straight
 * to setHeader without a cast. A missing/undefined Origin returns false.
 */
export function isAllowedOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && CORS_ALLOWED_ORIGINS.includes(origin);
}
