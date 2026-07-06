/**
 * Unit tests for src/services/qdrant.ts — Slice 2 payload/filter behavior.
 *
 * The `@qdrant/js-client-rest` client is mocked (no real Qdrant connection) —
 * this file proves the *shape* of the calls qdrant.ts makes to the client.
 * Real-Qdrant proof of the same behavior (payload actually persisted, filter
 * actually excludes foreign points) lives in the integration suite:
 *   tests/integration/qdrant-payload-scoping.test.ts
 *   tests/integration/retrieval-isolation.test.ts
 *
 * Criteria covered (plan §9):
 * - Every Qdrant upsert includes `userId` in its payload.
 * - Every Qdrant search includes the `userId` filter clause (`must` + keyword match),
 *   and `with_payload` stays `false`.
 * - `ensureCollection()` creates a `userId` keyword payload index, idempotently
 *   (swallows 409, rethrows other errors).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSearch, mockUpsert, mockGetCollection, mockCreateCollection, mockCreatePayloadIndex } =
  vi.hoisted(() => ({
    mockSearch: vi.fn(),
    mockUpsert: vi.fn(),
    mockGetCollection: vi.fn(),
    mockCreateCollection: vi.fn(),
    mockCreatePayloadIndex: vi.fn(),
  }));

vi.mock('@qdrant/js-client-rest', () => {
  const QdrantClient = vi.fn(() => ({
    search: mockSearch,
    upsert: mockUpsert,
    getCollection: mockGetCollection,
    createCollection: mockCreateCollection,
    createPayloadIndex: mockCreatePayloadIndex,
  }));
  return { QdrantClient };
});

import { ensureCollection, upsertPoints, searchPoints } from '../../../src/services/qdrant.js';

beforeEach(() => {
  vi.resetAllMocks();
  mockGetCollection.mockResolvedValue({ status: 'green' });
  mockCreatePayloadIndex.mockResolvedValue({});
});

describe('upsertPoints — userId payload (AC: every Qdrant upsert includes userId in its payload)', () => {
  it('writes payload: { userId } for every point in the batch', async () => {
    await upsertPoints([
      { id: 'point-1', vector: [0.1, 0.2], userId: 'user-a' },
      { id: 'point-2', vector: [0.3, 0.4], userId: 'user-b' },
    ]);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [collection, args] = mockUpsert.mock.calls[0] as [string, { points: unknown[] }];
    expect(collection).toBe('memory_bank');
    expect(args.points).toEqual([
      { id: 'point-1', vector: [0.1, 0.2], payload: { userId: 'user-a' } },
      { id: 'point-2', vector: [0.3, 0.4], payload: { userId: 'user-b' } },
    ]);
  });

  it('is a no-op (never calls upsert) for an empty points array', async () => {
    await upsertPoints([]);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('searchPoints — userId filter clause (AC: every Qdrant search includes the userId filter clause)', () => {
  it('calls client.search with a must userId filter and with_payload: false', async () => {
    mockSearch.mockResolvedValue([]);

    await searchPoints('user-a', [0.1, 0.2, 0.3], 10, 0.4);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    const [collection, args] = mockSearch.mock.calls[0] as [string, Record<string, unknown>];
    expect(collection).toBe('memory_bank');
    expect(args['filter']).toEqual({ must: [{ key: 'userId', match: { value: 'user-a' } }] });
    expect(args['with_payload']).toBe(false);
    expect(args['with_vector']).toBe(false);
    expect(args['vector']).toEqual([0.1, 0.2, 0.3]);
    expect(args['limit']).toBe(10);
    expect(args['score_threshold']).toBe(0.4);
  });

  it('scopes the filter to the given userId (different users produce different filters)', async () => {
    mockSearch.mockResolvedValue([]);

    await searchPoints('user-b', [0.5], 5, 0.5);

    const [, args] = mockSearch.mock.calls[0] as [string, Record<string, unknown>];
    expect(args['filter']).toEqual({ must: [{ key: 'userId', match: { value: 'user-b' } }] });
  });

  it('sorts and maps results by score descending, ignoring payload/vector', async () => {
    mockSearch.mockResolvedValue([
      { id: 'a', score: 0.5 },
      { id: 'b', score: 0.9 },
    ]);

    const result = await searchPoints('user-a', [0.1], 10, 0.4);
    expect(result).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.5 },
    ]);
  });
});

describe('ensureCollection — userId payload index (AC: index exists so filtered search avoids full scan)', () => {
  it('creates the userId keyword payload index after confirming the collection exists', async () => {
    await ensureCollection();

    expect(mockCreatePayloadIndex).toHaveBeenCalledWith('memory_bank', {
      field_name: 'userId',
      field_schema: 'keyword',
      wait: true,
    });
  });

  it('runs unconditionally even for a pre-existing collection (edge case #2)', async () => {
    mockGetCollection.mockResolvedValue({ status: 'green' }); // already exists
    await ensureCollection();
    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(1);
  });

  it('creates the collection first when it does not yet exist, then still creates the index', async () => {
    mockGetCollection.mockRejectedValue({ status: 404 });
    mockCreateCollection.mockResolvedValue({});

    await ensureCollection();

    expect(mockCreateCollection).toHaveBeenCalledWith('memory_bank', {
      vectors: { size: 3072, distance: 'Cosine' },
    });
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(1);
  });

  it('swallows a 409 ("index already exists") from createPayloadIndex (edge case #3, idempotent)', async () => {
    mockCreatePayloadIndex.mockRejectedValue({ status: 409 });
    await expect(ensureCollection()).resolves.toBeUndefined();
  });

  it('rethrows a non-409 error from createPayloadIndex', async () => {
    mockCreatePayloadIndex.mockRejectedValue({ status: 500, message: 'boom' });
    await expect(ensureCollection()).rejects.toEqual({ status: 500, message: 'boom' });
  });
});
