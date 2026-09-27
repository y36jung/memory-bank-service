import OpenAI from 'openai';
import { db } from '../db/index.js';
import { chunks, documents, statusEnum } from '../db/schema.js';
import { batchEmbed } from './embeddings.js';
import { searchPoints } from './qdrant.js';
import { eq, inArray, and, gte, lte, asc, desc, sql } from 'drizzle-orm';
import { type MetadataFilters, classifyQuery } from './queryClassifier.js';
import { rerank } from './reranker.js';
import { env } from '../config/env.js';
import { timed } from '../lib/timing.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  chunkId: string;
  qdrantId: string;
  documentId: string;
  documentName: string; // documents.original_name
  content: string; // chunks.content — from Postgres, never from Qdrant payload
  score: number;
  createdAt: Date; // documents.created_at
  sourceType: string; // documents.source_type
  mimeType: string; // documents.mime_type
  sizeBytes: number | null; // documents.size_bytes
  pageNumber: number | null; // chunks.page_number
  startSecs: number | null; // chunks.start_secs
  endSecs: number | null; // chunks.end_secs
}

export interface RetrievedDocument {
  documentId: string;
  documentName: string;
  sourceType: string;
  mimeType: string;
  sizeBytes: number | null;
  createdAt: Date;
  status: DocumentStatus; // documents.status — 'indexed' means searchable
}

/**
 * Derived from the schema enum rather than re-declared, so adding or renaming a
 * status is a compile error here instead of a silently-dead `=== 'indexed'`.
 */
export type DocumentStatus = (typeof statusEnum.enumValues)[number];

/**
 * Exact document counts for a list_documents query, computed in SQL rather than
 * derived from `documents.length`. Two reasons they can't be derived: the array
 * is capped at DOCUMENT_LIST_LIMIT, and asking GPT-4o to count the rows of the
 * rendered table gets the wrong answer (12 documents reported as 11).
 */
export interface DocumentListCounts {
  // Every document matching the query's filters, ignoring DOCUMENT_LIST_LIMIT.
  totalCount: number;
  // Of those, the ones with status 'indexed' — i.e. actually searchable. The
  // rest are still in the pipeline or failed, and are listed but not queryable.
  indexedCount: number;
}

export type RetrievalResult =
  | ({ type: 'document_list'; documents: RetrievedDocument[] } & DocumentListCounts)
  // The user is asking about the app itself (classifyQuery's 'app_identity'
  // intent) — retrieval is skipped entirely rather than running a vector search
  // that will only ever surface noise. This is a positive instruction to
  // introduce the app, not a generic "skip retrieval" signal: chat.ts answers
  // it from the app's own description, the one ungrounded reply permitted.
  | { type: 'app_identity' }
  | {
      type: 'chunk_results';
      chunks: RetrievedChunk[];
      // True if either the pre-rank vector search needed to back off below its
      // primary score threshold, or the post-rank top chunk score is below
      // RERANK_LOW_CONFIDENCE_THRESHOLD. Two independent triggers, OR'd — see
      // SCORE_FLOOR / RERANK_LOW_CONFIDENCE_THRESHOLD.
      lowConfidence: boolean;
    };

// ─── Constants ─────────────────────────────────────────────────────────────────

const CONTENT_WEIGHT = 0.5;
const METADATA_WEIGHT = 0.5;

// list_documents wants a full inventory, not a relevance-ranked top-K —
// reusing retrieve()'s topK (a vector-search relevance count, default 10)
// here would silently truncate "what documents do I have?" to the 10
// most-recently-created documents. Decoupled from topK; high enough to be
// a no-op for realistic personal document counts while still bounding the
// query.
const DOCUMENT_LIST_LIMIT = 200;

// Candidate pool fetched from Qdrant/metadata-SQL before reranking — wider than
// the final topK so the cross-encoder has real candidates to discriminate
// between, not just the final result count.
const RERANK_CANDIDATE_MULTIPLIER = 3;
const MIN_RERANK_CANDIDATE_POOL = 20;

// Floor for the score-threshold backoff below. Qdrant is queried once at this
// (lowest-acceptable) threshold; the primary threshold and any backoff tiers
// in between are then applied in process against that single result set, so
// backing off never costs an extra round trip.
//
// This is one of two independent low-confidence triggers (see
// RERANK_LOW_CONFIDENCE_THRESHOLD below for the other). Either one firing is
// enough to mark a result low-confidence — neither can cancel the other out.
const SCORE_FLOOR = 0.05;

