import { db } from '../db/index.js';
import { chunks, documents } from '../db/schema.js';
import { batchEmbed } from './embeddings.js';
import { searchPoints } from './qdrant.js';
import { eq, inArray } from 'drizzle-orm';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  chunkId: string;
  qdrantId: string;
  documentId: string;
  documentName: string; // documents.original_name
  content: string; // chunks.content — from Postgres, never from Qdrant payload
  score: number;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed `query`, search Qdrant for the nearest neighbours, then fetch the
 * matching chunk rows (including content) from Postgres.
 *
 * Invariant: Qdrant is queried with `with_payload: false`.  All text content
 * comes from Postgres — Qdrant returns only point IDs and scores.
 *
 * @param query          Natural-language query string.
 * @param topK           Maximum number of results to retrieve (default: 10).
 * @param scoreThreshold Minimum cosine-similarity score to include (default: 0.5).
 * @returns Chunks sorted by score descending.
 */
export async function retrieveChunks(
  query: string,
  topK = 10,
  scoreThreshold = 0.4,
): Promise<RetrievedChunk[]> {
  // Step 1: Embed the query.
  const [vector] = await batchEmbed([query]);
  if (vector === undefined) {
    return [];
  }

  // Step 2: Search Qdrant — returns [{id (qdrantId), score}], payload not fetched.
  const results = await searchPoints(vector, topK, scoreThreshold);

  // Step 3: Short-circuit when Qdrant returns no matches.
  if (results.length === 0) {
    return [];
  }

  // Step 4: Fetch chunk text from Postgres.
  // Single query; joins with documents to obtain original_name for source labels.
  const qdrantIds = results.map((r) => r.id);

  const rows = await db
    .select({
      id: chunks.id,
      qdrantId: chunks.qdrantId,
      documentId: chunks.documentId,
      content: chunks.content,
      originalName: documents.originalName,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(inArray(chunks.qdrantId, qdrantIds));

  // Step 5: Build a score-lookup map keyed by qdrantId, then map rows to
  // RetrievedChunk[], discarding any Qdrant hits with no matching Postgres row.
  const scoreByQdrantId = new Map(results.map((r) => [r.id, r.score]));

  const retrieved: RetrievedChunk[] = rows
    .map((row) => {
      const score = scoreByQdrantId.get(row.qdrantId);
      if (score === undefined) {
        return null;
      }
      return {
        chunkId: row.id,
        qdrantId: row.qdrantId,
        documentId: row.documentId,
        documentName: row.originalName,
        content: row.content,
        score,
      } satisfies RetrievedChunk;
    })
    .filter((c): c is RetrievedChunk => c !== null);

  // Step 6: Sort by score descending and return.
  return retrieved.sort((a, b) => b.score - a.score);
}
