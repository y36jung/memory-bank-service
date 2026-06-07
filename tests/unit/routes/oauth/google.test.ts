/**
 * E6: API contract tests for /api/oauth/google/* routes.
 *
 * Uses buildApp() from src/server.ts with all external dependencies mocked.
 * Verifies HTTP status codes, response shapes, and routing behavior.
 *
 * Criteria covered:
 * - GET /api/oauth/google/init → 302 redirect to accounts.google.com.
 * - GET /api/oauth/google/callback?error=... → 400 OAUTH_DENIED.
 * - GET /api/oauth/google/callback?code=... → 200 { connected: true }.
 * - GET /api/oauth/google/status (no tokens) → 200 { connected: false }.
 * - GET /api/oauth/google/status (has tokens) → 200 { connected: true, expired: false }.
 * - POST /api/oauth/google/sync (no tokens) → 401.
 * - POST /api/oauth/google/sync (has tokens) → 202 with jobId.
 * - DELETE /api/oauth/google/revoke (no tokens) → 404.
 * - DELETE /api/oauth/google/revoke (has tokens) → 200 { revoked: true }.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock all external service dependencies before importing server
// ---------------------------------------------------------------------------

vi.mock('../../../../src/services/oauth/google.js', () => ({
  getGoogleAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?test=1'),
  exchangeCodeForTokens: vi.fn().mockResolvedValue(undefined),
  getDecryptedTokens: vi.fn(),
  revokeGoogleTokens: vi.fn().mockResolvedValue(undefined),
  deleteGoogleTokens: vi.fn().mockResolvedValue(undefined),
  refreshAccessTokenIfNeeded: vi.fn(),
  updateLastSyncedAt: vi.fn(),
}));

vi.mock('../../../../src/queue/index.js', () => ({
  oauthSyncQueue: {
    add: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
  },
  ingestionQueue: {
    add: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
  },
  redisConnection: {},
}));

vi.mock('../../../../src/services/qdrant.js', () => ({
  deletePoints: vi.fn().mockResolvedValue(undefined),
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  searchPoints: vi.fn().mockResolvedValue([]),
  upsertPoints: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    transaction: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('../../../../src/services/storage.js', () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  uploadStream: vi.fn().mockResolvedValue(undefined),
  getStream: vi.fn(),
  putObject: vi.fn().mockResolvedValue(undefined),
}));

// Mock workers to prevent Redis connections during tests
vi.mock('../../../../src/queue/workers/ingestion.worker.js', () => ({}));
vi.mock('../../../../src/queue/workers/oauth-sync.worker.js', () => ({}));

// Mock OpenAI embeddings used by chat routes
vi.mock('../../../../src/services/embeddings.js', () => ({
  batchEmbed: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../../src/services/chat.js', () => ({
  streamChatResponse: vi.fn(),
}));

import { buildApp } from '../../../../src/server.js';
import { getDecryptedTokens } from '../../../../src/services/oauth/google.js';
import { AppError } from '../../../../src/lib/errors.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/oauth/google/init', () => {
  it('responds 302 with Location header pointing to accounts.google.com', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/init',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('accounts.google.com');
  });
});

describe('GET /api/oauth/google/callback', () => {
  it('returns 400 OAUTH_DENIED when error param present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/callback?error=access_denied',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('OAUTH_DENIED');
  });

  it('returns 200 connected: true on valid code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/callback?code=valid-code',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.connected).toBe(true);
  });
});

describe('GET /api/oauth/google/status', () => {
  it('returns connected: false when no tokens', async () => {
    vi.mocked(getDecryptedTokens).mockRejectedValue(
      new AppError('NOT_CONNECTED', 'Not connected', 401),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/status',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.connected).toBe(false);
  });

  it('returns connected: true with token info', async () => {
    vi.mocked(getDecryptedTokens).mockResolvedValue({
      id: 'token-id',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      lastSyncedAt: null,
      scope:
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/google/status',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.connected).toBe(true);
    expect(body.data.expired).toBe(false);
  });
});

describe('POST /api/oauth/google/sync', () => {
  it('returns 401 NOT_CONNECTED when no tokens', async () => {
    vi.mocked(getDecryptedTokens).mockRejectedValue(
      new AppError('NOT_CONNECTED', 'Not connected', 401),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/oauth/google/sync',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 202 with jobId when connected', async () => {
    vi.mocked(getDecryptedTokens).mockResolvedValue({
      id: 'token-id',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      lastSyncedAt: null,
      scope:
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/oauth/google/sync',
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.data.jobId).toBeDefined();
    expect(body.data.status).toBe('queued');
  });
});

describe('DELETE /api/oauth/google/revoke', () => {
  it('returns 404 when not connected', async () => {
    vi.mocked(getDecryptedTokens).mockRejectedValue(
      new AppError('NOT_CONNECTED', 'Not connected', 401),
    );
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/oauth/google/revoke',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 200 revoked: true when connected', async () => {
    vi.mocked(getDecryptedTokens).mockResolvedValue({
      id: 'token-id',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      lastSyncedAt: null,
      scope:
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly',
    });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/oauth/google/revoke',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.revoked).toBe(true);
  });
});
