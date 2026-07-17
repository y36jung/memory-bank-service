/**
 * Unit tests for src/services/retrieval.ts — retrieveChunks and retrieve
 *
 * External dependencies (batchEmbed, searchPoints, db, openai, classifyQuery)
 * are mocked — no real Postgres, Qdrant, or OpenAI calls.
 *
 * Criteria covered:
 * AC-4a: returns empty array when Qdrant returns no results
 * AC-4b: maps scores correctly from Qdrant results
 * AC-4c: returns empty array when batchEmbed returns no vector
 * AC-4d: results are sorted by score descending
 * AC-4e: Qdrant hits with no matching Postgres row are discarded
 * AC-4f: content comes from Postgres, not Qdrant payload (Postgres-first invariant)
 * AC-HYDE-1: generateHypotheticalAnswer returns hypothetical text passed to batchEmbed
 * AC-HYDE-2: generateHypotheticalAnswer falls back to original query on OpenAI error
 * AC-HYDE-3: classifyQuery receives original query, not hydeText
 * AC-FUSION-1: score fusion = 0.5*contentScore + 0.5*metadataScore on overlapping chunks
 * AC-FUSION-2: metadata-only chunks appear with contentScore=0 in fusion
 * AC-IR-1: list_documents intent → retrieve() returns { type: 'document_list', documents }
 * AC-IR-2: list_documents path skips searchPoints (never called)
 * AC-IR-3: list_documents path skips batchEmbed (never called)
 * AC-IR-4: list_documents with date filters applies date predicates
 * AC-IR-5: list_documents with null filters returns all documents (no date conditions)
 * AC-BACKOFF-1: primary threshold tier has hits → lowConfidence: false
 * AC-BACKOFF-2: only a lower tier has hits → those chunks returned, lowConfidence: true
 * AC-BACKOFF-3: even the floor tier has no hits → chunks: [], lowConfidence: false
 * AC-BACKOFF-4: searchPoints is called exactly once, always at the floor threshold —
 *               backoff tiers are applied in process, not via re-querying Qdrant
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock for the OpenAI chat.completions.create
// ---------------------------------------------------------------------------

const { mockChatCreate } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock external dependencies — no real Postgres, Qdrant, or OpenAI
// ---------------------------------------------------------------------------

vi.mock('openai', () => {
  const OpenAI = vi.fn(() => ({
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: vi.fn() } },
  }));
  return { default: OpenAI };
});

vi.mock('../../../src/services/embeddings.js', () => ({
  batchEmbed: vi.fn(),
}));

vi.mock('../../../src/services/qdrant.js', () => ({
  searchPoints: vi.fn(),
  ensureCollection: vi.fn(),
  upsertPoints: vi.fn(),
  deletePoints: vi.fn(),
}));

vi.mock('../../../src/services/queryClassifier.js', () => ({
  classifyQuery: vi.fn().mockResolvedValue(null), // default: no metadata intent → pure vector path
}));

vi.mock('../../../src/services/reranker.js', () => ({
  rerank: vi.fn(),
}));

vi.mock('../../../src/db/index.js', () => {
  const selectMock = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
  };
  return {
    db: {
      select: vi.fn(() => selectMock),
      _selectMock: selectMock,
    },
  };
});

import * as embeddings from '../../../src/services/embeddings.js';
import * as qdrant from '../../../src/services/qdrant.js';
import * as queryClassifierModule from '../../../src/services/queryClassifier.js';
import * as rerankerModule from '../../../src/services/reranker.js';
import { db } from '../../../src/db/index.js';
import { retrieveChunks, retrieve } from '../../../src/services/retrieval.js';
import type { RetrievedChunk } from '../../../src/services/retrieval.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_VECTOR = new Array(3072).fill(0.1) as number[];

// Fixed userId used across every call site in this file — retrieval.ts's four
// public functions all require userId as the leading argument (Slice 2).
const TEST_USER_ID = 'test-user-11111111-1111-1111-1111-111111111111';

const HYDE_RESPONSE =
  'Sedentary adults require approximately 0.8g protein per kg body weight daily.';

function mockEmbeddings(vector: number[] = MOCK_VECTOR) {
  vi.mocked(embeddings.batchEmbed).mockResolvedValue([vector]);
}

function mockHydeSuccess(text = HYDE_RESPONSE) {
  mockChatCreate.mockResolvedValue({
    choices: [{ message: { content: text } }],
  });
}

function mockHydeError() {
  mockChatCreate.mockRejectedValue(new Error('OpenAI 401 Unauthorized'));
}

/**
 * Build a mock select chain that resolves .where() (terminal) with the given rows.
 * Used for the simple vector-only path where there's no .orderBy()/.limit() after .where().
 */
