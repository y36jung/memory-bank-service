/**
 * Unit tests for src/services/retrieval.ts — retrieveChunks
 *
 * External dependencies (batchEmbed, searchPoints, db) are mocked.
 *
 * Criteria covered:
 * AC-4a: returns empty array when Qdrant returns no results
 * AC-4b: maps scores correctly from Qdrant results
 * AC-4c: returns empty array when batchEmbed returns no vector
 * AC-4d: results are sorted by score descending
 * AC-4e: Qdrant hits with no matching Postgres row are discarded
 * AC-4f: content comes from Postgres, not Qdrant payload (Postgres-first invariant)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external dependencies — no real Postgres, Qdrant, or OpenAI
// ---------------------------------------------------------------------------

vi.mock('../../../src/services/embeddings.js', () => ({
  batchEmbed: vi.fn(),
}));

vi.mock('../../../src/services/qdrant.js', () => ({
  searchPoints: vi.fn(),
  ensureCollection: vi.fn(),
  upsertPoints: vi.fn(),
  deletePoints: vi.fn(),
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
import { db } from '../../../src/db/index.js';
import { retrieveChunks } from '../../../src/services/retrieval.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_VECTOR = new Array(3072).fill(0.1) as number[];

function mockEmbeddings(vector: number[] = MOCK_VECTOR) {
  vi.mocked(embeddings.batchEmbed).mockResolvedValue([vector]);
}

function getSelectWhereMock() {
  // The db.select() chain ends with .where() — we need to mock its resolved value.
  const selectResult = (db as unknown as { _selectMock: { where: ReturnType<typeof vi.fn> } })
    ._selectMock;
  return selectResult.where as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retrieveChunks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish the select chain mock after reset
    const whereMock = vi.fn();
    const selectMock = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: whereMock,
    };
    vi.mocked(db.select).mockReturnValue(selectMock as ReturnType<typeof db.select>);
  });

  it('returns empty array when Qdrant returns no results', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    const result = await retrieveChunks('what is the meaning of life?');
    expect(result).toEqual([]);
  });

  it('returns empty array when batchEmbed returns empty array (no vector)', async () => {
    vi.mocked(embeddings.batchEmbed).mockResolvedValue([]);

    const result = await retrieveChunks('test query');
    expect(result).toEqual([]);
    // searchPoints should never be called if there's no vector
    expect(qdrant.searchPoints).not.toHaveBeenCalled();
  });

  it('maps scores from Qdrant results correctly', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([
      { id: 'qdrant-uuid-1', score: 0.95 },
      { id: 'qdrant-uuid-2', score: 0.72 },
    ]);

    // Mock DB to return matching Postgres rows
    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: 'First chunk content',
        originalName: 'document1.txt',
      },
      {
        id: 'chunk-pg-id-2',
        qdrantId: 'qdrant-uuid-2',
        documentId: 'doc-id-2',
        content: 'Second chunk content',
        originalName: 'document2.txt',
      },
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(dbRows),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    const result = await retrieveChunks('test query');

    expect(result).toHaveLength(2);
    // Sorted by score descending — highest score first
    expect(result[0]?.score).toBe(0.95);
    expect(result[1]?.score).toBe(0.72);
    expect(result[0]?.qdrantId).toBe('qdrant-uuid-1');
    expect(result[1]?.qdrantId).toBe('qdrant-uuid-2');
  });

  it('discards Qdrant hits with no matching Postgres row', async () => {
    mockEmbeddings();
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
      },
      // 'qdrant-uuid-orphan' has no Postgres row
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(dbRows),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    const result = await retrieveChunks('test query');
    expect(result).toHaveLength(1);
    expect(result[0]?.qdrantId).toBe('qdrant-uuid-1');
  });

  it('results are sorted by score descending even when DB returns in arbitrary order', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([
      { id: 'q-id-a', score: 0.6 },
      { id: 'q-id-b', score: 0.9 },
      { id: 'q-id-c', score: 0.75 },
    ]);

    const dbRows = [
      { id: 'pg-a', qdrantId: 'q-id-a', documentId: 'doc-1', content: 'A', originalName: 'a.txt' },
      { id: 'pg-c', qdrantId: 'q-id-c', documentId: 'doc-3', content: 'C', originalName: 'c.txt' },
      { id: 'pg-b', qdrantId: 'q-id-b', documentId: 'doc-2', content: 'B', originalName: 'b.txt' },
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(dbRows),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    const result = await retrieveChunks('test query');
    expect(result).toHaveLength(3);
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
    expect(result[1]?.score).toBeGreaterThan(result[2]?.score ?? 0);
    expect(result[0]?.qdrantId).toBe('q-id-b'); // score 0.90 is highest
  });

  it('content comes from Postgres row, not from Qdrant payload (Postgres-first invariant)', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.88 }]);

    const postgresContent = 'Authoritative content from Postgres';
    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: postgresContent,
        originalName: 'file.txt',
      },
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(dbRows),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    const result = await retrieveChunks('test query');
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe(postgresContent);
  });

  it('maps documentName from documents.original_name', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([{ id: 'qdrant-uuid-1', score: 0.8 }]);

    const dbRows = [
      {
        id: 'chunk-pg-id-1',
        qdrantId: 'qdrant-uuid-1',
        documentId: 'doc-id-1',
        content: 'some content',
        originalName: 'my-important-document.pdf',
      },
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(dbRows),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    const result = await retrieveChunks('test query');
    expect(result[0]?.documentName).toBe('my-important-document.pdf');
  });

  it('passes topK and scoreThreshold to searchPoints', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    await retrieveChunks('query', 5, 0.7);

    expect(qdrant.searchPoints).toHaveBeenCalledWith(MOCK_VECTOR, 5, 0.7);
  });

  it('uses defaults topK=10 and scoreThreshold=0.4 when not provided', async () => {
    mockEmbeddings();
    vi.mocked(qdrant.searchPoints).mockResolvedValue([]);

    await retrieveChunks('query');

    expect(qdrant.searchPoints).toHaveBeenCalledWith(MOCK_VECTOR, 10, 0.4);
  });
});
