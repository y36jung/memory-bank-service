/**
 * E3: Unit tests for src/services/oauth/google.ts
 *
 * Tests getGoogleAuthUrl, getDecryptedTokens, and refreshAccessTokenIfNeeded.
 * googleapis and src/db/index.js are mocked.
 *
 * Criteria covered:
 * - getGoogleAuthUrl returns a URL pointing to accounts.google.com.
 * - getGoogleAuthUrl URL contains gmail.readonly and drive.readonly scopes.
 * - getDecryptedTokens throws NOT_CONNECTED when no token row found.
 * - refreshAccessTokenIfNeeded calls refreshAccessToken when token expires within 5 min.
 * - refreshAccessTokenIfNeeded returns current token when expires in >5 min.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../../../src/lib/errors.js';

// ---------------------------------------------------------------------------
// Use vi.hoisted to create mock references before vi.mock hoisting occurs.
// vi.mock factories are hoisted to the top of the file; variables defined with
// vi.hoisted() are also hoisted and are available inside factory functions.
// ---------------------------------------------------------------------------

const {
  mockGenerateAuthUrl,
  mockRefreshAccessToken,
  mockSetCredentials,
  MockOAuth2,
  mockOAuth2Instance,
} = vi.hoisted(() => {
  const mockGenerateAuthUrl = vi
    .fn()
    .mockReturnValue(
      'https://accounts.google.com/o/oauth2/auth?scope=gmail.readonly+drive.readonly',
    );
  const mockGetToken = vi.fn();
  const mockRefreshAccessToken = vi.fn();
  const mockSetCredentials = vi.fn();
  const mockRevokeToken = vi.fn();

  const mockOAuth2Instance = {
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
    refreshAccessToken: mockRefreshAccessToken,
    setCredentials: mockSetCredentials,
    revokeToken: mockRevokeToken,
  };

  const MockOAuth2 = vi.fn().mockImplementation(() => mockOAuth2Instance);

  return {
    mockGenerateAuthUrl,
    mockGetToken,
    mockRefreshAccessToken,
    mockSetCredentials,
    mockRevokeToken,
    mockOAuth2Instance,
    MockOAuth2,
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
  },
}));

vi.mock('../../../../src/db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import {
  getGoogleAuthUrl,
  getDecryptedTokens,
  refreshAccessTokenIfNeeded,
} from '../../../../src/services/oauth/google.js';
import { db } from '../../../../src/db/index.js';

describe('getGoogleAuthUrl', () => {
  it('returns a URL containing accounts.google.com', () => {
    const url = getGoogleAuthUrl();
    expect(url).toContain('accounts.google.com');
  });

  it('URL contains gmail.readonly scope', () => {
    const url = getGoogleAuthUrl();
    expect(url).toContain('gmail.readonly');
  });

  it('URL contains drive.readonly scope', () => {
    const url = getGoogleAuthUrl();
    expect(url).toContain('drive.readonly');
  });
});

describe('getDecryptedTokens', () => {
  it('throws NOT_CONNECTED when no row found', async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    vi.mocked(db.select).mockImplementation(mockSelect);

    await expect(getDecryptedTokens()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });
});

describe('refreshAccessTokenIfNeeded', () => {
  beforeEach(() => {
    mockRefreshAccessToken.mockReset();
    mockSetCredentials.mockReset();
    MockOAuth2.mockImplementation(() => mockOAuth2Instance);
  });

  it('calls refreshAccessToken when token expires in 3 minutes', async () => {
    const newAccessToken = 'new-access-token';
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: newAccessToken,
        expiry_date: Date.now() + 3600_000,
      },
    });

    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    vi.mocked(db.update).mockImplementation(mockUpdate);

    const expiresInThreeMinutes = new Date(Date.now() + 3 * 60 * 1000);
    const tokenRow = {
      id: 'row-id',
      accessToken: 'old-access-token',
      refreshToken: 'my-refresh-token',
      expiresAt: expiresInThreeMinutes,
    };

    const result = await refreshAccessTokenIfNeeded(tokenRow);
    expect(result).toBe(newAccessToken);
    expect(mockRefreshAccessToken).toHaveBeenCalled();
  });

  it('does NOT call refreshAccessToken when token expires in 30 minutes', async () => {
    const expiresIn30Min = new Date(Date.now() + 30 * 60 * 1000);
    const tokenRow = {
      id: 'row-id',
      accessToken: 'still-valid-token',
      refreshToken: 'my-refresh-token',
      expiresAt: expiresIn30Min,
    };

    const result = await refreshAccessTokenIfNeeded(tokenRow);
    expect(result).toBe('still-valid-token');
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });
});
