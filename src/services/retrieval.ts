import OpenAI from 'openai';
import { db } from '../db/index.js';
import { chunks, documents } from '../db/schema.js';
import { batchEmbed } from './embeddings.js';
import { searchPoints } from './qdrant.js';
import { eq, inArray, and, gte, lte, asc, desc, sql } from 'drizzle-orm';
import { type MetadataFilters, classifyQuery } from './queryClassifier.js';
import { rerank } from './reranker.js';
import { env } from '../config/env.js';

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
}

export type RetrievalResult =
  | { type: 'document_list'; documents: RetrievedDocument[] }
  | { type: 'chunk_results'; chunks: RetrievedChunk[]; lowConfidence: boolean };

// ─── Constants ─────────────────────────────────────────────────────────────────

const CONTENT_WEIGHT = 0.5;
const METADATA_WEIGHT = 0.5;

// Candidate pool fetched from Qdrant/metadata-SQL before reranking — wider than
// the final topK so the cross-encoder has real candidates to discriminate
// between, not just the final result count.
const RERANK_CANDIDATE_MULTIPLIER = 3;
const MIN_RERANK_CANDIDATE_POOL = 20;

// Floor for the score-threshold backoff below. Qdrant is queried once at this
// (lowest-acceptable) threshold; the primary threshold and any backoff tiers
// in between are then applied in process against that single result set, so
// backing off never costs an extra round trip.
const SCORE_FLOOR = 0.05;

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
 */
async function retrieveDocuments(
  userId: string,
  filters: MetadataFilters | null,
  limit = 20,
): Promise<RetrievedDocument[]> {
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
    })
    .from(documents)
    .where(andConditions.length > 0 ? and(...andConditions) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    documentId: row.id,
    documentName: row.originalName,
    sourceType: row.sourceType,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    createdAt: row.createdAt,
  }));
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Classifies the query and routes to either:
 * - document_list: queries documents table directly (for listing/enumeration queries)
 * - chunk_results: hybrid vector + optional metadata search (for content queries)
 *
 * @param query          Natural-language query string.
 * @param topK           Maximum number of results to retrieve (default: 10).
 * @param scoreThreshold Minimum cosine-similarity score to include (default: 0.4).
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
    classifyQuery(query, currentDate),
    generateHypotheticalAnswer(query),
  ]);

  // list_documents path: skip vector search, query documents table directly.
  if (classification?.intent === 'list_documents') {
    const docs = await retrieveDocuments(userId, classification.filters, topK);
    return { type: 'document_list', documents: docs };
  }

  // Over-fetch beyond topK so the reranker has real candidates to discriminate
  // between, not just the final result count.
  const candidatePoolSize = Math.max(topK * RERANK_CANDIDATE_MULTIPLIER, MIN_RERANK_CANDIDATE_POOL);

  // Vector chain and metadata SQL are independent once classification + hydeText are ready.
  const [vectorChunksOrNull, sqlChunks] = await Promise.all([
    // Vector chain: embed → Qdrant (at the backoff floor) → tier selection → Postgres hydration.
    (async (): Promise<{ chunks: RetrievedChunk[]; lowConfidence: boolean } | null> => {
      const [vector] = await batchEmbed([hydeText]);
      if (vector === undefined) return null;

      // Query once at the widest threshold we'd ever accept — Qdrant already
      // returns results sorted by score, so the tiers below are applied
      // in process against this single result set instead of re-querying.
      const floorResults = await searchPoints(userId, vector, candidatePoolSize, SCORE_FLOOR);
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
        })
        .from(chunks)
        .innerJoin(documents, eq(chunks.documentId, documents.id))
        .where(and(inArray(chunks.qdrantId, qdrantIds), eq(documents.userId, userId)));

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
    })(),
    // Metadata SQL path: resolves to [] immediately if no classification/filters.
    classification?.filters
      ? retrieveByMetadata(userId, classification.filters, candidatePoolSize)
      : Promise.resolve([] as RetrievedChunk[]),
  ]);

  if (vectorChunksOrNull === null) {
    return { type: 'chunk_results', chunks: [], lowConfidence: false };
  }
  const { chunks: vectorChunks, lowConfidence } = vectorChunksOrNull;

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
  const rerankedChunks = await rerank(query, candidates, topK);
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
