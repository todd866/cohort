/**
 * Similarity Search
 *
 * Uses pgvector for efficient vector similarity when available.
 * Falls back to keyword/topic matching when embeddings don't exist.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  findSimilarByTopics,
  hasEmbeddings,
} from './similarity-fallback';
import { logger } from '@/lib/logger';
import { STORED_MANIFOLD_DIM, toRuntimeVector } from './config';

export interface SimilarCard {
  cardId: string;
  similarity: number;
  rotation?: string;
  front?: string;
  complexity?: number;
}

export interface SimilarQuestion {
  questionId: string;
  similarity: number;
  stem?: string;
  source?: string;
}

// Cache embedding availability check
let _hasEmbeddings: boolean | null = null;

async function checkEmbeddings(): Promise<boolean> {
  if (_hasEmbeddings === null) {
    _hasEmbeddings = await hasEmbeddings();
  }
  return _hasEmbeddings;
}

// =============================================================================
// Generic helpers — eliminate duplication across table-specific functions
// =============================================================================

/**
 * Batch-load embeddings by ID from a single embedding table.
 *
 * Used by `batchLoadItemEmbeddings` and `batchLoadConceptEmbeddings` for
 * per-id point lookups. Hot-path rotation-wide loads are GONE — they used
 * to live here as `loadEmbeddingsByRotation` and ship ~240 MB per cold
 * start. See @/lib/manifold/scoring for the SQL-native replacements.
 *
 * `truncate=true` (default) returns runtime-dim vectors for in-memory math.
 * Pass `truncate=false` when the result will be re-shipped to SQL as a
 * halfvec parameter — pgvector cosine requires matching dims (stored at
 * 3072), so truncating to 1024 would cause a "different halfvec dimensions"
 * error in the comparing query.
 */
async function loadEmbeddingsByIds(
  table: string,
  idColumn: string,
  ids: string[],
  truncate: boolean = true,
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (ids.length === 0) return result;

  const tbl = Prisma.raw(table);
  const col = Prisma.raw(idColumn);

  const rows = await prisma.$queryRaw<Array<{ id: string; embedding: string }>>`
    SELECT ${col} AS id, embedding::text AS embedding
    FROM ${tbl}
    WHERE ${col} = ANY(${ids}::text[])
  `;

  for (const row of rows) {
    const parsed = JSON.parse(row.embedding) as number[];
    result.set(row.id, truncate ? toRuntimeVector(parsed) : parsed);
  }

  return result;
}

/**
 * Find items near a concept embedding vector using pgvector cosine distance.
 * Generic helper for card/question/video vector search.
 */
async function findItemsNearVector<T>(opts: {
  embeddingTable: string;
  idColumn: string;
  idAlias: string;
  parentTable: string;
  embedding: number[];
  rotation?: string;
  limit: number;
  minSimilarity: number;
  extraWhere?: Prisma.Sql;
}): Promise<T[]> {
  const { embeddingTable, idColumn, idAlias, parentTable, embedding, rotation, limit, minSimilarity, extraWhere } = opts;

  try {
    const vectorJson = JSON.stringify(embedding);
    const minSim = Number(minSimilarity);
    const lim = Number(limit);

    const et = Prisma.raw(embeddingTable);
    const ic = Prisma.raw(idColumn);
    const ia = Prisma.raw(`"${idAlias}"`);
    const pt = Prisma.raw(`"${parentTable}"`);

    const rotationFilter = rotation
      ? Prisma.sql`AND p.rotation = ${rotation}`
      : Prisma.empty;

    const results = await prisma.$queryRaw<T[]>`
      SELECT
        e.${ic} as ${ia},
        (1 - (e.embedding <=> ${vectorJson}::halfvec))::float as similarity
      FROM ${et} e
      JOIN ${pt} p ON p.id = e.${ic}
      WHERE (1 - (e.embedding <=> ${vectorJson}::halfvec)) >= ${minSim}::float
        ${rotationFilter}
        ${extraWhere ?? Prisma.empty}
      ORDER BY e.embedding <=> ${vectorJson}::halfvec
      LIMIT ${lim}::int
    `;

    return results;
  } catch (error) {
    logger.warn(`pgvector concept→${embeddingTable} search failed`, { error: String(error) });
    return [];
  }
}

/**
 * Find similar cards using cosine similarity (or topic fallback)
 * Uses HNSW index for fast approximate nearest neighbor search
 */
