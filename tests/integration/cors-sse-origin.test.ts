/**
 * SSE CORS origin guard — sse-cors-origin-check plan §5.6 / §8 #11.
 *
 * Executable proof that the REAL route (src/routes/chat/messages.ts), wired
 * through the real harness (buildTestApp), actually calls `isAllowedOrigin`
 * on the request `Origin` and does NOT reflect an untrusted origin. Closes
 * the VERIFY-flagged gap: AC1/AC4 were previously proven only by the
 * isolated `isAllowedOrigin` unit test (tests/unit/config/cors.test.ts) plus
 * diff-inspection — nothing exercised the wired route
 * (ownership.test.ts's only POST-to-this-route case 404s before the CORS
 * code runs).
 *
 * The only mock in the integration suite: `streamChatResponse` (the
 * external-LLM tail) is stubbed so this test makes zero real OpenAI/Qdrant
 * calls. The route already sets + flushes the CORS/SSE headers BEFORE
 * calling streamChatResponse, so stubbing the tail still exercises the
 * entire real header path — real isAllowedOrigin, real route handler, real
 * buildTestApp CORS registration. Vitest isolates the module registry per
 * test file, so this mock affects ONLY this file and does not weaken the
 * no-mocks guarantee of any other integration test (plan §8 #11). Do not
 * "restore" a real streamChatResponse call here — that would make this test
 * paid, slow, non-deterministic, and infra-coupled (see plan §8 #11
 * Rejected Alternative).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/services/chat.js', () => ({
  streamChatResponse: vi.fn(async (_userId, _sessionId, _message, reply) => {
    // The route already set + flushed the CORS/SSE headers before calling this.
    reply.raw.write('data: {"type":"done"}\n\n');
    reply.raw.end();
  }),
}));

import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedChatSession } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';

describe('SSE CORS origin guard — POST /chat/sessions/:id/messages (sse-cors-origin-check)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('AC1/AC4: an untrusted Origin reaches the real route guard and gets NO access-control-allow-origin header', async () => {
    const user = await seedUser('cors-owner');
    const session = await seedChatSession(user.id);
    const token = signHS256({ sub: user.id }, env.JWT_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
      payload: { message: 'hello' },
    });

    // Proves the request passed the ownership 404 and reached the SSE
    // header block — i.e. the CORS-guard code path actually executed, not a
    // short-circuit.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    // Load-bearing assertion: a present, untrusted Origin is exactly the
    // input the OLD buggy `if (requestOrigin)` reflected verbatim (it would
    // have set access-control-allow-origin: https://evil.example); the
    // fixed `if (isAllowedOrigin(requestOrigin))` sets nothing. This
    // assertion fails under the pre-fix code and passes under the fix.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('AC4 (missing-Origin branch): a request with no Origin header also gets NO access-control-allow-origin header', async () => {
    const user = await seedUser('cors-owner-noorigin');
    const session = await seedChatSession(user.id);
    const token = signHS256({ sub: user.id }, env.JWT_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { message: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
