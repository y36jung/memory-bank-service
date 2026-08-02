/**
 * Cleanup supervisor's pure functions (src/services/cleanup.ts,
 * src/db/refreshTokens.ts's purgeExpiredRefreshTokens) — storage-hygiene
 * fixes #4/#5 for the shared demo account: stale demo chat history and dead
 * refresh-token rows shouldn't accumulate forever.
 *
 * Only the exported functions are tested directly, against real Postgres —
 * no timers involved. Matches the existing precedent that
 * src/services/ingestion.ts's startSupervisor() (the pattern this mirrors)
 * has no dedicated test for its setInterval/setImmediate wiring either.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedChatSession, seedRefreshToken } from './helpers/seed.js';
import { purgeStaleDemoChatSessions } from '../../src/services/cleanup.js';
import { purgeExpiredRefreshTokens } from '../../src/db/refreshTokens.js';
import { db, pool } from '../../src/db/index.js';
import { chatSessions, messages, refreshTokens } from '../../src/db/schema.js';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe('cleanup supervisor pure functions', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // buildTestApp() gives a migrated DB via globalSetup; no HTTP calls are
    // made in this file, but reusing the same app/db lifecycle keeps this
    // file consistent with every other integration test in this suite.
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('purgeStaleDemoChatSessions', () => {
    it('deletes a demo session older than the 7-day retention window, cascading its messages', async () => {
      const demoUser = await seedUser('cleanup-demo-old', undefined, true);
      const stale = await seedChatSession(demoUser.id, {
        deviceId: 'device-a',
        updatedAt: daysAgo(8),
      });
      await db.insert(messages).values({ sessionId: stale.id, role: 'user', content: 'hi' });

      const result = await purgeStaleDemoChatSessions();
      expect(result.deletedCount).toBeGreaterThanOrEqual(1);

      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, stale.id));
      expect(row).toBeUndefined();
      const remainingMsgs = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, stale.id));
      expect(remainingMsgs).toHaveLength(0);
    });

    it('leaves a demo session within the retention window untouched', async () => {
      const demoUser = await seedUser('cleanup-demo-fresh', undefined, true);
      const fresh = await seedChatSession(demoUser.id, {
        deviceId: 'device-b',
        updatedAt: daysAgo(1),
      });

      await purgeStaleDemoChatSessions();

      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, fresh.id));
      expect(row).toBeDefined();
    });

    it('leaves an old NON-demo session untouched — retention is demo-only', async () => {
      const regularUser = await seedUser('cleanup-regular-old');
      const oldRegular = await seedChatSession(regularUser.id, { updatedAt: daysAgo(30) });

      await purgeStaleDemoChatSessions();

      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, oldRegular.id));
      expect(row).toBeDefined();
    });
  });

  describe('purgeExpiredRefreshTokens', () => {
    it('deletes expired-but-unused and used-but-unexpired tokens, keeps a live token', async () => {
      const user = await seedUser('cleanup-tokens');
      const { row: expiredUnused } = await seedRefreshToken(user.id, {
        expiresAt: daysAgo(1),
        isUsed: false,
      });
      const { row: usedUnexpired } = await seedRefreshToken(user.id, {
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isUsed: true,
      });
      const { row: live } = await seedRefreshToken(user.id, {
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isUsed: false,
      });

      const result = await purgeExpiredRefreshTokens();
      expect(result.deletedCount).toBeGreaterThanOrEqual(2);

      const remainingIds = (await db.select({ id: refreshTokens.id }).from(refreshTokens)).map(
        (r) => r.id,
      );
      expect(remainingIds).not.toContain(expiredUnused.id);
      expect(remainingIds).not.toContain(usedUnexpired.id);
      expect(remainingIds).toContain(live.id);
    });
  });
});
