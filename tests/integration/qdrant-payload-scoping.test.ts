/**
 * Real-Qdrant proof (no mocks) — plan §9 row 1:
 *   "Every Qdrant upsert includes `userId` in its payload."
 *
 * Ingests (a minimal, direct Postgres+Qdrant simulation of) a document for a
 * seeded user, upserts its point via the real `upsertPoints()` against the
 * real Qdrant instance, then fetches the raw point back via the Qdrant
 * client directly (bypassing qdrant.ts's own with_payload:false search path,
 * which never returns payload) and asserts payload.userId equals the
 * document's user_id in Postgres.
 *
 * Deliberately avoids driving this through the full BullMQ/S3 ingestion
 * pipeline (that would require real file storage + a running worker); the
 * criterion is about the payload shape written by upsertPoints, which is the
 * single function every point-builder (ingestion.ts, rebuild-qdrant.ts) calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import { chunks } from '../../src/db/schema.js';
import { generateQdrantId } from '../../src/lib/idgen.js';
import { ensureCollection, upsertPoints, deletePoints } from '../../src/services/qdrant.js';
import { seedUser, seedDocument } from './helpers/seed.js';

const rawClient = new QdrantClient({ url: env.QDRANT_URL });
const COLLECTION = 'memory_bank';

describe('Qdrant upsert payload carries userId (plan §9 row 1)', () => {
  const pointIds: string[] = [];

  beforeAll(async () => {
    await ensureCollection();
  });

  afterAll(async () => {
    await deletePoints(pointIds);
    await pool.end();
  });

  it("each rebuilt/upserted point's payload.userId equals its document's user_id", async () => {
    const userA = await seedUser('qdrant-payload-a');
    const userB = await seedUser('qdrant-payload-b');
    const docA = await seedDocument(userA.id);
    const docB = await seedDocument(userB.id);

    const qdrantIdA = generateQdrantId(docA.id, 0);
    const qdrantIdB = generateQdrantId(docB.id, 0);
    pointIds.push(qdrantIdA, qdrantIdB);

    await db.insert(chunks).values([
      {
        documentId: docA.id,
        qdrantId: qdrantIdA,
        chunkIndex: 0,
        content: 'A content',
        tokenCount: 2,
      },
      {
        documentId: docB.id,
        qdrantId: qdrantIdB,
        chunkIndex: 0,
        content: 'B content',
        tokenCount: 2,
      },
    ]);

    // Real upsertPoints call against real Qdrant — the exact function every
    // point-builder (ingestion.ts, rebuild-qdrant.ts) uses.
    await upsertPoints([
      { id: qdrantIdA, vector: new Array(3072).fill(0.11), userId: docA.userId },
      { id: qdrantIdB, vector: new Array(3072).fill(0.22), userId: docB.userId },
    ]);

    // Fetch the raw points directly from Qdrant (with_payload: true) — proves
    // what was actually persisted, independent of qdrant.ts's own search path.
    const fetched = await rawClient.retrieve(COLLECTION, {
      ids: [qdrantIdA, qdrantIdB],
      with_payload: true,
    });

    const byId = new Map(fetched.map((p) => [String(p.id), p]));
    const pointA = byId.get(qdrantIdA);
    const pointB = byId.get(qdrantIdB);

    expect(pointA?.payload?.['userId']).toBe(docA.userId);
    expect(pointA?.payload?.['userId']).toBe(userA.id);
    expect(pointB?.payload?.['userId']).toBe(docB.userId);
    expect(pointB?.payload?.['userId']).toBe(userB.id);
    // The two users' points carry distinct userId payloads.
    expect(pointA?.payload?.['userId']).not.toBe(pointB?.payload?.['userId']);
  });
});
