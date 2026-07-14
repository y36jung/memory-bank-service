import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../config/env.js';

// ─── Client ────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MetadataFilters {
  documentKeywords?: string[]; // individual word tokens — NOT a phrase
  uploadedAfter?: string; // ISO date string e.g. "2024-01-01"
  uploadedBefore?: string; // ISO date string
  sourceType?: string; // 'upload' | 'gmail' | 'gdrive' | 'outlook' | 'onedrive'
  timeRangeStartSecs?: number; // seconds, for audio/video time queries
  timeRangeEndSecs?: number; // seconds
}

export type QueryIntent = 'list_documents' | 'search_content';

export interface QueryClassification {
  intent: QueryIntent;
  filters: MetadataFilters | null;
}

export type HistoryScope =
  | { mode: 'recent' }
  | { mode: 'full_session' }
  | { mode: 'count'; count: number };

// ─── Validation schema ─────────────────────────────────────────────────────────

// z.string().datetime() rejects date-only strings like "2024-01-01"; use refine instead.
const MetadataFiltersSchema = z
  .object({
    documentKeywords: z.array(z.string()).optional(),
    uploadedAfter: z
      .string()
      .refine((s) => !isNaN(Date.parse(s)), { message: 'invalid date' })
      .optional(),
    uploadedBefore: z
      .string()
      .refine((s) => !isNaN(Date.parse(s)), { message: 'invalid date' })
      .optional(),
    sourceType: z.enum(['upload', 'gmail', 'gdrive', 'outlook', 'onedrive']).optional(),
    timeRangeStartSecs: z.number().finite().nonnegative().optional(),
    timeRangeEndSecs: z.number().finite().nonnegative().optional(),
  })
  .strip();

// count is clamped, not rejected, when out of range — see classifyHistoryScope.
const HISTORY_SCOPE_COUNT_MIN = 1;
const HISTORY_SCOPE_COUNT_MAX = 500;

const HistoryScopeSchema = z
  .object({
    mode: z.enum(['recent', 'full_session', 'count']),
    count: z.number().finite().positive().optional(),
  })
  .strip();

const QueryClassificationSchema = z
  .object({
    intent: z.enum(['list_documents', 'search_content']),
    documentKeywords: z.array(z.string()).optional(),
    uploadedAfter: z
      .string()
      .refine((s) => !isNaN(Date.parse(s)), { message: 'invalid date' })
      .optional(),
    uploadedBefore: z
      .string()
      .refine((s) => !isNaN(Date.parse(s)), { message: 'invalid date' })
      .optional(),
    sourceType: z.enum(['upload', 'gmail', 'gdrive', 'outlook', 'onedrive']).optional(),
    timeRangeStartSecs: z.number().finite().nonnegative().optional(),
    timeRangeEndSecs: z.number().finite().nonnegative().optional(),
  })
  .strip();

// ─── Tool schema ───────────────────────────────────────────────────────────────

const EXTRACT_FILTERS_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'extract_metadata_filters',
    description:
      'Classify the user query and extract metadata filters. Always provide an intent. Return only filters you are confident about.',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['list_documents', 'search_content'],
          description:
            "Use 'list_documents' ONLY when the user wants to see which files/documents they own (e.g. 'what did I upload last week?', 'show me my files', 'list documents from January'). Use 'search_content' for ALL other queries — including any query that asks about content or data inside a named document, even if the query uses words like 'list', 'enumerate', or 'all the X in Y' (e.g. 'what countries are in the destinations CSV?', 'list all items in my nutrition guide', 'enumerate the steps in document X').",
        },
        documentKeywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Individual word tokens from a document name mentioned in the query. NOT a phrase — split into separate tokens. E.g. "world destination" → ["world", "destination"]. Also use this when the user asks about a named document\'s properties such as format, MIME type, or file size — extract the document name words as keywords.',
        },
        uploadedAfter: {
          type: 'string',
          description:
            'ISO date string (e.g. "2024-01-01") if the query specifies a lower bound on upload date. Resolve relative expressions like "last week" or "yesterday" using today\'s date.',
        },
        uploadedBefore: {
          type: 'string',
          description:
            'ISO date string (e.g. "2024-12-31") if the query specifies an upper bound on upload date. Resolve relative expressions using today\'s date.',
        },
        sourceType: {
          type: 'string',
          enum: ['upload', 'gmail', 'gdrive', 'outlook', 'onedrive'],
          description: 'Document source type if explicitly mentioned in the query.',
        },
        timeRangeStartSecs: {
          type: 'number',
          description:
            'Start of a time range in seconds, for audio/video queries like "between 1:00 and 2:00".',
        },
        timeRangeEndSecs: {
          type: 'number',
          description:
            'End of a time range in seconds, for audio/video queries like "between 1:00 and 2:00".',
        },
      },
      required: ['intent'],
    },
  },
};

const CLASSIFY_HISTORY_SCOPE_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'classify_history_scope',
    description:
      "Classify how much prior chat history from the CURRENT session should be included when answering the user's message. Always set mode.",
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['recent', 'full_session', 'count'],
          description:
            '\'recent\': the default — ordinary follow-ups with no explicit history request, e.g. "can you elaborate on that?", "what about the second one?". ' +
            '\'full_session\': the user wants to enumerate or recall the whole conversation with NO number stated, e.g. "list all the questions I\'ve asked", "what have we talked about in this session". ' +
            '\'count\': the query states an explicit number of prior messages/turns, e.g. "what did I ask in the last 7 messages", "summarize my previous 10 questions".',
        },
        count: {
          type: 'number',
          description:
            'The explicit number of prior messages requested. Set ONLY when mode is "count", and only to a number actually stated or clearly implied by the query — never guessed.',
        },
      },
      required: ['mode'],
    },
  },
};

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Calls GPT-4o-mini with a tool call to classify a query and extract metadata
 * filters. The currentDate parameter lets the LLM resolve relative temporal
 * expressions like "last week" into concrete ISO date strings.
 *
 * @param query       Natural-language query string.
 * @param currentDate ISO date string for today, e.g. "2026-06-20".
 * @returns QueryClassification if metadata or listing intent was detected, null otherwise.
 */
