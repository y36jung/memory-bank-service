/**
 * "Naive RAG" baseline provider — used only to measure how much the real
 * pipeline's HyDE / query classification / metadata fusion / Cohere rerank
 * stack improves eval pass rate over the textbook baseline.
 *
 * Pipeline: embed the raw query -> flat top-K cosine search in the same
 * Qdrant collection -> hydrate chunk text from Postgres -> stuff into the
 * same system prompt and same generation model (gpt-4o) as the real app.
 * No HyDE, no query classification/intent routing, no metadata score
 * fusion, no reranking, no score-threshold backoff, no low-confidence
 * gating. Reads the same Postgres/Qdrant data the real app ingested —
 * doesn't touch the app's HTTP API at all.
 */

import { Client } from 'pg';
import OpenAI from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: join(__dirname, '..', '..', '.env') }); // DATABASE_URL, QDRANT_URL, OPENAI_API_KEY
dotenv.config({ path: join(__dirname, '..', '.env') }); // EVAL_USER_EMAIL

const COLLECTION = 'memory_bank';
const TOP_K = 10;

const SYSTEM_PROMPT =
  'You are a helpful assistant that answers questions based on the provided context documents.\n' +
  'When answering:\n' +
  '- Every fact, topic, and section in your answer must come from the provided context documents. Never fill in a fact, subtopic, or section from outside/general knowledge — even one that would normally be expected in a complete answer to this kind of question.\n' +
  '- If the context is relevant but does not fully answer the question exactly, use the most closely related information actually present in the documents as a fallback. Do not invent related facts that are not present.\n' +
  '- If the question is a broad or open-ended request (e.g. "help me prepare for X", "give me an overview of X"), organize and synthesize the document content related to the topic, even if no single passage directly answers the request as phrased. But only include the aspects of the topic the documents actually cover — if the documents are silent on part of the question, briefly say so for that part instead of inventing content to make the answer feel complete.\n' +
  '- Say "I don\'t know based on the provided documents." — for the whole question, or for the specific part — whenever the documents lack relevant information to answer it, not only when the documents are unrelated to the topic entirely.\n' +
  '- Do not hallucinate or add information not present in the context.';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL });

let pgClient = null;
let userIdPromise = null;

async function getPg() {
  if (!pgClient) {
    pgClient = new Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
  }
  return pgClient;
}

async function getUserId() {
  if (!userIdPromise) {
    userIdPromise = (async () => {
      const pg = await getPg();
      const { rows } = await pg.query('SELECT id FROM users WHERE email = $1', [
        process.env.EVAL_USER_EMAIL,
      ]);
      if (rows.length === 0) {
        throw new Error(`No user found for EVAL_USER_EMAIL=${process.env.EVAL_USER_EMAIL}`);
      }
      return rows[0].id;
    })();
  }
  return userIdPromise;
}

function buildContextString(sources) {
  return sources.map((s) => `--- Source: ${s.documentName} ---\n${s.content}\n`).join('\n');
}

export default class NaiveRagProvider {
  constructor(options) {
    this.providerId = options?.id || 'naive-rag';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    try {
      const userId = await getUserId();
      const pg = await getPg();

      const embedRes = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: [prompt],
      });
      const vector = embedRes.data[0].embedding;

      const hits = await qdrant.search(COLLECTION, {
        vector,
        limit: TOP_K,
        filter: { must: [{ key: 'userId', match: { value: userId } }] },
        with_payload: false,
        with_vector: false,
      });

      let sources = [];
      if (hits.length > 0) {
        const ids = hits.map((h) => String(h.id));
        const scoreById = new Map(hits.map((h) => [String(h.id), h.score]));
        const { rows } = await pg.query(
          `SELECT c.id as chunk_id, c.qdrant_id, c.document_id, c.content, d.original_name
           FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.qdrant_id = ANY($1) AND d.user_id = $2`,
          [ids, userId],
        );
        sources = rows
          .map((r) => ({
            chunkId: r.chunk_id,
            documentId: r.document_id,
            documentName: r.original_name,
            content: r.content,
            score: scoreById.get(r.qdrant_id),
          }))
          .sort((a, b) => b.score - a.score);
      }

      const contextString =
        sources.length > 0 ? `${SYSTEM_PROMPT}\n\n${buildContextString(sources)}` : SYSTEM_PROMPT;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: contextString },
          { role: 'user', content: prompt },
        ],
      });

      return {
        output: completion.choices[0]?.message?.content ?? '',
        metadata: { sources },
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
