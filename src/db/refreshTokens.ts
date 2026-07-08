import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from './index.js';
import { refreshTokens } from './schema.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type RotateResult =
  | { status: 'rotated'; userId: string }
  | { status: 'reuse_detected' }
  | { status: 'not_found' }
  | { status: 'expired' };

/**
 * Minimal structural type shared by `db` and a `db.transaction` callback's `tx`
 * (both extend `PgDatabase`, which exposes `execute`). Lets the family-revoke
 * CTE run against whichever handle the caller is already inside a transaction with.
 */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Family-revoke recursive CTE (§5.3.3): walks up to the family root, then down
 * to every descendant, marking all `is_used = true`. Shared by the rotate-on-reuse
 * branch of `rotateRefreshToken` and by `revokeRefreshTokenFamily` (logout).
 */
async function revokeFamily(executor: SqlExecutor, tokenId: string): Promise<void> {
  await executor.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_token_id FROM refresh_tokens WHERE id = ${tokenId}
      UNION ALL
      SELECT rt.id, rt.parent_token_id
        FROM refresh_tokens rt JOIN ancestors a ON rt.id = a.parent_token_id
    ),
    family AS (
      (SELECT id FROM ancestors WHERE parent_token_id IS NULL LIMIT 1)
      UNION ALL
      SELECT rt.id FROM refresh_tokens rt JOIN family f ON rt.parent_token_id = f.id
    )
    UPDATE refresh_tokens SET is_used = true WHERE id IN (SELECT id FROM family);
  `);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Inserts a new refresh-token family root. Takes/returns hashes only — the raw
 * token never enters this module.
 */
export async function insertRootRefreshToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      parentTokenId: null,
      isUsed: false,
      expiresAt: input.expiresAt,
    })
    .returning({ id: refreshTokens.id });
  if (!row) throw new Error('insertRootRefreshToken: insert returned no row');
  return { id: row.id };
}

/**
 * Atomic, row-locked rotation (§5.3.1). Single `db.transaction`:
 * 1. SELECT ... FOR UPDATE the presented token's row.
 * 2. no row -> not_found.
 * 3. expired -> expired.
 * 4. already used -> reuse: revoke the whole family, report reuse_detected.
 * 5. else: mark used, insert child, report rotated.
 *
 * The FOR UPDATE lock makes concurrent double-refresh safe: the loser blocks,
 * then sees is_used = true and takes the reuse branch instead of minting a
 * second child.
 */
export async function rotateRefreshToken(input: {
  presentedHash: string;
  newTokenHash: string;
  newExpiresAt: Date;
}): Promise<RotateResult> {
  return db.transaction(async (tx): Promise<RotateResult> => {
    const [row] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, input.presentedHash))
      .for('update')
      .limit(1);

    if (!row) return { status: 'not_found' };
    if (row.expiresAt <= new Date()) return { status: 'expired' };

    if (row.isUsed) {
      await revokeFamily(tx, row.id);
      return { status: 'reuse_detected' };
    }

    await tx.update(refreshTokens).set({ isUsed: true }).where(eq(refreshTokens.id, row.id));
    await tx.insert(refreshTokens).values({
      userId: row.userId,
      tokenHash: input.newTokenHash,
      parentTokenId: row.id,
      isUsed: false,
      expiresAt: input.newExpiresAt,
    });

    return { status: 'rotated', userId: row.userId };
  });
}

/**
 * Logout: revoke the whole family the presented token belongs to (§5.3.4).
 */
export async function revokeRefreshTokenFamily(
  presentedHash: string,
): Promise<{ revoked: boolean }> {
  return db.transaction(async (tx): Promise<{ revoked: boolean }> => {
    const [row] = await tx
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, presentedHash))
      .limit(1);

    if (!row) return { revoked: false };

    await revokeFamily(tx, row.id);
    return { revoked: true };
  });
}
