/**
 * Unit tests for src/services/chat.ts — streamChatResponse (Slice 2).
 *
 * There was no tests/unit/services/chat.test.ts before Slice 2
 * (streamChatResponse was only exercised via HTTP integration tests) — this
 * file is authored fresh per the slice plan §4/§9.
 *
 * External dependencies (db, retrieve, openai) are mocked — no real Postgres,
 * Qdrant, or OpenAI calls. The full HTTP-level cross-user 404 is covered by
 * tests/integration/ownership.test.ts; this file proves the *service-level*
 * defense-in-depth check (plan §3, §8 edge case #4).
 *
 * Criterion covered (plan §9):
 * `streamChatResponse` for a session owned by another user throws
 * SESSION_NOT_FOUND before any retrieval or OpenAI call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';

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
      _selectMock: selectMock,
    },
  };
});

import * as retrievalModule from '../../../src/services/retrieval.js';
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

beforeEach(() => {
  vi.resetAllMocks();
});

describe('streamChatResponse — cross-user session rejection (plan §3, §8 edge case #4)', () => {
  it('throws SESSION_NOT_FOUND when the session belongs to a different user, before retrieve() or OpenAI are called', async () => {
    // Session-existence query returns no row — the and(eq(id), eq(userId)) predicate
    // excludes a session owned by another user.
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
    expect(mockChatCreate).not.toHaveBeenCalled();
    // No SSE bytes were ever written for the rejected request.
    expect(reply.raw.write).not.toHaveBeenCalled();
    expect(reply.raw.end).not.toHaveBeenCalled();
  });

  it('proceeds past the session check (calls retrieve) when the session belongs to the caller', async () => {
    // 1st db.select() call: session-existence check — .from().where() is terminal.
    // 2nd db.select() call: chat history — .from().where().orderBy().limit() is terminal.
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ id: SESSION_OWNED_BY_A }]),
        } as unknown as ReturnType<typeof db.select>;
      }
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof db.select>;
    });
    vi.mocked(retrievalModule.retrieve).mockResolvedValue({ type: 'chunk_results', chunks: [] });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]) }),
    } as unknown as ReturnType<typeof db.insert>);
    mockChatCreate.mockResolvedValue((async function* () {})());

    const reply = mockReply();
    await streamChatResponse(USER_A, SESSION_OWNED_BY_A, 'hello', reply);

    expect(retrievalModule.retrieve).toHaveBeenCalledWith(USER_A, 'hello');
  });
});
