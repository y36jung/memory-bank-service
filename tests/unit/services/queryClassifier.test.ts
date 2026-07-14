/**
 * Unit tests for src/services/queryClassifier.ts — classifyQuery,
 * classifyHistoryScope
 *
 * Mocks: openai, ../../../src/config/env.js
 * No real network calls.
 *
 * classifyHistoryScope criteria (AC-HS):
 * AC-HS-CQ-1: mode: 'recent' → { mode: 'recent' }
 * AC-HS-CQ-2: mode: 'full_session' → { mode: 'full_session' }
 * AC-HS-CQ-3: mode: 'count' with a count → { mode: 'count', count }
 * AC-HS-CQ-4: count above the max clamp is clamped down, not rejected
 * AC-HS-CQ-5: count below the min clamp is clamped up, not rejected
 * AC-HS-CQ-6: mode: 'count' with no count → degrades to { mode: 'recent' }
 * AC-HS-CQ-7: API error → degrades to { mode: 'recent' }
 * AC-HS-CQ-8: no tool call in response → degrades to { mode: 'recent' }
 * AC-HS-CQ-9: invalid JSON in tool call arguments → degrades to { mode: 'recent' }
 * AC-HS-CQ-10: tool_choice is set to 'required'
 *
 * Criteria covered (classifyQuery):
 * AC-CQ-1: tool_choice is set to 'required'
 * AC-CQ-2: returns null when LLM returns search_content with no filters (hasAnyFilter guard)
 * AC-CQ-3: returns null when LLM makes no tool call (choices[0].message has no tool_calls)
 * AC-CQ-4: extracts documentKeywords from tool call response (search_content intent)
 * AC-CQ-5: returns null on API error (degrades gracefully to vector-only)
 * AC-CQ-6: returns null on JSON parse failure in tool call arguments
 * AC-CQ-7: list_documents with date filters → returns { intent, filters }
 * AC-CQ-8: list_documents with no filters → still returns { intent, filters: null } (not null)
 * AC-CQ-9: currentDate is injected into the system prompt message sent to OpenAI
 * AC-CQ-10: search_content with no filters → returns null (degrades to pure vector)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock for openai.chat.completions.create
// ---------------------------------------------------------------------------

const { mockChatCreate } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('openai', () => {
  const OpenAI = vi.fn(() => ({
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: vi.fn() } },
  }));
  return { default: OpenAI };
});

// env is imported at module load time; mock it so no real env validation runs
// (setup.ts already populates process.env, but explicit mock prevents any side-effects)
vi.mock('../../../src/config/env.js', () => ({
  env: { OPENAI_API_KEY: 'sk-test-key' },
}));

import { classifyQuery, classifyHistoryScope } from '../../../src/services/queryClassifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DATE = '2026-06-20';

/**
 * Build a ChatCompletion response that contains a single function tool call.
 */
function makeToolCallResponse(argsObject: unknown) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'extract_metadata_filters',
                arguments: JSON.stringify(argsObject),
              },
            },
          ],
        },
      },
    ],
  };
}

/**
 * Build a ChatCompletion response with raw (non-JSON) arguments string.
 */
function makeRawArgsResponse(rawArguments: string) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'extract_metadata_filters',
                arguments: rawArguments,
              },
            },
          ],
        },
      },
    ],
  };
}

/**
 * Build a ChatCompletion response with no tool_calls (assistant text reply only).
 */
