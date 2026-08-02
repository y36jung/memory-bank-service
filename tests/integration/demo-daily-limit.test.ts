/**
 * Global daily spend cap on the shared demo account (src/lib/demoLimit.ts,
 * wired into POST /api/chat/sessions/:id/messages). Bounds total OpenAI cost
 * across ALL concurrent demo visitors combined — a separate concern from
 * src/server.ts's per-device rate limit (demo-rate-limit.test.ts).
 *
 * The Redis counter is pre-seeded directly rather than sent via 200 real
 * chat messages. The 429-boundary HTTP test never reaches OpenAI (the check
 * runs before any retrieval/completion call), so it's cheap and mock-free.
 * A genuine "allowed" HTTP round-trip and a "non-demo user's happy path
 * never touches the counter" HTTP round-trip are deliberately NOT exercised
 * here: retrieval alone makes a real OpenAI call (src/services/retrieval.ts
 * embeds the query and, on the classify path, calls chat.completions), the
 * same reason ownership.test.ts/demo-permissions.test.ts avoid the SSE
 * route's success path. That boundary logic is instead covered directly
 * against assertDemoDailyLimitNotExceeded() below (real Redis, no HTTP).
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts), real Postgres,
 * and real Redis — no OpenAI calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedChatSession } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';
import { redisConnection } from '../../src/queue/index.js';
import { assertDemoDailyLimitNotExceeded } from '../../src/lib/demoLimit.js';
import { DEMO_DEVICE_HEADER_NAME } from '../../src/plugins/auth.js';

function todayKey(): string {
  const day = new Date().toISOString().slice(0, 10);
  return `demo:msg-count:${day}`;
}

describe('global daily message cap on the shared demo account', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    await redisConnection.del(todayKey());
  });

  afterAll(async () => {
    await redisConnection.del(todayKey());
    await app.close();
    await pool.end();
  });

  describe('HTTP route', () => {
    it('a demo message send is rejected with 429 DEMO_LIMIT_EXCEEDED once the daily cap is already hit, without reaching OpenAI', async () => {
      await redisConnection.set(todayKey(), String(env.DEMO_DAILY_MESSAGE_LIMIT));

      const user = await seedUser('demo-daily-limit', undefined, true);
      const token = signHS256({ sub: user.id, isDemo: true }, env.JWT_SECRET);
      const deviceId = 'test-device-daily-limit';
      const session = await seedChatSession(user.id, { deviceId });

      const res = await app.inject({
        method: 'POST',
        url: `/api/chat/sessions/${session.id}/messages`,
        headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: deviceId },
        payload: { message: 'hello' },
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'DEMO_LIMIT_EXCEEDED', message: expect.any(String) },
      });
    });

    it('ownership is checked before the daily cap, so a demo request against a nonexistent session gets 404, not 429, even with the cap exhausted', async () => {
      await redisConnection.set(todayKey(), String(env.DEMO_DAILY_MESSAGE_LIMIT));

      const user = await seedUser('demo-daily-limit-404', undefined, true);
      const token = signHS256({ sub: user.id, isDemo: true }, env.JWT_SECRET);
      const bogusSessionId = '00000000-0000-4000-8000-000000000000';

      const res = await app.inject({
        method: 'POST',
        url: `/api/chat/sessions/${bogusSessionId}/messages`,
        headers: {
          authorization: `Bearer ${token}`,
          [DEMO_DEVICE_HEADER_NAME]: 'irrelevant-device',
        },
        payload: { message: 'hello' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('assertDemoDailyLimitNotExceeded() boundary logic', () => {
    it('allows exactly up to the limit and throws on the next call over it', async () => {
      await redisConnection.set(todayKey(), String(env.DEMO_DAILY_MESSAGE_LIMIT - 2));

      await expect(assertDemoDailyLimitNotExceeded()).resolves.toBeUndefined(); // -> LIMIT - 1
      await expect(assertDemoDailyLimitNotExceeded()).resolves.toBeUndefined(); // -> LIMIT
      await expect(assertDemoDailyLimitNotExceeded()).rejects.toMatchObject({
        code: 'DEMO_LIMIT_EXCEEDED',
        statusCode: 429,
      }); // -> LIMIT + 1
    });

    it('sets an expiry on the counter key on its first increment of the day', async () => {
      await assertDemoDailyLimitNotExceeded();
      const ttl = await redisConnection.ttl(todayKey());
      expect(ttl).toBeGreaterThan(0);
    });
  });
});
