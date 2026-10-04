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
import { withHnswRuntime } from './hnsw-runtime';
import { STORED_MANIFOLD_DIM, toRuntimeVector } from './config';

export interface SimilarCard {
  cardId: string;
  similarity: number;
  rotation?: string;
  front?: string;
  complexity?: number;
  /** Siblings share this; a sibling is the same fact reworded, never a scaffold for it. */
  variantGroupId?: string | null;
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

  // Slice to the runtime dimension INSIDE Postgres. `embedding::text` is
  // about 39 KB per row at 3072 dims, and slicing after the fact meant every
  // runtime-dim load still shipped the full vector — measured 2026-09-17 at
  // roughly 10 GB/day across the scheduler's concept and item loads. The
  // literal 1024 is RUNTIME_MANIFOLD_DIM; a test pins the two together.
  const rows = truncate
    ? await prisma.$queryRaw<Array<{ id: string; embedding: string }>>`
        SELECT ${col} AS id, subvector(embedding, 1, 1024)::text AS embedding
        FROM ${tbl}
        WHERE ${col} = ANY(${ids}::text[])
      `
    : await prisma.$queryRaw<Array<{ id: string; embedding: string }>>`
        SELECT ${col} AS id, embedding::text AS embedding
        FROM ${tbl}
        WHERE ${col} = ANY(${ids}::text[])
      `;

  for (const row of rows) {
    const parsed = JSON.parse(row.embedding) as number[];
    // Still applied: a no-op on a sliced row, and the guard if a table ever
    // holds a vector narrower than the slice asks for.
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

    const results = await withHnswRuntime((transaction) => transaction.$queryRaw<T[]>`
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
      `);

    return results;
  } catch (error) {
    logger.warn(`pgvector concept→${embeddingTable} search failed`, { error: String(error) });
    return [];
  }
}

/**
 * hnsw.ef_search for findSimilar. Its scan carries no filter, so it stops once the inner LIMIT
 * (the caller's limit plus the source card) is filled: one pass of this many candidates covers
 * every caller. The shared 1,000 is sized for the concept searches that filter inside the scan.
 */
export const FIND_SIMILAR_EF_SEARCH = 100;

/**
 * The findSimilar search: nearest neighbours first, straight off the HNSW index (ORDER BY the
 * distance to a parameter, LIMIT k + 1 so the source card itself cannot take a slot), then the
 * source card and the similarity floor on those rows.
 *
 * Similarity falls as distance grows, so "the first k rows that clear the floor" and "the k
 * nearest rows, then the floor" are the same set for an exact search. With the floor inside the
 * scan, a card with fewer than k close neighbours kept the iterative scan walking towards
 * hnsw.max_scan_tuples, detoasting a vector for every candidate it rejected. The Card join stays
 * inside so an embedding with no Card row cannot take a slot, as before. The distance is
 * computed once and the vector sent once (it was sent three times).
 *
 * Exported so the integration test can EXPLAIN exactly the statement findSimilar runs.
 */
export function findSimilarSql(options: {
  sourceVector: string;
  cardId: string;
  limit: number;
  minSimilarity: number;
}): Prisma.Sql {
  const lim = Number(options.limit);
  const minSim = Number(options.minSimilarity);
  return Prisma.sql`
    SELECT
      nn."cardId",
      nn.rotation,
      nn.front,
      nn.complexity,
      nn."variantGroupId",
      (1 - nn.distance)::float AS similarity
    FROM (
      SELECT
        c.id AS "cardId",
        c.rotation,
        c.front,
        c.complexity,
        c."variantGroupId" AS "variantGroupId",
        e.embedding <=> ${options.sourceVector}::halfvec AS distance
      FROM card_embeddings e
      JOIN "Card" c ON c.id = e.card_id
      ORDER BY distance
      LIMIT ${lim + 1}::int
    ) nn
    WHERE nn."cardId" <> ${options.cardId}
      AND (1 - nn.distance) >= ${minSim}::float
    ORDER BY nn.distance
    LIMIT ${lim}::int
  `;
}

