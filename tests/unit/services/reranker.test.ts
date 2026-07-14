/**
 * Unit tests for src/services/reranker.ts — rerank
 *
 * @xenova/transformers is mocked — no real ONNX model download/inference.
 *
 * Criteria covered:
 * AC-RR-1: returns [] for empty input without loading the cross-encoder
 * AC-RR-2: reorders candidates by cross-encoder score descending
 * AC-RR-3: replaces chunk.score with the cross-encoder score
 * AC-RR-4: truncates results to topN
 * AC-RR-5: scores every candidate against the raw query (text_pair = chunk content)
 * AC-RR-6: loads the cross-encoder lazily and reuses it across calls (no reload per call)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievedChunk } from '../../../src/services/retrieval.js';

// ---------------------------------------------------------------------------
// Hoisted mocks for @xenova/transformers
// ---------------------------------------------------------------------------

const { mockTokenizerFn, mockModelFn, mockFromPretrainedTokenizer, mockFromPretrainedModel } =
  vi.hoisted(() => {
    const mockTokenizerFn = vi.fn();
    const mockModelFn = vi.fn();
    return {
      mockTokenizerFn,
      mockModelFn,
      mockFromPretrainedTokenizer: vi.fn(),
      mockFromPretrainedModel: vi.fn(),
    };
  });

vi.mock('@xenova/transformers', () => ({
  AutoTokenizer: { from_pretrained: mockFromPretrainedTokenizer },
  AutoModelForSequenceClassification: { from_pretrained: mockFromPretrainedModel },
}));

import { rerank } from '../../../src/services/reranker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: 'chunk-1',
    qdrantId: 'qdrant-1',
    documentId: 'doc-1',
    documentName: 'doc.txt',
    content: 'default content',
    score: 0.5,
    createdAt: new Date(),
    sourceType: 'upload',
    mimeType: 'text/plain',
    sizeBytes: null,
    pageNumber: null,
    startSecs: null,
    endSecs: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFromPretrainedTokenizer.mockResolvedValue(mockTokenizerFn);
  mockFromPretrainedModel.mockResolvedValue(mockModelFn);
  mockTokenizerFn.mockImplementation((query: string, opts: { text_pair: string }) => ({
    query,
    passage: opts.text_pair,
  }));
  mockModelFn.mockResolvedValue({ logits: { data: [0] } });
});

// ---------------------------------------------------------------------------
// AC-RR-1
// ---------------------------------------------------------------------------

describe('AC-RR-1: empty input', () => {
  it('returns [] without loading the cross-encoder', async () => {
    const result = await rerank('query', [], 5);
    expect(result).toEqual([]);
    expect(mockFromPretrainedTokenizer).not.toHaveBeenCalled();
    expect(mockFromPretrainedModel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-RR-2, AC-RR-3: reordering + score replacement
// ---------------------------------------------------------------------------

describe('AC-RR-2/3: reorders by cross-encoder score and replaces chunk.score', () => {
  it('sorts candidates descending by cross-encoder relevance', async () => {
    const irrelevant = makeChunk({ chunkId: 'irrelevant', content: 'irrelevant passage' });
    const relevant = makeChunk({ chunkId: 'relevant', content: 'highly relevant passage' });

    mockModelFn.mockImplementation((inputs: { passage: string }) =>
      Promise.resolve({
        logits: { data: [inputs.passage === 'highly relevant passage' ? 5.2 : -3.1] },
      }),
    );

    const result = await rerank('query', [irrelevant, relevant], 10);

    expect(result.map((c) => c.chunkId)).toEqual(['relevant', 'irrelevant']);
    expect(result[0]?.score).toBe(5.2);
    expect(result[1]?.score).toBe(-3.1);
  });
});

// ---------------------------------------------------------------------------
// AC-RR-4: truncation
// ---------------------------------------------------------------------------

describe('AC-RR-4: truncates to topN', () => {
  it('returns only the top N candidates by rerank score', async () => {
    const chunks = [
      makeChunk({ chunkId: 'a', content: 'a' }),
      makeChunk({ chunkId: 'b', content: 'b' }),
      makeChunk({ chunkId: 'c', content: 'c' }),
    ];

    mockModelFn.mockImplementation((inputs: { passage: string }) =>
      Promise.resolve({ logits: { data: [{ a: 1, b: 3, c: 2 }[inputs.passage]] } }),
    );

    const result = await rerank('query', chunks, 2);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.chunkId)).toEqual(['b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// AC-RR-5: scores against the raw query
// ---------------------------------------------------------------------------

describe('AC-RR-5: scores every candidate against the raw query', () => {
  it('passes the raw query as text and chunk content as text_pair for every candidate', async () => {
    const chunks = [
      makeChunk({ chunkId: 'a', content: 'content A' }),
      makeChunk({ chunkId: 'b', content: 'content B' }),
    ];

    await rerank('the raw user query', chunks, 10);

    expect(mockTokenizerFn).toHaveBeenCalledTimes(2);
    for (const call of mockTokenizerFn.mock.calls) {
      expect(call[0]).toBe('the raw user query');
    }
    const passages = mockTokenizerFn.mock.calls.map(
      (c) => (c[1] as { text_pair: string }).text_pair,
    );
    expect(passages.sort()).toEqual(['content A', 'content B']);
  });
});

// ---------------------------------------------------------------------------
// AC-RR-6: lazy singleton loading
// ---------------------------------------------------------------------------

describe('AC-RR-6: loads the cross-encoder lazily and reuses it', () => {
  it('does not re-invoke from_pretrained on a second rerank() call', async () => {
    await rerank('q1', [makeChunk()], 5);
    const tokenizerCallsAfterFirst = mockFromPretrainedTokenizer.mock.calls.length;
    const modelCallsAfterFirst = mockFromPretrainedModel.mock.calls.length;

    await rerank('q2', [makeChunk()], 5);

    expect(mockFromPretrainedTokenizer.mock.calls.length).toBe(tokenizerCallsAfterFirst);
    expect(mockFromPretrainedModel.mock.calls.length).toBe(modelCallsAfterFirst);
  });
});
