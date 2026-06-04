import OpenAI from 'openai';
import { env } from '../config/env.js';

// ─── Client ────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function is429(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    return err.status === 429;
  }
  return false;
}

/**
 * Embed a single batch of texts (length ≤ BATCH_SIZE) with exponential backoff
 * on 429 responses. Non-429 errors are re-thrown immediately.
 */
async function embedBatch(texts: string[]): Promise<number[][]> {
  let attempt = 0;
  while (true) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: texts,
      });

      // Sort by index to guarantee output order matches input order.
      const sorted = response.data.slice().sort((a, b) => a.index - b.index);

      return sorted.map((d) => d.embedding);
    } catch (err) {
      if (is429(err) && attempt < MAX_RETRIES) {
        const delay =
          RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 4000;
        await sleep(delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed an array of texts using OpenAI `text-embedding-3-large`.
 *
 * - Returns [] for empty input.
 * - Splits input into batches of ≤ BATCH_SIZE (2048) and calls serially.
 * - Output indices match input indices (order-preserving).
 * - On 429: retries up to 3 times with delays [1000, 2000, 4000]ms.
 * - On any other error: re-throws immediately.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchVectors = await embedBatch(batch);
    results.push(...batchVectors);
  }

  return results;
}
