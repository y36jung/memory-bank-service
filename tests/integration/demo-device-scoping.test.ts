/**
 * Cross-DEVICE scoping on the shared demo account (src/plugins/auth.ts,
 * src/lib/chatOwnership.ts). Every demo visitor shares one userId, so
 * ownership.test.ts's cross-USER coverage doesn't protect them from each
 * other. This file proves the per-browser demo_device_id header keeps
 * concurrent demo visitors' chat sessions isolated the same way real users
 * are isolated from each other.
 *
 * The frontend generates demo_device_id client-side and the backend is a
 * pure consumer (see src/plugins/auth.ts) — these tests mint their own ids
 * with randomUUID() to stand in for that.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) and real
 * Postgres — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedChatSession } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';
import { DEMO_DEVICE_HEADER_NAME } from '../../src/plugins/auth.js';

describe('demo-account cross-device chat scoping', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function demoToken() {
    const user = await seedUser('demo-device', undefined, true);
    return { user, token: signHS256({ sub: user.id, isDemo: true }, env.JWT_SECRET) };
  }

  it('a demo request with no device header sees no sessions (fails closed, not unscoped)', async () => {
    const { user, token } = await demoToken();
    await seedChatSession(user.id, { deviceId: randomUUID() });

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it('a non-demo user is unaffected by the device header mechanism entirely', async () => {
    const user = await seedUser('regular-device');
    const token = signHS256({ sub: user.id, isDemo: false }, env.JWT_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers[DEMO_DEVICE_HEADER_NAME]).toBeUndefined();
  });

  it("two concurrent demo visitors (same account, different devices) cannot see, rename, or delete each other's sessions", async () => {
    const { token } = await demoToken();
    const visitor1 = randomUUID();
    const visitor2 = randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor1 },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const sessionId: string = created.json().data.id;

    // Visitor 2 can't read, rename, or delete visitor 1's session.
    const get2 = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor2 },
    });
    expect(get2.statusCode).toBe(404);

    const patch2 = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor2 },
      payload: { title: 'hijacked' },
    });
    expect(patch2.statusCode).toBe(404);

    const delete2 = await app.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor2 },
    });
    expect(delete2.statusCode).toBe(404);

    // It's absent from visitor 2's list.
    const list2 = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor2 },
    });
    const list2Ids: string[] = list2.json().data.map((s: { id: string }) => s.id);
    expect(list2Ids).not.toContain(sessionId);

    // Visitor 1 (the owner) can still read, rename, and delete it untouched.
    const get1 = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor1 },
    });
    expect(get1.statusCode).toBe(200);
    expect(get1.json().data.title).not.toBe('hijacked');

    const rename1 = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor1 },
      payload: { title: 'renamed by owner' },
    });
    expect(rename1.statusCode).toBe(200);

    const delete1 = await app.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor1 },
    });
    expect(delete1.statusCode).toBe(200);
  });

  it('a pre-migration row with deviceId = null is invisible to every demo device', async () => {
    const { user, token } = await demoToken();
    const orphan = await seedChatSession(user.id, { deviceId: null });
    const visitor = randomUUID();

    const get = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${orphan.id}`,
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor },
    });
    expect(get.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: visitor },
    });
    const listIds: string[] = list.json().data.map((s: { id: string }) => s.id);
    expect(listIds).not.toContain(orphan.id);
  });
});
