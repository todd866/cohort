/**
 * SQL-native scoring primitives.
 *
 * Single source of truth for vector arithmetic in the request path.
 * Vector data NEVER leaves Postgres — these helpers return only
 * (id, score) scalars produced by pgvector operators.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sessionCandidateItemJoinSql } from '@/lib/knowledge/session-candidate-scope';
import { withHnswRuntime } from '@/lib/manifold/hnsw-runtime';
import {
  SHARED_CATALOG_CARD_SCOPE,
  scopedCardSqlPredicate,
  type CardReadScope,
} from '@/lib/cards/read-repository.server';

export type ClusterCentroidFamily =
  | 'rotation-local'
  | 'canonical-global'
  | 'nonstandard';

const CANONICAL_GLOBAL_CLUSTER_PATTERN = '^cluster-[0-9]+$';

/**
 * Shared SQL-native topology for incremental cluster assignment.
 *
 * All vector columns and aggregates stay in this canonical scoring module;
 * callers receive only counts or scalar assignment rows.
 */
export function clusterAssignmentTopologyCtes(rotation: string): Prisma.Sql {
  return Prisma.sql`
    represented AS MATERIALIZED (
      SELECT c."clusterId" AS cluster_id
      FROM "Card" c
      JOIN card_embeddings ce ON ce.card_id = c.id
      WHERE c.rotation = ${rotation}
        AND c."deletedAt" IS NULL
        AND c."shelvedAt" IS NULL
        AND c."clusterId" IS NOT NULL

      UNION

      SELECT v."clusterId" AS cluster_id
      FROM "Video" v
      JOIN video_embeddings ve ON ve.video_id = v.id
      WHERE v.rotation = ${rotation}
        AND v.published = true
        AND v."clusterId" IS NOT NULL
    ),
    member_vectors AS MATERIALIZED (
      SELECT
        c."clusterId" AS cluster_id,
        subvector(ce.embedding, 1, 1024)::vector AS runtime_embedding
      FROM "Card" c
      JOIN card_embeddings ce ON ce.card_id = c.id
      WHERE c."deletedAt" IS NULL
        AND c."shelvedAt" IS NULL
        AND c."clusterId" IS NOT NULL

      UNION ALL

      SELECT
        v."clusterId" AS cluster_id,
        subvector(ve.embedding, 1, 1024)::vector AS runtime_embedding
      FROM "Video" v
      JOIN video_embeddings ve ON ve.video_id = v.id
      WHERE v.published = true
        AND v."clusterId" IS NOT NULL
    ),
    centroids AS MATERIALIZED (
      SELECT
        cluster_id,
        AVG(runtime_embedding)::halfvec AS centroid
      FROM member_vectors
      GROUP BY cluster_id
    )
  `;
}

