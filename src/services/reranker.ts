import type { RetrievedChunk } from './retrieval.js';
import { timed } from '../lib/timing.js';
import { env } from '../config/env.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
const COHERE_MODEL = 'rerank-v3.5';
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  results: CohereRerankResult[];
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the Cohere Rerank API with exponential backoff on 429 responses.
 * Non-429 error statuses throw immediately.
 */
async function rerankRequest(
  query: string,
  documents: string[],
  topN: number,
): Promise<CohereRerankResponse> {
  let attempt = 0;
  while (true) {
    const response = await fetch(COHERE_RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.COHERE_API_KEY}`,
      },
      body: JSON.stringify({ model: COHERE_MODEL, query, documents, top_n: topN }),
    });

    if (response.ok) {
      return (await response.json()) as CohereRerankResponse;
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 4000;
      await sleep(delay);
      attempt++;
      continue;
    }

    throw new Error(`Cohere rerank request failed: ${response.status} ${await response.text()}`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Re-scores `chunks` against `query` with the Cohere Rerank API (rerank-v3.5)
 * and returns the top `topN` by relevance, replacing chunk.score with the
 * rerank relevance score.
 *
 * Scores against the raw query, not the HyDE hypothetical-answer text — HyDE
 * is an embedding-stage trick; a cross-encoder compares real query vs. real
 * passage.
 */
export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return [];

  const { results } = await timed(`rerank: score ${chunks.length} candidates`, () =>
    rerankRequest(
      query,
      chunks.map((c) => c.content),
      Math.min(topN, chunks.length),
    ),
  );

  return results
    .map(({ index, relevance_score }): RetrievedChunk | undefined => {
      const chunk = chunks[index];
      return chunk === undefined ? undefined : { ...chunk, score: relevance_score };
    })
    .filter((c): c is RetrievedChunk => c !== undefined);
}