function makeNoToolCallResponse() {
  return {
    choices: [
      {
        message: {
          content: 'I cannot determine any metadata filters.',
          tool_calls: undefined,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// AC-CQ-1: tool_choice is set to 'required'
// ---------------------------------------------------------------------------

describe('AC-CQ-1: tool_choice is required', () => {
  it('calls openai.chat.completions.create with tool_choice = "required"', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'search_content', documentKeywords: ['test'] }),
    );

    await classifyQuery('what format is the foo document?', TEST_DATE);

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockChatCreate.mock.calls[0][0];
    expect(callArgs.tool_choice).toBe('required');
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-2: returns null when LLM returns search_content with no filters
// ---------------------------------------------------------------------------

describe('AC-CQ-2: search_content with no filters → null (hasAnyFilter guard)', () => {
  it('returns null when tool call returns { intent: search_content } with no filter fields', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ intent: 'search_content' }));

    const result = await classifyQuery('what is photosynthesis?', TEST_DATE);
    expect(result).toBeNull();
  });

  it('returns null when documentKeywords is an empty array', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'search_content', documentKeywords: [] }),
    );

    const result = await classifyQuery('tell me about anything', TEST_DATE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-3: returns null when no tool_calls in message
// ---------------------------------------------------------------------------

describe('AC-CQ-3: no tool_calls in message → null', () => {
  it('returns null when choices[0].message has no tool_calls', async () => {
    mockChatCreate.mockResolvedValue(makeNoToolCallResponse());

    const result = await classifyQuery('what is the capital of France?', TEST_DATE);
    expect(result).toBeNull();
  });

  it('returns null when choices array is empty', async () => {
    mockChatCreate.mockResolvedValue({ choices: [] });

    const result = await classifyQuery('any query', TEST_DATE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-4: extracts documentKeywords and filters (search_content intent)
// ---------------------------------------------------------------------------

describe('AC-CQ-4: extracts filters for search_content intent', () => {
  it('returns { intent, filters } with documentKeywords for search_content', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({
        intent: 'search_content',
        documentKeywords: ['world', 'destinations'],
      }),
    );

    const result = await classifyQuery(
      'what file format is the world destinations document?',
      TEST_DATE,
    );
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('search_content');
    expect(result?.filters?.documentKeywords).toEqual(['world', 'destinations']);
  });

  it('extracts uploadedAfter filter', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'search_content', uploadedAfter: '2024-01-01' }),
    );

    const result = await classifyQuery('documents uploaded after January 2024', TEST_DATE);
    expect(result).not.toBeNull();
    expect(result?.filters?.uploadedAfter).toBe('2024-01-01');
  });

  it('extracts sourceType filter', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'search_content', sourceType: 'gmail' }),
    );

    const result = await classifyQuery('emails from Gmail', TEST_DATE);
    expect(result).not.toBeNull();
    expect(result?.filters?.sourceType).toBe('gmail');
  });

  it('extracts combined documentKeywords + uploadedAfter filters', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({
        intent: 'search_content',
        documentKeywords: ['report'],
        uploadedAfter: '2024-06-01',
      }),
    );

    const result = await classifyQuery('report uploaded after June 2024', TEST_DATE);
    expect(result).not.toBeNull();
    expect(result?.filters?.documentKeywords).toEqual(['report']);
    expect(result?.filters?.uploadedAfter).toBe('2024-06-01');
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-5: returns null on API error (degrades gracefully)
// ---------------------------------------------------------------------------

describe('AC-CQ-5: API error → null (graceful degradation)', () => {
  it('returns null when openai.chat.completions.create rejects', async () => {
    mockChatCreate.mockRejectedValue(new Error('OpenAI 401 Unauthorized'));

    const result = await classifyQuery('some query', TEST_DATE);
    expect(result).toBeNull();
  });

  it('returns null when openai throws a network error', async () => {
    mockChatCreate.mockRejectedValue(new TypeError('fetch failed'));

    const result = await classifyQuery('another query', TEST_DATE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-6: returns null on JSON parse failure in tool call arguments
// ---------------------------------------------------------------------------

describe('AC-CQ-6: invalid JSON in tool call arguments → null', () => {
  it('returns null when tool_calls[0].function.arguments is invalid JSON', async () => {
    mockChatCreate.mockResolvedValue(makeRawArgsResponse('invalid json {{{'));

    const result = await classifyQuery('any query', TEST_DATE);
    expect(result).toBeNull();
  });

  it('returns null when tool call arguments is an empty string', async () => {
    mockChatCreate.mockResolvedValue(makeRawArgsResponse(''));

    const result = await classifyQuery('any query', TEST_DATE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-7: list_documents with date filters → returns classification
// ---------------------------------------------------------------------------

describe('AC-CQ-7: list_documents intent with date filters', () => {
  it('returns { intent: list_documents, filters } when LLM returns list intent with dates', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({
        intent: 'list_documents',
        uploadedAfter: '2026-06-13',
        uploadedBefore: '2026-06-20',
      }),
    );

    const result = await classifyQuery('what documents did I upload last week?', TEST_DATE);
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('list_documents');
    expect(result?.filters?.uploadedAfter).toBe('2026-06-13');
    expect(result?.filters?.uploadedBefore).toBe('2026-06-20');
  });

  it('returns list_documents with sourceType filter', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'list_documents', sourceType: 'gdrive' }),
    );

    const result = await classifyQuery('show me my Google Drive files', TEST_DATE);
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('list_documents');
    expect(result?.filters?.sourceType).toBe('gdrive');
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-8: list_documents with no filters → still returns classification (not null)
// ---------------------------------------------------------------------------

describe('AC-CQ-8: list_documents with no filters → classification returned', () => {
  it('returns { intent: list_documents, filters: null } when no filter fields are set', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ intent: 'list_documents' }));

    const result = await classifyQuery('what documents have I uploaded?', TEST_DATE);
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('list_documents');
    expect(result?.filters).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-9: currentDate is injected into the system prompt
// ---------------------------------------------------------------------------

describe('AC-CQ-9: currentDate is injected into the OpenAI system prompt', () => {
  it('includes currentDate in the system message content', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'search_content', documentKeywords: ['test'] }),
    );

    const testDate = '2026-06-20';
    await classifyQuery('some query', testDate);

    const callArgs = mockChatCreate.mock.calls[0][0];
    const systemMessage = callArgs.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage?.content).toContain(testDate);
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-10: search_content with no filters → null (pure vector fallback)
// ---------------------------------------------------------------------------

describe('AC-CQ-10: search_content with no filters → null', () => {
  it('returns null for a general content query with no metadata signals', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ intent: 'search_content' }));

    const result = await classifyQuery('explain what machine learning is', TEST_DATE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-11: filename / document-identity queries → list_documents
// (moved from RAGAS tc-22: these skip vector search entirely)
// ---------------------------------------------------------------------------

describe('AC-CQ-11: filename/document-identity queries → list_documents', () => {
  it('returns list_documents with documentKeywords for "what file contains X" queries', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({ intent: 'list_documents', documentKeywords: ['nutrition'] }),
    );

    const result = await classifyQuery(
      'What is the name of the file that contains information about nutrition?',
      TEST_DATE,
    );
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('list_documents');
    expect(result?.filters?.documentKeywords).toContain('nutrition');
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-12: upload-date metadata queries → list_documents
// (moved from RAGAS tc-23: upload date is in documents table, not chunks)
// ---------------------------------------------------------------------------

describe('AC-CQ-12: upload-date metadata queries → list_documents', () => {
  it('returns list_documents with documentKeywords for upload-date queries about a named doc', async () => {
    mockChatCreate.mockResolvedValue(
      makeToolCallResponse({
        intent: 'list_documents',
        documentKeywords: ['retirement', 'planning'],
      }),
    );

    const result = await classifyQuery(
      'When was the retirement planning document uploaded to the memory bank?',
      TEST_DATE,
    );
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('list_documents');
    expect(result?.filters?.documentKeywords).toEqual(
      expect.arrayContaining(['retirement', 'planning']),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-CQ-13: topic-based document enumeration → list_documents
// (moved from RAGAS tc-30: enumerating documents by topic skips vector search)
// ---------------------------------------------------------------------------

describe('AC-CQ-13: topic-based document enumeration → list_documents', () => {
  it('returns list_documents with filters: null for broad topic enumeration queries', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ intent: 'list_documents' }));

    const result = await classifyQuery(
      'Which documents in the memory bank are related to personal finance or investment?',
      TEST_DATE,
    );
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('list_documents');
    expect(result?.filters).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyHistoryScope
// ---------------------------------------------------------------------------

describe('AC-HS-CQ-1/2/3: extracts mode (and count) from the tool call', () => {
  it('returns { mode: "recent" } for mode: "recent"', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'recent' }));

    const result = await classifyHistoryScope('can you elaborate on that?');
    expect(result).toEqual({ mode: 'recent' });
  });

  it('returns { mode: "full_session" } for mode: "full_session"', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'full_session' }));

    const result = await classifyHistoryScope("list all the questions I've asked");
    expect(result).toEqual({ mode: 'full_session' });
  });

  it('returns { mode: "count", count } for mode: "count" with an explicit count', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'count', count: 7 }));

    const result = await classifyHistoryScope('what did I ask in the last 7 messages?');
    expect(result).toEqual({ mode: 'count', count: 7 });
  });
});

describe('AC-HS-CQ-4/5: count is clamped, not rejected, when out of range', () => {
  it('clamps a count above the max down to 500', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'count', count: 10_000 }));

    const result = await classifyHistoryScope('what did I ask in the last 10000 messages?');
    expect(result).toEqual({ mode: 'count', count: 500 });
  });

  it('clamps a non-integer count down to an integer within range', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'count', count: 3.7 }));

    const result = await classifyHistoryScope('what did I ask in the last few messages?');
    expect(result).toEqual({ mode: 'count', count: 3 });
  });
});

