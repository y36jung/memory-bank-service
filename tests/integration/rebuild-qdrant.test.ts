/**
 * Real Postgres + real Qdrant + real OpenAI (no mocks) — plan §9 row 5:
 *   "After `rebuild-qdrant.ts` runs, every point's payload `userId` matches
 *   its chunk's `documents.user_id`."
 *
 * Seeds chunks for two users directly in Postgres (bypassing the ingestion
 * pipeline — rebuild-qdrant.ts's whole point is to work from Postgres alone),
 * then actually runs `scripts/rebuild-qdrant.ts` as a real CLI invocation
 * (via `tsx`, exactly as `npm`/an operator would run it) against the
 * dedicated `mb_test_slice1` database, and spot-checks the resulting raw
 * Qdrant points.
 *
 * The script is run out-of-process (not imported directly) because its
 * module body unconditionally calls `main()` and closes the shared `pool` in
 * a `.finally()` — importing it in-process would tear down the pool used by
 * every other test in this file/suite (same hazard documented in
 * helpers/buildTestApp.ts for src/server.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import { chunks } from '../../src/db/schema.js';
import { generateQdrantId } from '../../src/lib/idgen.js';
import { ensureCollection, deletePoints } from '../../src/services/qdrant.js';
import { seedUser, seedDocument } from './helpers/seed.js';

const rawClient = new QdrantClient({ url: env.QDRANT_URL });
const COLLECTION = 'memory_bank';
const TEST_DB_URL = 'postgresql://memory_bank:dev-password@localhost:5432/mb_test_slice1';

describe('scripts/rebuild-qdrant.ts rebuilds userId payloads from Postgres (plan §9 row 5)', () => {
  const pointIds: string[] = [];

  beforeAll(async () => {
    await ensureCollection();
  });

  afterAll(async () => {
    await deletePoints(pointIds);
    await pool.end();
  });

  it("every rebuilt point's payload.userId matches its chunk's documents.user_id, for two distinct users", async () => {
    const userA = await seedUser('rebuild-a');
    const userB = await seedUser('rebuild-b');
    const docA = await seedDocument(userA.id, { originalName: 'rebuild-a-doc.txt' });
    const docB = await seedDocument(userB.id, { originalName: 'rebuild-b-doc.txt' });

    const qdrantIdA = generateQdrantId(docA.id, 0);
    const qdrantIdB = generateQdrantId(docB.id, 0);
    pointIds.push(qdrantIdA, qdrantIdB);

    await db.insert(chunks).values([
      {
        documentId: docA.id,
        qdrantId: qdrantIdA,
        chunkIndex: 0,
        content: 'Rebuild test content for user A.',
        tokenCount: 6,
      },
      {
        documentId: docB.id,
        qdrantId: qdrantIdB,
        chunkIndex: 0,
        content: 'Rebuild test content for user B.',
        tokenCount: 6,
      },
    ]);

    // Run the actual CLI script — same invocation an operator would use
    // (`tsx scripts/rebuild-qdrant.ts`) — against the dedicated test database.
    // It re-embeds and re-upserts EVERY chunk row currently in mb_test_slice1
    // (not just the two seeded above), which is the script's documented,
    // intentional full-rebuild behavior.
    const output = execFileSync('npx', ['tsx', 'scripts/rebuild-qdrant.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(output).toMatch(/\[rebuild-qdrant\] Done\./);

    const fetched = await rawClient.retrieve(COLLECTION, {
      ids: [qdrantIdA, qdrantIdB],
      with_payload: true,
    });
    const byId = new Map(fetched.map((p) => [String(p.id), p]));

    expect(byId.get(qdrantIdA)?.payload?.['userId']).toBe(userA.id);
    expect(byId.get(qdrantIdB)?.payload?.['userId']).toBe(userB.id);
    expect(byId.get(qdrantIdA)?.payload?.['userId']).not.toBe(
      byId.get(qdrantIdB)?.payload?.['userId'],
    );
  }, 130_000);
});
