/**
 * Session auto-naming (src/services/chat.ts, Step 1/2/2b) — the "is this the
 * session's first message, with the default title still untouched" gate is
 * implemented as a Postgres EXISTS subquery joined into the session lookup
 * (`sql\`EXISTS (SELECT 1 FROM messages WHERE ...)\``), followed by a real
 * `db.update(chatSessions)` write on success. tests/unit/services/chat.test.ts
 * mocks `db` entirely (its `where()` stub is a pass-through), so it cannot
 * exercise the real EXISTS predicate or confirm the UPDATE actually lands —
 * verified here against a real Postgres instead, same rationale as
 * tests/integration/chat-history-grounding.test.ts for loadHistory()'s
 * jsonb_array_length predicate.
 *
 * retrieve(), classifyHistoryScope(), generateSessionTitle(), and the OpenAI
 * streaming completion are all mocked so this suite stays fast, deterministic,
 * and free of real API calls — the LLM-facing behavior of generateSessionTitle
 * itself (tool-call parsing, validation, graceful degradation) is already
 * covered by tests/unit/services/queryClassifier.test.ts. Mocking retrieve()
 * to return zero chunks also means every call here takes the zero-chunk
 * short-circuit (chat.ts Step 3b), so the real GPT-4o streaming call is never
 * reached either.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';

const { mockChatCreate, mockGenerateSessionTitle } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockGenerateSessionTitle: vi.fn(),
}));

vi.mock('openai', () => {
  const OpenAI = vi.fn(() => ({
    chat: { completions: { create: mockChatCreate } },
  }));
  return { default: OpenAI };
});

vi.mock('../../src/services/retrieval.js', () => ({
  retrieve: vi.fn().mockResolvedValue({ type: 'chunk_results', chunks: [], lowConfidence: false }),
}));

vi.mock('../../src/services/queryClassifier.js', () => ({
  classifyHistoryScope: vi.fn().mockResolvedValue({ mode: 'recent' }),
  generateSessionTitle: mockGenerateSessionTitle,
}));

import { streamChatResponse } from '../../src/services/chat.js';
import { db, pool } from '../../src/db/index.js';
import { chatSessions, DEFAULT_SESSION_TITLE } from '../../src/db/schema.js';
import { seedUser, seedChatSession } from './helpers/seed.js';

function mockReply(): FastifyReply {
  return { raw: { write: vi.fn(), end: vi.fn() } } as unknown as FastifyReply;
}

async function titleOf(sessionId: string) {
  const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  return row?.title;
}

describe('Session auto-naming — real Postgres EXISTS-subquery gate', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('first message on a default-titled session generates and persists a title', async () => {
    const user = await seedUser('auto-title-first');
    const session = await seedChatSession(user.id, { title: DEFAULT_SESSION_TITLE });
    mockGenerateSessionTitle.mockResolvedValueOnce('Trip Planning Ideas');

    await streamChatResponse(user.id, session.id, 'help me plan a trip', mockReply());

    expect(mockGenerateSessionTitle).toHaveBeenCalledWith('help me plan a trip');
    expect(await titleOf(session.id)).toBe('Trip Planning Ideas');
  });

  it('a second message does not retrigger title generation, and the title is unchanged', async () => {
    const user = await seedUser('auto-title-second');
    const session = await seedChatSession(user.id, { title: DEFAULT_SESSION_TITLE });
    mockGenerateSessionTitle.mockResolvedValueOnce('First Title');

    await streamChatResponse(user.id, session.id, 'first message', mockReply());
    mockGenerateSessionTitle.mockClear();

    await streamChatResponse(user.id, session.id, 'second message', mockReply());

    expect(mockGenerateSessionTitle).not.toHaveBeenCalled();
    expect(await titleOf(session.id)).toBe('First Title');
  });

  it('does not overwrite a user-set title, even on the first message', async () => {
    const user = await seedUser('auto-title-custom');
    const session = await seedChatSession(user.id, { title: 'My Custom Title' });

    await streamChatResponse(user.id, session.id, 'hello', mockReply());

    expect(mockGenerateSessionTitle).not.toHaveBeenCalled();
    expect(await titleOf(session.id)).toBe('My Custom Title');
  });
});
