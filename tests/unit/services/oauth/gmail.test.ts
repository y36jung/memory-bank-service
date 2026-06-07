/**
 * E4: Unit tests for src/services/oauth/gmail.ts
 *
 * Tests decodeBase64Url (exported) and syncGmail behavior (deduplication, query building).
 * googleapis, db, storage, and queue are all mocked.
 *
 * Criteria covered:
 * - decodeBase64Url correctly decodes URL-safe base64.
 * - decodeBase64Url handles URL-safe characters (- and _).
 * - syncGmail does not append after: when lastSyncedAt is null.
 * - syncGmail appends after:{unix_seconds} when lastSyncedAt is provided.
 * - syncGmail skips already-indexed threads (deduplication).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted: create stable mock references before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockThreadsList, mockThreadsGet, mockGmailInstance } = vi.hoisted(() => {
  const mockThreadsList = vi.fn();
  const mockThreadsGet = vi.fn();
  const mockGmailInstance = {
    users: {
      threads: {
        list: mockThreadsList,
        get: mockThreadsGet,
      },
    },
  };
  return { mockThreadsList, mockThreadsGet, mockGmailInstance };
});

vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn().mockReturnValue(mockGmailInstance),
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
  },
}));

vi.mock('../../../../src/db/index.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../../../src/services/storage.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/queue/index.js', () => ({
  ingestionQueue: {
    add: vi.fn().mockResolvedValue({ id: 'job-id' }),
  },
}));

import { decodeBase64Url, syncGmail } from '../../../../src/services/oauth/gmail.js';
import { google } from 'googleapis';
import { db } from '../../../../src/db/index.js';

describe('decodeBase64Url', () => {
  it('correctly decodes URL-safe base64', () => {
    // btoa('hello') = 'aGVsbG8='
    expect(decodeBase64Url('aGVsbG8=')).toBe('hello');
  });

  it('handles URL-safe characters (- and _)', () => {
    // URL-safe base64 uses - instead of + and _ instead of /
    const original = Buffer.from('abc+/xyz').toString('base64url');
    const decoded = decodeBase64Url(original);
    expect(decoded).toBe('abc+/xyz');
  });
});

describe('syncGmail — listThreadIds after filter', () => {
  beforeEach(() => {
    mockThreadsList.mockReset();
    mockThreadsGet.mockReset();
    vi.mocked(db.select).mockReset();
    // Re-attach return value after reset
    vi.mocked(google.gmail).mockReturnValue(mockGmailInstance as any);
  });

  it('does not append after: when lastSyncedAt is null', async () => {
    mockThreadsList.mockResolvedValue({
      data: { threads: [], nextPageToken: undefined },
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await syncGmail('token', null, '');
    expect(mockThreadsList).toHaveBeenCalledWith(expect.objectContaining({ q: '' }));
  });

  it('appends after:{unix_seconds} when lastSyncedAt is provided', async () => {
    const afterDate = new Date('2024-01-01T00:00:00Z');
    mockThreadsList.mockResolvedValue({
      data: { threads: [], nextPageToken: undefined },
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await syncGmail('token', afterDate, '');
    const expectedTimestamp = Math.floor(afterDate.getTime() / 1000);
    expect(mockThreadsList).toHaveBeenCalledWith(
      expect.objectContaining({ q: `after:${expectedTimestamp}` }),
    );
  });
});

describe('syncGmail — deduplication', () => {
  beforeEach(() => {
    mockThreadsList.mockReset();
    mockThreadsGet.mockReset();
    vi.mocked(db.select).mockReset();
    vi.mocked(google.gmail).mockReturnValue(mockGmailInstance as any);
  });

  it('skips already-indexed threads', async () => {
    mockThreadsList.mockResolvedValue({
      data: { threads: [{ id: 'thread-1' }], nextPageToken: undefined },
    });

    // isThreadAlreadyIndexed returns true (a row exists)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'doc-id' }]),
        }),
      }),
    } as any);

    const result = await syncGmail('token', null);
    expect(result.skipped).toBe(1);
    expect(result.synced).toBe(0);
  });
});