function clusterFamilyPredicate(
  family: ClusterCentroidFamily,
  localPrefix: string,
): Prisma.Sql {
  if (family === 'rotation-local') {
    return Prisma.sql`c.cluster_id LIKE ${localPrefix}`;
  }
  if (family === 'canonical-global') {
    return Prisma.sql`c.cluster_id ~ ${CANONICAL_GLOBAL_CLUSTER_PATTERN}`;
  }
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM represented r
      WHERE r.cluster_id = c.cluster_id
    )
    AND c.cluster_id NOT LIKE ${localPrefix}
    AND c.cluster_id !~ ${CANONICAL_GLOBAL_CLUSTER_PATTERN}
  `;
}

/** Build the bounded nearest-centroid plan without returning vector data. */
export function clusterAssignmentPlanSql(options: {
  rotation: string;
  family: ClusterCentroidFamily;
  limit: number;
}): Prisma.Sql {
  const { rotation, family, limit } = options;
  const localPrefix = `${rotation}-cluster-%`;
  const predicate = clusterFamilyPredicate(family, localPrefix);

  return Prisma.sql`
    WITH
    ${clusterAssignmentTopologyCtes(rotation)},
    targets AS MATERIALIZED (
      SELECT
        c.id AS card_id,
        subvector(ce.embedding, 1, 1024)::halfvec AS embedding
      FROM "Card" c
      JOIN card_embeddings ce ON ce.card_id = c.id
      WHERE c.rotation = ${rotation}
        AND c."deletedAt" IS NULL
        AND c."shelvedAt" IS NULL
        AND c."clusterId" IS NULL
      ORDER BY c.id
      LIMIT ${limit}
    ),
    candidate_centroids AS MATERIALIZED (
      SELECT c.cluster_id, c.centroid
      FROM centroids c
      WHERE ${predicate}
    )
    SELECT
      t.card_id,
      nearest.cluster_id,
      nearest.distance::float8 AS distance
    FROM targets t
    CROSS JOIN LATERAL (
      SELECT
        c.cluster_id,
        t.embedding <=> c.centroid AS distance
      FROM candidate_centroids c
      ORDER BY distance ASC, c.cluster_id ASC
      LIMIT 1
    ) nearest
    ORDER BY t.card_id
  `;
}

export type EmbeddingItemTable =
  | 'card_embeddings'
  | 'question_embeddings'
  | 'video_embeddings'
  | 'courseware_embeddings';

export type EmbeddingItemIdColumn =
  | 'card_id'
  | 'question_id'
  | 'video_id'
  | 'courseware_chunk_id';

const ALLOWED_TABLES: ReadonlyArray<EmbeddingItemTable> = [
  'card_embeddings',
  'question_embeddings',
  'video_embeddings',
  'courseware_embeddings',
];

const ALLOWED_COLUMNS: ReadonlyArray<EmbeddingItemIdColumn> = [
  'card_id',
  'question_id',
  'video_id',
  'courseware_chunk_id',
];

/**
 * Keep the per-concept HNSW queries below the Neon pool's connection ceiling.
 *
 * A session build scores cards and questions concurrently. With ~116 concepts,
 * unbounded Promise.all previously attempted 230+ queries from one isolate and
 * starved unrelated review writes of connections. Three scoring queries leave
 * headroom for the other reads in bulkFetchCandidates while still completing a
 * normal scoring pass in a few seconds.
 */
export const TOP_K_QUERY_CONCURRENCY = 3;

/**
 * Concepts per top-K query. The old value was effectively 1 and it cost a
 * session build tens of seconds; see the comment in
 * scoreItemsAgainstConceptsTopK for the measurement. Kept well under the bind
 * parameter ceiling, and small enough that one failed batch retries cheaply.
 */
export const TOP_K_CONCEPTS_PER_QUERY = 16;

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>, onAcquire?: (active: number) => void): Promise<T> {
    await this.acquire();
    onAcquire?.(this.active);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the released slot directly to the oldest waiter. `active` stays
      // unchanged, so a newly arriving operation cannot jump the queue.
      next();
      return;
    }
    this.active -= 1;
  }
}

// Module-global so overlapping card/question/video scoring calls in the same
// serverless isolate share one budget instead of each creating its own burst.
const topKQuerySemaphore = new AsyncSemaphore(TOP_K_QUERY_CONCURRENCY);

function assertTable(table: string): asserts table is EmbeddingItemTable {
  if (!ALLOWED_TABLES.includes(table as EmbeddingItemTable)) {
    throw new Error(`scoring: itemTable "${table}" is not allowlisted`);
  }
}

function assertColumn(column: string): asserts column is EmbeddingItemIdColumn {
  if (!ALLOWED_COLUMNS.includes(column as EmbeddingItemIdColumn)) {
    throw new Error(`scoring: itemIdColumn "${column}" is not allowlisted`);
  }
}

export interface ScoreItemsAgainstConceptsOpts {
  itemTable: EmbeddingItemTable;
  itemIdColumn: EmbeddingItemIdColumn;
  itemIds: string[];
  conceptIds: string[];
}

export interface CalibrationAnchorInput {
  sourceKey: string;
  domain: string;
  embedding: number[];
}

export interface CalibrationAnchorScoreRow {
  item_id: string;
  source_key: string;
  domain: string;
  similarity: number;
}

export interface ScoreItemsAgainstCalibrationAnchorsOpts {
  itemTable: Extract<EmbeddingItemTable, 'card_embeddings' | 'question_embeddings'>;
  itemIdColumn: Extract<EmbeddingItemIdColumn, 'card_id' | 'question_id'>;
  itemIds: string[];
  anchors: CalibrationAnchorInput[];
}

/**
 * Score items against private exam-calibration anchors in Postgres.
 *
 * The anchor vectors come from private JSON files and are passed into SQL as
 * parameters. Item vectors never leave Postgres; callers receive only scalar
 * similarities plus source/domain labels.
 */
export async function scoreItemsAgainstCalibrationAnchors(
  opts: ScoreItemsAgainstCalibrationAnchorsOpts,
): Promise<CalibrationAnchorScoreRow[]> {
  const { itemTable, itemIdColumn, itemIds, anchors } = opts;
  if (itemIds.length === 0 || anchors.length === 0) return [];

  assertTable(itemTable);
  assertColumn(itemIdColumn);

  const tbl = Prisma.raw(itemTable);
  const col = Prisma.raw(itemIdColumn);
  const valuesSql = Prisma.join(
    anchors.map((anchor) => Prisma.sql`(
      ${anchor.sourceKey}::text,
      ${anchor.domain}::text,
      ${JSON.stringify(anchor.embedding)}::halfvec
    )`),
    ', ',
  );

  const rows = await prisma.$queryRaw<CalibrationAnchorScoreRow[]>`
    WITH anchors (source_key, domain, v) AS (
      VALUES ${valuesSql}
    )
    SELECT
      ie.${col} AS item_id,
      a.source_key,
      a.domain,
      (1 - (ie.embedding <=> a.v))::float AS similarity
    FROM ${tbl} ie
    CROSS JOIN anchors a
    WHERE ie.${col} = ANY(${itemIds}::text[])
  `;

  logger.info('manifold.scoring', {
    op: 'scoreItemsAgainstCalibrationAnchors',
    table: itemTable,
    itemCount: itemIds.length,
    anchorCount: anchors.length,
    rowCount: rows.length,
  });
  return rows;
}

/**
 * Score every (concept, item) pair via pgvector cosine similarity.
 * Returns Map<conceptId, Map<itemId, similarity>>.
 */
export async function scoreItemsAgainstConcepts(
  opts: ScoreItemsAgainstConceptsOpts,
): Promise<Map<string, Map<string, number>>> {
  const { itemTable, itemIdColumn, itemIds, conceptIds } = opts;
  if (itemIds.length === 0 || conceptIds.length === 0) return new Map();

  assertTable(itemTable);
  assertColumn(itemIdColumn);

  const tbl = Prisma.raw(itemTable);
  const col = Prisma.raw(itemIdColumn);

  const rows = await prisma.$queryRaw<
    Array<{ concept_id: string; item_id: string; similarity: number }>
  >`
    SELECT
      ce.concept_id AS concept_id,
      ie.${col} AS item_id,
      (1 - (ie.embedding <=> ce.embedding))::float AS similarity
    FROM ${tbl} ie
    CROSS JOIN concept_embeddings ce
    WHERE ie.${col} = ANY(${itemIds}::text[])
      AND ce.concept_id = ANY(${conceptIds}::text[])
  `;

  const result = new Map<string, Map<string, number>>();
  for (const row of rows) {
    let inner = result.get(row.concept_id);
    if (!inner) {
      inner = new Map();
      result.set(row.concept_id, inner);
    }
    inner.set(row.item_id, Number(row.similarity));
  }
  logger.info('manifold.scoring', {
    op: 'scoreItemsAgainstConcepts',
    table: itemTable,
    itemCount: itemIds.length,
    conceptCount: conceptIds.length,
    rowCount: rows.length,
  });
  return result;
}

export interface TopConceptsForItemOpts {
  itemTable: EmbeddingItemTable;
  itemIdColumn: EmbeddingItemIdColumn;
  itemId: string;
  rotation: string;
  topK: number;
  /** Optional minimum cosine similarity floor (0–1). Default 0 (off). */
  minSimilarity?: number;
}

/**
 * Top-K nearest concepts to a SINGLE item by pgvector cosine, within `rotation`.
 *
 * Geometric replacement for topic-string association: an item's concepts are the
 * concept embeddings nearest its own embedding — not concepts that merely share a
 * topic tag (which mis-associates, e.g. an aortic-dissection card matching
 * "opioid pharmacology" via a shared `pain` tag). Returns (conceptId, similarity)
 * scalars only; vectors never leave Postgres.
 *
 * Per-call cost: O(topK) float rows out; compute is one item embedding vs all
 * `rotation` concept embeddings (~130) — a bounded brute-force scan, negligible
 * for a single item. Intended for SINGLE-item use only; do NOT loop it over many
 * items — use scoreItemsAgainstConceptsTopK for the per-concept bulk direction.
 */
export async function topConceptsForItem(
  opts: TopConceptsForItemOpts,
): Promise<Array<{ conceptId: string; similarity: number }>> {
  const { itemTable, itemIdColumn, itemId, rotation, topK } = opts;
  const minSim = opts.minSimilarity ?? 0;
  if (topK <= 0) return [];

  assertTable(itemTable);
  assertColumn(itemIdColumn);

  const tbl = Prisma.raw(itemTable);
  const col = Prisma.raw(itemIdColumn);

  const rows = await prisma.$queryRaw<
    Array<{ concept_id: string; similarity: number }>
  >`
    SELECT con.id AS concept_id,
           (1 - (ie.embedding <=> ce.embedding))::float AS similarity
    FROM ${tbl} ie
    CROSS JOIN concept_embeddings ce
    JOIN "Concept" con ON con.id = ce.concept_id AND con.rotation = ${rotation}
    WHERE ie.${col} = ${itemId}
      AND (1 - (ie.embedding <=> ce.embedding)) >= ${minSim}::float
    ORDER BY ie.embedding <=> ce.embedding
    LIMIT ${topK}
  `;

  logger.info('manifold.scoring', {
    op: 'topConceptsForItem',
    table: itemTable,
    rotation,
    rowCount: rows.length,
  });

  return rows.map((r) => ({ conceptId: r.concept_id, similarity: Number(r.similarity) }));
}

const PARENT_TABLE_FOR: Record<EmbeddingItemTable, string | null> = {
  card_embeddings: '"Card"',
  question_embeddings: '"Question"',
  video_embeddings: '"Video"',
  courseware_embeddings: null,
};

const PARENT_PK_FOR: Record<EmbeddingItemTable, string> = {
  card_embeddings: 'id',
  question_embeddings: 'id',
  video_embeddings: 'id',
  courseware_embeddings: 'id',
};

export interface ScoreItemsAgainstConceptsTopKOpts {
  itemTable: EmbeddingItemTable;
  itemIdColumn: EmbeddingItemIdColumn;
  /**
   * Concept embeddings as Map<conceptId, vector>. Caller must already have
   * these (e.g. from batchLoadConceptEmbeddings). They are passed as
   * parameterized query inputs so pgvector's HNSW index fires per-concept.
   * (Joining concept_embeddings to *_embeddings inside SQL forces a seq
   * scan because pgvector HNSW requires a literal/param search vector.)
   */
  conceptEmbeddings: Map<string, number[]>;
  rotation: string;
  /**
   * Server-authorized source partitions. Default mapping still requires
   * `moduleNodes` membership in `rotation`; `crossSourceMappingMode: 'open'`
   * admits entitled source rows without that membership.
   */
  allowedCrossSourceRotations?: readonly string[];
  crossSourceMappingMode?: 'adjacent' | 'open';
  /**
   * Required owner context for private Card vector search. Omission keeps the
   * historical public/shared-catalog behavior and excludes all private Cards.
   */
  cardReadScope?: CardReadScope;
  topK: number;
  /** Optional minimum similarity floor (0–1). Default 0 (off). */
  minSimilarity?: number;
  /** Optional extra SQL fragment ANDed against parent table. */
  extraWhere?: Prisma.Sql;
}

/**
 * For each concept, return the top-K items in `rotation` by cosine similarity.
 *
 * Runs one parameterized query per concept through a shared concurrency limit
 * so each query can use the pgvector HNSW index without exhausting the DB pool.
 * Returns
 * Map<conceptId, Map<itemId, similarity>>.
 *
 * Wire cost per call: O(|conceptEmbeddings| × topK) scalar floats —
 * typically ~30 bytes/row.
 */
export async function scoreItemsAgainstConceptsTopK(
  opts: ScoreItemsAgainstConceptsTopKOpts,
): Promise<Map<string, Map<string, number>>> {
  const { itemTable, itemIdColumn, conceptEmbeddings, rotation, topK } = opts;
  const minSim = opts.minSimilarity ?? 0;
  if (conceptEmbeddings.size === 0 || topK <= 0) return new Map();

  assertTable(itemTable);
  assertColumn(itemIdColumn);

  const tbl = Prisma.raw(itemTable);
  const col = Prisma.raw(itemIdColumn);
  const parent = PARENT_TABLE_FOR[itemTable];
  const parentPk = Prisma.raw(PARENT_PK_FOR[itemTable]);
  const parentAccessPredicate = itemTable === 'card_embeddings'
    ? scopedCardSqlPredicate(
        opts.cardReadScope ?? SHARED_CATALOG_CARD_SCOPE,
        'p',
      )
    : Prisma.sql`TRUE`;

  const parentJoin = parent
    ? Prisma.sql`JOIN ${Prisma.raw(parent)} p ON p.${parentPk} = ie.${col} AND ${sessionCandidateItemJoinSql('p', rotation, opts.allowedCrossSourceRotations, opts.crossSourceMappingMode ?? 'adjacent')} AND ${parentAccessPredicate}`
    : Prisma.empty;
  const parentRotationFilter = parent
    ? Prisma.empty
    : Prisma.sql`AND ie.rotation = ${rotation}`;

  const extra = opts.extraWhere ?? Prisma.empty;

  const startedAt = Date.now();
  let maxInFlight = 0;
  let emptyConceptCount = 0;
  // A concept that failed returns no rows, but "failed" and "nothing matched"
  // are different facts and the log has always reported them separately.
  const failedConceptIds = new Set<string>();

  // One query per CHUNK of concepts, bounded across all overlapping calls in
  // this isolate. Each concept still gets the HNSW path: the search vector is
  // a VALUES column, and the planner drives the index scan from it — measured
  // on production, EXPLAIN shows `Index Scan using card_embeddings_hnsw_idx`
  // with `Order By: (embedding <=> "*VALUES*".column2)`.
  //
  // It used to be one query per concept, and that was the session build's
  // whole latency problem. A scheduler pass issues ~610 of these queries; at a
  // concurrency of 3 that is tens of seconds, which is long enough to lose the
  // connection, and a learner who opened a topic then saw a 503. Measured on
  // 2026-09-17 against the real corpus: 32 concepts as 32 queries at
  // concurrency 3 took 36,989ms, and as two batched queries took 1,875ms,
  // returning an identical 6,400 rows.
  const entries = [...conceptEmbeddings.entries()];
  const chunks: Array<typeof entries> = [];
  for (let i = 0; i < entries.length; i += TOP_K_CONCEPTS_PER_QUERY) {
    chunks.push(entries.slice(i, i + TOP_K_CONCEPTS_PER_QUERY));
  }

  const lateralFor = (vec: Prisma.Sql) => {
    const minSimSql = minSim > 0
      ? Prisma.sql`AND (1 - (ie.embedding <=> ${vec})) >= ${minSim}::float`
      : Prisma.empty;
    return Prisma.sql`
      SELECT
        ie.${col} AS item_id,
        (1 - (ie.embedding <=> ${vec}))::float AS similarity
      FROM ${tbl} ie
      ${parentJoin}
      WHERE 1=1
        ${parentRotationFilter}
        ${extra}
        ${minSimSql}
      ORDER BY ie.embedding <=> ${vec}
      LIMIT ${topK}::int
    `;
  };

  /** Today's shape, kept as the per-concept fallback when a batch fails. */
  const runOneConcept = async (
    conceptId: string,
    vector: number[],
  ): Promise<readonly [string, Array<{ item_id: string; similarity: number }>]> => {
    const vec = Prisma.sql`${JSON.stringify(vector)}::halfvec`;
    try {
      const rows = await withHnswRuntime((transaction) =>
        transaction.$queryRaw<Array<{ item_id: string; similarity: number }>>(
          lateralFor(vec),
        ));
      return [conceptId, rows] as const;
    } catch (error) {
      failedConceptIds.add(conceptId);
      logger.warn('manifold.scoring topK query failed', {
        conceptId,
        table: itemTable,
        error: String(error),
      });
      return [conceptId, []] as const;
    }
  };

  const queries = chunks.map(async (chunk) => topKQuerySemaphore.run(async () => {
    const values = Prisma.join(
      chunk.map(([conceptId, vector]) =>
        Prisma.sql`(${conceptId}::text, ${JSON.stringify(vector)}::halfvec)`),
      ', ',
    );
    try {
      const rows = await withHnswRuntime((transaction) => transaction.$queryRaw<
        Array<{ concept_id: string; item_id: string; similarity: number }>
      >`
          SELECT c.concept_id AS concept_id, k.item_id AS item_id, k.similarity AS similarity
          FROM (VALUES ${values}) AS c(concept_id, vec)
          CROSS JOIN LATERAL (${lateralFor(Prisma.sql`c.vec`)}) k
        `);
      const grouped = new Map<string, Array<{ item_id: string; similarity: number }>>(
        chunk.map(([conceptId]) => [conceptId, []]),
      );
      for (const row of rows) {
        grouped.get(row.concept_id)?.push({ item_id: row.item_id, similarity: row.similarity });
      }
      return [...grouped.entries()].map(([conceptId, rows]) => [conceptId, rows] as const);
    } catch (error) {
      // A batch is a bigger blast radius than a single query, so it must not
      // be a worse failure mode. Degrade to exactly what this function did
      // before and lose only the concepts that individually fail.
      logger.warn('manifold.scoring topK batch failed; retrying per concept', {
        table: itemTable,
        conceptCount: chunk.length,
        error: String(error),
      });
      return Promise.all(chunk.map(([conceptId, vector]) => runOneConcept(conceptId, vector)));
    }
  }, (active) => {
    maxInFlight = Math.max(maxInFlight, active);
  }));

  const perConcept = (await Promise.all(queries)).flat();
  for (const [conceptId, rows] of perConcept) {
    if (rows.length === 0 && !failedConceptIds.has(conceptId)) emptyConceptCount += 1;
  }
  const result = new Map<string, Map<string, number>>();
  let totalRows = 0;
  for (const [conceptId, rows] of perConcept) {
    const inner = new Map<string, number>();
    for (const row of rows) {
      inner.set(row.item_id, Number(row.similarity));
    }
    result.set(conceptId, inner);
    totalRows += rows.length;
  }
  logger.info('manifold.scoring', {
    op: 'scoreItemsAgainstConceptsTopK',
    table: itemTable,
    rotation,
    conceptCount: conceptEmbeddings.size,
    topK,
    rowCount: totalRows,
    durationMs: Date.now() - startedAt,
    queryConcurrencyLimit: TOP_K_QUERY_CONCURRENCY,
    conceptsPerQuery: TOP_K_CONCEPTS_PER_QUERY,
    maxInFlight,
    failedConceptCount: failedConceptIds.size,
    emptyConceptCount,
  });
  return result;
}

export interface ScoreItemsByGapAlignmentOpts {
  itemTable: EmbeddingItemTable;
  itemIdColumn: EmbeddingItemIdColumn;
  itemIds: string[];
  rotation: string;
  /** Knowledge-vector serialized as JSON-encoded float array. */
  knowledgeVectorJson: string;
}

/**
 * For each item in `itemIds`, compute cosine similarity against the gap
 * direction = (rotation exam centroid) - (user knowledge vector). Both
 * vectors stay in Postgres; only scalars come back.
 */
export async function scoreItemsByGapAlignment(
  opts: ScoreItemsByGapAlignmentOpts,
): Promise<Map<string, number>> {
  const { itemTable, itemIdColumn, itemIds, rotation, knowledgeVectorJson } = opts;
  if (itemIds.length === 0) return new Map();

  assertTable(itemTable);
  assertColumn(itemIdColumn);

  const tbl = Prisma.raw(itemTable);
  const col = Prisma.raw(itemIdColumn);

  const rows = await prisma.$queryRaw<
    Array<{ item_id: string; alignment: number }>
  >`
    WITH exam_centroid AS (
      SELECT AVG(embedding)::halfvec AS v
      FROM courseware_embeddings
      WHERE rotation = ${rotation}
    ),
    gap AS (
      SELECT (ec.v - ${knowledgeVectorJson}::halfvec) AS dir
      FROM exam_centroid ec
      WHERE ec.v IS NOT NULL
    )
    SELECT
      ie.${col} AS item_id,
      (1 - (ie.embedding <=> g.dir))::float AS alignment
    FROM ${tbl} ie
    CROSS JOIN gap g
    WHERE ie.${col} = ANY(${itemIds}::text[])
  `;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.item_id, Number(row.alignment));
  }
  logger.info('manifold.scoring', {
    op: 'scoreItemsByGapAlignment',
    table: itemTable,
    rotation,
    itemCount: itemIds.length,
    rowCount: rows.length,
  });
  return result;
}

export interface OrderedItem {
  id: string;
  table: EmbeddingItemTable;
  column: EmbeddingItemIdColumn;
}

/**
 * Given an ordered list of items, return Map<itemId, similarityToPrior>.
 * The first item has no prior and is omitted from the result. Cross-table
 * pairs (e.g. card -> question) are supported via a CASE on the table tag.
 */
export async function scoreOrderedPairwiseDistances(
  items: OrderedItem[],
): Promise<Map<string, number>> {
  if (items.length < 2) return new Map();

  const values: Prisma.Sql[] = [];
  for (let i = 1; i < items.length; i++) {
    const curr = items[i];
    const prior = items[i - 1];
    assertTable(curr.table);
    assertColumn(curr.column);
    assertTable(prior.table);
    assertColumn(prior.column);
    values.push(Prisma.sql`(
      ${i}::int,
      ${curr.id}::text, ${curr.table}::text,
      ${prior.id}::text, ${prior.table}::text
    )`);
  }
  const valuesSql = Prisma.join(values, ', ');

  const rows = await prisma.$queryRaw<
    Array<{ item_id: string; similarity_to_prior: number }>
  >`
    WITH ordered (idx, curr_id, curr_tbl, prior_id, prior_tbl) AS (
      VALUES ${valuesSql}
    ),
    curr_emb AS (
      SELECT o.idx, o.curr_id AS id,
        CASE o.curr_tbl
          WHEN 'card_embeddings' THEN (SELECT embedding FROM card_embeddings WHERE card_id = o.curr_id)
          WHEN 'question_embeddings' THEN (SELECT embedding FROM question_embeddings WHERE question_id = o.curr_id)
          WHEN 'video_embeddings' THEN (SELECT embedding FROM video_embeddings WHERE video_id = o.curr_id)
        END AS embedding
      FROM ordered o
    ),
    prior_emb AS (
      SELECT o.idx,
        CASE o.prior_tbl
          WHEN 'card_embeddings' THEN (SELECT embedding FROM card_embeddings WHERE card_id = o.prior_id)
          WHEN 'question_embeddings' THEN (SELECT embedding FROM question_embeddings WHERE question_id = o.prior_id)
          WHEN 'video_embeddings' THEN (SELECT embedding FROM video_embeddings WHERE video_id = o.prior_id)
        END AS embedding
      FROM ordered o
    )
    SELECT
      c.id AS item_id,
      (1 - (c.embedding <=> p.embedding))::float AS similarity_to_prior
    FROM curr_emb c
    JOIN prior_emb p ON p.idx = c.idx
    WHERE c.embedding IS NOT NULL AND p.embedding IS NOT NULL
  `;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.item_id, Number(row.similarity_to_prior));
  }
  logger.info('manifold.scoring', {
    op: 'scoreOrderedPairwiseDistances',
    pairCount: items.length - 1,
    rowCount: rows.length,
  });
  return result;
}
