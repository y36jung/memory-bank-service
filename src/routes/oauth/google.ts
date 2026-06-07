import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { db } from '../../db/index.js';
import { documents, chunks } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { oauthSyncQueue } from '../../queue/index.js';
import { sendSuccess, AppError } from '../../lib/errors.js';
import { deletePoints } from '../../services/qdrant.js';
import { deleteObject } from '../../services/storage.js';
import {
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  getDecryptedTokens,
  revokeGoogleTokens,
  deleteGoogleTokens,
} from '../../services/oauth/google.js';

export const googleOAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /oauth/google/init — redirect to consent screen
  app.get('/oauth/google/init', async (_request, reply) => {
    const url = getGoogleAuthUrl();
    return reply.redirect(url);
  });

  // GET /oauth/google/callback?code=...&error=...
  app.get(
    '/oauth/google/callback',
    {
      schema: {
        querystring: z.object({
          code: z.string().optional(),
          error: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      if (request.query.error) {
        throw new AppError('OAUTH_DENIED', `Google OAuth denied: ${request.query.error}`, 400);
      }
      if (!request.query.code) {
        throw new AppError('OAUTH_DENIED', 'Missing authorization code', 400);
      }
      await exchangeCodeForTokens(request.query.code);
      sendSuccess(reply, { connected: true });
    },
  );

  // POST /oauth/google/sync
  app.post(
    '/oauth/google/sync',
    {
      schema: {
        body: z.object({ gmailQuery: z.string().optional() }),
      },
    },
    async (request, reply) => {
      // Verify tokens exist before enqueuing
      await getDecryptedTokens(); // throws AppError NOT_CONNECTED (401) if not set
      const job = await oauthSyncQueue.add('google-sync', {
        provider: 'google',
        gmailQuery: request.body.gmailQuery ?? '',
      });
      sendSuccess(reply, { jobId: job.id, status: 'queued' }, 202);
    },
  );

  // GET /oauth/google/status
  app.get('/oauth/google/status', async (_request, reply) => {
    try {
      const tokenRow = await getDecryptedTokens();
      const expired = tokenRow.expiresAt != null && tokenRow.expiresAt < new Date();
      sendSuccess(reply, {
        connected: true,
        expiresAt: tokenRow.expiresAt,
        lastSyncedAt: tokenRow.lastSyncedAt,
        expired,
      });
    } catch {
      sendSuccess(reply, { connected: false });
    }
  });

  // DELETE /oauth/google/revoke?deleteDocuments=true|false
  app.delete(
    '/oauth/google/revoke',
    {
      schema: {
        querystring: z.object({
          deleteDocuments: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (request, reply) => {
      let tokenRow: Awaited<ReturnType<typeof getDecryptedTokens>>;
      try {
        tokenRow = await getDecryptedTokens();
      } catch {
        throw new AppError('NOT_CONNECTED', 'Google account is not connected', 404);
      }

      // Best-effort revoke at Google (token may already be expired)
      await revokeGoogleTokens(tokenRow.accessToken);

      try {
        if (request.query.deleteDocuments === 'true') {
          // Delete all Gmail + Drive documents in order: Qdrant → Postgres → S3
          const sourcedDocs = await db
            .select({ id: documents.id, storageKey: documents.storageKey })
            .from(documents)
            .where(sql`${documents.sourceType} IN ('gmail', 'gdrive')`);

          for (const doc of sourcedDocs) {
            // 1. Qdrant first
            const chunkRows = await db
              .select({ qdrantId: chunks.qdrantId })
              .from(chunks)
              .where(eq(chunks.documentId, doc.id));
            if (chunkRows.length > 0) {
              await deletePoints(chunkRows.map((c) => c.qdrantId));
            }
            // 2. Postgres (cascade deletes chunks)
            await db.delete(documents).where(eq(documents.id, doc.id));
            // 3. S3 (best-effort)
            if (doc.storageKey) {
              await deleteObject(doc.storageKey).catch(() => {});
            }
          }
        }
      } finally {
        await deleteGoogleTokens();
      }

      sendSuccess(reply, { revoked: true });
    },
  );
};