describe('AC-HS-CQ-6: mode "count" with no count degrades to recent', () => {
  it('returns { mode: "recent" } when mode is "count" but count is missing', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'count' }));

    const result = await classifyHistoryScope('some ambiguous query');
    expect(result).toEqual({ mode: 'recent' });
  });
});

describe('AC-HS-CQ-7: API error degrades to recent', () => {
  it('returns { mode: "recent" } when openai.chat.completions.create rejects', async () => {
    mockChatCreate.mockRejectedValue(new Error('OpenAI 401 Unauthorized'));

    const result = await classifyHistoryScope('some query');
    expect(result).toEqual({ mode: 'recent' });
  });
});

describe('AC-HS-CQ-8: no tool call degrades to recent', () => {
  it('returns { mode: "recent" } when choices[0].message has no tool_calls', async () => {
    mockChatCreate.mockResolvedValue(makeNoToolCallResponse());

    const result = await classifyHistoryScope('some query');
    expect(result).toEqual({ mode: 'recent' });
  });
});

describe('AC-HS-CQ-9: invalid JSON in tool call arguments degrades to recent', () => {
  it('returns { mode: "recent" } when tool_calls[0].function.arguments is invalid JSON', async () => {
    mockChatCreate.mockResolvedValue(makeRawArgsResponse('not valid json {{{'));

    const result = await classifyHistoryScope('some query');
    expect(result).toEqual({ mode: 'recent' });
  });
});

describe('AC-HS-CQ-10: tool_choice is required', () => {
  it('calls openai.chat.completions.create with tool_choice = "required"', async () => {
    mockChatCreate.mockResolvedValue(makeToolCallResponse({ mode: 'recent' }));

    await classifyHistoryScope('some query');

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockChatCreate.mock.calls[0][0];
    expect(callArgs.tool_choice).toBe('required');
  });
});
