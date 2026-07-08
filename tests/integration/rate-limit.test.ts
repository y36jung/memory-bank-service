/**
 * Per-IP rate limiting on POST /api/auth/{login,register} — slice-3 plan
 * §5.11 / §9 row 4 (part of criterion 4): max 10 requests / 1 minute per IP,
 * 11th request -> 429 with the standard `{ data, error }` envelope
 * (`RATE_LIMITED`).
 *
 * Deliberately its OWN file with its OWN buildTestApp() instance (own
 * in-memory rate-limit counter — plan §8 edge case #12) so the 429 assertion
 * can never poison auth-flow.test.ts or any other suite. login and register
 * each get an independent per-route counter (a fresh child LocalStore is
 * created per route by @fastify/rate-limit's `onRoute` hook, keyed only by
 * req.ip), so exhausting one route's budget in this file has no effect on
 * the other route's budget used by auth-flow.test.ts.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) and real Postgres
 * (mb_test_slice1) — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { pool } from '../../src/db/index.js';

describe('per-IP rate limiting on /api/auth/login and /api/auth/register', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('login: the 11th attempt within the window from the same IP -> 429 { data: null, error: { code: RATE_LIMITED } }', async () => {
    const payload = { email: 'rate-limit-login-probe@test.local', password: 'irrelevant8' };

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).not.toBe(429);
    }

    const eleventh = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json()).toEqual({
      data: null,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
  }, 30_000);

  it('register: the 11th attempt within the window from the same IP -> 429 { data: null, error: { code: RATE_LIMITED } }', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: `rate-limit-register-probe-${i}@test.local`, password: 'password123' },
      });
      expect(res.statusCode).not.toBe(429);
    }

    const eleventh = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'rate-limit-register-probe-10@test.local', password: 'password123' },
    });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json()).toEqual({
      data: null,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
  }, 30_000);
});
