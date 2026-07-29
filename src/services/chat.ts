import OpenAI from 'openai';
import type { FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { messages, chatSessions } from '../db/schema.js';
import { eq, desc, and, or, ne, sql } from 'drizzle-orm';
import { retrieve, type RetrievedChunk, type RetrievedDocument } from './retrieval.js';
import { classifyHistoryScope, type HistoryScope } from './queryClassifier.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { countTokens } from '../lib/tokenizer.js';

// ─── Client ────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of tokens to use for the assembled context block.
 * Leaves room for the system prompt, history, the user message, and the
 * model's response within GPT-4o's context window.
 */
const MAX_CONTEXT_TOKENS = 100_000;

/**
 * Default depth for the 'recent' history scope (today's original fixed
 * behavior). PLAN.md §Query Pipeline step 7.
 */
const HISTORY_DEPTH = 6;

/**
 * Token budget for the history block, checked whenever history-scope
 * classification resolves to more than HISTORY_DEPTH messages ('full_session'
 * or an explicit 'count'). Well under MAX_CONTEXT_TOKENS, leaving headroom
 * for the document context block + system prompt + response.
 */
const MAX_HISTORY_TOKENS = 20_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Source {
  chunkId?: string;
  documentId: string;
  documentName: string;
  score?: number;
  pageNumber?: number | null;
  content?: string;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a helpful assistant that answers questions based on the provided context documents.\n' +
  'When answering:\n' +
  '- Cite the source document name when referencing specific information.\n' +
  '- If the context is relevant but does not fully answer the question exactly, answer as best you can using the most closely related information in the documents — treat broader or adjacent facts as a fallback. Do not highlight what is missing; just answer from what is available. Never supplement with general knowledge.\n' +
  '- If the context contains no relevant information at all, say "I don\'t know based on the provided documents."\n' +
  '- Do not hallucinate or add information not present in the context.\n' +
  '- If anything in the conversation history conflicts with the context documents provided for this message, trust the context documents — they are freshly retrieved and authoritative, while prior conversation turns are not guaranteed to be accurate.';

/**
 * Instruction appended to the system prompt when retrieval only found chunks
 * by backing off below its primary score threshold (RetrievalResult.lowConfidence).
 * Steers the model toward hedging instead of answering as confidently as it
 * would on a normal, high-confidence retrieval.
 */
const LOW_CONFIDENCE_INSTRUCTION =
  '\n\nNote: the context above only cleared a relaxed relevance threshold — it may not closely match ' +
  "the question. If it doesn't clearly answer the question, say so explicitly and ask the user to " +
  'clarify or confirm relevance, rather than answering confidently.';

/**
 * Deterministic, app-authored reply used when retrieval finds no chunks at
 * all (even after the score-threshold backoff in retrieval.ts). Sent
 * directly instead of asking GPT-4o to generate a refusal, so an ungrounded
 * completion is never a possibility for this case — and because the text is
 * known-trustworthy, loadHistory() (below) exempts it from the
 * empty-sources history filter, unlike a model-authored "I don't know."
 *
 * Exported so the integration suite can assert against the exact text
 * loadHistory()'s SQL predicate matches on, rather than duplicating it.
 */
export const NO_RELEVANT_DOCS_MESSAGE =
  "I couldn't find any relevant documents for that question. Could you rephrase, or upload something related?";

// ─── Internal helpers ──────────────────────────────────────────────────────────

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return 'unknown size';
  return sizeBytes >= 1_048_576
    ? `${(sizeBytes / 1_048_576).toFixed(1)} MB`
    : `${(sizeBytes / 1024).toFixed(1)} KB`;
}

/**
 * Concatenate retrieved chunks into a single context string with source headers.
 * Chunks are assumed to be pre-sorted by score descending.
 * If the assembled text would exceed MAX_CONTEXT_TOKENS, the lowest-scored
 * chunks (tail of the array) are dropped until the total fits.
 */
function buildContextString(retrievedChunks: RetrievedChunk[]): string {
  const parts: string[] = [];
  let totalTokens = 0;

  for (const chunk of retrievedChunks) {
    let header = `--- Source: ${chunk.documentName} | Uploaded: ${chunk.createdAt.toISOString()} | Type: ${chunk.sourceType} | Format: ${chunk.mimeType} | Size: ${formatSize(chunk.sizeBytes)}`;
    if (chunk.startSecs !== null && chunk.endSecs !== null) {
      header += ` | Timestamp: ${formatTimestamp(chunk.startSecs)}–${formatTimestamp(chunk.endSecs)}`;
    }
    header += ` ---`;
    const part = `${header}\n${chunk.content}\n\n`;
    const partTokens = countTokens(part);

    if (totalTokens + partTokens > MAX_CONTEXT_TOKENS) {
      break;
    }

    parts.push(part);
    totalTokens += partTokens;
  }

  return parts.join('');
}

/**
 * Format a document list as a markdown table for the system prompt context.
 * Used when the query intent is list_documents.
 */
function buildDocumentListContext(docs: RetrievedDocument[]): string {
  if (docs.length === 0) {
    return '## Documents\n\nNo documents found matching the query.\n';
  }

  const header =
    '## Documents\n\n| Name | Uploaded | Source | Format | Size |\n|------|----------|--------|--------|------|\n';
  const rows = docs
    .map(
      (d) =>
        `| ${d.documentName} | ${d.createdAt.toISOString().split('T')[0]} | ${d.sourceType} | ${d.mimeType} | ${formatSize(d.sizeBytes)} |`,
    )
    .join('\n');

  return header + rows + '\n';
}

/**
 * Load chat history for the current session, resolving `historyScope` into a
 * concrete row limit ('recent' → HISTORY_DEPTH, 'count' → the extracted
 * count, 'full_session' → unbounded), then applying a token-budget guard so
 * an unbounded or large-count fetch can't blow past MAX_HISTORY_TOKENS. Rows
 * are fetched newest-first so truncation drops the oldest messages when over
 * budget, then reversed to chronological order for the completion request.
 *
 * Assistant rows with no retrieved sources are excluded at the query level
 * (not after fetching): an ungrounded reply is the likeliest place a
 * hallucination entered the conversation, and replaying it verbatim would
 * let the model treat it as established fact in later turns. Filtering in
 * SQL — rather than fetching `limit` rows and filtering in JS — means a
 * dropped row doesn't cost history depth: `LIMIT` applies to the
 * already-grounded row set, so 'recent'/'count' scopes backfill from older
 * grounded messages instead of silently returning fewer than `limit` rows.
 * User rows are always kept — `sources` is an assistant-only signal, never
 * populated on user messages, and a NULL/empty sources column excludes the
 * row (`jsonb_array_length` of NULL is NULL, which is falsy in SQL).
 *
 * One exemption: NO_RELEVANT_DOCS_MESSAGE also has empty `sources` (retrieval
 * genuinely found nothing), but unlike a model-authored empty-context reply
 * it is app-authored and therefore known-trustworthy — dropping it would
 * strip the only assistant turn between two user turns, leaving a follow-up
 * like "can you expand on that?" with no antecedent in the model's context
 * even though the user still sees the reply in the transcript. It's kept in
 * history so the model can correctly respond to that follow-up instead of
 * silently losing the thread. The empty-sources filter remains a safety net
 * for the residual case: a model reply that ignores the "say I don't know"
 * instruction over a genuinely empty context.
 *
 * Exported (not just used internally) so the integration suite can verify
 * this SQL predicate against a real Postgres — the unit-test suite mocks
 * `db` entirely and can't exercise real WHERE-clause evaluation.
 */
export async function loadHistory(sessionId: string, historyScope: HistoryScope) {
  const limit =
    historyScope.mode === 'recent'
      ? HISTORY_DEPTH
      : historyScope.mode === 'count'
        ? historyScope.count
        : undefined;

  const baseQuery = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        or(
          ne(messages.role, 'assistant'),
          sql`jsonb_array_length(${messages.sources}) > 0`,
          eq(messages.content, NO_RELEVANT_DOCS_MESSAGE),
        ),
      ),
    )
    .orderBy(desc(messages.createdAt));

  const rows = limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;

  const kept: (typeof rows)[number][] = [];
  let totalTokens = 0;

  for (const row of rows) {
    const rowTokens = countTokens(row.content);
    if (totalTokens + rowTokens > MAX_HISTORY_TOKENS) {
      break;
    }
    kept.push(row);
    totalTokens += rowTokens;
  }

  return kept.reverse();
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Handle a user message for the given session:
 *  1. Validates the session exists.
 *  2. Retrieves relevant chunks or document list from the store.
 *  3. Persists the user message.
 *  3b. If retrieval found zero chunks, short-circuits with
 *      NO_RELEVANT_DOCS_MESSAGE — no GPT-4o call.
 *  4. Streams a GPT-4o response via SSE (context flagged as low-confidence
 *     when retrieval only cleared the score-threshold backoff, not the
 *     primary threshold).
 *  5. Persists the assistant message with sources on stream completion.
 *
 * The caller (api-transport route) must NOT write to `reply` after this
 * function returns — the SSE stream is terminated inside this function.
 */
