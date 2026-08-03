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
 * AC-TITLE-1: first message on a default-titled session calls
 *             generateSessionTitle, persists the result, and emits a 'title'
 *             SSE event
 * AC-TITLE-2: generateSessionTitle is NOT called when the session already
 *             has messages
 * AC-TITLE-3: generateSessionTitle is NOT called when the session has a
 *             user-set (non-default) title, even on its first message
 * AC-TITLE-4: a null result from generateSessionTitle leaves the title
 *             untouched and emits no 'title' event
 *
 * NOT covered here: the anti-hallucination-compounding guard (excluding
 * assistant messages with no retrieved sources) lives in loadHistory()'s SQL
 * WHERE clause, not in JS — this suite mocks `db` entirely and its `where()`
 * stub is a pass-through, so it cannot exercise real predicate evaluation.
 * See tests/integration/chat-history-grounding.test.ts (real Postgres) for
 * that behavior, including the LIMIT-applies-after-filtering fix.
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

vi.mock('../../../src/db/index.js', () => {
  const selectMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(), // configured per-test
  };
  return {
    db: {
      select: vi.fn(() => selectMock),
      insert: vi.fn(),
      update: vi.fn(),
      _selectMock: selectMock,
    },
  };
});

vi.mock('../../../src/services/queryClassifier.js', () => ({
  classifyHistoryScope: vi.fn(),
  generateSessionTitle: vi.fn(),
}));

import * as retrievalModule from '../../../src/services/retrieval.js';
import * as queryClassifierModule from '../../../src/services/queryClassifier.js';
import { db } from '../../../src/db/index.js';
import { streamChatResponse, type Source } from '../../../src/services/chat.js';
import { AppError } from '../../../src/lib/errors.js';
import { DEFAULT_SESSION_TITLE } from '../../../src/db/schema.js';

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

// Defaults represent an established session (already has messages, custom
// title) — i.e. NOT eligible for auto-titling, so existing happy-path tests
// that don't care about titling are unaffected. Auto-title tests below pass
// explicit overrides to make the session look brand new.
function makeSessionOkChain(overrides: { title?: string; hasMessages?: boolean } = {}) {
  const { title = 'Some Existing Chat', hasMessages = true } = overrides;
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ id: SESSION_OWNED_BY_A, title, hasMessages }]),
  };
}

function makeUpdateChain() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  return { setMock, whereMock };
}

// A single non-empty, normal-confidence chunk — used by setupHappyPath so
// the zero-chunk short-circuit (which these history-focused tests don't
// exercise) never kicks in. See the dedicated short-circuit / low-confidence
// describe blocks below for those paths.
const MOCK_CHUNK = {
  chunkId: 'chunk-1',
  qdrantId: 'qdrant-1',
  documentId: 'doc-1',
  documentName: 'doc.txt',
  content: 'chunk content',
  score: 0.9,
  createdAt: new Date(),
  sourceType: 'upload',
  mimeType: 'text/plain',
  sizeBytes: null,
  pageNumber: null,
  startSecs: null,
  endSecs: null,
};

function setupHappyPath(
  historyRows: { role: string; content: string }[],
  scope: HistoryScope,
  retrievalResult: Awaited<ReturnType<typeof retrievalModule.retrieve>> = {
    type: 'chunk_results',
    chunks: [MOCK_CHUNK],
    lowConfidence: false,
  },
  sessionOverrides: { title?: string; hasMessages?: boolean } = {},
) {
  const { chain: historyChain, limitMock } = makeHistoryChain(historyRows);

  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return makeSessionOkChain(sessionOverrides) as unknown as ReturnType<typeof db.select>;
    }
    return historyChain as unknown as ReturnType<typeof db.select>;
  });

  vi.mocked(retrievalModule.retrieve).mockResolvedValue(retrievalResult);
  vi.mocked(queryClassifierModule.classifyHistoryScope).mockResolvedValue(scope);
  vi.mocked(queryClassifierModule.generateSessionTitle).mockResolvedValue(null);
  const valuesMock = vi
    .fn()
    .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]) });
  vi.mocked(db.insert).mockReturnValue({
    values: valuesMock,
  } as unknown as ReturnType<typeof db.insert>);
  const { setMock, whereMock: updateWhereMock } = makeUpdateChain();
  vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
  mockChatCreate.mockResolvedValue((async function* () {})());

  return { limitMock, valuesMock, setMock, updateWhereMock };
}

