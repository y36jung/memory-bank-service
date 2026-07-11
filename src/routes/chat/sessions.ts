import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { and, eq, desc, ilike } from 'drizzle-orm';
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
        .values({ userId: request.user.id, title: request.body.title ?? 'New Chat' })
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
      const whereClause = search
        ? and(eq(chatSessions.userId, request.user.id), ilike(chatSessions.title, `%${search}%`))
        : eq(chatSessions.userId, request.user.id);
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
        .where(
          and(eq(chatSessions.id, request.params.id), eq(chatSessions.userId, request.user.id)),
        )
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

  // PATCH /chat/sessions/:id — rename a session (update its title)
  app.patch(
    '/chat/sessions/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ title: z.string().min(1).max(200) }),
      },
    },
    async (request, reply) => {
      const [session] = await db
        .update(chatSessions)
        .set({ title: request.body.title, updatedAt: new Date() })
        .where(
          and(eq(chatSessions.id, request.params.id), eq(chatSessions.userId, request.user.id)),
        )
        .returning();
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);

      sendSuccess(reply, session);
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
        .where(
          and(eq(chatSessions.id, request.params.id), eq(chatSessions.userId, request.user.id)),
        )
        .limit(1);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);

      await db.delete(chatSessions).where(eq(chatSessions.id, request.params.id));
      sendSuccess(reply, { deleted: true });
    },
  );
};
