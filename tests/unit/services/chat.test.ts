/**
 * Unit tests for src/services/chat.ts — streamChatResponse (Slice 2, + dynamic
 * history scope).
 *
 * External dependencies (db, retrieve, classifyHistoryScope, openai,
 * countTokens) are mocked — no real Postgres, Qdrant, or OpenAI calls.
 * The full HTTP-level cross-user 404 is covered by
 * tests/integration/ownership.test.ts; this file proves the *service-level*
 * defense-in-depth check (plan §3, §8 edge case #4), plus the dynamic
 * history-scope wiring (recent / full_session / count → loadHistory()).
 *
 * Criteria covered:
 * `streamChatResponse` for a session owned by another user throws
 * SESSION_NOT_FOUND before any retrieval, classification, or OpenAI call.
 * AC-HS-1: 'recent' scope queries with LIMIT = HISTORY_DEPTH (6)
 * AC-HS-2: 'full_session' scope queries with no LIMIT and includes every
 *          message when under the token budget
 * AC-HS-3: 'count' scope queries with LIMIT = the extracted count
 * AC-HS-4: history over MAX_HISTORY_TOKENS is truncated, dropping the oldest
 *          messages first (most-recent-preserved)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { HistoryScope } from '../../../src/services/queryClassifier.js';

const { mockChatCreate } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
}));

vi.mock('openai', () => {
  const OpenAI = vi.fn(() => ({
    chat: { completions: { create: mockChatCreate } },
  }));
  return { default: OpenAI };
});

vi.mock('../../../src/services/retrieval.js', () => ({
  retrieve: vi.fn(),
}));

vi.mock('../../../src/services/queryClassifier.js', () => ({
  classifyHistoryScope: vi.fn(),
}));

vi.mock('../../../src/db/index.js', () => {
  const selectMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(), // configured per-test
  };
  return {
    db: {
      select: vi.fn(() => selectMock),
      insert: vi.fn(),
      _selectMock: selectMock,
    },
  };
});

import * as retrievalModule from '../../../src/services/retrieval.js';
import * as queryClassifierModule from '../../../src/services/queryClassifier.js';
import { db } from '../../../src/db/index.js';
import { streamChatResponse } from '../../../src/services/chat.js';
import { AppError } from '../../../src/lib/errors.js';

const USER_A = 'user-a-11111111-1111-1111-1111-111111111111';
const USER_B = 'user-b-22222222-2222-2222-2222-222222222222';
const SESSION_OWNED_BY_A = 'session-33333333-3333-3333-3333-333333333333';

function mockReply(): FastifyReply {
  return {
    raw: { write: vi.fn(), end: vi.fn() },
  } as unknown as FastifyReply;
}

/**
 * Builds a mock chain for the Step 5 history query:
 * .select().from().where().orderBy() — the result is BOTH directly awaitable
 * (for the unbounded 'full_session' path) AND has a chainable .limit() (for
 * the 'recent'/'count' paths), mirroring Drizzle's thenable query builder.
 */
function makeHistoryChain(unboundedRows: { role: string; content: string }[]) {
  const limitMock = vi.fn().mockResolvedValue(unboundedRows);
  const orderByResult = Object.assign(Promise.resolve(unboundedRows), { limit: limitMock });
  return {
    chain: {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue(orderByResult),
    },
    limitMock,
  };
}

function makeSessionOkChain() {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ id: SESSION_OWNED_BY_A }]),
  };
}

function setupHappyPath(historyRows: { role: string; content: string }[], scope: HistoryScope) {
  const { chain: historyChain, limitMock } = makeHistoryChain(historyRows);

  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return makeSessionOkChain() as unknown as ReturnType<typeof db.select>;
    }
    return historyChain as unknown as ReturnType<typeof db.select>;
  });

  vi.mocked(retrievalModule.retrieve).mockResolvedValue({ type: 'chunk_results', chunks: [] });
  vi.mocked(queryClassifierModule.classifyHistoryScope).mockResolvedValue(scope);
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]) }),
  } as unknown as ReturnType<typeof db.insert>);
  mockChatCreate.mockResolvedValue((async function* () {})());

  return { limitMock };
}