function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

/**
 * Build a mock select chain for the metadata SQL path.
 * retrieveByMetadata calls: .select().from().innerJoin().where().orderBy().limit()
 */
function makeMetadataSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn().mockReturnValue(chain);
  chain['innerJoin'] = vi.fn().mockReturnValue(chain);
  chain['where'] = vi.fn().mockReturnValue(chain);
  chain['orderBy'] = vi.fn().mockReturnValue(chain);
  chain['limit'] = vi.fn().mockResolvedValue(rows);
  return chain;
}

/**
 * Build a mock select chain for the document listing path.
 * retrieveDocuments calls: .select().from().where().orderBy().limit()
 */
function makeDocumentListSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn().mockReturnValue(chain);
  chain['where'] = vi.fn().mockReturnValue(chain);
  chain['orderBy'] = vi.fn().mockReturnValue(chain);
  chain['limit'] = vi.fn().mockResolvedValue(rows);
  return chain;
}

// ---------------------------------------------------------------------------
// Setup: reset all mocks before each test, establish default select chain
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  // Default HyDE: returns the hypothetical answer text
  mockHydeSuccess();
  // Default classifyQuery: null (pure vector path)
  vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue(null);
  // Default batchEmbed: returns a valid vector
  mockEmbeddings();
  // Default rerank mock: sorts by the existing chunk.score (vector or fused)
  // and truncates to topN, without overwriting scores — stands in for the
  // real cross-encoder so callers still see sorted, bounded results.
  vi.mocked(rerankerModule.rerank).mockImplementation(
    async (_query: string, chunks: RetrievedChunk[], topN: number) =>
      chunks
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, topN),
  );
  // Re-establish the select chain mock after reset
  const basicChain = makeSelectChain([]);
  vi.mocked(db.select).mockReturnValue(basicChain as unknown as ReturnType<typeof db.select>);
});

// ---------------------------------------------------------------------------
// Existing AC tests: vector-only path (via retrieveChunks)
// ---------------------------------------------------------------------------

