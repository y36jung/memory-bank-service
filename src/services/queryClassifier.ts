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
            "Use 'list_documents' when the user wants to enumerate or list which documents exist (e.g. 'what did I upload last week?', 'show me my files', 'list documents from January'). Use 'search_content' when the user wants to find information contained within documents.",
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
    "Use 'list_documents' when the user wants to enumerate or list documents. " +
    "Use 'search_content' when the user wants to find information within documents. " +
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