function historyMessagesSentToOpenAI(): { role: string; content: string }[] {
  const callArgs = mockChatCreate.mock.calls[0]?.[0] as {
    messages: { role: string; content: string }[];
  };
  // [system, ...history, user] — strip the system message (index 0) and the
  // trailing user message (last index).
  return callArgs.messages.slice(1, -1);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('streamChatResponse — cross-user session rejection (plan §3, §8 edge case #4)', () => {
  it('throws SESSION_NOT_FOUND when the session belongs to a different user, before retrieve(), classifyHistoryScope(), or OpenAI are called', async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as unknown as ReturnType<typeof db.select>);

    const reply = mockReply();

    await expect(
      streamChatResponse(USER_B, SESSION_OWNED_BY_A, 'hello', reply),
    ).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      message: 'Session not found',
      statusCode: 404,
    });

    await expect(
      streamChatResponse(USER_B, SESSION_OWNED_BY_A, 'hello', mockReply()),
    ).rejects.toBeInstanceOf(AppError);

    expect(retrievalModule.retrieve).not.toHaveBeenCalled();
    expect(queryClassifierModule.classifyHistoryScope).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(reply.raw.write).not.toHaveBeenCalled();
    expect(reply.raw.end).not.toHaveBeenCalled();
  });

  it('proceeds past the session check (calls retrieve and classifyHistoryScope) when the session belongs to the caller', async () => {
    setupHappyPath([], { mode: 'recent' });

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'hello', reply);

    expect(retrievalModule.retrieve).toHaveBeenCalledWith(USER_A, 'hello');
    expect(queryClassifierModule.classifyHistoryScope).toHaveBeenCalledWith('hello');
  });
});

describe('AC-HS-1: recent scope queries with LIMIT = HISTORY_DEPTH', () => {
  it('calls .limit(6) when classifyHistoryScope resolves to { mode: "recent" }', async () => {
    const { limitMock } = setupHappyPath(
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
      { mode: 'recent' },
    );

    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'follow-up', mockReply());

    expect(limitMock).toHaveBeenCalledWith(6);
  });
});

describe('AC-HS-2: full_session scope fetches unbounded history', () => {
  it('does not call .limit(), includes every message, and restores chronological order', async () => {
    // The DB query orders DESC (newest first) — index 0 is newest, index 8 oldest.
    const rowsNewestFirst = Array.from({ length: 9 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-newest-minus-${i}`,
    }));
    const { limitMock } = setupHappyPath(rowsNewestFirst, { mode: 'full_session' });

    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'list all my questions', mockReply());

    expect(limitMock).not.toHaveBeenCalled();
    const sentHistory = historyMessagesSentToOpenAI();
    expect(sentHistory).toHaveLength(9);
    // Reversed to chronological order: oldest (index 8) first, newest (index 0) last.
    expect(sentHistory.map((m) => m.content)).toEqual(
      rowsNewestFirst
        .slice()
        .reverse()
        .map((r) => r.content),
    );
  });
});

describe('AC-HS-3: count scope queries with LIMIT = the extracted count', () => {
  it('calls .limit(7) when classifyHistoryScope resolves to { mode: "count", count: 7 }', async () => {
    const { limitMock } = setupHappyPath([{ role: 'user', content: 'q1' }], {
      mode: 'count',
      count: 7,
    });

    await streamChatResponse(
      USER_A,
      SESSION_OWNED_BY_A,
      'what did I ask in the last 7 messages',
      mockReply(),
    );

    expect(limitMock).toHaveBeenCalledWith(7);
  });
});

describe('AC-HS-4: history over MAX_HISTORY_TOKENS is truncated, most-recent-preserved', () => {
  it('drops the oldest messages first when the full session exceeds the token budget', async () => {
    // 9 messages, newest-first as the DB would return them (DESC), each
    // ~3000 tokens (a long repeated word makes token counting predictable
    // enough without mocking the tokenizer): 9 * 3000 = 27000 > 20000 budget,
    // so only the newest ~6 fit.
    const longContent = 'token '.repeat(3000);
    const rowsNewestFirst = Array.from({ length: 9 }, (_, i) => ({
      role: 'user',
      content: `${longContent}#${i}`, // #0 = newest, #8 = oldest
    }));
    setupHappyPath(rowsNewestFirst, { mode: 'full_session' });

    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'list all my questions', mockReply());

    const sentHistory = historyMessagesSentToOpenAI();
    expect(sentHistory.length).toBeGreaterThan(0);
    expect(sentHistory.length).toBeLessThan(9);
    // Kept messages must be the newest ones (#0 is newest and must survive;
    // #8 is oldest and must have been dropped).
    expect(sentHistory[sentHistory.length - 1]?.content).toContain('#0');
    expect(sentHistory.some((m) => m.content.includes('#8'))).toBe(false);
  });
});
