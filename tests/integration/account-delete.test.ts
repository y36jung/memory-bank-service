/**
 * account-delete slice — `DELETE /api/auth/me` (plan
 * `.claude/plans/account-delete.md` §9 criterion -> test table).
 *
 * Runs against REAL Postgres (mb_test_slice1), REAL Qdrant (the local
 * docker-compose `qdrant` service), and REAL S3 (the bucket configured in
 * .env) — no mocks, per PLAN.md §M1 Deliverables. Every object/point this
 * suite creates is either consumed by the route under test (deleted as part
 * of the assertion) or explicitly cleaned up in `afterAll`.
 *
 * Criterion -> test map (plan §9):
 *   1 -> "criterion 1: ..." (two tests: missing header, malformed token)
 *   2 -> "criterion 2: ..."
 *   3 -> "criteria 3, 5, 6: ..." (all three stores deleted for the caller)
 *   4 -> "criterion 4: ordering ..." (forces a real Qdrant outage)
 *   5 -> "criteria 3, 5, 6: ..." (cookie clear + response envelope)
 *   6 -> "criteria 3, 5, 6: ..." (user B fully survives)
 *   7 -> "criterion 7: ..." (static source check) + the fact that every test
 *        above only passes if the route is reachable through buildTestApp's
 *        mirrored protectedScope registration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { QdrantClient } from '@qdrant/js-client-rest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument, seedChatSession, seedRefreshToken } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import {
  users,
  documents,
  chunks,
  ingestionJobs,
  chatSessions,
  refreshTokens,
} from '../../src/db/schema.js';
import { generateQdrantId } from '../../src/lib/idgen.js';
import { ensureCollection, upsertPoints, deletePoints } from '../../src/services/qdrant.js';
import {
  putObject,
  getObjectBuffer,
  deleteObject,
  buildDocumentStorageKey,
} from '../../src/services/storage.js';

const rawClient = new QdrantClient({ url: env.QDRANT_URL });
const COLLECTION = 'memory_bank';

/** Poll the real Qdrant instance until it accepts connections again. */
async function waitForQdrantReady(timeoutMs = 20_000, intervalMs = 500): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await rawClient.getCollections();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `waitForQdrantReady: Qdrant did not become reachable again within ${timeoutMs}ms: ${String(err)}`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** True if `docker compose` can see the qdrant service in this environment. */
function dockerComposeAvailable(): boolean {
  try {
    execSync('docker compose ps -q qdrant', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('account-delete — DELETE /api/auth/me', () => {
  let app: FastifyInstance;
  const pointIdsToCleanUp: string[] = [];
  const s3KeysToCleanUp: string[] = [];

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureCollection();
  });

  afterAll(async () => {
    await deletePoints(pointIdsToCleanUp).catch(() => undefined);
    for (const key of s3KeysToCleanUp) {
      await deleteObject(key).catch(() => undefined);
    }
    await app.close();
    await pool.end();
  });

  // ── Criterion 1 ──────────────────────────────────────────────────────────
  it('criterion 1: DELETE /api/auth/me with no Authorization header -> 401 UNAUTHORIZED', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      data: null,
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('criterion 1: DELETE /api/auth/me with a malformed/invalid token -> 401 UNAUTHORIZED', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  // ── Criterion 2 ──────────────────────────────────────────────────────────
  it('criterion 2: valid JWT signature but no corresponding users row (stale token) -> 404 NOT_FOUND', async () => {
    const staleId = randomUUID(); // well-formed but never inserted into `users`
    const token = signHS256({ sub: staleId }, env.JWT_SECRET);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      data: null,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  // ── Criteria 3, 5, 6 ─────────────────────────────────────────────────────
  it(
    "criteria 3, 5, 6: deletes ALL of user A's data (Qdrant + Postgres cascade + S3), " +
      'clears the refresh cookie, returns { deleted: true }, and leaves user B fully intact',
    async () => {
      const userA = await seedUser('account-delete-a');
      const userB = await seedUser('account-delete-b');

      const storageKeyA = buildDocumentStorageKey(userA.id, randomUUID(), 'a.txt');
      const storageKeyB = buildDocumentStorageKey(userB.id, randomUUID(), 'b.txt');

      const docA = await seedDocument(userA.id, { storageKey: storageKeyA });
      const docB = await seedDocument(userB.id, { storageKey: storageKeyB });

      // Real S3 objects under each user's users/<userId>/ prefix.
      await putObject(storageKeyA, 'A content', 'text/plain');
      await putObject(storageKeyB, 'B content', 'text/plain');
      s3KeysToCleanUp.push(storageKeyA, storageKeyB);

      // Confirm both objects really landed before the delete (sanity check).
      expect((await getObjectBuffer(storageKeyA))?.toString('utf8')).toBe('A content');
      expect((await getObjectBuffer(storageKeyB))?.toString('utf8')).toBe('B content');

      const qdrantIdA = generateQdrantId(docA.id, 0);
      const qdrantIdB = generateQdrantId(docB.id, 0);
      pointIdsToCleanUp.push(qdrantIdA, qdrantIdB);

      await db.insert(chunks).values([
        {
          documentId: docA.id,
          qdrantId: qdrantIdA,
          chunkIndex: 0,
          content: 'A chunk',
          tokenCount: 2,
        },
        {
          documentId: docB.id,
          qdrantId: qdrantIdB,
          chunkIndex: 0,
          content: 'B chunk',
          tokenCount: 2,
        },
      ]);

      await db.insert(ingestionJobs).values([
        { documentId: docA.id, bullJobId: `account-delete-a-${randomUUID()}`, status: 'done' },
        { documentId: docB.id, bullJobId: `account-delete-b-${randomUUID()}`, status: 'done' },
      ]);

      await upsertPoints([
        { id: qdrantIdA, vector: new Array(3072).fill(0.11), userId: userA.id },
        { id: qdrantIdB, vector: new Array(3072).fill(0.22), userId: userB.id },
      ]);

      const sessionA = await seedChatSession(userA.id);
      const sessionB = await seedChatSession(userB.id);

      const { raw: refreshRawA } = await seedRefreshToken(userA.id);
      await seedRefreshToken(userB.id); // untouched control row

      const tokenA = signHS256({ sub: userA.id }, env.JWT_SECRET);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${tokenA}` },
        cookies: { refresh_token: refreshRawA },
      });

      // ── Criterion 5: success envelope + cookie clear ──
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { deleted: true }, error: null });

      const clearedCookie = res.cookies.find((c) => c.name === 'refresh_token');
      expect(clearedCookie).toBeDefined();
      expect(clearedCookie?.path).toBe('/api/auth');
      expect(clearedCookie?.value).toBe('');
      // clearCookie sets expires to the epoch / maxAge 0 — either signal proves deletion.
      const expiresPast = clearedCookie?.expires
        ? clearedCookie.expires.getTime() <= Date.now()
        : false;
      const maxAgeZero = Number(clearedCookie?.maxAge) <= 0;
      expect(expiresPast || maxAgeZero).toBe(true);

      // ── Criterion 3: user A's data is gone from all three stores ──
      const [userARow] = await db.select().from(users).where(eq(users.id, userA.id));
      expect(userARow).toBeUndefined();

      const [docARow] = await db.select().from(documents).where(eq(documents.id, docA.id));
      expect(docARow).toBeUndefined();

      const [chunkARow] = await db.select().from(chunks).where(eq(chunks.qdrantId, qdrantIdA));
      expect(chunkARow).toBeUndefined();

      const jobRowsA = await db
        .select()
        .from(ingestionJobs)
        .where(eq(ingestionJobs.documentId, docA.id));
      expect(jobRowsA.length).toBe(0);

      const [sessionARow] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionA.id));
      expect(sessionARow).toBeUndefined();

      const refreshRowsA = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userA.id));
      expect(refreshRowsA.length).toBe(0);

      const fetchedA = await rawClient.retrieve(COLLECTION, {
        ids: [qdrantIdA],
        with_payload: true,
      });
      expect(fetchedA.length).toBe(0);

      const bufA = await getObjectBuffer(storageKeyA);
      expect(bufA).toBeNull();

      // ── Criterion 6: user B's data survives, completely untouched ──
      const [userBRow] = await db.select().from(users).where(eq(users.id, userB.id));
      expect(userBRow).toBeDefined();
      expect(userBRow?.id).toBe(userB.id);

      const [docBRow] = await db.select().from(documents).where(eq(documents.id, docB.id));
      expect(docBRow).toBeDefined();

      const [chunkBRow] = await db.select().from(chunks).where(eq(chunks.qdrantId, qdrantIdB));
      expect(chunkBRow).toBeDefined();

      const jobRowsB = await db
        .select()
        .from(ingestionJobs)
        .where(eq(ingestionJobs.documentId, docB.id));
      expect(jobRowsB.length).toBe(1);

      const [sessionBRow] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionB.id));
      expect(sessionBRow).toBeDefined();

      const refreshRowsB = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userB.id));
      expect(refreshRowsB.length).toBe(1);

      const fetchedB = await rawClient.retrieve(COLLECTION, {
        ids: [qdrantIdB],
        with_payload: true,
      });
      expect(fetchedB.length).toBe(1);
      expect(fetchedB[0]?.payload?.['userId']).toBe(userB.id);

      const bufB = await getObjectBuffer(storageKeyB);
      expect(bufB?.toString('utf8')).toBe('B content');

      // Clean up B's real S3 object ourselves (route under test never touches it).
      await deleteObject(storageKeyB);
      s3KeysToCleanUp.splice(s3KeysToCleanUp.indexOf(storageKeyB), 1);
    },
  );

  // ── Criterion 4 ──────────────────────────────────────────────────────────
  describe('criterion 4: ordering — Qdrant runs before Postgres', () => {
    it(
      'forces a real Qdrant outage (docker compose stop/start); the request must 500 ' +
        "and user C's users row must still exist afterward (Postgres never touched)",
      async () => {
        if (!dockerComposeAvailable()) {
          // eslint-disable-next-line no-console
          console.warn(
            '[account-delete.test.ts] docker compose not available in this environment — ' +
              'criterion 4 (ordering) is BLOCKED, not proven, in this run.',
          );
          return;
        }

        const userC = await seedUser('account-delete-ordering-c');
        const tokenC = signHS256({ sub: userC.id }, env.JWT_SECRET);

        execSync('docker compose stop qdrant', { stdio: 'pipe' });
        try {
          const res = await app.inject({
            method: 'DELETE',
            url: '/api/auth/me',
            headers: { authorization: `Bearer ${tokenC}` },
          });

          expect(res.statusCode).toBe(500);
          expect(res.json().error.code).toBe('INTERNAL_ERROR');

          // Postgres must be untouched: the users row survives because Qdrant
          // (which ran first, unguarded) aborted before `db.delete(users)` ran.
          const [stillThere] = await db.select().from(users).where(eq(users.id, userC.id));
          expect(stillThere).toBeDefined();
          expect(stillThere?.id).toBe(userC.id);
        } finally {
          execSync('docker compose start qdrant', { stdio: 'pipe' });
          await waitForQdrantReady();
        }

        // Manual cleanup — the failed request left userC's row in place by design.
        await db.delete(users).where(eq(users.id, userC.id));
      },
      30_000,
    );
  });

  // ── Criterion 7 (registration wiring; reachability is also proven by every
  //    test above only passing through buildTestApp's mirrored protectedScope) ──
  it("criterion 7: both server.ts and buildTestApp.ts register accountRoutes in protectedScope with { prefix: '/api' }", () => {
    const serverSrc = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const testAppSrc = readFileSync(new URL('./helpers/buildTestApp.ts', import.meta.url), 'utf8');

    for (const src of [serverSrc, testAppSrc]) {
      expect(src).toMatch(/accountRoutes/);
      expect(src).toMatch(
        /protectedScope\.register\(accountRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/,
      );
    }
  });
});
