import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { eq, and, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, chunks, ingestionJobs } from '../db/schema.js';
import { extractText } from './extractor/index.js';
import type { TranscribedSegment } from './extractor/audio.js';
import { env } from '../config/env.js';
import { chunkText } from './chunker.js';
import type { Chunk } from './chunker.js';
import { countTokens } from '../lib/tokenizer.js';
import { batchEmbed } from './embeddings.js';
import { upsertPoints, deletePoints } from './qdrant.js';
import { generateQdrantId } from '../lib/idgen.js';
import { withTimeout } from '../lib/utils.js';
import { ingestionQueue } from '../queue/index.js';
import type { IngestionJobPayload } from '../queue/index.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface MediaChunk extends Chunk {
  startSecs: number;
  endSecs: number;
}

type IngestChunk = Chunk | MediaChunk;

// ─── Media chunking ────────────────────────────────────────────────────────────

const MEDIA_TARGET_TOKENS = 800;

/**
 * Group consecutive Whisper segments greedily into chunks of up to 800 tokens.
 * No overlap is applied — segment boundaries are already natural speech units.
 */
function chunkSegments(segments: TranscribedSegment[]): MediaChunk[] {
  const result: MediaChunk[] = [];
  let groupTexts: string[] = [];
  let groupTokens = 0;
  let groupStart = 0;
  let groupEnd = 0;
  let chunkIndex = 0;

  const flush = (): void => {
    if (groupTexts.length === 0) return;
    const content = groupTexts.join(' ').trim();
    result.push({
      content,
      tokenCount: countTokens(content),
      chunkIndex: chunkIndex++,
      startSecs: groupStart,
      endSecs: groupEnd,
    });
    groupTexts = [];
    groupTokens = 0;
  };

  for (const seg of segments) {
    const segTokens = countTokens(seg.text);

    if (groupTokens + segTokens > MEDIA_TARGET_TOKENS && groupTexts.length > 0) {
      flush();
      groupStart = seg.start;
    } else if (groupTexts.length === 0) {
      groupStart = seg.start;
    }

    groupTexts.push(seg.text);
    groupTokens += segTokens;
    groupEnd = seg.end;
  }

  flush();
  return result;
}

function isMediaMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
  );
}

