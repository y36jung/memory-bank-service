import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { and, eq } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { db } from '../../db/index.js';
import { documents } from '../../db/schema.js';
import { getStreamWithLength, getObjectBuffer } from '../../services/storage.js';
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
        .where(and(eq(documents.id, request.params.id), eq(documents.userId, request.user.id)))
        .limit(1);

      if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);
      if (!doc.storageKey)
        throw new AppError('NOT_READY', 'Document has not been ingested yet', 409);

      // HTML can carry <script>; sanitize before serving inline since this app
      // has no CSP/helmet to contain a stored-XSS from an uploaded file.
      if (doc.mimeType === 'text/html') {
        const buf = await getObjectBuffer(doc.storageKey);
        if (!buf) throw new AppError('S3_NOT_FOUND', 'Object not found', 404);
        const sanitized = sanitizeHtml(buf.toString('utf-8'));

        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Content-Disposition', `inline; filename="${doc.originalName}"`);
        reply.header('Content-Security-Policy', "script-src 'none'");
        return reply.send(sanitized);
      }

      const { stream, contentLength } = await getStreamWithLength(doc.storageKey);

      reply.header('Content-Type', doc.mimeType);
      reply.header('Content-Disposition', `inline; filename="${doc.originalName}"`);
      if (contentLength != null) reply.header('Content-Length', contentLength);
      return reply.send(stream);
    },
  );
};