export async function classifyQuery(
  query: string,
  currentDate: string,
): Promise<QueryClassification | null> {
  const systemPrompt =
    `Today's date is ${currentDate}. Use this to resolve relative date expressions like "last week", "yesterday", or "this month" into ISO date strings.\n\n` +
    'Classify the user query and extract metadata filters. Always set the intent field. ' +
    "Use 'list_documents' ONLY when the user wants to enumerate or list the files/documents they own (e.g. 'what did I upload?', 'show me my files'). " +
    "Use 'search_content' for ALL other queries, including any query that asks about content inside a named document — even if the query contains words like 'list', 'enumerate', or 'all the X in Y' (those words refer to items within the document, not to the document itself). " +
    'Return only filters you are confident about. ' +
    "Return an empty object (with just the intent) if the query has no metadata filter intent (e.g. it's asking about content, " +
    'not about when/where/what-type a document is). documentKeywords must be individual word tokens, not phrases. ' +
    "When the user asks about a named document's properties (format, MIME type, size, upload date), extract the document name words as documentKeywords so the document can be located.";

  let response: OpenAI.ChatCompletion;
  try {
    response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 512,
      tools: [EXTRACT_FILTERS_TOOL],
      tool_choice: 'required',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
    });
  } catch (err) {
    // If the classifier fails, degrade gracefully to pure vector search.
    console.error('classifyQuery: OpenAI API error, falling back to vector-only search:', err);
    return null;
  }

  // Find the function tool call in the response.
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    return null;
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(toolCall.function.arguments);
  } catch {
    console.error(
      'classifyQuery: failed to parse tool call arguments, falling back to vector-only search',
    );
    return null;
  }

  const parseResult = QueryClassificationSchema.safeParse(rawInput);
  if (!parseResult.success) {
    console.error(
      'classifyQuery: invalid classification structure from LLM, falling back to vector-only:',
      parseResult.error.issues,
    );
    return null;
  }

  const { intent, ...filterFields } = parseResult.data;

  // Build the MetadataFilters object from the non-intent fields.
  const rawFilters = MetadataFiltersSchema.safeParse(filterFields);
  const filters: MetadataFilters | null = rawFilters.success
    ? (rawFilters.data as MetadataFilters)
    : null;

  const hasAnyFilter =
    filters !== null &&
    ((filters.documentKeywords !== undefined && filters.documentKeywords.length > 0) ||
      filters.uploadedAfter !== undefined ||
      filters.uploadedBefore !== undefined ||
      filters.sourceType !== undefined ||
      filters.timeRangeStartSecs !== undefined ||
      filters.timeRangeEndSecs !== undefined);

  // list_documents intent is always meaningful, even without specific filters
  // (means "show me all documents").
  if (intent === 'list_documents') {
    return { intent, filters: hasAnyFilter ? filters : null };
  }

  // search_content without any filters degrades to pure vector search.
  if (!hasAnyFilter) {
    return null;
  }

  return { intent, filters };
}

/**
 * Calls GPT-4o-mini with a tool call to classify how much prior chat history
 * (from the current session only) should be included when answering the
 * query. Degrades to `{ mode: 'recent' }` — today's fixed-depth behavior —
 * on any API error, parse error, or validation failure, so a classifier
 * outage never causes an unbounded history fetch.
 *
 * An explicit `count` is only ever extracted from a number stated in the
 * query text (e.g. "last 7 messages") — the LLM never has to invent a count,
 * since it has no way to know a session's true message total. That's why
 * "list all my questions" maps to 'full_session', not a guessed count.
 */
export async function classifyHistoryScope(query: string): Promise<HistoryScope> {
  const DEFAULT_SCOPE: HistoryScope = { mode: 'recent' };

  let response: OpenAI.ChatCompletion;
  try {
    response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 128,
      tools: [CLASSIFY_HISTORY_SCOPE_TOOL],
      tool_choice: 'required',
      messages: [{ role: 'user', content: query }],
    });
  } catch (err) {
    console.error('classifyHistoryScope: OpenAI API error, falling back to recent history:', err);
    return DEFAULT_SCOPE;
  }

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    return DEFAULT_SCOPE;
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(toolCall.function.arguments);
  } catch {
    console.error(
      'classifyHistoryScope: failed to parse tool call arguments, falling back to recent history',
    );
    return DEFAULT_SCOPE;
  }

  const parseResult = HistoryScopeSchema.safeParse(rawInput);
  if (!parseResult.success) {
    console.error(
      'classifyHistoryScope: invalid structure from LLM, falling back to recent history:',
      parseResult.error.issues,
    );
    return DEFAULT_SCOPE;
  }

  const { mode, count } = parseResult.data;

  if (mode === 'count') {
    if (count === undefined) return DEFAULT_SCOPE;
    const clamped = Math.min(
      Math.max(Math.trunc(count), HISTORY_SCOPE_COUNT_MIN),
      HISTORY_SCOPE_COUNT_MAX,
    );
    return { mode: 'count', count: clamped };
  }

  return { mode };
}