export async function streamChatResponse(
  userId: string,
  sessionId: string,
  userMessage: string,
  reply: FastifyReply,
): Promise<void> {
  // ── Step 1: Validate session ──────────────────────────────────────────────
  const sessionRows = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));

  if (sessionRows.length === 0) {
    throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);
  }

  // ── Step 2: Retrieve grounding context + classify history scope ──────────
  // Independent of each other — run in parallel.
  const [retrievalResult, historyScope] = await Promise.all([
    retrieve(userId, userMessage),
    classifyHistoryScope(userMessage),
  ]);

  // ── Step 3: Insert user message ──────────────────────────────────────────
  await db.insert(messages).values({
    sessionId,
    role: 'user',
    content: userMessage,
  });

  // ── Step 3b: Zero-chunk short-circuit ─────────────────────────────────────
  // Retrieval (including its own score-threshold backoff) found nothing at
  // all. Skip the GPT-4o call entirely rather than trust a freeform refusal —
  // see NO_RELEVANT_DOCS_MESSAGE for why. No streaming loop: emit the canned
  // text as a single delta, then done, matching the normal SSE shape below.
  if (retrievalResult.type === 'chunk_results' && retrievalResult.chunks.length === 0) {
    let messageId = '';
    try {
      const [inserted] = await db
        .insert(messages)
        .values({
          sessionId,
          role: 'assistant',
          content: NO_RELEVANT_DOCS_MESSAGE,
          sources: [] as unknown as Record<string, unknown>[],
        })
        .returning({ id: messages.id });
      messageId = inserted?.id ?? '';
    } catch (dbErr) {
      console.error('Failed to persist assistant message:', dbErr);
    }

    reply.raw.write(
      `data: ${JSON.stringify({ type: 'delta', content: NO_RELEVANT_DOCS_MESSAGE })}\n\n`,
    );
    reply.raw.write(`data: ${JSON.stringify({ type: 'done', messageId, sources: [] })}\n\n`);
    reply.raw.end();
    return;
  }

  // ── Step 4: Build context string ──────────────────────────────────────────
  let contextString: string;
  let sources: Source[];
  let lowConfidence = false;

  if (retrievalResult.type === 'document_list') {
    contextString = buildDocumentListContext(retrievalResult.documents);
    sources = retrievalResult.documents.map((d) => ({
      documentId: d.documentId,
      documentName: d.documentName,
    }));
  } else {
    contextString = buildContextString(retrievalResult.chunks);
    sources = retrievalResult.chunks.map((c) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      documentName: c.documentName,
      score: c.score,
      pageNumber: c.pageNumber,
      content: c.content,
    }));
    lowConfidence = retrievalResult.lowConfidence;
  }

  let systemContent =
    contextString.length > 0 ? `${SYSTEM_PROMPT}\n\n${contextString}` : SYSTEM_PROMPT;
  if (lowConfidence) {
    systemContent += LOW_CONFIDENCE_INSTRUCTION;
  }

  // ── Step 5: Load chat history per the classified scope ────────────────────
  const historyRows = await loadHistory(sessionId, historyScope);

  // ── Step 7: Open GPT-4o streaming completion ──────────────────────────────
  const systemMsg: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'system',
    content: systemContent,
  };

  const historyMsgs: OpenAI.Chat.ChatCompletionMessageParam[] = historyRows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
  }));

  const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'user',
    content: userMessage,
  };

  let fullResponse = '';

  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages: [systemMsg, ...historyMsgs, userMsg],
    });

    // ── Step 8: Forward delta tokens as SSE events ─────────────────────────
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta !== undefined && delta !== null) {
        fullResponse += delta;
        reply.raw.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
      }
    }
  } catch (streamErr) {
    // ── Step 10: Error mid-stream (headers already sent) ───────────────────
    console.error('OpenAI stream error:', streamErr);
    reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream error' })}\n\n`);
    reply.raw.end();
    return;
  }

  // ── Step 9: Persist assistant message and emit done event ─────────────────
  let messageId: string;
  try {
    const [inserted] = await db
      .insert(messages)
      .values({
        sessionId,
        role: 'assistant',
        content: fullResponse,
        sources: sources as unknown as Record<string, unknown>[],
      })
      .returning({ id: messages.id });

    messageId = inserted?.id ?? '';
  } catch (dbErr) {
    // Log but do not surface to the user — SSE must still close cleanly.
    console.error('Failed to persist assistant message:', dbErr);
    messageId = '';
  }

  reply.raw.write(
    `data: ${JSON.stringify({ type: 'done', messageId, sources, uncertain: lowConfidence })}\n\n`,
  );
  reply.raw.end();
}
