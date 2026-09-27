/**
 * loadHistory() (src/services/chat.ts) — anti-hallucination-compounding
 * guard: assistant messages with no retrieved sources are excluded from
 * history at the SQL level (WHERE, not a post-fetch JS filter), so LIMIT
 * applies to the already-grounded row set. Verified here against a real
 * Postgres because tests/unit/services/chat.test.ts mocks `db` entirely and
 * its `where()` stub is a pass-through — it cannot exercise real predicate
 * evaluation (in particular `jsonb_array_length`).
 *
 * Also covers the two exemptions from that filter: NO_RELEVANT_DOCS_MESSAGE
 * (retrieval genuinely found nothing) and APP_INTRO_MESSAGE (the app's own
 * description) also have empty sources but are app-authored, not
 * model-authored, so they're known-trustworthy and kept in history — unlike an
 * arbitrary empty-sources reply, which is still dropped.
 *
 * Calls loadHistory() directly (not through streamChatResponse / the HTTP
 * route) so this suite never needs a real or mocked OpenAI call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadHistory,
  NO_RELEVANT_DOCS_MESSAGE,
  APP_INTRO_MESSAGE,
} from '../../src/services/chat.js';
import { seedUser, seedChatSession } from './helpers/seed.js';
import { db, pool } from '../../src/db/index.js';
import { messages } from '../../src/db/schema.js';

describe('loadHistory — SQL-level groundedness filter', () => {
  afterAll(async () => {
    await pool.end();
  });

  async function seedSession() {
    const user = await seedUser('history-grounding');
    const session = await seedChatSession(user.id);
    return session.id;
  }

  // Fixed base instant + index-based offsets give deterministic ordering
  // regardless of how fast inserts actually execute.
  const BASE = new Date('2026-01-01T00:00:00Z').getTime();
  function at(i: number) {
    return new Date(BASE + i * 1000);
  }

  async function insertTurn(
    sessionId: string,
    i: number,
    role: 'user' | 'assistant',
    content: string,
    sources?: unknown[],
  ) {
    await db.insert(messages).values({
      sessionId,
      role,
      content,
      createdAt: at(i),
      ...(sources !== undefined ? { sources: sources as Record<string, unknown>[] } : {}),
    });
  }

  it('excludes ungrounded assistant turns, keeps grounded ones and all user turns, in chronological order', async () => {
    const sessionId = await seedSession();
    await insertTurn(sessionId, 0, 'user', 'q1');
    await insertTurn(sessionId, 1, 'assistant', 'a1-grounded', [{ documentId: 'doc-1' }]);
    await insertTurn(sessionId, 2, 'user', 'q2');
    await insertTurn(sessionId, 3, 'assistant', 'a2-hallucinated', []);
    await insertTurn(sessionId, 4, 'user', 'q3');
    await insertTurn(sessionId, 5, 'assistant', 'a3-no-sources-field'); // sources omitted -> column default []

    const history = await loadHistory(sessionId, { mode: 'full_session' });

    expect(history.map((m) => m.content)).toEqual(['q1', 'a1-grounded', 'q2', 'q3']);
  });

  it("'count' scope backfills from older grounded turns instead of shrinking below the requested count", async () => {
    // Oldest turn is grounded; the two most recent turns are both
    // hallucinated (empty sources). A naive "LIMIT 4 raw rows, then filter"
    // would fetch only the newest 4 raw rows [a3, q3, a2, q2], drop both
    // assistant rows, and return just 2 messages — silently discarding the
    // older grounded turn (q1, a1) even though it was available. Filtering
    // in SQL before LIMIT must return all 4: [q1, a1, q2, q3].
    const sessionId = await seedSession();
    await insertTurn(sessionId, 0, 'user', 'q1');
    await insertTurn(sessionId, 1, 'assistant', 'a1-grounded', [{ documentId: 'doc-1' }]);
    await insertTurn(sessionId, 2, 'user', 'q2');
    await insertTurn(sessionId, 3, 'assistant', 'a2-hallucinated', []);
    await insertTurn(sessionId, 4, 'user', 'q3');
    await insertTurn(sessionId, 5, 'assistant', 'a3-hallucinated', []);

    const history = await loadHistory(sessionId, { mode: 'count', count: 4 });

    expect(history.map((m) => m.content)).toEqual(['q1', 'a1-grounded', 'q2', 'q3']);
  });

  it('keeps the canned NO_RELEVANT_DOCS_MESSAGE reply despite empty sources, but still drops an arbitrary empty-sources reply', async () => {
    const sessionId = await seedSession();
    await insertTurn(sessionId, 0, 'user', 'q1');
    // App-authored short-circuit reply — empty sources, but exempted by content match.
    await insertTurn(sessionId, 1, 'assistant', NO_RELEVANT_DOCS_MESSAGE, []);
    await insertTurn(sessionId, 2, 'user', 'q2 — can you expand on that?');
    // A different empty-sources reply (e.g. a model-authored hallucination) is still dropped.
    await insertTurn(sessionId, 3, 'assistant', 'a2-hallucinated', []);
    await insertTurn(sessionId, 4, 'user', 'q3');

    const history = await loadHistory(sessionId, { mode: 'full_session' });

    expect(history.map((m) => m.content)).toEqual([
      'q1',
      NO_RELEVANT_DOCS_MESSAGE,
      'q2 — can you expand on that?',
      'q3',
    ]);
  });

  it('keeps the canned APP_INTRO_MESSAGE reply but drops a model-authored identity follow-up', async () => {
    const sessionId = await seedSession();
    await insertTurn(sessionId, 0, 'user', 'who are you');
    // App-authored intro — empty sources, exempted by content match. Keeping it
    // is what lets an identity follow-up see the app was already described, so
    // it can say there's nothing more instead of repeating itself.
    await insertTurn(sessionId, 1, 'assistant', APP_INTRO_MESSAGE, []);
    await insertTurn(sessionId, 2, 'user', 'what else can you do?');
    // The follow-up's own reply is model-authored with empty sources, so it is
    // deliberately NOT exempted — later turns see the fixed intro and the
    // user's repeated asks, never the model's paraphrase of itself.
    await insertTurn(sessionId, 3, 'assistant', "That's everything I can share about the app.", []);
    await insertTurn(sessionId, 4, 'user', 'tell me more about this app');

    const history = await loadHistory(sessionId, { mode: 'full_session' });

    expect(history.map((m) => m.content)).toEqual([
      'who are you',
      APP_INTRO_MESSAGE,
      'what else can you do?',
      'tell me more about this app',
    ]);
  });
});
