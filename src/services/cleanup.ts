import { and, eq, lt, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chatSessions, users } from '../db/schema.js';
import { purgeExpiredRefreshTokens } from '../db/refreshTokens.js';

const DEMO_CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Deletes chat_sessions owned by the shared demo account (users.is_demo =
 * true) whose updatedAt is older than the retention window. messages
 * cascade-delete automatically via the existing ON DELETE CASCADE FK
 * (src/db/schema.ts) — no separate messages query needed. Not a privacy
 * mechanism (src/lib/chatOwnership.ts's device scoping already handles
 * that) — purely storage hygiene so demo chat history doesn't grow forever.
 */
export async function purgeStaleDemoChatSessions(): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - DEMO_CHAT_RETENTION_MS);
  const demoUserIds = db.select({ id: users.id }).from(users).where(eq(users.isDemo, true));
  const deleted = await db
    .delete(chatSessions)
    .where(and(inArray(chatSessions.userId, demoUserIds), lt(chatSessions.updatedAt, cutoff)))
    .returning({ id: chatSessions.id });
  return { deletedCount: deleted.length };
}

/**
 * Hourly supervisor mirroring src/services/ingestion.ts's startSupervisor()
 * pattern: an eager first tick plus a recurring interval, each step
 * try/caught independently so one failure doesn't kill the timer or block
 * the other cleanup task.
 */
export function startCleanupSupervisor(): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      await purgeStaleDemoChatSessions();
    } catch (e) {
      console.error('[cleanup-supervisor] demo chat purge tick error', e);
    }
    try {
      await purgeExpiredRefreshTokens();
    } catch (e) {
      console.error('[cleanup-supervisor] refresh token purge tick error', e);
    }
  };

  setImmediate(() => {
    void tick();
  });
  return setInterval(() => {
    void tick();
  }, CLEANUP_TICK_INTERVAL_MS);
}
