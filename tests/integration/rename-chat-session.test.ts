/**
 * PATCH /chat/sessions/:id — rename-chat-session slice.
 * Plan: .claude/plans/let-s-add-an-endpoint-sleepy-barto.md §2 (AC-B1..B8),
 * §8 (edge cases), §9 (criterion -> proof table).
 *
 * IMPORTANT — pre-existing, out-of-scope gap (plan §3, §8): Fastify/Zod
 * schema-validation failures are not `AppError` instances, so
 * `fastifyErrorHandler` (src/lib/errors.ts) falls through to its generic
 * `else` branch -> HTTP 500 `INTERNAL_ERROR`, not 400, for this route and
 * every other route in the app. The AC-B2 tests below assert this actual
 * current behavior, per the plan's explicit instruction, not an idealized
 * 400.
 *
 * AC-B8 (no new files / no server.ts change / no migration — single-file
 * diff) is confirmed by `git diff --stat` inspection, not a runtime test;
 * see the handback report for that confirmation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedChatSession } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import { chatSessions } from '../../src/db/schema.js';

describe('PATCH /chat/sessions/:id — rename chat session', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function authedUser(prefix: string) {
    const user = await seedUser(prefix);
    const token = signHS256({ sub: user.id }, env.JWT_SECRET);
    return { user, token };
  }

  // ---- AC-B1 ----
  it('AC-B1: PATCH renames the title, GET detail confirms the new title', async () => {
    const { user, token } = await authedUser('rename-b1');
    const session = await seedChatSession(user.id, { title: 'Original title' });

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Renamed title' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.title).toBe('Renamed title');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().data.title).toBe('Renamed title');
  });

  // ---- AC-B2 ----
  describe('AC-B2: title validated 1-200 chars (actual current behavior: 500, not 400, on failure — pre-existing plan §3/§8 gap)', () => {
    it('empty string title -> 500 INTERNAL_ERROR (fails min(1) before handler runs; no DB mutation)', async () => {
      const { user, token } = await authedUser('rename-b2-empty');
      const session = await seedChatSession(user.id, { title: 'Untouched' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/${session.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: '' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL_ERROR');

      const [unchanged] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, session.id));
      expect(unchanged?.title).toBe('Untouched');
    });

    it('201-char title -> 500 INTERNAL_ERROR (fails max(200) before handler runs; no DB mutation)', async () => {
      const { user, token } = await authedUser('rename-b2-long');
      const session = await seedChatSession(user.id, { title: 'Untouched' });
      const tooLong = 'x'.repeat(201);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/${session.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: tooLong },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL_ERROR');

      const [unchanged] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, session.id));
      expect(unchanged?.title).toBe('Untouched');
    });

    it('1-char and 200-char boundary titles are both accepted (200 OK)', async () => {
      const { user, token } = await authedUser('rename-b2-boundary');
      const session1 = await seedChatSession(user.id, { title: 'Untouched1' });
      const session2 = await seedChatSession(user.id, { title: 'Untouched2' });

      const res1 = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/${session1.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'x' },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().data.title).toBe('x');

      const exactly200 = 'y'.repeat(200);
      const res2 = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/${session2.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: exactly200 },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().data.title).toBe(exactly200);
    });

    it('missing title field entirely -> 500 INTERNAL_ERROR (§8 edge case #9)', async () => {
      const { user, token } = await authedUser('rename-b2-missing');
      const session = await seedChatSession(user.id, { title: 'Untouched' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/${session.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL_ERROR');
    });

    it('malformed :id (not a UUID) -> 500 INTERNAL_ERROR (§8 edge case #3)', async () => {
      const { token } = await authedUser('rename-b2-bad-uuid');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/not-a-uuid`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'whatever' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ---- AC-B3 ----
  it('AC-B3: renaming bumps updatedAt, reordering the session to the top of GET /chat/sessions', async () => {
    const { user, token } = await authedUser('rename-b3');
    const sessionA = await seedChatSession(user.id, { title: 'A (older)' });
    // Ensure a distinguishable updatedAt ordering before the rename.
    await new Promise((r) => setTimeout(r, 20));
    const sessionB = await seedChatSession(user.id, { title: 'B (newer)' });

    // Sanity check: B is currently more recent than A.
    const beforeList = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(beforeList.json().data[0].id).toBe(sessionB.id);

    await new Promise((r) => setTimeout(r, 20));
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${sessionA.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'A (renamed, now newest)' },
    });
    expect(patchRes.statusCode).toBe(200);

    const afterList = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterList.json().data[0].id).toBe(sessionA.id);
    expect(afterList.json().data[0].title).toBe('A (renamed, now newest)');
  });

  // ---- AC-B4 ----
  it('AC-B4: cross-user rename attempt -> 404, target session unchanged', async () => {
    const { user: userA } = await authedUser('rename-b4-owner');
    const { token: tokenB } = await authedUser('rename-b4-stranger');
    const session = await seedChatSession(userA.id, { title: "A's original title" });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { title: 'Hijacked title' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    const [stillThere] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, session.id));
    expect(stillThere?.title).toBe("A's original title");
  });

  // ---- AC-B5 ----
  it('AC-B5: non-existent session id -> 404 NOT_FOUND', async () => {
    const { token } = await authedUser('rename-b5');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Does not matter' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  // ---- AC-B6 (code-inspection proof, encoded as a regression-guarding static check) ----
  it('AC-B6: the PATCH handler performs a single atomic update, no select-then-mutate', () => {
    const src = readFileSync(new URL('../../src/routes/chat/sessions.ts', import.meta.url), 'utf8');
    const start = src.indexOf("'/chat/sessions/:id'");
    const patchStart = src.lastIndexOf('app.patch(', src.indexOf('app.delete('));
    const deleteStart = src.indexOf('app.delete(');
    expect(start).toBeGreaterThan(-1);
    expect(patchStart).toBeGreaterThan(-1);
    expect(deleteStart).toBeGreaterThan(patchStart);
    const handlerBody = src.slice(patchStart, deleteStart);

    const dbCallCount = (handlerBody.match(/await db\b/g) ?? []).length;
    expect(dbCallCount).toBe(1);
    expect(handlerBody).toContain('.update(chatSessions)');
    expect(handlerBody).not.toContain('.select()');
  });

  // ---- AC-B7 ----
  it('AC-B7: success response uses {data, error:null} envelope at HTTP 200 (not 201)', async () => {
    const { user, token } = await authedUser('rename-b7');
    const session = await seedChatSession(user.id, { title: 'Envelope check' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Enveloped' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.data).toMatchObject({
      id: session.id,
      userId: user.id,
      title: 'Enveloped',
    });
    expect(body.data.createdAt).toBeDefined();
    expect(body.data.updatedAt).toBeDefined();
  });

  // ---- §8 edge case #5: whitespace-only title accepted verbatim, no trimming ----
  it('§8 edge case #5: whitespace-only title is accepted as-is (no trimming)', async () => {
    const { user, token } = await authedUser('rename-whitespace');
    const session = await seedChatSession(user.id, { title: 'Original' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: '   ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.title).toBe('   ');

    const [stored] = await db.select().from(chatSessions).where(eq(chatSessions.id, session.id));
    expect(stored?.title).toBe('   ');
  });

  // ---- §8 edge case #8: concurrent delete then rename -> clean 404, no crash ----
  it('§8 edge case #8: renaming a session that was already deleted -> clean 404, not a crash', async () => {
    const { user, token } = await authedUser('rename-deleted');
    const session = await seedChatSession(user.id, { title: 'About to be deleted' });

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(200);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Too late' },
    });
    expect(patchRes.statusCode).toBe(404);
    expect(patchRes.json().error.code).toBe('NOT_FOUND');
  });
});
