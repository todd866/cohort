import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  clusterAssignmentPlanSql,
  clusterAssignmentTopologyCtes,
} from '@/lib/manifold/scoring';

export type ClusterAssignmentFamily =
  | 'rotation-local'
  | 'canonical-global'
  | 'nonstandard'
  | 'none';

export interface ClusterFamilyCounts {
  localCentroids: number;
  canonicalGlobalCentroids: number;
  nonstandardCentroids: number;
}

/** Stable namespace precedence for assigning new cards without reshaping history. */
export function chooseClusterFamily(counts: ClusterFamilyCounts): ClusterAssignmentFamily {
  if (counts.localCentroids > 0) return 'rotation-local';
  if (counts.canonicalGlobalCentroids > 0) return 'canonical-global';
  if (counts.nonstandardCentroids > 0) return 'nonstandard';
  return 'none';
}

export interface ClusterAssignmentDb {
  $queryRaw(query: Prisma.Sql): Promise<unknown>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

export interface ClusterAssignmentClient extends ClusterAssignmentDb {
  $transaction<T>(
    work: (tx: ClusterAssignmentDb) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export interface AssignMissingCardClustersOptions {
  rotation: string;
  limit?: number;
  client?: ClusterAssignmentClient;
}

export interface ClusterAssignmentError {
  stage: 'validation' | 'transaction';
  message: string;
}

export interface IncrementalClusterAssignmentResult {
  ok: boolean;
  rotation: string;
  limit: number;
  family: ClusterAssignmentFamily;
  candidateCentroids: number;
  affectedClusterIds: string[];
  counts: {
    eligible: number;
    considered: number;
    planned: number;
    assigned: number;
    deferredByLimit: number;
    metadataUpdated: number;
    masteryStatesStaled: number;
  };
  skipped: {
    missingEmbedding: number;
    noCentroid: number;
    concurrentOrChanged: number;
  };
  errors: ClusterAssignmentError[];
}

interface AvailabilityRow {
  eligible_count: bigint | number;
  missing_embedding_count: bigint | number;
  local_centroid_count: bigint | number;
  canonical_global_centroid_count: bigint | number;
  nonstandard_centroid_count: bigint | number;
}

interface AssignmentPlanRow {
  card_id: string;
  cluster_id: string;
  distance: number;
}

interface UpdatedAssignmentRow {
  card_id: string;
  cluster_id: string;
}

interface IdRow {
  id: string;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1_000;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 120_000;
const CANONICAL_GLOBAL_PATTERN = '^cluster-[0-9]+$';

function count(value: bigint | number | null | undefined): number {
  return Number(value ?? 0);
}

function normalizedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value!)));
}

function emptyResult(rotation: string, limit: number): IncrementalClusterAssignmentResult {
  return {
    ok: true,
    rotation,
    limit,
    family: 'none',
    candidateCentroids: 0,
    affectedClusterIds: [],
    counts: {
      eligible: 0,
      considered: 0,
      planned: 0,
      assigned: 0,
      deferredByLimit: 0,
      metadataUpdated: 0,
      masteryStatesStaled: 0,
    },
    skipped: {
      missingEmbedding: 0,
      noCentroid: 0,
      concurrentOrChanged: 0,
    },
    errors: [],
  };
}

function candidateCount(family: ClusterAssignmentFamily, counts: ClusterFamilyCounts): number {
  if (family === 'rotation-local') return counts.localCentroids;
  if (family === 'canonical-global') return counts.canonicalGlobalCentroids;
  if (family === 'nonstandard') return counts.nonstandardCentroids;
  return 0;
}

/**
 * Assign one bounded batch of active, embedded, unclustered cards.
 *
 * Existing assignments are never updated. A rotation with no established
 * centroid is reported for explicit bootstrap and is not mutated here.
 */