/** Parses the `data: {...}\n\n` SSE frames written to reply.raw.write into objects. */
function sseEventsWritten(reply: FastifyReply): Record<string, unknown>[] {
  return vi.mocked(reply.raw.write).mock.calls.map(([data]) => {
    const json = (data as string).replace(/^data: /, '').replace(/\n\n$/, '');
    return JSON.parse(json) as Record<string, unknown>;
  });
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

describe('AC-ZERO: zero-chunk short-circuit (no relevant documents found)', () => {
  it('skips the OpenAI call and persists/emits the canned message when retrieval finds zero chunks', async () => {
    const { valuesMock } = setupHappyPath(
      [],
      { mode: 'recent' },
      {
        type: 'chunk_results',
        chunks: [],
        lowConfidence: false,
      },
    );

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'something unrelated', reply);

    expect(mockChatCreate).not.toHaveBeenCalled();

    const events = sseEventsWritten(reply);
    expect(events).toHaveLength(2);
    expect(events[0]?.['type']).toBe('delta');
    expect(events[0]?.['content']).toContain("couldn't find any relevant documents");
    expect(events[1]).toMatchObject({ type: 'done', messageId: 'msg-1', sources: [] });
    expect(reply.raw.end).toHaveBeenCalled();

    // Persisted assistant message (the last db.insert().values() call) carries
    // the canned content and empty sources, not model output.
    const insertedValues = valuesMock.mock.calls.at(-1)?.[0] as {
      role: string;
      content: string;
      sources: unknown[];
    };
    expect(insertedValues.role).toBe('assistant');
    expect(insertedValues.content).toContain("couldn't find any relevant documents");
    expect(insertedValues.sources).toEqual([]);
  });
});

describe('AC-LOWCONF: low-confidence retrieval (score-threshold backoff) hedging', () => {
  it('appends the hedge instruction to the system prompt and marks the done event uncertain: true', async () => {
    setupHappyPath(
      [],
      { mode: 'recent' },
      {
        type: 'chunk_results',
        chunks: [MOCK_CHUNK],
        lowConfidence: true,
      },
    );

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'weakly matching query', reply);

    const callArgs = mockChatCreate.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const systemMessage = callArgs.messages[0];
    expect(systemMessage?.content).toContain('no strongly-matching documents were found');

    const events = sseEventsWritten(reply);
    const doneEvent = events.find((e) => e['type'] === 'done');
    expect(doneEvent).toMatchObject({ uncertain: true });
  });

  it('does not append the hedge instruction or set uncertain when retrieval is normal-confidence', async () => {
    setupHappyPath(
      [],
      { mode: 'recent' },
      {
        type: 'chunk_results',
        chunks: [MOCK_CHUNK],
        lowConfidence: false,
      },
    );

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'clearly matching query', reply);

    const callArgs = mockChatCreate.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const systemMessage = callArgs.messages[0];
    expect(systemMessage?.content).not.toContain('no strongly-matching documents were found');

    const events = sseEventsWritten(reply);
    const doneEvent = events.find((e) => e['type'] === 'done');
    expect(doneEvent).toMatchObject({ uncertain: false });
  });
});

describe('AC-TITLE-1: first message on a default-titled session auto-generates a title', () => {
  it('calls generateSessionTitle, persists the title, and emits a title SSE event', async () => {
    const { setMock, updateWhereMock } = setupHappyPath(
      [],
      { mode: 'recent' },
      { type: 'chunk_results', chunks: [MOCK_CHUNK], lowConfidence: false },
      { title: DEFAULT_SESSION_TITLE, hasMessages: false },
    );
    vi.mocked(queryClassifierModule.generateSessionTitle).mockResolvedValue('Trip Planning Ideas');

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'help me plan a trip', reply);

    expect(queryClassifierModule.generateSessionTitle).toHaveBeenCalledWith('help me plan a trip');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Trip Planning Ideas' }));
    expect(updateWhereMock).toHaveBeenCalled();

    const events = sseEventsWritten(reply);
    expect(events[0]).toEqual({ type: 'title', title: 'Trip Planning Ideas' });
  });
});

