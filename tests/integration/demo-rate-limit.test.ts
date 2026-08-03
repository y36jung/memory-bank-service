/**
 * Per-DEVICE rate limiting for the shared demo account (src/server.ts's
 * protected-scope limiter, keyGenerator branching on req.user.isDemo).
 * Every demo visitor shares one userId, so keying by userId alone (the
 * pre-fix behavior) would let one busy demo visitor 429 every other
 * concurrent visitor. This proves the bucket is now keyed per demoDeviceId.
 *
 * Deliberately its OWN file with its OWN buildTestApp() instance (own
 * in-memory rate-limit counter, same isolation convention as
 * rate-limit.test.ts) so its 429s can't poison any other suite sharing the
 * 1-minute window.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) and real
 * Postgres — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';
import { DEMO_DEVICE_HEADER_NAME } from '../../src/plugins/auth.js';

const PROTECTED_LIMIT = 100; // matches src/server.ts's rateLimit max

describe('per-device rate limiting for the shared demo account', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function demoToken() {
    const user = await seedUser('demo-rate-limit', undefined, true);
    return { user, token: signHS256({ sub: user.id, isDemo: true }, env.JWT_SECRET) };
  }

  it("exhausting one demo device's bucket does not 429 a second concurrent demo device on the same account", async () => {
    const { token } = await demoToken();
    const device1 = randomUUID();
    const device2 = randomUUID(); // independent key from device1

    // Drive device1 to exactly its limit (100 calls -> 100 total).
    for (let i = 0; i < PROTECTED_LIMIT; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/chat/sessions',
        headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: device1 },
      });
      expect(res.statusCode).not.toBe(429);
    }

    // device1's 101st request in the window -> 429.
    const overLimit = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: device1 },
    });
    expect(overLimit.statusCode).toBe(429);
    expect(overLimit.json()).toEqual({
      data: null,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });

    // device2's bucket is untouched by device1's exhaustion.
    const device2Call = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: device2 },
    });
    expect(device2Call.statusCode).not.toBe(429);
  }, 30_000);

  it('a non-demo user is keyed by userId (unchanged) and unaffected by demo-device buckets', async () => {
    const user = await seedUser('regular-rate-limit');
    const token = signHS256({ sub: user.id, isDemo: false }, env.JWT_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).not.toBe(429);
    expect(res.headers[DEMO_DEVICE_HEADER_NAME]).toBeUndefined();
  });
});
