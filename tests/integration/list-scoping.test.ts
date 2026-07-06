/**
 * List endpoints only return the caller's own rows — plan §9 row 6, edge case #9.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument, seedChatSession } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';

describe('GET /documents and GET /chat/sessions are scoped to the caller', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("GET /documents as B returns only B's documents (and correct total)", async () => {
    const userA = await seedUser('list-a');
    const userB = await seedUser('list-b');
    await seedDocument(userA.id, { originalName: 'a1.txt' });
    await seedDocument(userA.id, { originalName: 'a2.txt' });
    await seedDocument(userB.id, { originalName: 'b1.txt' });

    const tokenB = signHS256({ sub: userB.id }, env.JWT_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].originalName).toBe('b1.txt');
    expect(body.data.items.every((d: { userId: string }) => d.userId === userB.id)).toBe(true);
  });

  it('GET /documents as a user with zero documents returns an empty list, no error (edge case #9)', async () => {
    const userC = await seedUser('list-c-empty');
    const tokenC = signHS256({ sub: userC.id }, env.JWT_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it("GET /chat/sessions as B returns only B's sessions", async () => {
    const userA = await seedUser('list-sess-a');
    const userB = await seedUser('list-sess-b');
    await seedChatSession(userA.id, { title: 'A session 1' });
    await seedChatSession(userA.id, { title: 'A session 2' });
    await seedChatSession(userB.id, { title: 'B session 1' });

    const tokenB = signHS256({ sub: userB.id }, env.JWT_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe('B session 1');
    expect(body.data.every((s: { userId: string }) => s.userId === userB.id)).toBe(true);
  });

  it('GET /chat/sessions as a user with zero sessions returns [] (edge case #9)', async () => {
    const userD = await seedUser('list-sess-d-empty');
    const tokenD = signHS256({ sub: userD.id }, env.JWT_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${tokenD}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
  });
});
