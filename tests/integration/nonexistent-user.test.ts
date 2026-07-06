/**
 * Plan §8 edge case #6: a valid signature whose `sub` is a well-formed UUID
 * not present in `users`. No user-existence check happens at auth time
 * (design decision, plan §3) — reads scoped to that userId return
 * empty/404, and inserts violate the FK constraint, surfacing as a 500
 * INTERNAL_ERROR through fastifyErrorHandler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';

describe('edge case #6 — token sub is a well-formed UUID absent from users', () => {
  let app: FastifyInstance;
  const ghostUserId = randomUUID();
  const ghostToken = signHS256({ sub: ghostUserId }, env.JWT_SECRET);

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('GET /documents (list, scoped read) returns an empty list, not an error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: `Bearer ${ghostToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it('GET /documents/:id (scoped single read) returns 404, not 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${randomUUID()}`,
      headers: { authorization: `Bearer ${ghostToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /chat/sessions (insert with nonexistent userId) -> 500 INTERNAL_ERROR via the FK constraint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${ghostToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
