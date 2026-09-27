import OpenAI from 'openai';
import type { FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { messages, chatSessions, DEFAULT_SESSION_TITLE } from '../db/schema.js';
import { eq, desc, and, or, ne, inArray, exists, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { retrieve, type RetrievedChunk, type RetrievedDocument } from './retrieval.js';
import {
  classifyHistoryScope,
  generateSessionTitle,
  type HistoryScope,
} from './queryClassifier.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { countTokens } from '../lib/tokenizer.js';
import { timed } from '../lib/timing.js';

// ─── Client ────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Driverless builder for correlated subqueries embedded in a select field list
 * (see the EXISTS flags in streamChatResponse's Step 1). Deliberately not `db`:
 * these subqueries are only ever compiled into an enclosing statement, never
 * executed on their own, so they need no connection.
 */
const qb = new QueryBuilder();

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

// ─── App identity ─────────────────────────────────────────────────────────────

/**
 * The app's own description — the ONLY thing this assistant may say that isn't
 * grounded in the user's documents. Everything the model is allowed to know
 * about Memory Bank is in this string: it is both the canned first-turn reply
 * (see the app_identity branch in streamChatResponse) and the sole permitted
 * source for APP_IDENTITY_IN_CONVERSATION_PROMPT below.
 *
 * Kept deliberately factual about what the app actually supports (the formats
 * listed match src/services/extractor/) — the model has no other information to
 * fall back on, so anything absent here is something it must decline to answer.
 *
 * Exported so tests and loadHistory() below can match on the exact text.
 */
export const APP_INTRO_MESSAGE =
  "I'm the Memory Bank assistant — an AI agent for your personal knowledge base. You upload " +
  'documents here (PDFs, Word docs, spreadsheets, web pages, images, audio and video), I index ' +
  'them, and then I answer your questions using only what those documents actually say, citing ' +
  "the sources I used. I don't answer from general knowledge — if something isn't in your uploads, " +
  "I'll tell you rather than guess. Ask me about anything you've uploaded, or ask what's in your " +
  'library to get started.';

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a helpful assistant that answers questions based on the provided context documents.\n' +
  'When answering:\n' +
  '- Every fact, topic, and section in your answer must come from the provided context documents. Never fill in a fact, subtopic, or section from outside/general knowledge — even one that would normally be expected in a complete answer to this kind of question.\n' +
  '- If the context is relevant but does not fully answer the question exactly, use the most closely related information actually present in the documents as a fallback. Do not invent related facts that are not present.\n' +
  '- If the question is a broad or open-ended request (e.g. "help me prepare for X", "give me an overview of X"), organize and synthesize the document content related to the topic, even if no single passage directly answers the request as phrased. But only include the aspects of the topic the documents actually cover — if the documents are silent on part of the question, briefly say so for that part instead of inventing content to make the answer feel complete.\n' +
  '- Say "I don\'t know based on the provided documents." — for the whole question, or for the specific part — whenever the documents lack relevant information to answer it, not only when the documents are unrelated to the topic entirely.\n' +
  '- Do not hallucinate or add information not present in the context.\n' +
  "- If the context documents give different values or claims for the same fact, do not silently pick one — state all differing values and attribute each to its source, even if the question doesn't explicitly ask you to compare documents.\n" +
  '- If anything in the conversation history conflicts with the context documents provided for this message, trust the context documents — they are freshly retrieved and authoritative, while prior conversation turns are not guaranteed to be accurate.\n' +
  '- The single exception to the rule that every fact must come from the context documents: if the user asks who or what you are, what this app is, or what you can do, answer from this description of yourself instead — "' +
  APP_INTRO_MESSAGE +
  '" Never describe yourself as a general-purpose assistant, and never name the model or company behind you.';

/**
 * Used instead of SYSTEM_PROMPT when classifyQuery() routed the message to the
 * app_identity intent and the session already has prior messages. The cold-open
 * case never gets here — it's answered with APP_INTRO_MESSAGE verbatim and never
 * reaches the model at all (see Step 3a).
 *
 * Mid-conversation, an identity question is not self-evidently about the app:
 * "what is this?" right after a discussion of API design far more likely means
 * the API design than Memory Bank. So the model's first job is to judge, against
 * the conversation, whether the question is even unambiguous — and to ask rather
 * than guess when it isn't. Reciting the app description over a question that
 * meant something else is the failure this prompt exists to prevent.
 *
 * The description is also the model's entire knowledge of the app, so a request
 * for more than it contains has to be answered by saying there is no more, not
 * by inventing plausible product features.
 */
const APP_IDENTITY_IN_CONVERSATION_PROMPT =
  'You are the Memory Bank assistant. The user has asked something that may be about you or about ' +
  'this app, but this conversation is already underway, so the question may not mean what it would ' +
  'mean in isolation.\n\n' +
  'The following description is the ONLY information you have about this app — you know nothing ' +
  'else about its features, pricing, limits, who built it, or how it works internally:\n\n' +
  APP_INTRO_MESSAGE +
  '\n\nDecide which of these three situations applies, judging against the conversation so far:\n' +
  '1. The question could plausibly refer to a topic discussed earlier in this conversation rather ' +
  'than to the app itself — e.g. "what is this?", "what does this do?", "tell me more about this" ' +
  'after discussing a document. Do NOT answer and do NOT describe the app. Ask one short question ' +
  'to disambiguate, naming both readings concretely: the specific earlier topic, and this app ' +
  "itself. Then stop and wait for the user's answer.\n" +
  '2. The question can only be about you or this app — e.g. "who are you?", "what is Memory Bank?", ' +
  'or the user has just clarified that they meant the app — and the description above has not yet ' +
  'been given in this conversation. Answer from the description.\n' +
  '3. The description has already been given in this conversation and the user is asking for more ' +
  'about the app. Tell them plainly that this is everything you can share about the app itself, ' +
  'and invite them to ask about their uploaded documents instead. Do not repeat the description ' +
  'verbatim, and do not pad the answer with new claims to make it feel complete.\n\n' +
  'If the user asks something about the app the description does not cover, say you do not have ' +
  'that information. Never invent features, integrations, pricing, or technical details. Never ' +
  'describe yourself as a general-purpose assistant, and never name the model or company behind you.';

/**
 * Instruction appended to the system prompt when retrieval flags low
 * confidence (RetrievalResult.lowConfidence) — either because the vector
 * search backed off below its primary score threshold, or because the
 * best-matching chunk's post-rerank score was weak against the raw query.
 * Steers the model toward hedging instead of answering as confidently as it
 * would on a normal, high-confidence retrieval.
 */
const LOW_CONFIDENCE_INSTRUCTION =
  '\n\nNote: no strongly-matching documents were found for this question — the context above only ' +
  'weakly relates to it. Let the user know upfront that you could not find highly relevant documents ' +
  "and that the answer below is uncertain as a result. If the context doesn't clearly answer the " +
  'question, say so explicitly and ask the user to clarify or confirm relevance, rather than answering confidently.';

/**
 * Deterministic, app-authored reply used when retrieval finds no chunks at
 * all — either nothing cleared the score-threshold backoff, or nothing cleared
 * RERANK_IRRELEVANCE_THRESHOLD, i.e. the question is neither about the app nor
 * answerable from anything the user uploaded. Sent directly instead of asking
 * GPT-4o to generate a refusal, so an ungrounded completion is never a
 * possibility for this case — and because the text is known-trustworthy,
 * loadHistory() (below) exempts it from the empty-sources history filter,
 * unlike a model-authored "I don't know."
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
 * Collapses sources to one entry per document, keeping the first occurrence.
 * Chunk-based sources are already sorted best-score-first (rerank()), so this
 * keeps the highest-scoring chunk's snippet/page/score per document instead
 * of showing the same document once per matching chunk.
 */
function dedupeSourcesByDocument(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const result: Source[] = [];
  for (const source of sources) {
    if (seen.has(source.documentId)) continue;
    seen.add(source.documentId);
    result.push(source);
  }
  return result;
}

/**
 * Persist and emit a fixed, app-authored reply, bypassing GPT-4o entirely.
 * Used for the two answers the app knows in advance — APP_INTRO_MESSAGE and
 * NO_RELEVANT_DOCS_MESSAGE — so neither can be reworded, hedged, or drifted by
 * the model. Emits the text as a single `delta` followed by `done`, matching the
 * SSE shape of a streamed reply, so clients need no special case.
 *
 * `sources` is always empty here; both strings are exempted from
 * loadHistory()'s empty-sources filter precisely because they are app-authored.
 * A persistence failure is logged but never surfaced — the stream must still
 * close cleanly, same as the streaming path.
 */
async function sendCannedReply(
  sessionId: string,
  content: string,
  reply: FastifyReply,
  requestStart: number,
  label: string,
): Promise<void> {
  let messageId = '';
  try {
    const [inserted] = await db
      .insert(messages)
      .values({
        sessionId,
        role: 'assistant',
        content,
        sources: [] as unknown as Record<string, unknown>[],
      })
      .returning({ id: messages.id });
    messageId = inserted?.id ?? '';
  } catch (dbErr) {
    console.error('Failed to persist assistant message:', dbErr);
  }

  reply.raw.write(`data: ${JSON.stringify({ type: 'delta', content })}\n\n`);
  reply.raw.write(`data: ${JSON.stringify({ type: 'done', messageId, sources: [] })}\n\n`);
  reply.raw.end();
  console.log(`[timing] total request time (${label}): ${Date.now() - requestStart}ms`);
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
 * Two exemptions, both app-authored fixed strings and therefore
 * known-trustworthy despite empty `sources`: NO_RELEVANT_DOCS_MESSAGE
 * (retrieval genuinely found nothing) and APP_INTRO_MESSAGE (the app's own
 * description). Dropping either would strip the only assistant turn between two
 * user turns, leaving a follow-up like "can you expand on that?" with no
 * antecedent in the model's context even though the user still sees the reply in
 * the transcript. Keeping APP_INTRO_MESSAGE is what lets an identity follow-up
 * ("what else can you do?") see that the description was already given, so it
 * can say there is nothing further instead of repeating itself.
 *
 * Note what is deliberately NOT exempted: a model-authored identity follow-up
 * reply. It also carries empty `sources`, but it is model output, exactly the
 * class this filter exists to drop — so later turns see the fixed intro and the
 * user's repeated asks (user rows are never filtered), not the model's own
 * previous paraphrase. The empty-sources filter otherwise remains a safety net
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
          inArray(messages.content, [NO_RELEVANT_DOCS_MESSAGE, APP_INTRO_MESSAGE]),
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
 *  2b. On the session's first message (default title, no prior messages),
 *      generates and persists a session title, emitted as its own SSE
 *      'title' event.
 *  3. Persists the user message.
 *  3a. If the query was classified app_identity AND it is the session's first
 *      message, short-circuits with APP_INTRO_MESSAGE — no GPT-4o call. Later in
 *      a conversation the same question is ambiguous, so it instead goes to the
 *      model under APP_IDENTITY_IN_CONVERSATION_PROMPT, which asks the user
 *      which reading they meant rather than assuming the app.
 *  3b. If retrieval found zero chunks, short-circuits with
 *      NO_RELEVANT_DOCS_MESSAGE — no GPT-4o call. This is where every question
 *      that is neither about the app nor answerable from the user's documents
 *      ends up, including general-knowledge ones: there is no path that answers
 *      from the model's own knowledge.
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
  const requestStart = Date.now();

  // ── Step 1: Validate session ──────────────────────────────────────────────
  const [sessionRow] = await timed('validate session', () =>
    db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        // Whether the session had any messages BEFORE this one — i.e. whether
        // this message is the session's cold open. Gates auto-titling, and also
        // the canned app intro (see Step 3a): an identity question is only
        // unambiguous when there is no conversation for it to refer back to.
        //
        // Uses exists() with a query-builder subquery rather than a raw sql
        // template, and that matters: inside a select field list (no join),
        // drizzle renders a template's `${table.column}` UNqualified, so
        // `${messages.sessionId} = ${chatSessions.id}` became
        // `"session_id" = "id"` — and since `messages` has an `id` column of its
        // own, Postgres resolved both names against the inner table and silently
        // compared messages.session_id to messages.id, which is never true.
        // exists() emits the properly qualified correlated reference
        // `"messages"."session_id" = "chat_sessions"."id"`.
        hasMessages: exists(
          qb
            .select({ one: sql`1` })
            .from(messages)
            .where(eq(messages.sessionId, chatSessions.id)),
        ),
      })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId))),
  );

  if (!sessionRow) {
    throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);
  }

  // Only auto-name a session on its first message, and only if the title is
  // still the untouched default — never clobber a title the user set
  // explicitly (at creation or via PATCH).
  const shouldGenerateTitle = sessionRow.title === DEFAULT_SESSION_TITLE && !sessionRow.hasMessages;

  // The api-transport route flushes SSE headers onto the raw response before
  // calling this function, so from here on the connection is already
  // committed to an SSE stream. Any error from this point must become an SSE
  // `error` event followed by a clean reply.raw.end(), never a rejected
  // promise: letting it propagate reaches Fastify's default error handler,
  // which tries to send a second, JSON-shaped response on a connection whose
  // headers are already sent. That has been observed in practice (a Cohere
  // rerank 429 exhausting its retries under concurrent load) to cascade into
  // FST_ERR_REP_INVALID_PAYLOAD_TYPE then ERR_HTTP_HEADERS_SENT and crash the
  // whole process, taking every other in-flight request down with it.
  try {
    await runChatPipeline(
      userId,
      sessionId,
      userMessage,
      reply,
      requestStart,
      shouldGenerateTitle,
      !sessionRow.hasMessages,
    );
  } catch (err) {
    console.error('streamChatResponse error:', err);
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`);
      reply.raw.end();
    }
  }
}

async function runChatPipeline(
  userId: string,
  sessionId: string,
  userMessage: string,
  reply: FastifyReply,
  requestStart: number,
  shouldGenerateTitle: boolean,
  isFirstMessage: boolean,
): Promise<void> {
  // ── Step 2: Retrieve grounding context, classify history scope, and (on a
  // session's first message) generate a title — all independent of each
  // other, so run in parallel.
  const [retrievalResult, historyScope, generatedTitle] = await Promise.all([
    timed('retrieve() total', () => retrieve(userId, userMessage)),
    timed('classifyHistoryScope', () => classifyHistoryScope(userMessage)),
    shouldGenerateTitle
      ? timed('generateSessionTitle', () => generateSessionTitle(userMessage))
      : Promise.resolve(null),
  ]);

  // ── Step 2b: Persist + emit the generated title, if any ──────────────────
  // Emitted as its own SSE event as soon as it's ready — independent of
  // whether the answer below ends up being the zero-chunk short-circuit or a
  // normal streamed reply — so the client can rename the session without
  // waiting for the full answer.
  if (generatedTitle) {
    await db
      .update(chatSessions)
      .set({ title: generatedTitle, updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));
    reply.raw.write(`data: ${JSON.stringify({ type: 'title', title: generatedTitle })}\n\n`);
  }

  // ── Step 3: Insert user message ──────────────────────────────────────────
  await timed('insert user message', () =>
    db.insert(messages).values({
      sessionId,
      role: 'user',
      content: userMessage,
    }),
  );

  // ── Step 3a: App-identity cold open ───────────────────────────────────────
  // An identity question as the session's FIRST message can only be about the
  // app — there is no earlier turn for "what is this?" to refer back to — so the
  // answer is known in advance and is sent as fixed text. Asking GPT-4o to
  // produce it would only add latency, cost, and a chance of drifting into its
  // own pretrained identity.
  //
  // Deliberately gated on isFirstMessage, not on the intent alone: mid-conversation
  // the same words are ambiguous, and replying with the app description would
  // talk straight past a user who meant the topic they were just discussing.
  // Those fall through to APP_IDENTITY_IN_CONVERSATION_PROMPT in step 4, which
  // disambiguates instead of guessing.
  if (retrievalResult.type === 'app_identity' && isFirstMessage) {
    await sendCannedReply(sessionId, APP_INTRO_MESSAGE, reply, requestStart, 'app-intro');
    return;
  }

  // ── Step 3b: Zero-chunk short-circuit ─────────────────────────────────────
  // Retrieval found nothing at all — either nothing cleared the score-threshold
  // backoff, or nothing cleared the rerank irrelevance floor. Skip the GPT-4o
  // call entirely rather than trust a freeform refusal — see
  // NO_RELEVANT_DOCS_MESSAGE for why. Every question that is neither about the
  // app nor answerable from the user's documents lands here.
  if (retrievalResult.type === 'chunk_results' && retrievalResult.chunks.length === 0) {
    await sendCannedReply(
      sessionId,
      NO_RELEVANT_DOCS_MESSAGE,
      reply,
      requestStart,
      'zero-chunk short-circuit',
    );
    return;
  }

  // ── Step 4: Build context string ──────────────────────────────────────────
  let contextString: string;
  let sources: Source[];
  let lowConfidence = false;

  let baseSystemPrompt: string = SYSTEM_PROMPT;

  if (retrievalResult.type === 'app_identity') {
    // Mid-conversation identity question. History is what makes this decidable:
    // it shows both what "this" might refer to and whether the app has already
    // been described (the intro is exempted from loadHistory()'s groundedness
    // filter, so it survives). No context block — the prompt carries the app
    // description itself and forbids going beyond it.
    contextString = '';
    sources = [];
    baseSystemPrompt = APP_IDENTITY_IN_CONVERSATION_PROMPT;
  } else if (retrievalResult.type === 'document_list') {
    contextString = buildDocumentListContext(retrievalResult.documents);
    sources = retrievalResult.documents.map((d) => ({
      documentId: d.documentId,
      documentName: d.documentName,
    }));
  } else {
    contextString = buildContextString(retrievalResult.chunks);
    sources = dedupeSourcesByDocument(
      retrievalResult.chunks.map((c) => ({
        chunkId: c.chunkId,
        documentId: c.documentId,
        documentName: c.documentName,
        score: c.score,
        pageNumber: c.pageNumber,
        content: c.content,
      })),
    );
    lowConfidence = retrievalResult.lowConfidence;
  }

  let systemContent =
    contextString.length > 0 ? `${baseSystemPrompt}\n\n${contextString}` : baseSystemPrompt;
  if (lowConfidence) {
    systemContent += LOW_CONFIDENCE_INSTRUCTION;
  }

  // ── Step 5: Load chat history per the classified scope ────────────────────
  const historyRows = await timed('loadHistory', () => loadHistory(sessionId, historyScope));

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
  let firstTokenLogged = false;
  const streamCallStart = Date.now();

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
        if (!firstTokenLogged) {
          console.log(`[timing] GPT-4o time-to-first-token: ${Date.now() - streamCallStart}ms`);
          console.log(
            `[timing] total time-to-first-token (end-to-end): ${Date.now() - requestStart}ms`,
          );
          firstTokenLogged = true;
        }
        fullResponse += delta;
        reply.raw.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
      }
    }
    console.log(`[timing] total request time: ${Date.now() - requestStart}ms`);
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
