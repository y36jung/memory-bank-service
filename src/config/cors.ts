import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { env } from './env.js';

/**
 * Single source of truth for the CORS allow-list.
 * Development trusts only the local frontend; beta trusts the deployed
 * frontend AND the local frontend (so a local dev frontend can be pointed at
 * the deployed beta API to test against real beta data); test allows no
 * cross-origin access (empty list), so the isolated unit/integration suites
 * never depend on a real deployed origin — identical to the @fastify/cors
 * `origin` posture in src/server.ts.
 * Consumed by src/server.ts, the SSE chat-messages route, and the
 * integration test app.
 */
export const CORS_ALLOWED_ORIGINS: readonly string[] =
  env.NODE_ENV === 'development'
    ? ['http://localhost:3001']
    : env.NODE_ENV === 'beta'
      ? ['https://memory-bank-ui.vercel.app', 'http://localhost:3001']
      : [];

/**
 * True only when `origin` is present AND an exact-match member of the
 * allow-list. Type-guards to `string` so callers may pass the result straight
 * to setHeader without a cast. A missing/undefined Origin returns false.
 */
export function isAllowedOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && CORS_ALLOWED_ORIGINS.includes(origin);
}

/**
 * CSRF guard for the two routes that consume the refresh_token cookie:
 * POST /api/auth/refresh and POST /api/auth/logout. Deliberately
 * asymmetric: fails CLOSED (403) only when Origin is PRESENT and not
 * allow-listed; fails OPEN when Origin is ABSENT. A present-but-wrong
 * Origin is a strong forged-cross-site-request signal (browsers set it
 * themselves; page script cannot override it) — a missing Origin isn't
 * proof of an attack (same-origin legacy browsers, non-browser clients),
 * so it isn't treated as one. login/register are deliberately NOT gated
 * (out of scope — would break cors.test.ts's login assertions).
 */
export function assertTrustedOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    throw new AppError('FORBIDDEN', 'Untrusted origin', 403);
  }
}