export async function processIngestionJob(job: Job<IngestionJobPayload>): Promise<void> {
  const { documentId, storageKey } = job.data;
  if (!job.id) throw new UnrecoverableError('BullMQ job has no id');
  const bullJobId = job.id;

  // Step 1 VERIFY: durable receipt must exist.
  const [jobRow] = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.bullJobId, bullJobId))
    .limit(1);
  if (!jobRow) {
    throw new UnrecoverableError(`ingestion_jobs row missing for bullJobId=${bullJobId}`);
  }

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    throw new UnrecoverableError(`document missing for id=${documentId}`);
  }

  // Step 2 CLEANUP: idempotent; no-op on first attempt.
  // Fetch qdrantIds while they still exist in Postgres, then commit all Postgres
  // writes atomically before touching Qdrant. Orphan Qdrant vectors (if deletePoints
  // fails) are harmless — retrieval joins on chunks.qdrant_id and silently drops misses.
  const existingChunkRows = await db
    .select({ qdrantId: chunks.qdrantId })
    .from(chunks)
    .where(eq(chunks.documentId, documentId));

  await withTimeout(
    db.transaction(async (tx) => {
      await tx.delete(chunks).where(eq(chunks.documentId, documentId));
      await tx
        .update(documents)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await tx
        .update(ingestionJobs)
        .set({ status: 'running', startedAt: new Date(), attempt: job.attemptsMade + 1 })
        .where(eq(ingestionJobs.bullJobId, bullJobId));
    }),
    10_000,
    'cleanup commit',
  );

  if (existingChunkRows.length > 0) {
    await deletePoints(existingChunkRows.map((c) => c.qdrantId));
  }

  // Step 3 EXTRACT — dynamic timeout for media types; progress written to documents.metadata.
  const extractTimeout = isMediaMimeType(doc.mimeType) ? env.MEDIA_EXTRACT_TIMEOUT_MS : 60_000;

  const onProgress = isMediaMimeType(doc.mimeType)
    ? async (stage: string, pct: number): Promise<void> => {
        await db
          .update(documents)
          .set({ metadata: { stage, progress: pct }, updatedAt: new Date() })
          .where(eq(documents.id, documentId));
      }
    : undefined;

  const extraction = await withTimeout(
    onProgress
      ? extractText(storageKey, doc.mimeType, { onProgress })
      : extractText(storageKey, doc.mimeType),
    extractTimeout,
    'extract',
  );

  // Step 4 CHUNK (synchronous — no timeout per PLAN.md).
  // Fork: media path (segments present) vs text path.
  const produced: IngestChunk[] =
    extraction.segments && extraction.segments.length > 0
      ? chunkSegments(extraction.segments)
      : chunkText(extraction.text);

  // Step 5 EMBED (30s timeout per batch).
  const vectors = await withTimeout(batchEmbed(produced.map((c) => c.content)), 30_000, 'embed');
  if (vectors.length !== produced.length) {
    throw new Error(`embedding count mismatch: expected ${produced.length}, got ${vectors.length}`);
  }

  // Step 6 POSTGRES COMMIT — single transaction, 10s timeout.
  await withTimeout(
    db.transaction(async (tx) => {
      await tx.insert(chunks).values(
        produced.map((c) => ({
          documentId,
          qdrantId: generateQdrantId(documentId, c.chunkIndex),
          chunkIndex: c.chunkIndex,
          content: c.content,
          tokenCount: c.tokenCount,
          startSecs: (c as MediaChunk).startSecs ?? null,
          endSecs: (c as MediaChunk).endSecs ?? null,
        })),
      );
      await tx
        .update(documents)
        .set({ status: 'indexed', updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await tx
        .update(ingestionJobs)
        .set({ status: 'done', finishedAt: new Date() })
        .where(eq(ingestionJobs.bullJobId, bullJobId));
    }),
    10_000,
    'postgres commit',
  );

  // Step 7 UPSERT Qdrant (after Postgres commit succeeds) — 15s timeout.
  const points = produced.map((c, i) => {
    const qdrantId = generateQdrantId(documentId, c.chunkIndex);
    const vector = vectors[i];
    if (!vector) throw new Error(`Missing embedding for chunk index ${i}`);
    return { id: qdrantId, vector };
  });
  await withTimeout(upsertPoints(points), 15_000, 'qdrant upsert');
}

export async function handleFailedJob(job: Job<IngestionJobPayload>, err: Error): Promise<void> {
  const { documentId } = job.data;
  if (!job.id) throw new UnrecoverableError('BullMQ job has no id');
  const bullJobId = job.id;
  const message = err.message ?? 'unknown error';

  await withTimeout(
    db.transaction(async (tx) => {
      await tx
        .update(documents)
        .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await tx
        .update(ingestionJobs)
        .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
        .where(eq(ingestionJobs.bullJobId, bullJobId));
    }),
    10_000,
    'failure commit',
  );
}

export function startSupervisor(): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    const stuckAfter = new Date(Date.now() - 20 * 60 * 1000);
    try {
      const stuck = await db
        .select()
        .from(ingestionJobs)
        .where(and(eq(ingestionJobs.status, 'running'), lt(ingestionJobs.startedAt, stuckAfter)));

      for (const row of stuck) {
        const [docRow] = await db
          .select({ storageKey: documents.storageKey })
          .from(documents)
          .where(eq(documents.id, row.documentId))
          .limit(1);
        if (!docRow?.storageKey) continue;

        await ingestionQueue.add(
          'ingest',
          {
            documentId: row.documentId,
            storageKey: docRow.storageKey,
            attempt: row.attempt + 1,
          },
          { jobId: row.bullJobId },
        );
      }
    } catch (e) {
      console.error('[ingestion-supervisor] tick error', e);
    }
  };

  setImmediate(() => {
    void tick();
  });
  return setInterval(
    () => {
      void tick();
    },
    10 * 60 * 1000,
  );
}