export async function findSimilar(
  cardId: string,
  limit: number = 10,
  minSimilarity: number = 0.5
): Promise<SimilarCard[]> {
  // Check if embeddings are available
  const useEmbeddings = await checkEmbeddings();

  if (!useEmbeddings) {
    // Fallback to topic-based similarity
    const fallbackResults = await findSimilarByTopics(cardId, limit);
    return fallbackResults.filter((r) => r.similarity >= minSimilarity);
  }

  // Use raw SQL for pgvector operations
  try {
    const minSim = Number(minSimilarity);
    const lim = Number(limit);
    const results = await prisma.$queryRaw<SimilarCard[]>`
      SELECT
        c.id as "cardId",
        c.rotation,
        c.front,
        (1 - (e1.embedding <=> e2.embedding))::float as similarity
      FROM card_embeddings e1
      JOIN card_embeddings e2 ON e2.card_id != e1.card_id
      JOIN "Card" c ON c.id = e2.card_id
      WHERE e1.card_id = ${cardId}
        AND (1 - (e1.embedding <=> e2.embedding)) >= ${minSim}::float
      ORDER BY e1.embedding <=> e2.embedding
      LIMIT ${lim}::int
    `;

    return results;
  } catch (error) {
    // Embedding query failed, fall back to topics
    logger.warn('Embedding query failed, using topic fallback', { error: String(error) });
    _hasEmbeddings = false;
    const fallbackResults = await findSimilarByTopics(cardId, limit);
    return fallbackResults.filter((r) => r.similarity >= minSimilarity);
  }
}

/**
 * Find similar cards from OTHER rotations
 * Useful for cross-rotation concept linking
 */
export async function findCrossRotation(
  cardId: string,
  currentRotation: string,
  limit: number = 5
): Promise<SimilarCard[]> {
  const lim = Number(limit);
  const results = await prisma.$queryRaw<SimilarCard[]>`
    SELECT
      c.id as "cardId",
      c.rotation,
      c.front,
      (1 - (e1.embedding <=> e2.embedding))::float as similarity
    FROM card_embeddings e1
    JOIN card_embeddings e2 ON e2.card_id != e1.card_id
    JOIN "Card" c ON c.id = e2.card_id
    WHERE e1.card_id = ${cardId}
      AND c.rotation != ${currentRotation}
      AND (1 - (e1.embedding <=> e2.embedding)) >= 0.7
    ORDER BY e1.embedding <=> e2.embedding
    LIMIT ${lim}::int
  `;

  return results;
}

/**
 * Find cards similar to a question (cross-modal search)
 * Used for remediation: when a question is answered wrong, find cards to review
 */
export async function findCardsForQuestion(
  questionId: string,
  limit: number = 5,
  minSimilarity: number = 0.3
): Promise<SimilarCard[]> {
  const questionMeta = await prisma.question.findUnique({
    where: { id: questionId },
    select: { rotation: true },
  });
  const rotation = questionMeta?.rotation ?? null;

  try {
    const minSim = Number(minSimilarity);
    const lim = Number(limit);
    const results = rotation
      ? await prisma.$queryRaw<SimilarCard[]>`
          SELECT
            c.id as "cardId",
            c.rotation,
            c.front,
            (1 - (qe.embedding <=> ce.embedding))::FLOAT as similarity
          FROM question_embeddings qe
          CROSS JOIN card_embeddings ce
          JOIN "Card" c ON c.id = ce.card_id
          WHERE qe.question_id = ${questionId}
            AND c.rotation = ${rotation}
            AND (1 - (qe.embedding <=> ce.embedding)) >= ${minSim}::float
          ORDER BY qe.embedding <=> ce.embedding
          LIMIT ${lim}::int
        `
      : await prisma.$queryRaw<SimilarCard[]>`
          SELECT
            c.id as "cardId",
            c.rotation,
            c.front,
            (1 - (qe.embedding <=> ce.embedding))::FLOAT as similarity
          FROM question_embeddings qe
          CROSS JOIN card_embeddings ce
          JOIN "Card" c ON c.id = ce.card_id
          WHERE qe.question_id = ${questionId}
            AND (1 - (qe.embedding <=> ce.embedding)) >= ${minSim}::float
          ORDER BY qe.embedding <=> ce.embedding
          LIMIT ${lim}::int
        `;
    return results;
  } catch (error) {
    logger.warn('Cross-modal search failed (Question → Cards)', { error: String(error) });
    return [];
  }
}

/**
 * Find questions similar to a card (cross-modal search)
 * Used for testing: after reviewing cards, test with related questions
 */
