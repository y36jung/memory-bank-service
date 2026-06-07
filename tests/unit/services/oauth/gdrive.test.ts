/**
 * E5: Unit tests for src/services/oauth/gdrive.ts
 *
 * Tests syncGoogleDrive deduplication and modifiedTime filter behavior.
 * googleapis, db, storage, and queue are all mocked.
 *
 * Criteria covered:
 * - Skips files already indexed with same driveFileId and modifiedTime.
 * - Processes files with different modifiedTime (re-ingests updated file).
 * - Includes modifiedTime filter in Drive query when lastSyncedAt is provided.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted: create stable mock references before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockFilesList, mockFilesExport, mockFilesGet, mockDriveInstance } = vi.hoisted(() => {
  const mockFilesList = vi.fn();
  const mockFilesExport = vi.fn();
  const mockFilesGet = vi.fn();
  const mockDriveInstance = {
    files: {
      list: mockFilesList,
      export: mockFilesExport,
      get: mockFilesGet,
    },
  };
  return { mockFilesList, mockFilesExport, mockFilesGet, mockDriveInstance };
});

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn().mockReturnValue(mockDriveInstance),
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

import { syncGoogleDrive } from '../../../../src/services/oauth/gdrive.js';
import { google } from 'googleapis';
import { db } from '../../../../src/db/index.js';

describe('syncGoogleDrive — deduplication', () => {
  beforeEach(() => {
    mockFilesList.mockReset();
    mockFilesExport.mockReset();
    mockFilesGet.mockReset();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.transaction).mockReset();
    vi.mocked(google.drive).mockReturnValue(mockDriveInstance as any);
  });

  it('skips files with same driveFileId and modifiedTime', async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          {
            id: 'file-1',
            name: 'doc.txt',
            mimeType: 'text/plain',
            modifiedTime: '2024-01-01T00:00:00Z',
            size: '100',
          },
        ],
        nextPageToken: undefined,
      },
    });

    // isDriveFileAlreadyIndexed returns true (same ID + modifiedTime)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'existing-doc-id' }]),
        }),
      }),
    } as any);

    const result = await syncGoogleDrive('token', null);
    expect(result.skipped).toBe(1);
    expect(result.synced).toBe(0);
  });

  it('processes files with different modifiedTime (re-ingests updated file)', async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          {
            id: 'file-1',
            name: 'doc.txt',
            mimeType: 'text/plain',
            modifiedTime: '2024-06-01T00:00:00Z',
            size: '200',
          },
        ],
        nextPageToken: undefined,
      },
    });

    // isDriveFileAlreadyIndexed returns false (different modifiedTime)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    // downloadDriveFile — files.get is called with alt: 'media'
    mockFilesGet.mockResolvedValue({
      data: Buffer.from('file content'),
    });

    // db.transaction mock
    vi.mocked(db.transaction).mockImplementation(async (fn) =>
      fn({
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      } as any),
    );

    const result = await syncGoogleDrive('token', null);
    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

describe('syncGoogleDrive — modifiedTime filter', () => {
  beforeEach(() => {
    mockFilesList.mockReset();
    mockFilesGet.mockReset();
    vi.mocked(db.select).mockReset();
    vi.mocked(google.drive).mockReturnValue(mockDriveInstance as any);
  });

  it('includes modifiedTime filter when lastSyncedAt is provided', async () => {
    mockFilesList.mockResolvedValue({
      data: { files: [], nextPageToken: undefined },
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const afterDate = new Date('2024-03-01T00:00:00Z');
    await syncGoogleDrive('token', afterDate);
    expect(mockFilesList).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining(`modifiedTime > '${afterDate.toISOString()}'`),
      }),
    );
  });
});
