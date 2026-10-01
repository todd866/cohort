import { Prisma } from '@prisma/client';

export interface ClusterMetadataTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

export interface ClusterMetadataClient {
  $transaction<T>(work: (tx: ClusterMetadataTransaction) => Promise<T>): Promise<T>;
}

export interface ClusterMetadataRefreshResult {
  clusterIds: string[];
  metadataUpdated: number;
  masteryStatesInvalidated: number;
}

interface RefreshedClusterRow {
  id: string;
  card_count: number;
}

export function buildExplicitClusterCardCountRefreshSql(clusterIds: string[]): Prisma.Sql {
  return Prisma.sql`
    UPDATE "Cluster" cl
    SET
      "cardCount" = (
        SELECT COUNT(*)::int
        FROM "Card" c
        WHERE c."clusterId" = cl.id
          AND c."deletedAt" IS NULL
          AND c."shelvedAt" IS NULL
      ),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE cl.id = ANY(${clusterIds}::text[])
    RETURNING cl.id, cl."cardCount" AS card_count
  `;
}

export function buildExplicitClusterStateInvalidationSql(clusterIds: string[]): Prisma.Sql {
  return Prisma.sql`
    UPDATE "UserClusterState"
    SET "lastComputedAt" = to_timestamp(0)
    WHERE "clusterId" = ANY(${clusterIds}::text[])
  `;
}

/**
 * Refresh metadata only for preflight-validated explicit cluster targets.
 * The metadata update and mastery-cache invalidation are atomic and use a
 * parameterized text[] value, never interpolated identifiers or content.
 */
export async function refreshExplicitClusterMetadata(
  client: ClusterMetadataClient,
  targetClusterIds: string[],
): Promise<ClusterMetadataRefreshResult> {
  const clusterIds = [...new Set(targetClusterIds.filter(Boolean))].sort();
  if (clusterIds.length === 0) {
    return { clusterIds, metadataUpdated: 0, masteryStatesInvalidated: 0 };
  }

  return client.$transaction(async (tx) => {
    const refreshed = await tx.$queryRaw<RefreshedClusterRow[]>(
      buildExplicitClusterCardCountRefreshSql(clusterIds),
    );

    // Preflight validated every target. A missing row here indicates a
    // concurrent topology change; abort so metadata and cache state cannot
    // diverge silently.
    if (refreshed.length !== clusterIds.length) {
      throw new Error(
        `Explicit cluster metadata refresh expected ${clusterIds.length} rows, updated ${refreshed.length}`,
      );
    }

    const masteryStatesInvalidated = await tx.$executeRaw(
      buildExplicitClusterStateInvalidationSql(clusterIds),
    );

    return {
      clusterIds,
      metadataUpdated: refreshed.length,
      masteryStatesInvalidated,
    };
  });
}
