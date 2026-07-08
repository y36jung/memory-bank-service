import { randomUUID } from 'node:crypto';
import { db } from '../../../src/db/index.js';
import { users, documents, chatSessions, refreshTokens } from '../../../src/db/schema.js';
import { hashPassword } from '../../../src/lib/password.js';
import { generateRefreshToken, hashRefreshToken } from '../../../src/lib/refreshToken.js';

/**
 * Seed a user directly (bypassing the HTTP registration flow).
 *
 * When `password` is omitted, `passwordHash` stays null — the existing
 * no-password behavior (matches the synthetic/legacy user shape) is
 * unchanged so pre-existing callers (auth.test.ts, ownership.test.ts,
 * list-scoping.test.ts) are unaffected.
 *
 * When `password` is given, `passwordHash` is set via the REAL production
 * bcrypt hashing (src/lib/password.ts) so the seeded row can log in through
 * POST /api/auth/login exactly like a registered user.
 */
export async function seedUser(emailPrefix: string, password?: string) {
  const passwordHash = password === undefined ? undefined : await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({ email: `${emailPrefix}-${randomUUID()}@test.local`, passwordHash })
    .returning();
  if (!user) throw new Error('seedUser: insert returned no row');
  return user;
}

/**
 * Insert a refresh_tokens row directly (bypassing rotateRefreshToken), using
 * the same hashing production code uses. Needed to construct shapes that
 * can't be reached by waiting on the real 30-day TTL (an EXPIRED token) or by
 * driving arbitrary family trees (parentTokenId / isUsed) through HTTP alone.
 *
 * Returns both the raw token (settable as the refresh_token cookie in tests)
 * and the inserted row (for asserting DB state, e.g. is_used).
 */
export async function seedRefreshToken(
  userId: string,
  opts: {
    raw?: string;
    expiresAt?: Date;
    isUsed?: boolean;
    parentTokenId?: string | null;
  } = {},
) {
  const raw = opts.raw ?? generateRefreshToken();
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId,
      tokenHash: hashRefreshToken(raw),
      parentTokenId: opts.parentTokenId ?? null,
      isUsed: opts.isUsed ?? false,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error('seedRefreshToken: insert returned no row');
  return { raw, row };
}

export async function seedDocument(
  userId: string,
  overrides: Partial<typeof documents.$inferInsert> = {},
) {
  const [doc] = await db
    .insert(documents)
    .values({
      userId,
      filename: 'seed.txt',
      originalName: 'seed.txt',
      sourceType: 'upload',
      mimeType: 'text/plain',
      storageKey: `documents/${randomUUID()}/seed.txt`,
      status: 'indexed',
      ...overrides,
    })
    .returning();
  if (!doc) throw new Error('seedDocument: insert returned no row');
  return doc;
}

export async function seedChatSession(
  userId: string,
  overrides: Partial<typeof chatSessions.$inferInsert> = {},
) {
  const [session] = await db
    .insert(chatSessions)
    .values({ userId, title: 'Seeded session', ...overrides })
    .returning();
  if (!session) throw new Error('seedChatSession: insert returned no row');
  return session;
}
