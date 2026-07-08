/**
 * CORS credentials — cors-credentials-addendum plan §9 AC1 proof:
 *   "test-verification asserts a dev cross-origin response for allowed
 *   origin `http://localhost:3001` includes header
 *   `access-control-allow-credentials: true`."
 *
 * NOTE on scope (see handback finding filed against the addendum plan):
 * Vitest sets `process.env.NODE_ENV = 'test'` before `dotenv/config` runs,
 * and dotenv never overrides an already-set var, so `env.NODE_ENV` is
 * `'test'` (not `'development'`) for the entire integration suite, in both
 * src/server.ts and this file's helpers/buildTestApp.ts. That means the
 * `origin: [...] : []` ternary's dev branch (which allow-lists
 * `http://localhost:3001`) is unreachable here, and `Access-Control-Allow-
 * Origin` is never echoed in this suite. This file therefore only asserts
 * the literal AC1 proof text (the `access-control-allow-credentials: true`
 * header on a request carrying `Origin: http://localhost:3001`), which is
 * NODE_ENV-independent for @fastify/cors@11.2.0 (installed) — see below.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { pool } from '../../src/db/index.js';

describe('CORS — credentials on cross-origin responses (cors-credentials-addendum)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('AC1: a cross-origin request from the frontend origin (http://localhost:3001) gets access-control-allow-credentials: true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:3001' },
      payload: { email: 'cors-probe@test.local', password: 'irrelevant8' },
    });

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('AC1 (plan §8 preflight edge case): an OPTIONS preflight from the frontend origin also gets access-control-allow-credentials: true', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('AC2 regression guard: the CORS origin option is untouched — a request with no Origin header gets no access-control-allow-origin header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'cors-probe@test.local', password: 'irrelevant8' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.json()).toEqual({
      data: null,
      error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
    });
  });
});
