import OpenAI from 'openai';
import type { FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { messages, chatSessions } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { retrieveChunks, type RetrievedChunk } from './retrieval.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { countTokens } from '../lib/tokenizer.js';

// ─── Client ────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of tokens to use for the assembled context block.
 * Leaves room for the system prompt, the last-6-turn history, the user
 * message, and the model's response within GPT-4o's context window.
 */
const MAX_CONTEXT_TOKENS = 100_000;

/**
 * Number of prior assistant/user turns included in every chat completion.
 * PLAN.md §Query Pipeline step 7: "[system, ...recent chat history (last 6), user]"
 */
const HISTORY_DEPTH = 6;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Source {
  chunkId: string;
  documentId: string;
  documentName: string;
  score: number;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a helpful assistant that answers questions based strictly on the provided context documents.\n' +
  'When answering:\n' +
  '- Cite the source document name when referencing specific information.\n' +
  '- If the context does not contain enough information to answer, say "I don\'t know based on the provided documents."\n' +
  '- Do not hallucinate or add information not present in the context.';

// ─── Internal helpers ──────────────────────────────────────────────────────────

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
    const part = `--- Source: ${chunk.documentName} ---\n${chunk.content}\n\n`;
    const partTokens = countTokens(part);

    if (totalTokens + partTokens > MAX_CONTEXT_TOKENS) {
      // Dropping this chunk (and all remaining lower-scored ones) keeps us within budget.
      break;
    }

    parts.push(part);
    totalTokens += partTokens;
  }

  return parts.join('');
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Handle a user message for the given session:
 *  1. Validates the session exists.
 *  2. Retrieves relevant chunks from the vector store.
 *  3. Persists the user message.
 *  4. Streams a GPT-4o response via SSE.
 *  5. Persists the assistant message with sources on stream completion.
 *
 * The caller (api-transport route) must NOT write to `reply` after this
 * function returns — the SSE stream is terminated inside this function.
 */
export async function streamChatResponse(
  sessionId: string,
  userMessage: string,
  reply: FastifyReply,
): Promise<void> {
  // ── Step 1: Validate session ──────────────────────────────────────────────
  const sessionRows = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));

  if (sessionRows.length === 0) {
    throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);
  }

  // ── Step 2: Retrieve grounding context ───────────────────────────────────
  const retrievedChunks = await retrieveChunks(userMessage);

  // ── Step 3: Insert user message ──────────────────────────────────────────
  await db.insert(messages).values({
    sessionId,
    role: 'user',
    content: userMessage,
  });

  // ── Step 4: Build context string ──────────────────────────────────────────
  const contextString = buildContextString(retrievedChunks);

  const systemContent =
    contextString.length > 0 ? `${SYSTEM_PROMPT}\n\n## Context\n\n${contextString}` : SYSTEM_PROMPT;

  // ── Step 5: Load recent chat history (last HISTORY_DEPTH messages) ────────
  const historyRows = (
    await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_DEPTH)
  ).reverse();

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
  const sources: Source[] = retrievedChunks.map((c) => ({
    chunkId: c.chunkId,
    documentId: c.documentId,
    documentName: c.documentName,
    score: c.score,
  }));

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

  reply.raw.write(`data: ${JSON.stringify({ type: 'done', messageId, sources })}\n\n`);
  reply.raw.end();
}
