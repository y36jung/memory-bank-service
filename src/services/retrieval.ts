import OpenAI from 'openai';
import { db } from '../db/index.js';
import { chunks, documents } from '../db/schema.js';
import { batchEmbed } from './embeddings.js';
import { searchPoints } from './qdrant.js';
import { eq, inArray, and, gte, lte, asc, desc, sql } from 'drizzle-orm';
import { type MetadataFilters, classifyQuery } from './queryClassifier.js';
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
  | { type: 'chunk_results'; chunks: RetrievedChunk[] };

// ─── Constants ─────────────────────────────────────────────────────────────────

const CONTENT_WEIGHT = 0.5;
const METADATA_WEIGHT = 0.5;

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
async function retrieveByMetadata(filters: MetadataFilters, limit = 10): Promise<RetrievedChunk[]> {
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
  filters: MetadataFilters | null,
  limit = 20,
): Promise<RetrievedDocument[]> {
  const andConditions = [];

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
  query: string,
  topK = 10,
  scoreThreshold = 0.4,
): Promise<RetrievalResult> {
  const currentDate = new Date().toISOString().split('T')[0] as string;
  const classification = await classifyQuery(query, currentDate);

  // list_documents path: skip vector search, query documents table directly.
  if (classification?.intent === 'list_documents') {
    const docs = await retrieveDocuments(classification.filters, topK);
    return { type: 'document_list', documents: docs };
  }

  // Content search path: HyDE + vector search + optional metadata fusion.
  const [hydeText] = await Promise.all([generateHypotheticalAnswer(query)]);

  const [vector] = await batchEmbed([hydeText]);

  if (vector === undefined) return { type: 'chunk_results', chunks: [] };

  // Vector search path.
  const qdrantResults = await searchPoints(vector, topK, scoreThreshold);

  // Fetch Postgres rows for vector hits.
  let vectorChunks: RetrievedChunk[] = [];
  if (qdrantResults.length > 0) {
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
        startSecs: chunks.startSecs,
        endSecs: chunks.endSecs,
      })
      .from(chunks)
      .innerJoin(documents, eq(chunks.documentId, documents.id))
      .where(inArray(chunks.qdrantId, qdrantIds));

    vectorChunks = rows
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
          startSecs: row.startSecs ?? null,
          endSecs: row.endSecs ?? null,
        };
      })
      .filter((c): c is RetrievedChunk => c !== null);
  }

  // If no metadata filters, return vector results sorted by score.
  if (!classification) {
    return { type: 'chunk_results', chunks: vectorChunks.sort((a, b) => b.score - a.score) };
  }

  // Metadata SQL path (search_content with filters).
  const sqlChunks = await retrieveByMetadata(classification.filters ?? {}, topK);

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

  const fusedChunks = Array.from(map.values())
    .map(({ chunk, contentScore, metadataScore }) => ({
      ...chunk,
      score: CONTENT_WEIGHT * contentScore + METADATA_WEIGHT * metadataScore,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { type: 'chunk_results', chunks: fusedChunks };
}

/**
 * Convenience wrapper around retrieve() that always returns RetrievedChunk[].
 * For list_documents queries, returns an empty array.
 * Existing callers (tests, chat.ts pre-migration) can use this without changes.
 */
export async function retrieveChunks(
  query: string,
  topK = 10,
  scoreThreshold = 0.4,
): Promise<RetrievedChunk[]> {
  const result = await retrieve(query, topK, scoreThreshold);
  return result.type === 'chunk_results' ? result.chunks : [];
}
