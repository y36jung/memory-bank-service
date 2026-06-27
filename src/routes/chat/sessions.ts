import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { eq, desc, ilike } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { chatSessions, messages } from '../../db/schema.js';
import { sendSuccess, AppError } from '../../lib/errors.js';

export const chatSessionRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /chat/sessions — create a new session
  app.post(
    '/chat/sessions',
    {
      schema: { body: z.object({ title: z.string().optional() }) },
    },
    async (request, reply) => {
      const [session] = await db
        .insert(chatSessions)
        .values({ title: request.body.title ?? 'New Chat' })
        .returning();
      sendSuccess(reply, session, 201);
    },
  );

  // GET /chat/sessions — list all sessions, most recent first, with optional search filter
  app.get(
    '/chat/sessions',
    {
      schema: {
        querystring: z.object({
          search: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { search } = request.query;
      const whereClause = search ? ilike(chatSessions.title, `%${search}%`) : undefined;
      const sessions = await db
        .select()
        .from(chatSessions)
        .where(whereClause)
        .orderBy(desc(chatSessions.updatedAt));
      sendSuccess(reply, sessions);
    },
  );

  // GET /chat/sessions/:id — session detail with messages
  app.get(
    '/chat/sessions/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, request.params.id))
        .limit(1);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);

      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, request.params.id))
        .orderBy(messages.createdAt);

      sendSuccess(reply, { ...session, messages: msgs });
    },
  );

  // DELETE /chat/sessions/:id — delete session (messages cascade)
  app.delete(
    '/chat/sessions/:id',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, request.params.id))
        .limit(1);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);

      await db.delete(chatSessions).where(eq(chatSessions.id, request.params.id));
      sendSuccess(reply, { deleted: true });
    },
  );
};
