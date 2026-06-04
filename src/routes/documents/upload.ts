import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { documents, ingestionJobs } from '../../db/schema.js';
import { uploadStream } from '../../services/storage.js';
import { ingestionQueue } from '../../queue/index.js';
import { sendSuccess, AppError } from '../../lib/errors.js';
import { randomUUID } from 'node:crypto';

export const documentUploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/documents/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) throw new AppError('NO_FILE', 'No file uploaded', 400);

    const documentId = randomUUID();
    const storageKey = `documents/${documentId}/${data.filename}`;

    // Stream directly to S3 — never buffer the full file in memory
    await uploadStream(storageKey, data.file, data.mimetype);

    // Single Postgres transaction: INSERT document + INSERT ingestion_job
    const bullJobId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(documents).values({
        id: documentId,
        filename: data.filename,
        originalName: data.filename,
        sourceType: 'upload',
        mimeType: data.mimetype,
        storageKey,
        status: 'pending',
        sizeBytes: Number(request.headers['content-length'] ?? 0) || null,
      });
      await tx.insert(ingestionJobs).values({
        documentId,
        bullJobId,
        status: 'queued',
        attempt: 1,
      });
    });

    // BullMQ enqueue outside transaction; ingestion_jobs row is the durable receipt
    await ingestionQueue.add(
      'ingest',
      { documentId, storageKey, attempt: 1 },
      { jobId: bullJobId },
    );

    sendSuccess(reply, { documentId, status: 'pending' }, 201);
  });
};