describe('retrieveChunks', () => {
  it('returns empty array when Qdrant returns no results', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const result = await retrieveChunks(TEST_USER_ID, 'what is the meaning of life?');
    expect(result).toEqual([]);
  });

  it('returns empty array when batchEmbed returns empty array (no vector)', async () => {
    vi.mocked(embeddings.batchEmbed).mockResolvedValue([]);

    const result = await retrieveChunks(TEST_USER_ID, 'test query');
    expect(result).toEqual([]);
    // searchPoints should never be called if there's no vector
    expect(qdrant.searchPoints).not.toHaveBeenCalled();
  });

  it('maps scores from Qdrant results correctly', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([
      { id: 'qdrant-uuid-1', score: 0.95 },
      { id: 'qdrant-uuid-2', score: 0.72 },
    ]);

    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: 'First chunk content',
        originalName: 'document1.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: 100,
        startSecs: null,
        endSecs: null,
      },
      {
        id: 'chunk-pg-id-2',
        qdrantId: 'qdrant-uuid-2',
        documentId: 'doc-id-2',
        content: 'Second chunk content',
        originalName: 'document2.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: 100,
        startSecs: null,
        endSecs: null,
      },
    ];

    vi.mocked(db.select).mockReturnValue(
      makeSelectChain(dbRows) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieveChunks(TEST_USER_ID, 'test query');

    expect(result).toHaveLength(2);
    // Sorted by score descending — highest score first
    expect(result[0]?.score).toBe(0.95);
    expect(result[1]?.score).toBe(0.72);
    expect(result[0]?.qdrantId).toBe('qdrant-uuid-1');
    expect(result[1]?.qdrantId).toBe('qdrant-uuid-2');
  });

  it('discards Qdrant hits with no matching Postgres row', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([
      { id: 'qdrant-uuid-1', score: 0.91 },
      { id: 'qdrant-uuid-orphan', score: 0.85 }, // no matching row in Postgres
    ]);

    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: 'Content for chunk 1',
        originalName: 'doc.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: 100,
        startSecs: null,
        endSecs: null,
      },
      // 'qdrant-uuid-orphan' has no Postgres row
    ];

    vi.mocked(db.select).mockReturnValue(
      makeSelectChain(dbRows) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieveChunks(TEST_USER_ID, 'test query');
    expect(result).toHaveLength(1);
    expect(result[0]?.qdrantId).toBe('qdrant-uuid-1');
  });

  it('results are sorted by score descending even when DB returns in arbitrary order', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([
      { id: 'q-id-a', score: 0.6 },
      { id: 'q-id-b', score: 0.9 },
      { id: 'q-id-c', score: 0.75 },
    ]);

    const dbRows = [
      {
        id: 'pg-a',
        qdrantId: 'q-id-a',
        documentId: 'doc-1',
        content: 'A',
        originalName: 'a.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: null,
        startSecs: null,
        endSecs: null,
      },
      {
        id: 'pg-c',
        qdrantId: 'q-id-c',
        documentId: 'doc-3',
        content: 'C',
        originalName: 'c.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: null,
        startSecs: null,
        endSecs: null,
      },
      {
        id: 'pg-b',
        qdrantId: 'q-id-b',
        documentId: 'doc-2',
        content: 'B',
        originalName: 'b.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: null,
        startSecs: null,
        endSecs: null,
      },
    ];

    vi.mocked(db.select).mockReturnValue(
      makeSelectChain(dbRows) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieveChunks(TEST_USER_ID, 'test query');
    expect(result).toHaveLength(3);
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
    expect(result[1]?.score).toBeGreaterThan(result[2]?.score ?? 0);
    expect(result[0]?.qdrantId).toBe('q-id-b'); // score 0.90 is highest
  });

  it('content comes from Postgres row, not from Qdrant payload (Postgres-first invariant)', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.88 }]);

    const postgresContent = 'Authoritative content from Postgres';
    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: postgresContent,
        originalName: 'file.txt',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'text/plain',
        sizeBytes: null,
        startSecs: null,
        endSecs: null,
      },
    ];

    vi.mocked(db.select).mockReturnValue(
      makeSelectChain(dbRows) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieveChunks(TEST_USER_ID, 'test query');
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe(postgresContent);
  });

  it('maps documentName from documents.original_name', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.8 }]);

    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: 'some content',
        originalName: 'my-important-document.pdf',
        createdAt: new Date(),
        sourceType: 'upload',
        mimeType: 'application/pdf',
        sizeBytes: null,
        startSecs: null,
        endSecs: null,
      },
    ];

    vi.mocked(db.select).mockReturnValue(
      makeSelectChain(dbRows) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieveChunks(TEST_USER_ID, 'test query');
    expect(result[0]?.documentName).toBe('my-important-document.pdf');
  });

  it('passes a widened candidate pool (topK * 3, min 20) to searchPoints, queried at the backoff floor', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    await retrieveChunks(TEST_USER_ID, 'query', 5, 0.7);

    // candidatePoolSize = max(5*3, 20) = 20 — over-fetched for the reranker.
    // Qdrant is always queried at the 0.05 floor threshold, not the passed-in
    // scoreThreshold (0.7 here) — tiers between floor and primary are applied
    // in process against that single result set (see AC-BACKOFF-4).
    expect(qdrant.searchPoints).toHaveBeenCalledWith(TEST_USER_ID, MOCK_VECTOR, 20, 0.05);
  });

  it('uses defaults topK=10, widening the candidate pool to 30, queried at the backoff floor', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    await retrieveChunks(TEST_USER_ID, 'query');

    // candidatePoolSize = max(10*3, 20) = 30.
    expect(qdrant.searchPoints).toHaveBeenCalledWith(TEST_USER_ID, MOCK_VECTOR, 30, 0.05);
  });

  it('calls rerank() with the raw query and the final topK as truncation size', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.9 }]);
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([
        {
          id: 'chunk-pg-id-1',
          qdrantId: 'qdrant-uuid-1',
          documentId: 'doc-id-1',
          content: 'content',
          originalName: 'doc.txt',
          createdAt: new Date(),
          sourceType: 'upload',
          mimeType: 'text/plain',
          sizeBytes: null,
          startSecs: null,
          endSecs: null,
        },
      ]) as unknown as ReturnType<typeof db.select>,
    );

    await retrieveChunks(TEST_USER_ID, 'the raw query', 7, 0.4);

    expect(rerankerModule.rerank).toHaveBeenCalledWith('the raw query', expect.any(Array), 7);
  });
});

