import { AutoModelForSequenceClassification, AutoTokenizer } from '@xenova/transformers';
import type { RetrievedChunk } from './retrieval.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

// ─── Model (lazy singleton) ──────────────────────────────────────────────────

interface CrossEncoder {
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
}

let crossEncoderPromise: Promise<CrossEncoder> | null = null;

function loadCrossEncoder(): Promise<CrossEncoder> {
  if (crossEncoderPromise === null) {
    crossEncoderPromise = (async () => {
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL_ID),
        AutoModelForSequenceClassification.from_pretrained(MODEL_ID),
      ]);
      return { tokenizer, model };
    })();
  }
  return crossEncoderPromise;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function scorePair(
  crossEncoder: CrossEncoder,
  query: string,
  passage: string,
): Promise<number> {
  const inputs = crossEncoder.tokenizer(query, { text_pair: passage, truncation: true });
  const output = await crossEncoder.model(inputs);
  return output.logits.data[0] as number;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Re-scores `chunks` against `query` with a local cross-encoder
 * (ms-marco-MiniLM, via @xenova/transformers) and returns the top `topN` by
 * cross-encoder relevance, replacing chunk.score with the rerank score.
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

  const crossEncoder = await loadCrossEncoder();

  const scored = await Promise.all(
    chunks.map(async (chunk) => ({
      chunk,
      rerankScore: await scorePair(crossEncoder, query, chunk.content),
    })),
  );

  return scored
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topN)
    .map(({ chunk, rerankScore }) => ({ ...chunk, score: rerankScore }));
}