export async function assignMissingCardClusters(
  options: AssignMissingCardClustersOptions,
): Promise<IncrementalClusterAssignmentResult> {
  const rotation = options.rotation.trim();
  const limit = normalizedLimit(options.limit);
  const result = emptyResult(rotation, limit);

  if (!rotation) {
    result.ok = false;
    result.errors.push({ stage: 'validation', message: 'rotation is required' });
    return result;
  }

  const client = options.client
    ?? (prisma as unknown as ClusterAssignmentClient);
  const localPrefix = `${rotation}-cluster-%`;

  let observedAvailability: AvailabilityRow | undefined;
  let observedFamily: ClusterAssignmentFamily = 'none';
  let observedCandidateCentroids = 0;
  let observedPlanCount = 0;
  let observedConcurrentOrChanged = 0;

  try {
    return await client.$transaction(async (tx) => {
      const topology = clusterAssignmentTopologyCtes(rotation);
      const availabilityRows = await tx.$queryRaw(Prisma.sql`
        WITH
        ${topology},
        eligible AS MATERIALIZED (
          SELECT c.id
          FROM "Card" c
          JOIN card_embeddings ce ON ce.card_id = c.id
          WHERE c.rotation = ${rotation}
            AND c."deletedAt" IS NULL
            AND c."shelvedAt" IS NULL
            AND c."clusterId" IS NULL
        )
        SELECT
          (SELECT COUNT(*) FROM eligible)::bigint AS eligible_count,
          (
            SELECT COUNT(*)
            FROM "Card" c
            WHERE c.rotation = ${rotation}
              AND c."deletedAt" IS NULL
              AND c."shelvedAt" IS NULL
              AND c."clusterId" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM card_embeddings ce WHERE ce.card_id = c.id
              )
          )::bigint AS missing_embedding_count,
          (
            SELECT COUNT(*)
            FROM centroids c
            WHERE c.cluster_id LIKE ${localPrefix}
              AND EXISTS (
                SELECT 1 FROM represented r WHERE r.cluster_id LIKE ${localPrefix}
              )
          )::bigint AS local_centroid_count,
          (
            SELECT COUNT(*)
            FROM centroids c
            WHERE c.cluster_id ~ ${CANONICAL_GLOBAL_PATTERN}
              AND EXISTS (
                SELECT 1
                FROM represented r
                WHERE r.cluster_id ~ ${CANONICAL_GLOBAL_PATTERN}
              )
          )::bigint AS canonical_global_centroid_count,
          (
            SELECT COUNT(*)
            FROM centroids c
            JOIN represented r ON r.cluster_id = c.cluster_id
            WHERE c.cluster_id NOT LIKE ${localPrefix}
              AND c.cluster_id !~ ${CANONICAL_GLOBAL_PATTERN}
          )::bigint AS nonstandard_centroid_count
      `) as AvailabilityRow[];

      const availability = availabilityRows[0] ?? {
        eligible_count: 0,
        missing_embedding_count: 0,
        local_centroid_count: 0,
        canonical_global_centroid_count: 0,
        nonstandard_centroid_count: 0,
      };
      observedAvailability = availability;

      const eligible = count(availability.eligible_count);
      const considered = Math.min(eligible, limit);
      const familyCounts: ClusterFamilyCounts = {
        localCentroids: count(availability.local_centroid_count),
        canonicalGlobalCentroids: count(availability.canonical_global_centroid_count),
        nonstandardCentroids: count(availability.nonstandard_centroid_count),
      };
      const family = chooseClusterFamily(familyCounts);
      const centroids = candidateCount(family, familyCounts);
      observedFamily = family;
      observedCandidateCentroids = centroids;

      const summary = emptyResult(rotation, limit);
      summary.family = family;
      summary.candidateCentroids = centroids;
      summary.counts.eligible = eligible;
      summary.counts.considered = considered;
      summary.counts.deferredByLimit = Math.max(0, eligible - considered);
      summary.skipped.missingEmbedding = count(availability.missing_embedding_count);

      if (considered === 0) return summary;
      if (family === 'none') {
        summary.skipped.noCentroid = considered;
        return summary;
      }

      const planRows = await tx.$queryRaw(clusterAssignmentPlanSql({
        rotation,
        family,
        limit,
      })) as AssignmentPlanRow[];
      observedPlanCount = planRows.length;
      summary.counts.planned = planRows.length;

      if (planRows.length === 0) {
        summary.skipped.noCentroid = considered;
        return summary;
      }

      const cardIds = planRows.map((row) => row.card_id);
      const clusterIds = planRows.map((row) => row.cluster_id);
      const updatedRows = await tx.$queryRaw(Prisma.sql`
        WITH planned AS (
          SELECT *
          FROM unnest(
            ${cardIds}::text[],
            ${clusterIds}::text[]
          ) AS p(card_id, cluster_id)
        )
        UPDATE "Card" c
        SET "clusterId" = p.cluster_id
        FROM planned p
        WHERE c.id = p.card_id
          AND c.rotation = ${rotation}
          AND c."deletedAt" IS NULL
          AND c."shelvedAt" IS NULL
          AND c."clusterId" IS NULL
        RETURNING c.id AS card_id, c."clusterId" AS cluster_id
      `) as UpdatedAssignmentRow[];

      observedConcurrentOrChanged = Math.max(0, planRows.length - updatedRows.length);
      if (observedConcurrentOrChanged > 0) {
        throw new Error(
          `planned ${planRows.length} card assignments but updated ${updatedRows.length}; transaction rolled back`,
        );
      }

      const affectedClusterIds = [...new Set(updatedRows.map((row) => row.cluster_id))].sort();
      summary.affectedClusterIds = affectedClusterIds;
      summary.counts.assigned = updatedRows.length;

      if (affectedClusterIds.length === 0) return summary;

      const metadataRows = await tx.$queryRaw(Prisma.sql`
        UPDATE "Cluster" cl
        SET
          "cardCount" = (
            SELECT COUNT(*)::int
            FROM "Card" c
            WHERE c."clusterId" = cl.id
              AND c."deletedAt" IS NULL
              AND c."shelvedAt" IS NULL
          ),
          "videoCount" = (
            SELECT COUNT(*)::int
            FROM "Video" v
            WHERE v."clusterId" = cl.id
              AND v.published = true
          ),
          rotations = ARRAY(
            SELECT represented_rotation
            FROM (
              SELECT c.rotation AS represented_rotation
              FROM "Card" c
              WHERE c."clusterId" = cl.id
                AND c."deletedAt" IS NULL
                AND c."shelvedAt" IS NULL
              UNION
              SELECT v.rotation AS represented_rotation
              FROM "Video" v
              WHERE v."clusterId" = cl.id
                AND v.published = true
            ) represented_rotations
            WHERE represented_rotation IS NOT NULL
            ORDER BY represented_rotation
          ),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE cl.id = ANY(${affectedClusterIds}::text[])
        RETURNING cl.id
      `) as IdRow[];
      summary.counts.metadataUpdated = metadataRows.length;

      summary.counts.masteryStatesStaled = await tx.$executeRaw(Prisma.sql`
        UPDATE "UserClusterState"
        SET "lastComputedAt" = to_timestamp(0)
        WHERE "clusterId" = ANY(${affectedClusterIds}::text[])
      `);

      return summary;
    }, {
      maxWait: TRANSACTION_MAX_WAIT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    const failed = emptyResult(rotation, limit);
    failed.ok = false;
    failed.family = observedFamily;
    failed.candidateCentroids = observedCandidateCentroids;
    if (observedAvailability) {
      failed.counts.eligible = count(observedAvailability.eligible_count);
      failed.counts.considered = Math.min(failed.counts.eligible, limit);
      failed.counts.planned = observedPlanCount;
      failed.counts.deferredByLimit = Math.max(0, failed.counts.eligible - failed.counts.considered);
      failed.skipped.missingEmbedding = count(observedAvailability.missing_embedding_count);
      failed.skipped.concurrentOrChanged = observedConcurrentOrChanged;
    }
    failed.errors.push({
      stage: 'transaction',
      message: error instanceof Error ? error.message : String(error),
    });
    return failed;
  }
}
