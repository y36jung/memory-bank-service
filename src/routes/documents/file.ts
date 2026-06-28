import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents } from '../../db/schema.js';
import { getStreamWithLength } from '../../services/storage.js';
import { AppError } from '../../lib/errors.js';

export const documentFileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/documents/:id/file',
    {
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.params.id))
        .limit(1);

      if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);
      if (!doc.storageKey)
        throw new AppError('NOT_READY', 'Document has not been ingested yet', 409);

      const { stream, contentLength } = await getStreamWithLength(doc.storageKey);

      reply.header('Content-Type', doc.mimeType);
      reply.header('Content-Disposition', `inline; filename="${doc.originalName}"`);
      if (contentLength != null) reply.header('Content-Length', contentLength);
      return reply.send(stream);
    },
  );
};
