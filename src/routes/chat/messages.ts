import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { chatSessions } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { streamChatResponse } from '../../services/chat.js';
import { isAllowedOrigin } from '../../config/cors.js';

export const chatMessageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/chat/sessions/:id/messages',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ message: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const [session] = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(
          and(eq(chatSessions.id, request.params.id), eq(chatSessions.userId, request.user.id)),
        )
        .limit(1);
      if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);

      // @fastify/cors sets Access-Control-Allow-Origin in onSend, which fires after
      // the route handler — too late for SSE since we flush headers here directly.
      // Mirror the CORS header manually, but ONLY for origins in the shared
      // allow-list (src/config/cors.ts) — never reflect an arbitrary Origin.
      const requestOrigin = request.headers.origin;
      if (isAllowedOrigin(requestOrigin)) {
        reply.raw.setHeader('Access-Control-Allow-Origin', requestOrigin);
        reply.raw.setHeader('Vary', 'Origin');
      }
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      await streamChatResponse(request.user.id, request.params.id, request.body.message, reply);
    },
  );
};