// Below this, even the best-matching reranked chunk doesn't clearly relate to
// the raw query per Cohere's cross-encoder (the only score in this pipeline
// computed against the real query text, not the HyDE hypothetical answer).
// A starting value, not empirically tuned — revisit once production
// relevance_score distributions are available.
const RERANK_LOW_CONFIDENCE_THRESHOLD = 0.3;

// Below this, the best chunk Cohere could find isn't about the query at all —
// not merely a weak match. Retrieval returns zero chunks so chat.ts's fixed
// "no relevant documents" reply fires, instead of handing GPT-4o noise to hedge
// over. Necessary because an unrelated query clears the *cosine* SCORE_FLOOR
// above almost every time: the HyDE hypothetical answer is prose, and prose
// resembles arbitrary prose, so one hit out of the candidate pool is enough.
// Deliberately below RERANK_LOW_CONFIDENCE_THRESHOLD, which keeps its hedging
// band for weak-but-plausible matches. Same caveat as that constant — a
// starting value, pending real relevance_score distributions.
const RERANK_IRRELEVANCE_THRESHOLD = 0.05;

/**
 * Builds a descending list of score thresholds from `primary` down to
 * `floor`, halving each step — e.g. buildScoreTiers(0.2, 0.05) => [0.2, 0.1, 0.05].
 */
function buildScoreTiers(primary: number, floor: number): number[] {
  const tiers = [primary];
  let current = primary;
  while (current > floor) {
    current = Math.max(current / 2, floor);
    tiers.push(current);
  }
  return tiers;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Generates a short hypothetical answer to the query using GPT-4o-mini.
 * Embedding this answer instead of the raw question closes the lexical gap
 * between question-style queries and declarative document text (HyDE technique).
 * Falls back to the original query string on any error.
 */
async function generateHypotheticalAnswer(query: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        {
          role: 'system',
          content:
            'Answer the following question in 2–3 factual sentences as if you were writing a reference document. Be concise and direct. Do not add caveats or say you are uncertain.',
        },
        { role: 'user', content: query },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? query;
  } catch {
    return query;
  }
}

/**
 * Retrieves chunks from Postgres using metadata filters only (no vector search).
 * Keyword matching is performed against documents.original_name via ILIKE.
 * A keyword relevance score is computed as the fraction of keywords matched.
 */