export async function findQuestionsForCard(
  cardId: string,
  limit: number = 5,
  minSimilarity: number = 0.3
): Promise<SimilarQuestion[]> {
  const cardMeta = await prisma.card.findUnique({
    where: { id: cardId },
    select: { rotation: true },
  });
  const rotation = cardMeta?.rotation ?? null;

  try {
    const minSim = Number(minSimilarity);
    const lim = Number(limit);
    const results = rotation
      ? await prisma.$queryRaw<SimilarQuestion[]>`
          SELECT
            q.id as "questionId",
            q.stem,
            q.source,
            (1 - (ce.embedding <=> qe.embedding))::FLOAT as similarity
          FROM card_embeddings ce
          CROSS JOIN question_embeddings qe
          JOIN "Question" q ON q.id = qe.question_id
          WHERE ce.card_id = ${cardId}
            AND q.rotation = ${rotation}
            AND (1 - (ce.embedding <=> qe.embedding)) >= ${minSim}::float
          ORDER BY ce.embedding <=> qe.embedding
          LIMIT ${lim}::int
        `
      : await prisma.$queryRaw<SimilarQuestion[]>`
          SELECT
            q.id as "questionId",
            q.stem,
            q.source,
            (1 - (ce.embedding <=> qe.embedding))::FLOAT as similarity
          FROM card_embeddings ce
          CROSS JOIN question_embeddings qe
          JOIN "Question" q ON q.id = qe.question_id
          WHERE ce.card_id = ${cardId}
            AND (1 - (ce.embedding <=> qe.embedding)) >= ${minSim}::float
          ORDER BY ce.embedding <=> qe.embedding
          LIMIT ${lim}::int
        `;
    return results;
  } catch (error) {
    logger.warn('Cross-modal search failed (Card → Questions)', { error: String(error) });
    return [];
  }
}

// Re-export from shared math module
export { cosineSimilarity } from '@/lib/math/vector-math';

/**
 * Pre-compute and cache similar cards for all cards
 * Run offline to avoid runtime overhead
 */
export async function precomputeSimilarities(
  batchSize: number = 100,
  onProgress?: (completed: number, total: number) => void
): Promise<void> {
  // Get all cards
  const cards = await prisma.card.findMany({
    select: { id: true },
  });

  const total = cards.length;

  for (let i = 0; i < cards.length; i += batchSize) {
    const batch = cards.slice(i, i + batchSize);

    // For each card, find top 10 similar and cache
    for (const card of batch) {
      try {
        const similar = await findSimilar(card.id, 10, 0.5);

        await prisma.card.update({
          where: { id: card.id },
          data: {
            similarCards: similar.map((s) => ({
              cardId: s.cardId,
              similarity: s.similarity,
            })),
          },
        });
      } catch (error) {
        logger.error(`Error computing similarities for ${card.id}`, { error: String(error) });
      }
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, total), total);
    }
  }
}

/**
 * SQL to create HNSW index for fast similarity search
 * Run this after populating embeddings
 */
export const CREATE_HNSW_INDEX = `
CREATE INDEX IF NOT EXISTS card_embeddings_hnsw_idx
ON card_embeddings
USING hnsw (embedding halfvec_cosine_ops)
WITH (m = 16, ef_construction = 64);
`;

/**
 * SQL to create the embeddings table with pgvector
 */
