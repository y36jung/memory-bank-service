/**
 * Auth plugin (src/plugins/auth.ts) — plan §9 rows 3 & 4:
 *   - No Authorization header / expired JWT / wrong-secret JWT / malformed
 *     bearer / algorithm-confusion token -> 401 via the standard envelope.
 *   - Valid JWT -> request.user.id matches the token's `sub`.
 *
 * Runs against a real Fastify app (see helpers/buildTestApp.ts) and a real
 * Postgres database (mb_test_slice1, migrated by tests/integration/globalSetup.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument } from './helpers/seed.js';
import { signHS256, signExpiredHS256, signAlgNone, signAlgConfusion } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';

describe('auth plugin — request rejection paths', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const envelopeCases: Array<[string, () => string | undefined]> = [
    ['no Authorization header', () => undefined],
    [
      'expired JWT',
      () =>
        `Bearer ${signExpiredHS256({ sub: '00000000-0000-0000-0000-000000000099' }, env.JWT_SECRET)}`,
    ],
    [
      'wrong-secret JWT',
      () =>
        `Bearer ${signHS256({ sub: '00000000-0000-0000-0000-000000000099' }, 'a-completely-different-secret-that-is-32-chars')}`,
    ],
    ['malformed / non-JWT bearer string', () => 'Bearer not-a-jwt-at-all'],
    [
      'alg: none token',
      () => `Bearer ${signAlgNone({ sub: '00000000-0000-0000-0000-000000000099' })}`,
    ],
    [
      'algorithm-confusion (declared RS256, HMAC-signed) token',
      () =>
        `Bearer ${signAlgConfusion({ sub: '00000000-0000-0000-0000-000000000099' }, env.JWT_SECRET)}`,
    ],
  ];

  it.each(envelopeCases)(
    '%s -> 401 with { data: null, error: { code: UNAUTHORIZED } }',
    async (_label, buildHeader) => {
      const headers: Record<string, string> = {};
      const authHeader = buildHeader();
      if (authHeader) headers.authorization = authHeader;

      const response = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers,
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    },
  );

  it('never leaks the underlying @fastify/jwt library error message', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: 'Bearer not-a-jwt-at-all' },
    });
    const body = response.json();
    expect(body.error.message).toBe('Missing or invalid authentication token');
  });

  it('valid JWT -> request.user.id matches the token sub (proven via a scoped read)', async () => {
    const user = await seedUser('auth-valid-sub');
    const doc = await seedDocument(user.id, { originalName: 'sub-match-proof.txt' });

    const token = signHS256({ sub: user.id }, env.JWT_SECRET);
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error).toBeNull();
    expect(body.data.id).toBe(doc.id);
    expect(body.data.userId).toBe(user.id);
  });

  it('edge case #13: multipart upload route rejects unauthenticated requests before consuming the body (no S3/file read attempted)', async () => {
    // No Authorization header, and no multipart body at all. If jwtVerify()
    // ran after request.file() this would hang or 400 on "no file uploaded"
    // instead of 401 — proving the preHandler resolves auth first.
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: '',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      data: null,
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('valid JWT for a DIFFERENT user does not resolve to the seeded document (sub is not conflated across tokens)', async () => {
    const owner = await seedUser('auth-owner');
    const stranger = await seedUser('auth-stranger');
    const doc = await seedDocument(owner.id);

    const strangerToken = signHS256({ sub: stranger.id }, env.JWT_SECRET);
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });

    expect(response.statusCode).toBe(404);
  });
});