/**
 * How a neighbour search ran. Only 'embedding' makes an empty result mean "nothing near this card":
 * - 'embedding': the card's own vector was searched;
 * - 'topics': the topic fallback ran, because embeddings are unavailable or the vector query failed;
 * - 'none': nothing was searched, because the card has no embedding yet.
 */
export type SimilarSearchSource = 'embedding' | 'topics' | 'none';

export interface SimilarSearch {
  neighbours: SimilarCard[];
  source: SimilarSearchSource;
}

async function topicNeighbours(cardId: string, limit: number, minSimilarity: number): Promise<SimilarCard[]> {
  const fallbackResults = await findSimilarByTopics(cardId, limit);
  return fallbackResults.filter((r) => r.similarity >= minSimilarity);
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
  return (await searchSimilar(cardId, limit, minSimilarity)).neighbours;
}

/**
 * findSimilar's search, with how it ran. A caller that treats "no neighbours" as a finding (the
 * failed-card scaffold path records it as missing content) must check `source`: a card with no
 * embedding returns the same empty list without anything having been searched.
 */
export async function searchSimilar(
  cardId: string,
  limit: number = 10,
  minSimilarity: number = 0.5
): Promise<SimilarSearch> {
  // Check if embeddings are available
  const useEmbeddings = await checkEmbeddings();

  if (!useEmbeddings) {
    // Fallback to topic-based similarity
    return { neighbours: await topicNeighbours(cardId, limit, minSimilarity), source: 'topics' };
  }

  // Resolve the source vector first, then pass it back as a query parameter.
  // pgvector can use the HNSW index only when the ORDER BY search vector is a
  // literal/parameter. The previous e1.embedding <=> e2.embedding join made
  // PostgreSQL scan and sort the entire embedding table for every failed card.
  try {
    const sourceRows = await prisma.$queryRaw<Array<{ embedding: string }>>`
      SELECT embedding::text AS embedding
      FROM card_embeddings
      WHERE card_id = ${cardId}
      LIMIT 1
    `;

    if (sourceRows.length === 0) return { neighbours: [], source: 'none' };
    const sourceVector = sourceRows[0].embedding;
    const results = await withHnswRuntime(
      (transaction) => transaction.$queryRaw<SimilarCard[]>(
        findSimilarSql({ sourceVector, cardId, limit, minSimilarity }),
      ),
      undefined,
      { efSearch: FIND_SIMILAR_EF_SEARCH },
    );

    return { neighbours: results, source: 'embedding' };
  } catch (error) {
    // Embedding query failed, fall back to topics
    logger.warn('Embedding query failed, using topic fallback', { error: String(error) });
    _hasEmbeddings = false;
    return { neighbours: await topicNeighbours(cardId, limit, minSimilarity), source: 'topics' };
  }
}

/**
 * The findCardsForQuestion search. The question's vector is a join column, so no index can serve
 * it: this is an exact scan of the cards in the question's rotation (of every card, when there is
 * no rotation), as it always was. The OFFSET 0 fence stops the planner inlining the subquery,
 * which would copy the distance back into the WHERE, the sort and the select list: three vector
 * comparisons, each detoasting both vectors, for every card instead of one. The floor and the
 * order then work on the distance already computed.
 *
 * Exported so the integration test can EXPLAIN exactly the statement findCardsForQuestion runs.
 */
export function cardsForQuestionSql(options: {
  questionId: string;
  rotation: string | null;
  limit: number;
  minSimilarity: number;
}): Prisma.Sql {
  const lim = Number(options.limit);
  const minSim = Number(options.minSimilarity);
  const rotationBound = options.rotation
    ? Prisma.sql`AND c.rotation = ${options.rotation}`
    : Prisma.empty;
  return Prisma.sql`
    SELECT
      nn."cardId",
      nn.rotation,
      nn.front,
      (1 - nn.distance)::float AS similarity
    FROM (
      SELECT
        c.id AS "cardId",
        c.rotation,
        c.front,
        qe.embedding <=> ce.embedding AS distance
      FROM question_embeddings qe
      CROSS JOIN card_embeddings ce
      JOIN "Card" c ON c.id = ce.card_id
      WHERE qe.question_id = ${options.questionId}
        ${rotationBound}
      OFFSET 0
    ) nn
    WHERE (1 - nn.distance) >= ${minSim}::float
    ORDER BY nn.distance
    LIMIT ${lim}::int
  `;
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
    const results = await prisma.$queryRaw<SimilarCard[]>(
      cardsForQuestionSql({ questionId, rotation, limit, minSimilarity }),
    );
    return results;
  } catch (error) {
    logger.warn('Cross-modal search failed (Question → Cards)', { error: String(error) });
    return [];
  }
}