export const CREATE_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS card_embeddings (
  id TEXT PRIMARY KEY,
  card_id TEXT UNIQUE NOT NULL REFERENCES "Card"(id) ON DELETE CASCADE,
  embedding halfvec(${STORED_MANIFOLD_DIM}) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

// =============================================================================
// Concept → Content vector search (for unified scheduler)
// =============================================================================

export interface VectorSearchResult {
  cardId: string;
  similarity: number;
}

export interface VectorQuestionSearchResult {
  questionId: string;
  similarity: number;
}

/**
 * Find cards near a concept embedding vector.
 * Uses pgvector cosine distance search.
 */
export async function findCardsNearVector(
  embedding: number[],
  options: { rotation: string; limit: number; minSimilarity: number }
): Promise<VectorSearchResult[]> {
  return findItemsNearVector<VectorSearchResult>({
    embeddingTable: 'card_embeddings',
    idColumn: 'card_id',
    idAlias: 'cardId',
    parentTable: 'Card',
    embedding,
    rotation: options.rotation,
    limit: options.limit,
    minSimilarity: options.minSimilarity,
  });
}

/**
 * Find questions near a concept embedding vector.
 * Uses pgvector cosine distance search.
 */
export async function findQuestionsNearVector(
  embedding: number[],
  options: { rotation: string; limit: number; minSimilarity: number }
): Promise<VectorQuestionSearchResult[]> {
  return findItemsNearVector<VectorQuestionSearchResult>({
    embeddingTable: 'question_embeddings',
    idColumn: 'question_id',
    idAlias: 'questionId',
    parentTable: 'Question',
    embedding,
    rotation: options.rotation,
    limit: options.limit,
    minSimilarity: options.minSimilarity,
  });
}

/**
 * Find videos near a concept embedding vector.
 */
export async function findVideosNearVector(
  embedding: number[],
  options: { rotation?: string; limit: number; minSimilarity: number }
): Promise<Array<{ videoId: string; similarity: number }>> {
  return findItemsNearVector<{ videoId: string; similarity: number }>({
    embeddingTable: 'video_embeddings',
    idColumn: 'video_id',
    idAlias: 'videoId',
    parentTable: 'Video',
    embedding,
    rotation: options.rotation,
    limit: options.limit,
    minSimilarity: options.minSimilarity,
    extraWhere: Prisma.sql`AND p.published = true AND p."rightsStatus" = 'cleared'`,
  });
}

/**
 * Load a single concept embedding from the concept_embeddings table.
 * Returns null if the concept hasn't been embedded yet.
 */
export async function loadConceptEmbedding(
  conceptId: string
): Promise<number[] | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ embedding: string }>>`
      SELECT embedding::text
      FROM concept_embeddings
      WHERE concept_id = ${conceptId}
      LIMIT 1
    `;

    if (rows.length === 0) return null;

    return toRuntimeVector(JSON.parse(rows[0].embedding) as number[]);
  } catch {
    return null;
  }
}

/**
 * Batch-load concept embeddings in a single query.
 * Returns a Map of conceptId → embedding vector.
 *
 * `truncate=true` (default) returns runtime-dim (1024) vectors — used by
 * in-JS knowledge-vector / centroid math.
 * Pass `truncate=false` when the result will be re-shipped to SQL as a
 * halfvec parameter against the 3072-dim *_embeddings tables (otherwise
 * pgvector errors with "different halfvec dimensions 3072 and 1024").
 */
export async function batchLoadConceptEmbeddings(
  conceptIds: string[],
  truncate: boolean = true,
): Promise<Map<string, number[]>> {
  try {
    return await loadEmbeddingsByIds('concept_embeddings', 'concept_id', conceptIds, truncate);
  } catch {
    // Table may not exist yet — return empty map (graceful degradation)
    return new Map();
  }
}

/**
 * Batch-load card and question embeddings for manifold walk ordering.
 * Returns a unified map keyed by item ID (card or question).
 * Point lookups by primary key — no index scan needed.
 */
export async function batchLoadItemEmbeddings(
  cardIds: string[],
  questionIds: string[],
  videoIds: string[] = []
): Promise<Map<string, number[]>> {
  if (cardIds.length === 0 && questionIds.length === 0 && videoIds.length === 0) {
    return new Map();
  }

  try {
    const maps = await Promise.all([
      loadEmbeddingsByIds('card_embeddings', 'card_id', cardIds),
      loadEmbeddingsByIds('question_embeddings', 'question_id', questionIds),
      loadEmbeddingsByIds('video_embeddings', 'video_id', videoIds),
    ]);

    // Merge all maps into one
    const result = new Map<string, number[]>();
    for (const map of maps) {
      for (const [id, emb] of map) {
        result.set(id, emb);
      }
    }
    return result;
  } catch (error) {
    logger.error('Failed to load item embeddings', { error: String(error) });
    return new Map();
  }
}

/**
 * Load a single question embedding in runtime dimension.
 * Returns null if the question hasn't been embedded.
 */
export async function loadQuestionEmbedding(
  questionId: string
): Promise<number[] | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ embedding: string }>>`
      SELECT embedding::text AS embedding
      FROM question_embeddings
      WHERE question_id = ${questionId}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return toRuntimeVector(JSON.parse(rows[0].embedding) as number[]);
  } catch {
    return null;
  }
}

// Rotation-level batch loaders + the JS cosine ranker were deleted
// 2026-04-28 as part of the embedding-egress refactor. They shipped raw
// halfvec(3072) embeddings out of Postgres for in-memory ranking; their
// SQL-native replacements live in @/lib/manifold/scoring.ts.
