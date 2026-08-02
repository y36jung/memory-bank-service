/**
 * Demo-account permission restrictions (src/lib/permissions.ts assertNotDemo).
 *
 * The demo account (users.is_demo = true) is a single shared login used by
 * anonymous beta visitors. It may fully drive chat (create/rename/delete
 * sessions) and read documents (list/detail/file download), but must not
 * mutate the documents domain (upload/delete/retry) or delete the shared
 * account itself.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts), real Postgres,
 * and real S3 (for the file-download read-path) — no mocks, per PLAN.md §M1.
 * Sending a chat message itself is deliberately NOT covered here: that route
 * makes a real OpenAI call and is untouched by this change (no assertNotDemo
 * call was added to it), matching how chat-history-grounding.test.ts already
 * avoids the real streaming round-trip for unrelated reasons.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';
import { buildDocumentStorageKey, putObject, deleteObject } from '../../src/services/storage.js';
import { DEMO_DEVICE_HEADER_NAME } from '../../src/plugins/auth.js';

describe('demo-account permission restrictions', () => {
  let app: FastifyInstance;
  const s3KeysToCleanUp: string[] = [];

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    for (const key of s3KeysToCleanUp) {
      await deleteObject(key).catch(() => undefined);
    }
    await app.close();
    await pool.end();
  });

  async function demoToken() {
    const user = await seedUser('demo-perms', undefined, true);
    return { user, token: signHS256({ sub: user.id, isDemo: true }, env.JWT_SECRET) };
  }

  describe('blocked: document mutations + account deletion', () => {
    it('POST /documents/upload -> 403 FORBIDDEN', async () => {
      const { token } = await demoToken();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/upload',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'multipart/form-data; boundary=x',
        },
        payload: '',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    });

    it('DELETE /documents/:id -> 403 FORBIDDEN', async () => {
      const { user, token } = await demoToken();
      const doc = await seedDocument(user.id);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${doc.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('POST /documents/:id/retry -> 403 FORBIDDEN', async () => {
      const { user, token } = await demoToken();
      const doc = await seedDocument(user.id, { status: 'failed' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${doc.id}/retry`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('DELETE /auth/me -> 403 FORBIDDEN (cannot delete the shared demo account)', async () => {
      const { token } = await demoToken();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });
  });

  describe('allowed: read-only document access', () => {
    it('GET /documents -> 200', async () => {
      const { user, token } = await demoToken();
      await seedDocument(user.id);
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.items.length).toBeGreaterThan(0);
    });

    it('GET /documents/:id -> 200', async () => {
      const { user, token } = await demoToken();
      const doc = await seedDocument(user.id);
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${doc.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe(doc.id);
    });

    it('GET /documents/:id/file -> 200 (can download a pre-seeded document)', async () => {
      const { user, token } = await demoToken();
      const storageKey = buildDocumentStorageKey(user.id, randomUUID(), 'demo-seed.txt');
      await putObject(storageKey, 'seeded demo content', 'text/plain');
      s3KeysToCleanUp.push(storageKey);
      const doc = await seedDocument(user.id, { storageKey });

      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${doc.id}/file`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('seeded demo content');
    });
  });

  describe('allowed: full chat session access', () => {
    it('create, rename, and delete a chat session', async () => {
      const { token } = await demoToken();

      // The shared demo account scopes chat-session ownership by a
      // per-browser demo_device_id header (src/plugins/auth.ts,
      // src/lib/chatOwnership.ts) in addition to userId, so every call in
      // this "same browser" flow must carry the same minted header value —
      // see demo-device-scoping.test.ts for the cross-device behavior.
      const created = await app.inject({
        method: 'POST',
        url: '/api/chat/sessions',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      const sessionId: string = created.json().data.id;
      const deviceId = created.headers[DEMO_DEVICE_HEADER_NAME];
      if (typeof deviceId !== 'string' || !deviceId) {
        throw new Error('expected an x-demo-device-id response header on session create');
      }

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/chat/sessions/${sessionId}`,
        headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: deviceId },
        payload: { title: 'Renamed by demo' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().data.title).toBe('Renamed by demo');

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/chat/sessions/${sessionId}`,
        headers: { authorization: `Bearer ${token}`, [DEMO_DEVICE_HEADER_NAME]: deviceId },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ data: { deleted: true }, error: null });
    });
  });
});