async function retrieveByMetadata(
  userId: string,
  filters: MetadataFilters,
  limit = 10,
): Promise<RetrievedChunk[]> {
  const keywords = (filters.documentKeywords ?? []).filter((kw) => kw.trim().length > 0);
  const kwCount = keywords.length;

  // Build OR candidacy clause and keyword score expression dynamically.
  let keywordCandidacyExpr: ReturnType<typeof sql> | undefined;
  let keywordScoreExpr: ReturnType<typeof sql>;

  if (kwCount > 0) {
    const orParts = keywords.map((kw) => sql`${documents.originalName} ILIKE ${'%' + kw + '%'}`);
    keywordCandidacyExpr = orParts.reduce((acc, part) => sql`(${acc}) OR (${part})`);
    const sumParts = keywords.map(
      (kw) => sql`(${documents.originalName} ILIKE ${'%' + kw + '%'})::int`,
    );
    const sumExpr = sumParts.reduce((acc, part) => sql`${acc} + ${part}`);
    keywordScoreExpr = sql`(${sumExpr})::float / ${kwCount}`;
  } else {
    keywordScoreExpr = sql`1.0::float`;
  }

  // Build AND conditions for non-keyword filters.
  const andConditions = [];
  andConditions.push(eq(documents.userId, userId));
  if (keywordCandidacyExpr) andConditions.push(sql`(${keywordCandidacyExpr})`);
  if (filters.uploadedAfter)
    andConditions.push(gte(documents.createdAt, new Date(filters.uploadedAfter)));
  if (filters.uploadedBefore)
    andConditions.push(lte(documents.createdAt, new Date(filters.uploadedBefore)));
  if (filters.sourceType)
    andConditions.push(
      eq(
        documents.sourceType,
        filters.sourceType as 'upload' | 'gmail' | 'gdrive' | 'outlook' | 'onedrive',
      ),
    );
  if (filters.timeRangeStartSecs !== undefined)
    andConditions.push(sql`${chunks.endSecs} >= ${filters.timeRangeStartSecs}`);
  if (filters.timeRangeEndSecs !== undefined)
    andConditions.push(sql`${chunks.startSecs} <= ${filters.timeRangeEndSecs}`);

  const rows = await db
    .select({
      id: chunks.id,
      qdrantId: chunks.qdrantId,
      documentId: chunks.documentId,
      content: chunks.content,
      originalName: documents.originalName,
      createdAt: documents.createdAt,
      sourceType: documents.sourceType,
      mimeType: documents.mimeType,
      sizeBytes: documents.sizeBytes,
      pageNumber: chunks.pageNumber,
      startSecs: chunks.startSecs,
      endSecs: chunks.endSecs,
      keywordScore: keywordScoreExpr.as('keyword_score'),
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(andConditions.length > 0 ? and(...andConditions) : undefined)
    .orderBy(desc(sql`keyword_score`), asc(chunks.chunkIndex))
    .limit(limit);

  return rows.map((row) => ({
    chunkId: row.id,
    qdrantId: row.qdrantId,
    documentId: row.documentId,
    documentName: row.originalName,
    content: row.content,
    score: (row.keywordScore as number) ?? 1.0,
    createdAt: row.createdAt,
    sourceType: row.sourceType,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    pageNumber: row.pageNumber ?? null,
    startSecs: row.startSecs ?? null,
    endSecs: row.endSecs ?? null,
  }));
}

/**
 * Retrieves documents from Postgres matching the given metadata filters.
 * Queries the documents table directly — no chunks join needed.
 * Used for list_documents intent queries.
 *
 * Returns the (limit-capped) rows alongside exact counts, which the rows alone
 * can't supply: `limit` truncates them, and the model that reads them cannot
 * reliably count — 12 rows were once reported to a user as 11 documents.
 *
 * The counts are window aggregates in the SAME statement as the rows, not a
 * second query. Postgres evaluates them over the full matching set before LIMIT
 * applies, so they stay exact under truncation, and one statement means one
 * snapshot: a separate COUNT could straddle a concurrent upload or delete and
 * report a total that contradicts the very rows it was paired with, recreating
 * this bug from the data side.
 *
 * No status filter: a document that failed to ingest still belongs to the
 * user and must not silently vanish from their inventory. It is reported as
 * part of `totalCount` but excluded from `indexedCount`, so callers can state
 * both numbers instead of conflating owned with searchable.
 */
async function retrieveDocuments(
  userId: string,
  filters: MetadataFilters | null,
  limit = 20,
): Promise<{ documents: RetrievedDocument[] } & DocumentListCounts> {
  const andConditions = [];
  andConditions.push(eq(documents.userId, userId));

  if (filters) {
    if (filters.uploadedAfter)
      andConditions.push(gte(documents.createdAt, new Date(filters.uploadedAfter)));
    if (filters.uploadedBefore)
      andConditions.push(lte(documents.createdAt, new Date(filters.uploadedBefore)));
    if (filters.sourceType)
      andConditions.push(
        eq(
          documents.sourceType,
          filters.sourceType as 'upload' | 'gmail' | 'gdrive' | 'outlook' | 'onedrive',
        ),
      );
  }

  const rows = await db
    .select({
      id: documents.id,
      originalName: documents.originalName,
      sourceType: documents.sourceType,
      mimeType: documents.mimeType,
      sizeBytes: documents.sizeBytes,
      createdAt: documents.createdAt,
      status: documents.status,
      // Repeated on every row (same value), read off the first below. pg returns
      // int8 as a string and a bare sql`` template has no decoder, so
      // .mapWith(Number) is required to make the declared type honest — unlike
      // drizzle's count(), which applies it internally.
      totalCount: sql<number>`count(*) OVER ()`.mapWith(Number),
      // eq() rather than a raw `= 'indexed'` literal so the enum value is
      // type-checked: a rename breaks the build instead of quietly yielding 0.
      indexedCount:
        sql<number>`count(*) FILTER (WHERE ${eq(documents.status, 'indexed')}) OVER ()`.mapWith(
          Number,
        ),
    })
    .from(documents)
    .where(andConditions.length > 0 ? and(...andConditions) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(limit);

  const mapped = rows.map((row) => ({
    documentId: row.id,
    documentName: row.originalName,
    sourceType: row.sourceType,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    createdAt: row.createdAt,
    status: row.status,
  }));

  // No rows means nothing matched the filters, so both counts are genuinely 0 —
  // the window aggregates are present by construction whenever a row exists.
  return {
    documents: mapped,
    totalCount: rows[0]?.totalCount ?? 0,
    indexedCount: rows[0]?.indexedCount ?? 0,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Classifies the query and routes to either:
 * - app_identity: the user is asking about the app itself; no retrieval at all
 * - document_list: queries documents table directly (for listing/enumeration queries)
 * - chunk_results: hybrid vector + optional metadata search (for content queries).
 *   Returns zero chunks when nothing clears RERANK_IRRELEVANCE_THRESHOLD, which
 *   the caller turns into a fixed "no relevant documents" reply.
 *
 * @param query          Natural-language query string.
 * @param topK           Maximum number of results to retrieve (default: 10).
 * @param scoreThreshold Minimum cosine-similarity score to include (default: 0.2).
 */
export async function retrieve(
  userId: string,
  query: string,
  topK = 10,
  scoreThreshold = 0.2,
): Promise<RetrievalResult> {
  const currentDate = new Date().toISOString().split('T')[0] as string;

  // classifyQuery and HyDE both need only the query string — run in parallel.
  const [classification, hydeText] = await Promise.all([
    timed('classifyQuery', () => classifyQuery(query, currentDate)),
    timed('generateHypotheticalAnswer (HyDE)', () => generateHypotheticalAnswer(query)),
  ]);

  // list_documents path: skip vector search, query documents table directly.
  if (classification?.intent === 'list_documents') {
    const listed = await retrieveDocuments(userId, classification.filters, DOCUMENT_LIST_LIMIT);
    return { type: 'document_list', ...listed };
  }

  // app_identity path: the user is asking about the app itself — skip vector
  // search entirely rather than attaching noise.
  if (classification?.intent === 'app_identity') {
    return { type: 'app_identity' };
  }

  // Over-fetch beyond topK so the reranker has real candidates to discriminate
  // between, not just the final result count.
  const candidatePoolSize = Math.max(topK * RERANK_CANDIDATE_MULTIPLIER, MIN_RERANK_CANDIDATE_POOL);

  // Vector chain and metadata SQL are independent once classification + hydeText are ready.
  const [vectorChunksOrNull, sqlChunks] = await Promise.all([
    // Vector chain: embed → Qdrant (at the backoff floor) → tier selection → Postgres hydration.
    timed(
      'vectorChain total',
      async (): Promise<{
        chunks: RetrievedChunk[];
        lowConfidence: boolean;
      } | null> => {
        const [vector] = await timed('batchEmbed', () => batchEmbed([hydeText]));
        if (vector === undefined) return null;

        // Query once at the widest threshold we'd ever accept — Qdrant already
        // returns results sorted by score, so the tiers below are applied
        // in process against this single result set instead of re-querying.
        const floorResults = await timed('qdrant searchPoints', () =>
          searchPoints(userId, vector, candidatePoolSize, SCORE_FLOOR),
        );
        if (floorResults.length === 0) return { chunks: [], lowConfidence: false };

        const tiers = buildScoreTiers(scoreThreshold, SCORE_FLOOR);
        let qdrantResults: typeof floorResults = [];
        let usedTier = SCORE_FLOOR;
        for (const tier of tiers) {
          const atTier = floorResults.filter((r) => r.score >= tier);
          if (atTier.length > 0) {
            qdrantResults = atTier;
            usedTier = tier;
            break;
          }
        }
        if (qdrantResults.length === 0) return { chunks: [], lowConfidence: false };

        const lowConfidence = usedTier < scoreThreshold;

        const qdrantIds = qdrantResults.map((r) => r.id);
        const scoreByQdrantId = new Map(qdrantResults.map((r) => [r.id, r.score]));

        const rows = await timed('postgres hydrate chunks', () =>
          db
            .select({
              id: chunks.id,
              qdrantId: chunks.qdrantId,
              documentId: chunks.documentId,
              content: chunks.content,
              originalName: documents.originalName,
              createdAt: documents.createdAt,
              sourceType: documents.sourceType,
              mimeType: documents.mimeType,
              sizeBytes: documents.sizeBytes,
              pageNumber: chunks.pageNumber,
              startSecs: chunks.startSecs,
              endSecs: chunks.endSecs,
            })
            .from(chunks)
            .innerJoin(documents, eq(chunks.documentId, documents.id))
            .where(and(inArray(chunks.qdrantId, qdrantIds), eq(documents.userId, userId))),
        );

        const hydrated = rows
          .map((row): RetrievedChunk | null => {
            const contentScore = scoreByQdrantId.get(row.qdrantId);
            if (contentScore === undefined) return null;
            return {
              chunkId: row.id,
              qdrantId: row.qdrantId,
              documentId: row.documentId,
              documentName: row.originalName,
              content: row.content,
              score: contentScore,
              createdAt: row.createdAt,
              sourceType: row.sourceType,
              mimeType: row.mimeType,
              sizeBytes: row.sizeBytes ?? null,
              pageNumber: row.pageNumber ?? null,
              startSecs: row.startSecs ?? null,
              endSecs: row.endSecs ?? null,
            };
          })
          .filter((c): c is RetrievedChunk => c !== null);

        return { chunks: hydrated, lowConfidence };
      },
    ),
    // Metadata SQL path: resolves to [] immediately if no classification/filters.
    timed('retrieveByMetadata (sqlChunks)', () =>
      classification?.filters
        ? retrieveByMetadata(userId, classification.filters, candidatePoolSize)
        : Promise.resolve([] as RetrievedChunk[]),
    ),
  ]);

  if (vectorChunksOrNull === null) {
    return { type: 'chunk_results', chunks: [], lowConfidence: false };
  }
  const { chunks: vectorChunks, lowConfidence: vectorLowConfidence } = vectorChunksOrNull;

  // If no metadata filters, candidates are the vector results as-is (order
  // doesn't matter — rerank() below re-sorts).
  let candidates: RetrievedChunk[];

  if (!classification) {
    candidates = vectorChunks;
  } else {
    // Score fusion: merge both sets, combine content + metadata scores.
    type FusionEntry = { chunk: RetrievedChunk; contentScore: number; metadataScore: number };
    const map = new Map<string, FusionEntry>();

    for (const c of vectorChunks) {
      map.set(c.chunkId, { chunk: c, contentScore: c.score, metadataScore: 0 });
    }
    for (const c of sqlChunks) {
      const existing = map.get(c.chunkId);
      if (existing) {
        existing.metadataScore = c.score;
      } else {
        map.set(c.chunkId, { chunk: c, contentScore: 0, metadataScore: c.score });
      }
    }

    candidates = Array.from(map.values())
      .map(({ chunk, contentScore, metadataScore }) => ({
        ...chunk,
        score: CONTENT_WEIGHT * contentScore + METADATA_WEIGHT * metadataScore,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidatePoolSize);
  }

  if (candidates.length === 0) {
    return { type: 'chunk_results', chunks: [], lowConfidence: false };
  }

  // Final step: rerank the candidate pool with the local cross-encoder and
  // truncate to topK. Reranks against the raw query, not the HyDE text.
  const rerankedChunks = await timed('rerank total', () => rerank(query, candidates, topK));

  // Second, independent low-confidence trigger: the best-matching chunk's
  // Cohere score, checked against the raw query text rather than the HyDE
  // hypothetical answer. Neither this nor vectorLowConfidence can cancel the
  // other out — either one being weak is enough.
  const topRerankScore = rerankedChunks[0]?.score ?? 0;

  // Nothing here is about the query — report it as "found nothing" rather than
  // as a weak find, so the caller sends its fixed refusal. lowConfidence: false
  // matches every other zero-chunk return in this function.
  if (topRerankScore < RERANK_IRRELEVANCE_THRESHOLD) {
    return { type: 'chunk_results', chunks: [], lowConfidence: false };
  }

  const rerankLowConfidence = topRerankScore < RERANK_LOW_CONFIDENCE_THRESHOLD;
  const lowConfidence = vectorLowConfidence || rerankLowConfidence;

  return { type: 'chunk_results', chunks: rerankedChunks, lowConfidence };
}

/**
 * Convenience wrapper around retrieve() that always returns RetrievedChunk[].
 * For list_documents queries, returns an empty array.
 * Existing callers (tests, chat.ts pre-migration) can use this without changes.
 */
export async function retrieveChunks(
  userId: string,
  query: string,
  topK = 10,
  scoreThreshold = 0.2,
): Promise<RetrievedChunk[]> {
  const result = await retrieve(userId, query, topK, scoreThreshold);
  return result.type === 'chunk_results' ? result.chunks : [];
}
