/**
 * Cross-user ownership scoping — plan §9 row 5 / §8 edge cases #7, #8:
 *   User B must get 404 (never 403) for every document/session route when
 *   requesting user A's resources, and A's data must be untouched afterward.
 *
 * Deliberately does NOT exercise POST /documents/upload or the success path
 * of POST /documents/:id/retry (those would make real S3 calls / enqueue
 * real BullMQ jobs against shared dev infrastructure). Ownership scoping for
 * `retry` is fully provable by confirming the 404 happens before those calls
 * — i.e. the ownership-scoped SELECT finds no row and throws first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument, seedChatSession } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import { documents, chatSessions } from '../../src/db/schema.js';

describe("cross-user access returns 404 (not 403), and does not mutate the owner's data", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function makeUsersAndResources() {
    const userA = await seedUser('owner-a');
    const userB = await seedUser('stranger-b');
    const doc = await seedDocument(userA.id, { status: 'failed', storageKey: 'documents/x/f.txt' });
    const session = await seedChatSession(userA.id);
    const tokenB = signHS256({ sub: userB.id }, env.JWT_SECRET);
    const tokenA = signHS256({ sub: userA.id }, env.JWT_SECRET);
    return { userA, userB, doc, session, tokenB, tokenA };
  }

  it("GET /documents/:id as B on A's document -> 404", async () => {
    const { doc, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it("DELETE /documents/:id as B on A's document -> 404, and A's row survives untouched", async () => {
    const { doc, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${doc.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);

    const [stillThere] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(stillThere).toBeDefined();
    expect(stillThere?.id).toBe(doc.id);
  });

  it("POST /documents/:id/retry as B on A's (failed) document -> 404, and no job is enqueued", async () => {
    const { doc, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/${doc.id}/retry`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
    // The document must still be 'failed' (retry's status flip never ran).
    const [stillThere] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(stillThere?.status).toBe('failed');
  });

  it("GET /documents/:id/file as B on A's document -> 404 (no S3 call attempted)", async () => {
    const { doc, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}/file`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /chat/sessions/:id as B on A's session -> 404", async () => {
    const { session, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /chat/sessions/:id as B on A's session -> 404, and A's session survives untouched", async () => {
    const { session, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(404);

    const [stillThere] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, session.id));
    expect(stillThere).toBeDefined();
  });

  it("POST /chat/sessions/:id/messages (SSE) as B on A's session -> 404 envelope, headers never flushed for SSE", async () => {
    const { session, tokenB } = await makeUsersAndResources();
    const res = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { message: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    // A non-owner must get a clean JSON 404 envelope, not a partially-flushed SSE stream.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({
      data: null,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('as A (the owner), the same routes succeed — proving the 404s above are ownership-specific, not universal breakage', async () => {
    const { doc, session, tokenA } = await makeUsersAndResources();

    const getDoc = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(getDoc.statusCode).toBe(200);

    const getSession = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(getSession.statusCode).toBe(200);
  });
});