describe('AC-TITLE-2: no auto-title when the session already has messages', () => {
  it('does not call generateSessionTitle for a non-first message, even with a default title', async () => {
    const { setMock } = setupHappyPath(
      [],
      { mode: 'recent' },
      { type: 'chunk_results', chunks: [MOCK_CHUNK], lowConfidence: false },
      { title: DEFAULT_SESSION_TITLE, hasMessages: true },
    );

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'a follow-up message', reply);

    expect(queryClassifierModule.generateSessionTitle).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(sseEventsWritten(reply).some((e) => e['type'] === 'title')).toBe(false);
  });
});

describe('AC-TITLE-3: no auto-title when the session has a user-set title', () => {
  it('does not call generateSessionTitle on the first message if the title is not the default', async () => {
    const { setMock } = setupHappyPath(
      [],
      { mode: 'recent' },
      { type: 'chunk_results', chunks: [MOCK_CHUNK], lowConfidence: false },
      { title: 'My Custom Title', hasMessages: false },
    );

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'hello', reply);

    expect(queryClassifierModule.generateSessionTitle).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(sseEventsWritten(reply).some((e) => e['type'] === 'title')).toBe(false);
  });
});

describe('AC-TITLE-4: a null title result leaves the session untouched', () => {
  it('does not update the session or emit a title event when generateSessionTitle resolves null', async () => {
    const { setMock } = setupHappyPath(
      [],
      { mode: 'recent' },
      { type: 'chunk_results', chunks: [MOCK_CHUNK], lowConfidence: false },
      { title: DEFAULT_SESSION_TITLE, hasMessages: false },
    );
    vi.mocked(queryClassifierModule.generateSessionTitle).mockResolvedValue(null);

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'hello', reply);

    expect(queryClassifierModule.generateSessionTitle).toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(sseEventsWritten(reply).some((e) => e['type'] === 'title')).toBe(false);
  });
});

describe('AC-DEDUPE: sources are deduped by document', () => {
  it('collapses multiple chunks from the same document into one source, keeping the first (highest-scoring) chunk', async () => {
    const chunkA1 = { ...MOCK_CHUNK, chunkId: 'chunk-1', score: 0.9, content: 'best passage' };
    const chunkA2 = {
      ...MOCK_CHUNK,
      chunkId: 'chunk-2',
      score: 0.7,
      content: 'weaker passage',
    };
    const chunkB = {
      ...MOCK_CHUNK,
      chunkId: 'chunk-3',
      documentId: 'doc-2',
      documentName: 'other.txt',
      score: 0.8,
    };

    const { valuesMock } = setupHappyPath(
      [],
      { mode: 'recent' },
      {
        type: 'chunk_results',
        // Pre-sorted best-score-first, as rerank() guarantees.
        chunks: [chunkA1, chunkA2, chunkB],
        lowConfidence: false,
      },
    );

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'a query', reply);

    const events = sseEventsWritten(reply);
    const doneEvent = events.find((e) => e['type'] === 'done') as { sources: Source[] };
    expect(doneEvent.sources).toHaveLength(2);
    const docASource = doneEvent.sources.find((s) => s.documentId === 'doc-1');
    expect(docASource).toMatchObject({ chunkId: 'chunk-1', content: 'best passage' });

    // Persisted sources match what was emitted — reloading the session via
    // GET /chat/sessions/:id won't reproduce the duplicate.
    const insertedValues = valuesMock.mock.calls.at(-1)?.[0] as { sources: Source[] };
    expect(insertedValues.sources).toEqual(doneEvent.sources);
  });
});
