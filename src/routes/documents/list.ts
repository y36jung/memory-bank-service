import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { and, eq, ilike, count, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, chunks, ingestionJobs } from '../../db/schema.js';
import { deleteObject } from '../../services/storage.js';
import { deletePoints } from '../../services/qdrant.js';
import { ingestionQueue } from '../../queue/index.js';
import { sendSuccess, AppError } from '../../lib/errors.js';
import { randomUUID } from 'node:crypto';

export const documentListRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /documents — list all documents with optional search filter and pagination
  app.get(
    '/documents',
    {
      schema: {
        querystring: z.object({
          search: z.string().optional(),
          status: z.preprocess(
            (val) => (val === undefined ? undefined : Array.isArray(val) ? val : [val]),
            z.array(z.enum(['pending', 'processing', 'indexed', 'failed'])).optional(),
          ),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
    },
    async (request, reply) => {
      const { search, status, page, limit } = request.query;

      const conditions: SQL[] = [];
      if (search) conditions.push(ilike(documents.originalName, `%${search}%`));
      if (status && status.length > 0) conditions.push(inArray(documents.status, status));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, countRows] = await Promise.all([
        db
          .select()
          .from(documents)
          .where(whereClause)
          .orderBy(documents.createdAt)
          .limit(limit)
          .offset((page - 1) * limit),
        db.select({ total: count() }).from(documents).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      sendSuccess(reply, {
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    },
  );

  // GET /documents/:id — single document + full job history
  app.get(
    '/documents/:id',
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

      const jobs = await db
        .select()
        .from(ingestionJobs)
        .where(eq(ingestionJobs.documentId, request.params.id))
        .orderBy(ingestionJobs.createdAt);

      sendSuccess(reply, { ...doc, jobs });
    },
  );

  // DELETE /documents/:id — Qdrant → Postgres cascade → S3
  app.delete(
    '/documents/:id',
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

      // Delete Qdrant points before Postgres cascade (invariant from PLAN.md §ACID)
      const chunkRows = await db
        .select({ qdrantId: chunks.qdrantId })
        .from(chunks)
        .where(eq(chunks.documentId, request.params.id));
      if (chunkRows.length > 0) {
        await deletePoints(chunkRows.map((c) => c.qdrantId));
      }

      // Postgres cascade delete (removes chunks and ingestion_jobs via FK cascade)
      await db.delete(documents).where(eq(documents.id, request.params.id));

      // S3 cleanup — failure is non-fatal (key may already be gone)
      if (doc.storageKey) {
        await deleteObject(doc.storageKey).catch((err: unknown) => {
          app.log.warn(
            { err, storageKey: doc.storageKey },
            'S3 deleteObject failed during document delete',
          );
        });
      }

      sendSuccess(reply, { deleted: true });
    },
  );

  // POST /documents/:id/retry — re-queue a failed document
  app.post(
    '/documents/:id/retry',
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
      if (doc.status !== 'failed') {
        throw new AppError('INVALID_STATUS', 'Document is not in failed state', 409);
      }
      if (!doc.storageKey) {
        throw new AppError('NO_STORAGE_KEY', 'Document has no S3 file to re-process', 400);
      }

      const bullJobId = randomUUID();
      await db.insert(ingestionJobs).values({
        documentId: request.params.id,
        bullJobId,
        status: 'queued',
        attempt: 1,
      });
      await ingestionQueue.add(
        'ingest',
        { documentId: request.params.id, storageKey: doc.storageKey, attempt: 1 },
        { jobId: bullJobId },
      );

      sendSuccess(reply, { jobId: bullJobId });
    },
  );
};
