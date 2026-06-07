import { google } from 'googleapis';
import { db } from '../../db/index.js';
import { oauthTokens } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { encryptTokens, decryptTokens } from './token.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

function createOAuth2Client() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new AppError('GOOGLE_NOT_CONFIGURED', 'Google OAuth credentials are not configured', 500);
  }
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export function getGoogleAuthUrl(): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    prompt: 'consent',
  });
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new AppError('OAUTH_FAILED', 'No access token received from Google', 500);
  }
  const { accessToken, refreshToken } = encryptTokens(
    tokens.access_token,
    tokens.refresh_token ?? null,
  );
  await db
    .insert(oauthTokens)
    .values({
      provider: 'google',
      accessToken,
      refreshToken,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope ?? null,
    })
    .onConflictDoUpdate({
      target: oauthTokens.provider,
      set: {
        accessToken,
        refreshToken,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scope: tokens.scope ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function getDecryptedTokens(): Promise<{
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  lastSyncedAt: Date | null;
  scope: string | null;
}> {
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.provider, 'google'))
    .limit(1);
  if (rows.length === 0 || !rows[0]) {
    throw new AppError('NOT_CONNECTED', 'Google account is not connected', 401);
  }
  const row = rows[0];
  const { accessToken, refreshToken } = decryptTokens(row);
  return {
    id: row.id,
    accessToken,
    refreshToken,
    expiresAt: row.expiresAt,
    lastSyncedAt: row.lastSyncedAt,
    scope: row.scope,
  };
}

export function hasScope(grantedScopeStr: string | null, requiredScope: string): boolean {
  if (!grantedScopeStr) return false;
  return grantedScopeStr.split(' ').includes(requiredScope);
}

export async function refreshAccessTokenIfNeeded(tokenRow: {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}): Promise<string> {
  const fiveMinutes = 5 * 60 * 1000;
  const needsRefresh =
    tokenRow.expiresAt == null || tokenRow.expiresAt.getTime() < Date.now() + fiveMinutes;

  if (!needsRefresh) return tokenRow.accessToken;

  if (!tokenRow.refreshToken) {
    throw new AppError(
      'NO_REFRESH_TOKEN',
      'No refresh token available; user must re-authenticate',
      401,
    );
  }

  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: tokenRow.refreshToken });
  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token) {
    throw new AppError('REFRESH_FAILED', 'Failed to obtain new access token from Google', 500);
  }
  const encrypted = encryptTokens(credentials.access_token, null);
  await db
    .update(oauthTokens)
    .set({
      accessToken: encrypted.accessToken,
      expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      updatedAt: new Date(),
    })
    .where(eq(oauthTokens.id, tokenRow.id));

  return credentials.access_token;
}

export async function updateLastSyncedAt(id: string): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(oauthTokens.id, id));
}

export async function revokeGoogleTokens(accessToken: string): Promise<void> {
  try {
    const client = createOAuth2Client();
    await client.revokeToken(accessToken);
  } catch {
    // Token may already be expired or revoked — swallow
  }
}

export async function deleteGoogleTokens(): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.provider, 'google'));
}
