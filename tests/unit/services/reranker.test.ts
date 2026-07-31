/**
 * Unit tests for src/services/reranker.ts — rerank
 *
 * global.fetch is mocked — no real Cohere API calls.
 *
 * Criteria covered:
 * AC-RR-1: returns [] for empty input without calling Cohere
 * AC-RR-2: reorders candidates per Cohere's result order
 * AC-RR-3: replaces chunk.score with the Cohere relevance score
 * AC-RR-4: sends top_n = min(topN, chunks.length) to Cohere
 * AC-RR-5: scores every candidate against the raw query (documents = chunk contents)
 * AC-RR-6: retries on 429 with backoff, then throws after MAX_RETRIES
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievedChunk } from '../../../src/services/retrieval.js';

vi.mock('../../../src/config/env.js', () => ({
  env: { COHERE_API_KEY: 'test-cohere-key' },
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

function mockFetchOnce(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

// ---------------------------------------------------------------------------
// AC-RR-1
// ---------------------------------------------------------------------------

describe('AC-RR-1: empty input', () => {
  it('returns [] without calling Cohere', async () => {
    const result = await rerank('query', [], 5);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-RR-2, AC-RR-3: reordering + score replacement
// ---------------------------------------------------------------------------

describe('AC-RR-2/3: reorders per Cohere result order and replaces chunk.score', () => {
  it('maps Cohere results (already sorted) back onto the original chunks', async () => {
    const irrelevant = makeChunk({ chunkId: 'irrelevant', content: 'irrelevant passage' });
    const relevant = makeChunk({ chunkId: 'relevant', content: 'highly relevant passage' });

    mockFetchOnce(200, {
      results: [
        { index: 1, relevance_score: 0.92 },
        { index: 0, relevance_score: 0.03 },
      ],
    });

    const result = await rerank('query', [irrelevant, relevant], 10);

    expect(result.map((c) => c.chunkId)).toEqual(['relevant', 'irrelevant']);
    expect(result[0]?.score).toBe(0.92);
    expect(result[1]?.score).toBe(0.03);
  });
});

// ---------------------------------------------------------------------------
// AC-RR-4: top_n sent to Cohere
// ---------------------------------------------------------------------------

describe('AC-RR-4: sends top_n = min(topN, chunks.length)', () => {
  it('caps top_n at the candidate count when topN exceeds it', async () => {
    const chunks = [makeChunk({ chunkId: 'a' }), makeChunk({ chunkId: 'b' })];
    mockFetchOnce(200, { results: [{ index: 0, relevance_score: 1 }] });

    await rerank('query', chunks, 10);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { top_n: number };
    expect(body.top_n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-RR-5: scores against the raw query
// ---------------------------------------------------------------------------

describe('AC-RR-5: scores every candidate against the raw query', () => {
  it('sends the raw query and every chunk content as documents', async () => {
    const chunks = [
      makeChunk({ chunkId: 'a', content: 'content A' }),
      makeChunk({ chunkId: 'b', content: 'content B' }),
    ];
    mockFetchOnce(200, {
      results: [
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.4 },
      ],
    });

    await rerank('the raw user query', chunks, 10);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      query: string;
      documents: string[];
    };
    expect(body.query).toBe('the raw user query');
    expect(body.documents).toEqual(['content A', 'content B']);
  });
});

// ---------------------------------------------------------------------------
// AC-RR-6: 429 retry with backoff
// ---------------------------------------------------------------------------

describe('AC-RR-6: retries on 429 with backoff', () => {
  it('retries after 429 responses and succeeds once Cohere returns 200', async () => {
    vi.useFakeTimers();
    try {
      mockFetchOnce(429, { message: 'rate limited' });
      mockFetchOnce(200, { results: [{ index: 0, relevance_score: 0.7 }] });

      const promise = rerank('query', [makeChunk()], 5);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result[0]?.score).toBe(0.7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws after exhausting retries on repeated 429s', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) {
        mockFetchOnce(429, { message: 'rate limited' });
      }

      const promise = rerank('query', [makeChunk()], 5);
      const expectation = expect(promise).rejects.toThrow('Cohere rerank request failed: 429');
      await vi.runAllTimersAsync();
      await expectation;

      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
