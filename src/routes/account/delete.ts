import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { deletePointsByUserId } from '../../services/qdrant.js';
import { deleteObjectsByPrefix } from '../../services/storage.js';
import { REFRESH_COOKIE_NAME } from '../../lib/refreshToken.js';
import { sendSuccess, AppError } from '../../lib/errors.js';

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  // DELETE /auth/me — delete the caller's account: Qdrant → Postgres cascade → S3.
  app.delete('/auth/me', async (request, reply) => {
    const userId = request.user.id;

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('NOT_FOUND', 'Account not found', 404);

    // 1. Qdrant first — unguarded. A failure aborts here (500) before Postgres
    //    is touched. If Qdrant succeeds but Postgres later fails, surviving
    //    chunks rows let scripts/rebuild-qdrant.ts regenerate the vectors
    //    (PLAN.md: "Qdrant is fully rebuildable from Postgres", L253).
    await deletePointsByUserId(userId);

    // 2. Postgres cascade — one DELETE removes the user and every child row via
    //    ON DELETE CASCADE (documents→chunks/ingestion_jobs,
    //    chat_sessions→messages, refresh_tokens). No manual child deletes.
    await db.delete(users).where(eq(users.id, userId));

    // 3. S3 best-effort — never fail the request (mirrors documents/list.ts).
    await deleteObjectsByPrefix(`users/${userId}/`).catch((err: unknown) => {
      app.log.warn({ err, userId }, 'S3 deleteObjectsByPrefix failed during account delete');
    });

    // Cascade already removed ALL refresh_tokens for this user (every family) —
    // stronger than logout's single-family revoke — so only the cookie is cleared.
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    sendSuccess(reply, { deleted: true });
  });
};
