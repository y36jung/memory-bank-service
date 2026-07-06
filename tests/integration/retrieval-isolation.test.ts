/**
 * Real Postgres + real Qdrant + real OpenAI (no mocks) — plan §9 row 3 / row 4
 * (the core acceptance criterion):
 *
 *   "Seed two users with disjoint documents/chunks; querying as user A never
 *   returns user B's content, even for a lexically matching query."
 *
 * Both users' seeded chunks share the EXACT SAME content text (and therefore,
 * once embedded, the exact same — or near-identical — vector). This is the
 * strongest form of the criterion: even a perfect lexical/semantic match on
 * user B's content must never surface for user A, because the Qdrant `must`
 * userId filter excludes B's point from the candidate set before scoring, and
 * the Postgres hydration query's `eq(documents.userId, userId)` predicate is
 * an independent second gate (plan §3, §8 edge case #1).
 *
 * Also covers plan §9 row 3's list_documents path: `retrieveDocuments` scopes
 * by userId even when the query intent is "list my documents" rather than a
 * content search.
 *
 * This suite makes real OpenAI calls (classifyQuery, HyDE, batchEmbed) — kept
 * to a minimum (one shared embedding reused for both users' identical
 * content) to bound cost/latency while still exercising the full retrieve()
 * pipeline with zero mocks, per PLAN.md §M1 Deliverables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, pool } from '../../src/db/index.js';
import { chunks, documents } from '../../src/db/schema.js';
import { generateQdrantId } from '../../src/lib/idgen.js';
import { batchEmbed } from '../../src/services/embeddings.js';
import { ensureCollection, upsertPoints, deletePoints } from '../../src/services/qdrant.js';
import { retrieve, retrieveChunks } from '../../src/services/retrieval.js';
import { seedUser, seedDocument } from './helpers/seed.js';

const SHARED_SECRET_CONTENT =
  'The confidential Q3 rollout codename is BlueFalcon-99 and the launch date is locked.';

describe('Two-user Qdrant + Postgres isolation, even for a lexically matching query (plan §9 core criterion)', () => {
  const pointIds: string[] = [];

  beforeAll(async () => {
    await ensureCollection();
  });

  afterAll(async () => {
    await deletePoints(pointIds);
    await pool.end();
  });

  it("user A's retrieveChunks() query never returns user B's content, even when both users' chunks are lexically identical", async () => {
    const userA = await seedUser('isolation-a');
    const userB = await seedUser('isolation-b');
    const docA = await seedDocument(userA.id, { originalName: 'a-report.txt' });
    const docB = await seedDocument(userB.id, { originalName: 'b-report.txt' });

    const qdrantIdA = generateQdrantId(docA.id, 0);
    const qdrantIdB = generateQdrantId(docB.id, 0);
    pointIds.push(qdrantIdA, qdrantIdB);

    await db.insert(chunks).values([
      {
        documentId: docA.id,
        qdrantId: qdrantIdA,
        chunkIndex: 0,
        content: SHARED_SECRET_CONTENT,
        tokenCount: 20,
      },
      {
        documentId: docB.id,
        qdrantId: qdrantIdB,
        chunkIndex: 0,
        content: SHARED_SECRET_CONTENT, // identical text — perfect lexical match
        tokenCount: 20,
      },
    ]);

    // One real embedding call, reused for both points — both users' vectors
    // are therefore IDENTICAL, which is the strongest possible test of the
    // userId filter: even a zero-distance match on B's point must not surface.
    const [vector] = await batchEmbed([SHARED_SECRET_CONTENT]);
    if (!vector) throw new Error('test setup: embedding failed');

    await upsertPoints([
      { id: qdrantIdA, vector, userId: docA.userId },
      { id: qdrantIdB, vector, userId: docB.userId },
    ]);

    // Real retrieve() pipeline: real classifyQuery + HyDE + batchEmbed (OpenAI),
    // real searchPoints (Qdrant), real Postgres hydration.
    const resultsAsA = await retrieveChunks(
      userA.id,
      'What is the confidential Q3 rollout codename?',
    );

    expect(resultsAsA.length).toBeGreaterThan(0);
    for (const chunk of resultsAsA) {
      expect(chunk.documentId).not.toBe(docB.id);
    }
    // A's own content must be present — proves this isn't just an empty result set.
    expect(resultsAsA.some((c) => c.documentId === docA.id)).toBe(true);

    // Symmetric check: querying as B never returns A's content.
    const resultsAsB = await retrieveChunks(
      userB.id,
      'What is the confidential Q3 rollout codename?',
    );
    expect(resultsAsB.length).toBeGreaterThan(0);
    for (const chunk of resultsAsB) {
      expect(chunk.documentId).not.toBe(docA.id);
    }
    expect(resultsAsB.some((c) => c.documentId === docB.id)).toBe(true);
  }, 30_000);

  it("list_documents intent: retrieve() scopes retrieveDocuments() by userId — A never sees B's documents", async () => {
    const userA = await seedUser('isolation-list-a');
    const userB = await seedUser('isolation-list-b');
    await seedDocument(userA.id, { originalName: 'alpha-notes.txt' });
    await seedDocument(userB.id, { originalName: 'beta-notes.txt' });

    const result = await retrieve(userA.id, 'What documents have I uploaded so far?');

    expect(result.type).toBe('document_list');
    if (result.type === 'document_list') {
      expect(result.documents.length).toBeGreaterThan(0);
      const names = result.documents.map((d) => d.documentName);
      expect(names).not.toContain('beta-notes.txt');
    }
  }, 30_000);
});
