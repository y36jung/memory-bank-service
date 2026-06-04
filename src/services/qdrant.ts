import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../config/env.js';

// ─── Client ────────────────────────────────────────────────────────────────────

const client = new QdrantClient({
  url: env.QDRANT_URL,
  ...(env.QDRANT_API_KEY !== undefined && { apiKey: env.QDRANT_API_KEY }),
});

// ─── Constants ─────────────────────────────────────────────────────────────────

const COLLECTION = 'memory_bank';
const VECTOR_SIZE = 3072;
const UPSERT_BATCH_SIZE = 100;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface QdrantPoint {
  id: string; // qdrantId — the point's identity in Qdrant
  vector: number[]; // 3072-float embedding
}

export interface SearchResult {
  id: string;
  score: number;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensure the `memory_bank` collection exists with the correct configuration.
 * Creates it if absent; no-ops (does not throw) if it already exists.
 */
export async function ensureCollection(): Promise<void> {
  try {
    await client.getCollection(COLLECTION);
    // Collection already exists — nothing to do.
  } catch (err) {
    // Qdrant returns a 404-style error when the collection does not exist.
    // Attempt to create it; if it already exists (race condition), ignore.
    try {
      await client.createCollection(COLLECTION, {
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine',
        },
      });
    } catch (createErr) {
      // If creation fails because another process beat us to it, that's fine.
      // Re-throw any other unexpected error.
      if ((createErr as { status?: number })?.status !== 409) {
        throw createErr;
      }
    }

    // Suppress the original "not found" error — collection is now guaranteed to exist.
    void err;
  }
}

/**
 * Upsert points into the `memory_bank` collection in batches of 100.
 */
export async function upsertPoints(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) {
    return;
  }

  for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
    const batch = points.slice(i, i + UPSERT_BATCH_SIZE);

    await client.upsert(COLLECTION, {
      wait: true,
      points: batch.map((p) => ({ id: p.id, vector: p.vector })),
    });
  }
}

/**
 * Search the `memory_bank` collection for the nearest neighbors.
 *
 * Returns `[{ id, score }]` sorted by score descending.
 * Payload and vector are not returned (`with_payload: false`).
 */
export async function searchPoints(
  vector: number[],
  topK: number,
  scoreThreshold: number,
): Promise<SearchResult[]> {
  const response = await client.search(COLLECTION, {
    vector,
    limit: topK,
    score_threshold: scoreThreshold,
    with_payload: false,
    with_vector: false,
  });

  return response
    .map((hit) => ({ id: String(hit.id), score: hit.score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Delete points from the `memory_bank` collection by their IDs.
 *
 * No-op when `qdrantIds` is empty (avoids a needless API call).
 */
export async function deletePoints(qdrantIds: string[]): Promise<void> {
  if (qdrantIds.length === 0) {
    return;
  }

  await client.delete(COLLECTION, {
    wait: true,
    points: qdrantIds,
  });
}