// ---------------------------------------------------------------------------
// AC-HYDE: HyDE (Hypothetical Document Embeddings) behavior
// ---------------------------------------------------------------------------

describe('HyDE — generateHypotheticalAnswer integration', () => {
  it('passes hypothetical text (not original query) to batchEmbed', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const originalQuery = 'How much protein should a sedentary adult consume per day?';
    await retrieveChunks(TEST_USER_ID, originalQuery);

    // batchEmbed must have been called with the HyDE text, not the original query
    expect(embeddings.batchEmbed).toHaveBeenCalledWith([HYDE_RESPONSE]);
    expect(embeddings.batchEmbed).not.toHaveBeenCalledWith([originalQuery]);
  });

  it('falls back to original query when OpenAI throws (batchEmbed receives original query)', async () => {
    mockHydeError();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const originalQuery = 'What is photosynthesis?';
    await retrieveChunks(TEST_USER_ID, originalQuery);

    // On error, generateHypotheticalAnswer returns the original query as fallback
    expect(embeddings.batchEmbed).toHaveBeenCalledWith([originalQuery]);
  });

  it('classifyQuery receives the original query and a date string, not the hypothetical text', async () => {
    const differentHydeText = 'A completely different hypothetical answer text.';
    mockHydeSuccess(differentHydeText);
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const originalQuery = 'How much protein should a sedentary adult consume per day?';
    await retrieveChunks(TEST_USER_ID, originalQuery);

    // classifyQuery must be called with the original query + a date string
    expect(queryClassifierModule.classifyQuery).toHaveBeenCalledWith(
      originalQuery,
      expect.any(String),
    );
    expect(queryClassifierModule.classifyQuery).not.toHaveBeenCalledWith(
      differentHydeText,
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-FUSION: Score fusion when classifyQuery returns search_content + filters
// ---------------------------------------------------------------------------

describe('score fusion — hybrid metadata + vector search', () => {
  it('fused score = 0.5*contentScore + 0.5*metadataScore for overlapping chunks', async () => {
    // classifyQuery returns a search_content classification (triggers hybrid path)
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'search_content',
      filters: { documentKeywords: ['foo'] },
    });

    const CONTENT_SCORE = 0.8;
    const METADATA_SCORE = 0.6;
    const OVERLAP_CHUNK_ID = 'chunk-overlap-1';
    const OVERLAP_QDRANT_ID = 'qdrant-overlap-1';

    // Qdrant returns one hit for the vector path
    vi.mocked(qdrant.searchPoints).mockResolvedValue([
      { id: OVERLAP_QDRANT_ID, score: CONTENT_SCORE },
    ]);

    // Vector DB row
    const vectorRow = {
      id: OVERLAP_CHUNK_ID,
      qdrantId: OVERLAP_QDRANT_ID,
      documentId: 'doc-1',
      content: 'Overlapping chunk content',
      originalName: 'foo.txt',
      createdAt: new Date(),
      sourceType: 'upload',
      mimeType: 'text/plain',
      sizeBytes: null,
      startSecs: null,
      endSecs: null,
    };

    // Metadata DB row — same chunk, has keywordScore
    const metadataRow = {
      ...vectorRow,
      keywordScore: METADATA_SCORE,
    };

    // We need two separate db.select() calls.
    // With parallelized retrieve(), retrieveByMetadata starts immediately while the
    // vector chain first awaits batchEmbed + searchPoints, so the metadata chain
    // calls db.select() FIRST.
    // 1st: metadata path (retrieveByMetadata) — returns metadataRow via .limit()
    // 2nd: vector path — returns vectorRow via .where() (no orderBy/limit)
    const vectorChain = makeSelectChain([vectorRow]);
    const metadataChain = makeMetadataSelectChain([metadataRow]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return metadataChain as unknown as ReturnType<typeof db.select>;
      return vectorChain as unknown as ReturnType<typeof db.select>;
    });

    const result = await retrieveChunks(TEST_USER_ID, 'foo document query');

    expect(result).toHaveLength(1);
    const fusedScore = 0.5 * CONTENT_SCORE + 0.5 * METADATA_SCORE;
    expect(result[0]?.score).toBeCloseTo(fusedScore, 5);
  });

  it('metadata-only chunks (not in Qdrant results) appear with contentScore=0', async () => {
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'search_content',
      filters: { documentKeywords: ['foo'] },
    });

    // Qdrant returns no hits
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const METADATA_SCORE = 1.0;
    const metadataRow = {
      id: 'chunk-metadata-only',
      qdrantId: 'qdrant-metadata-only',
      documentId: 'doc-1',
      content: 'Metadata-only chunk',
      originalName: 'foo.txt',
      createdAt: new Date(),
      sourceType: 'upload',
      mimeType: 'text/plain',
      sizeBytes: null,
      startSecs: null,
      endSecs: null,
      keywordScore: METADATA_SCORE,
    };

    // 1st db.select call: vector path returns empty (no qdrant hits → no db query needed)
    // 2nd db.select call: metadata path returns metadataRow
    // Actually when qdrantResults.length === 0, the vector db.select is never called.
    // So only one db.select call happens (for metadata).
    const metadataChain = makeMetadataSelectChain([metadataRow]);
    vi.mocked(db.select).mockReturnValue(metadataChain as unknown as ReturnType<typeof db.select>);

    const result = await retrieveChunks(TEST_USER_ID, 'foo document');

    expect(result).toHaveLength(1);
    // contentScore = 0 (not in vector results), metadataScore = 1.0
    // fused = 0.5 * 0 + 0.5 * 1.0 = 0.5
    expect(result[0]?.score).toBeCloseTo(0.5, 5);
    expect(result[0]?.chunkId).toBe('chunk-metadata-only');
  });
});

