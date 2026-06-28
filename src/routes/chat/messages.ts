import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { streamChatResponse } from '../../services/chat.js';

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
      // @fastify/cors sets Access-Control-Allow-Origin in onSend, which fires after
      // the route handler — too late for SSE since we flush headers here directly.
      // Mirror the CORS header manually so the browser can read the stream.
      const requestOrigin = request.headers.origin;
      if (requestOrigin) {
        reply.raw.setHeader('Access-Control-Allow-Origin', requestOrigin);
        reply.raw.setHeader('Vary', 'Origin');
      }
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      await streamChatResponse(request.params.id, request.body.message, reply);
    },
  );
};
