/**
 * CSRF Origin guard (src/config/cors.ts's assertTrustedOrigin) on the two
 * routes that consume the refresh_token cookie: POST /api/auth/refresh and
 * POST /api/auth/logout. Deliberately asymmetric: rejects only a PRESENT
 * and mismatched Origin; a MISSING Origin passes through (fail-open) — see
 * auth-flow.test.ts, which already exercises both routes without ever
 * setting an Origin header, proving the fail-open path in the large.
 *
 * The "matching, allow-listed origin passes through" case is deliberately
 * NOT covered here via a mocked CORS_ALLOWED_ORIGINS — assertTrustedOrigin
 * calls isAllowedOrigin as a same-module internal reference, so a
 * vi.mock('../../src/config/cors.js', ...) spread-in factory would replace
 * the external export binding but not what assertTrustedOrigin itself sees
 * internally, silently testing against the wrong (real, empty in test env)
 * allow-list. That case is covered as a pure unit test instead, in
 * tests/unit/config/cors.test.ts, against the module reloaded under
 * NODE_ENV=beta.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) and real
 * Postgres — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedRefreshToken } from './helpers/seed.js';
import { pool } from '../../src/db/index.js';
import { REFRESH_COOKIE_NAME } from '../../src/lib/refreshToken.js';

describe('CSRF Origin guard — POST /api/auth/{refresh,logout}', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('/refresh', () => {
    it('a present, mismatched Origin -> 403 FORBIDDEN (route body never runs)', async () => {
      const user = await seedUser('csrf-refresh-blocked');
      const { raw } = await seedRefreshToken(user.id);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { origin: 'https://evil.example' },
        cookies: { [REFRESH_COOKIE_NAME]: raw },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: 'Untrusted origin' },
      });
    });

    it('a missing Origin passes the guard through (fail-open)', async () => {
      const user = await seedUser('csrf-refresh-noorigin');
      const { raw } = await seedRefreshToken(user.id);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: raw },
      });
      // 200 proves the guard didn't block it — the route's own logic runs.
      expect(res.statusCode).toBe(200);
    });
  });

  describe('/logout', () => {
    it('a present, mismatched Origin -> 403 FORBIDDEN', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { origin: 'https://evil.example' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: 'Untrusted origin' },
      });
    });

    it('a missing Origin passes the guard through (fail-open, idempotent 200 even with no cookie)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(200);
    });
  });
});
