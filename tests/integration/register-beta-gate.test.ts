/**
 * Beta registration gate — POST /api/auth/register must reject public
 * self-registration once NODE_ENV=beta, and only accept it with the correct
 * x-registration-secret header (the operator-only Bruno flow). Outside beta
 * (dev/test), register stays exactly as open as before — proven implicitly
 * by every existing register call in auth-flow.test.ts / auth.test.ts, which
 * all run under NODE_ENV=test with no header.
 *
 * `env.ts` parses NODE_ENV/REGISTRATION_SECRET once at module load, so
 * exercising the beta branch requires vi.resetModules() + an overridden
 * process.env + a dynamic re-import of the whole app graph — same technique
 * tests/unit/config/cors.test.ts uses for its development/beta branches.
 * Each test builds (and tears down) its own isolated app + DB pool.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_REGISTRATION_SECRET = process.env['REGISTRATION_SECRET'];
const REGISTRATION_SECRET = 'correct-beta-secret-for-tests';

async function buildBetaApp(): Promise<FastifyInstance> {
  vi.resetModules();
  process.env['NODE_ENV'] = 'beta';
  process.env['REGISTRATION_SECRET'] = REGISTRATION_SECRET;
  const { buildTestApp } = await import('./helpers/buildTestApp.js');
  return buildTestApp();
}

async function closeBetaApp(app: FastifyInstance): Promise<void> {
  await app.close();
  const { pool } = await import('../../src/db/index.js');
  await pool.end();
}

describe('POST /api/auth/register — beta registration gate', () => {
  afterEach(() => {
    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
    if (ORIGINAL_REGISTRATION_SECRET === undefined) {
      delete process.env['REGISTRATION_SECRET'];
    } else {
      process.env['REGISTRATION_SECRET'] = ORIGINAL_REGISTRATION_SECRET;
    }
    vi.resetModules();
  });

  it('beta env, no x-registration-secret header -> 403 FORBIDDEN', async () => {
    const app = await buildBetaApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: `beta-gate-${randomUUID()}@test.local`, password: 'password123' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    } finally {
      await closeBetaApp(app);
    }
  });

  it('beta env, wrong x-registration-secret header -> 403 FORBIDDEN', async () => {
    const app = await buildBetaApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-registration-secret': 'not-the-right-secret' },
        payload: { email: `beta-gate-${randomUUID()}@test.local`, password: 'password123' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    } finally {
      await closeBetaApp(app);
    }
  });

  it('beta env, correct x-registration-secret header -> 201 (account created)', async () => {
    const app = await buildBetaApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-registration-secret': REGISTRATION_SECRET },
        payload: { email: `beta-gate-${randomUUID()}@test.local`, password: 'password123' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.error).toBeNull();
      expect(typeof body.data.accessToken).toBe('string');
    } finally {
      await closeBetaApp(app);
    }
  });

  it('beta env, correct secret + isDemo: true -> the created account is flagged as demo', async () => {
    const app = await buildBetaApp();
    try {
      const email = `beta-gate-demo-${randomUUID()}@test.local`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-registration-secret': REGISTRATION_SECRET },
        payload: { email, password: 'password123', isDemo: true },
      });
      expect(res.statusCode).toBe(201);

      const { db } = await import('../../src/db/index.js');
      const { users } = await import('../../src/db/schema.js');
      const { eq } = await import('drizzle-orm');
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      expect(row?.isDemo).toBe(true);
    } finally {
      await closeBetaApp(app);
    }
  });
});