// findCrossRotation and findQuestionsForCard were deleted 2026-10-02: neither had a caller, and
// both still compared one stored vector with every row of an embedding table, up to three times
// a row. A new search of that kind should start from cardsForQuestionSql's shape (one distance
// per row, behind an OFFSET 0 fence) or findSimilarSql's (index first, filters after).

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
  const now = Date.now();
  const result = new Map<string, number[]>();
  const missing: string[] = [];
  for (const conceptId of conceptIds) {
    const hit = conceptEmbeddingMemo.get(memoKey(conceptId, truncate));
    if (hit && now - hit.loadedAt <= CONCEPT_EMBEDDING_MEMO_TTL_MS) {
      result.set(conceptId, hit.vector);
    } else {
      missing.push(conceptId);
    }
  }
  if (missing.length === 0) return result;
  try {
    const loaded = await loadEmbeddingsByIds('concept_embeddings', 'concept_id', missing, truncate);
    for (const [conceptId, vector] of loaded) {
      result.set(conceptId, vector);
      rememberConceptEmbedding(memoKey(conceptId, truncate), vector, now);
    }
    return result;
  } catch {
    // Table may not exist yet — return what the memo had (graceful degradation)
    return result;
  }
}

/**
 * Per-isolate memo of concept vectors.
 *
 * The scheduler loads the same rotation's concept embeddings on every pass —
 * on the order of 1,800 passes a day across cache warming, live sessions and
 * offline-pack rotations, at ~116 vectors × 39 KB each — and a concept's
 * embedding changes only when a script re-embeds it. Sourcing the vectors
 * inside the top-K query instead was measured 40% slower on production
 * (2026-09-17), so the vectors stay in Node and the cure is not to fetch them
 * again. Vercel reuses a warm isolate across many requests; each fresh one
 * pays the load once.
 *
 * Bounded two ways: entries expire after the TTL (so a re-embed is picked up
 * within the hour without any cross-process invalidation), and the map is
 * capped so a pathological caller cannot grow it past the concept catalogue.
 * The values are shared by reference — callers already treat them as
 * read-only (`truncateToManifoldDim` copies).
 *
 * The TTL was 10 minutes, the same as the session-cache warm cron's cadence,
 * so cron runs missed the memo almost every time. A concept vector changes
 * only when a script re-embeds it, and the precomputed concept top-K (which
 * reads vectors inside Postgres) is invalidated by trigger, not by this memo.
 */
export const CONCEPT_EMBEDDING_MEMO_TTL_MS = 60 * 60 * 1000;
const CONCEPT_EMBEDDING_MEMO_MAX_ENTRIES = 4_000;
const conceptEmbeddingMemo = new Map<string, { vector: number[]; loadedAt: number }>();

function memoKey(conceptId: string, truncate: boolean): string {
  return `${truncate ? 'r' : 'f'}:${conceptId}`;
}

function rememberConceptEmbedding(key: string, vector: number[], loadedAt: number): void {
  if (conceptEmbeddingMemo.size >= CONCEPT_EMBEDDING_MEMO_MAX_ENTRIES) {
    // Insertion order is oldest-first, so evicting the first key is an LRU-ish
    // drop of the stalest load rather than a full flush.
    const oldest = conceptEmbeddingMemo.keys().next().value;
    if (oldest !== undefined) conceptEmbeddingMemo.delete(oldest);
  }
  conceptEmbeddingMemo.set(key, { vector, loadedAt });
}

/** Test seam; also the right call after an in-process re-embed. */
export function resetConceptEmbeddingMemo(): void {
  conceptEmbeddingMemo.clear();
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