// ---------------------------------------------------------------------------
// AC-IR: Intent routing — list_documents path
// ---------------------------------------------------------------------------

describe('AC-IR: retrieve() — list_documents intent routing', () => {
  const mockDocRow = {
    id: 'doc-uuid-1',
    originalName: 'report.pdf',
    sourceType: 'upload',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    createdAt: new Date('2026-06-18T10:00:00Z'),
  };

  it('AC-IR-1: returns { type: document_list, documents } for list_documents intent', async () => {
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'list_documents',
      filters: null,
    });

    const docChain = makeDocumentListSelectChain([mockDocRow]);
    vi.mocked(db.select).mockReturnValue(docChain as unknown as ReturnType<typeof db.select>);

    const result = await retrieve(TEST_USER_ID, 'what documents have I uploaded?');

    expect(result.type).toBe('document_list');
    if (result.type === 'document_list') {
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]?.documentId).toBe('doc-uuid-1');
      expect(result.documents[0]?.documentName).toBe('report.pdf');
    }
  });

  it('AC-IR-2: list_documents path never calls searchPoints', async () => {
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'list_documents',
      filters: null,
    });

    const docChain = makeDocumentListSelectChain([mockDocRow]);
    vi.mocked(db.select).mockReturnValue(docChain as unknown as ReturnType<typeof db.select>);

    await retrieve(TEST_USER_ID, 'list all my documents');

    expect(qdrant.searchPoints).not.toHaveBeenCalled();
  });

  it('AC-IR-3: list_documents path never calls batchEmbed', async () => {
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'list_documents',
      filters: null,
    });

    const docChain = makeDocumentListSelectChain([]);
    vi.mocked(db.select).mockReturnValue(docChain as unknown as ReturnType<typeof db.select>);

    await retrieve(TEST_USER_ID, 'show me my files');

    expect(embeddings.batchEmbed).not.toHaveBeenCalled();
  });

  it('AC-IR-4: list_documents with date filters passes filters to db query', async () => {
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'list_documents',
      filters: { uploadedAfter: '2026-06-13', uploadedBefore: '2026-06-20' },
    });

    const docChain = makeDocumentListSelectChain([mockDocRow]);
    const selectSpy = vi
      .mocked(db.select)
      .mockReturnValue(docChain as unknown as ReturnType<typeof db.select>);

    const result = await retrieve(TEST_USER_ID, 'what did I upload last week?');

    // The query should have used db.select (SQL path)
    expect(selectSpy).toHaveBeenCalled();
    expect(result.type).toBe('document_list');
  });

  it('AC-IR-5: list_documents with null filters returns all documents', async () => {
    vi.mocked(queryClassifierModule.classifyQuery).mockResolvedValue({
      intent: 'list_documents',
      filters: null,
    });

    const allDocs = [mockDocRow, { ...mockDocRow, id: 'doc-uuid-2', originalName: 'notes.txt' }];
    const docChain = makeDocumentListSelectChain(allDocs);
    vi.mocked(db.select).mockReturnValue(docChain as unknown as ReturnType<typeof db.select>);

    const result = await retrieve(TEST_USER_ID, 'what documents have I uploaded?');

    expect(result.type).toBe('document_list');
    if (result.type === 'document_list') {
      expect(result.documents).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-BACKOFF: score-threshold backoff on the vector chain
// ---------------------------------------------------------------------------

describe('AC-BACKOFF: retrieve() — score-threshold backoff', () => {
  const backoffDbRow = {
    id: 'chunk-pg-id-1',
    qdrantId: 'qdrant-uuid-1',
    documentId: 'doc-id-1',
    content: 'chunk content',
    originalName: 'doc.txt',
    createdAt: new Date(),
    sourceType: 'upload',
    mimeType: 'text/plain',
    sizeBytes: null,
    startSecs: null,
    endSecs: null,
  };

  it('AC-BACKOFF-1: a hit at/above the primary tier (0.2) returns lowConfidence: false', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.9 }]);
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([backoffDbRow]) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieve(TEST_USER_ID, 'query');

    expect(result.type).toBe('chunk_results');
    if (result.type === 'chunk_results') {
      expect(result.lowConfidence).toBe(false);
      expect(result.chunks).toHaveLength(1);
    }
  });

  it('AC-BACKOFF-2: no hit clears 0.2 but one clears the 0.1 tier → returned with lowConfidence: true', async () => {
    // 0.12 is below the primary tier (0.2) but clears the next tier (0.1).
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.12 }]);
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([backoffDbRow]) as unknown as ReturnType<typeof db.select>,
    );

    const result = await retrieve(TEST_USER_ID, 'query');

    expect(result.type).toBe('chunk_results');
    if (result.type === 'chunk_results') {
      expect(result.lowConfidence).toBe(true);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]?.qdrantId).toBe('qdrant-uuid-1');
    }
  });

  it('AC-BACKOFF-3: nothing clears even the floor tier → empty chunks, lowConfidence: false', async () => {
    // Qdrant is queried at the floor threshold, so an empty result here means
    // nothing exists even at the widest tier.
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const result = await retrieve(TEST_USER_ID, 'query');

    expect(result.type).toBe('chunk_results');
    if (result.type === 'chunk_results') {
      expect(result.chunks).toEqual([]);
      expect(result.lowConfidence).toBe(false);
    }
  });

  it('AC-BACKOFF-4: searchPoints is called exactly once even when backoff is needed', async () => {
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.06 }]);
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([backoffDbRow]) as unknown as ReturnType<typeof db.select>,
    );

    await retrieve(TEST_USER_ID, 'query');

    expect(qdrant.searchPoints).toHaveBeenCalledTimes(1);
    expect(qdrant.searchPoints).toHaveBeenCalledWith(TEST_USER_ID, MOCK_VECTOR, 30, 0.05);
  });
});
