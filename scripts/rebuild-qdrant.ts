/**
 * rebuild-qdrant.ts
 *
 * Standalone script: re-embeds all chunks.content rows from Postgres and
 * upserts them into the Qdrant `memory_bank` collection using deterministic IDs.
 *
 * Usage: tsx scripts/rebuild-qdrant.ts
 *
 * Idempotent: upsert overwrites existing points with the same deterministic ID.
 * Data source: Postgres `chunks` table only. No S3 access required.
 */

import 'dotenv/config';

import { db, pool } from '../src/db/index.js';
import { chunks } from '../src/db/schema.js';
import { generateQdrantId } from '../src/lib/idgen.js';
import { batchEmbed } from '../src/services/embeddings.js';
import { ensureCollection, upsertPoints } from '../src/services/qdrant.js';
import type { QdrantPoint } from '../src/services/qdrant.js';
import { asc, sql } from 'drizzle-orm';

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  console.log('[rebuild-qdrant] Starting Qdrant rebuild from Postgres...');

  // Step 1: Ensure the collection exists before upserting.
  await ensureCollection();
  console.log('[rebuild-qdrant] Collection ensured.');

  // Step 2: Count total chunks for progress reporting.
  const countResult = await db.select({ count: sql<number>`cast(count(*) as int)` }).from(chunks);
  const totalChunks = countResult[0]?.count ?? 0;
  console.log(`[rebuild-qdrant] Total chunks to process: ${totalChunks}`);

  if (totalChunks === 0) {
    console.log('[rebuild-qdrant] No chunks found. Nothing to do.');
    return;
  }

  // Step 3: Process in batches of BATCH_SIZE.
  let offset = 0;
  let processedCount = 0;

  while (offset < totalChunks) {
    // Fetch a batch from Postgres ordered deterministically.
    const batch = await db
      .select({
        id: chunks.id,
        documentId: chunks.documentId,
        chunkIndex: chunks.chunkIndex,
        content: chunks.content,
      })
      .from(chunks)
      .orderBy(asc(chunks.documentId), asc(chunks.chunkIndex))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) {
      break;
    }

    // Step 4a: Embed the batch content.
    const texts = batch.map((c) => c.content);
    const vectors = await batchEmbed(texts);

    // Step 4b: Build QdrantPoint[] using deterministic IDs.
    const points: QdrantPoint[] = batch.map((c, i) => {
      const vector = vectors[i];
      if (vector === undefined) {
        throw new Error(
          `[rebuild-qdrant] Missing vector for chunk index ${i} in batch starting at offset ${offset}`,
        );
      }
      const qdrantId = generateQdrantId(c.documentId, c.chunkIndex);
      return { id: qdrantId, vector };
    });

    // Step 4c: Upsert into Qdrant.
    await upsertPoints(points);

    processedCount += batch.length;
    offset += batch.length;

    // Step 4d: Log progress.
    console.log(
      `[rebuild-qdrant] Processed ${processedCount}/${totalChunks} chunks (${Math.round((processedCount / totalChunks) * 100)}%)`,
    );
  }

  console.log(
    `[rebuild-qdrant] Done. ${processedCount} chunks upserted into Qdrant collection 'memory_bank'.`,
  );
}

// Step 5: Ensure pool is closed on completion or error.
main()
  .catch((err) => {
    console.error('[rebuild-qdrant] Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end().catch((err) => {
      console.error('[rebuild-qdrant] Error closing pool:', err);
    });
  });
