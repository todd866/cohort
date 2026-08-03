/**
 * Clustering Module
 *
 * Groups semantically related cards into clusters.
 * Detects cross-rotation concepts.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { shuffle } from '@/lib/utils/shuffle';

export interface ClusterInfo {
  id: string;
  name: string;
  rotations: string[];
  cardCount: number;
  topics: string[];
}

interface ClusterAssignment {
  cardId: string;
  clusterId: string;
  distance: number;
}

/**
 * K-means clustering on card embeddings
 * Runs offline as a batch job
 */
export async function clusterCards(
  numClusters: number = 50,
  maxIterations: number = 100
): Promise<ClusterInfo[]> {
  // Get all embeddings
  const embeddings = await prisma.$queryRaw<
    Array<{ card_id: string; embedding: string; rotation: string; topics: string[] }>
  >`
    SELECT
      ce.card_id,
      ce.embedding::text as embedding,
      c.rotation,
      c.topics
    FROM card_embeddings ce
    JOIN "Card" c ON c.id = ce.card_id
  `;

  if (embeddings.length === 0) {
    logger.info('No embeddings found, skipping clustering');
    return [];
  }

  // Parse embeddings from text (pgvector returns as string)
  const parsed = embeddings.map((e) => ({
    ...e,
    embedding: JSON.parse(e.embedding.replace(/^\[/, '[').replace(/\]$/, ']')) as number[],
  }));

  // Initialize centroids randomly
  let centroids = shuffle(parsed).slice(0, numClusters).map((e) => [...e.embedding]);

  // K-means iterations
  let assignments: ClusterAssignment[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each card to nearest centroid
    assignments = parsed.map((item) => {
      let minDist = Infinity;
      let nearestCluster = 0;

      for (let k = 0; k < centroids.length; k++) {
        const dist = euclideanDistance(item.embedding, centroids[k]);
        if (dist < minDist) {
          minDist = dist;
          nearestCluster = k;
        }
      }

      return {
        cardId: item.card_id,
        clusterId: `cluster-${nearestCluster}`,
        distance: minDist,
      };
    });

    // Update centroids
    const newCentroids = centroids.map((_, k) => {
      const clusterItems = parsed.filter(
        (_, i) => assignments[i].clusterId === `cluster-${k}`
      );

      if (clusterItems.length === 0) {
        return centroids[k]; // Keep old centroid if cluster is empty
      }

      // Average of all embeddings in cluster
      const dim = centroids[k].length;
      const avg = new Array(dim).fill(0);

      for (const item of clusterItems) {
        for (let d = 0; d < dim; d++) {
          avg[d] += item.embedding[d] / clusterItems.length;
        }
      }

      return avg;
    });

    // Check convergence
    const moved = centroids.some((c, k) =>
      c.some((v, d) => Math.abs(v - newCentroids[k][d]) > 0.0001)
    );

    centroids = newCentroids;

    if (!moved) {
      logger.info('K-means converged', { iteration: iter });
      break;
    }
  }

  // Create/update clusters in database
  const clusterMap = new Map<string, { rotations: Set<string>; topics: string[]; count: number }>();

  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    const item = parsed[i];

    if (!clusterMap.has(assignment.clusterId)) {
      clusterMap.set(assignment.clusterId, {
        rotations: new Set(),
        topics: [],
        count: 0,
      });
    }

    const cluster = clusterMap.get(assignment.clusterId)!;
    cluster.rotations.add(item.rotation);
    cluster.topics.push(...item.topics);
    cluster.count++;
  }

  // Save clusters
  const clusterInfos: ClusterInfo[] = [];

  for (const [clusterId, data] of clusterMap) {
    // Get most common topics for cluster name
    const topicCounts = data.topics.reduce(
      (acc, t) => {
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    const name = topTopics.join(' / ') || 'Unnamed Cluster';
    const rotations = [...data.rotations];

    // Upsert cluster
    const cluster = await prisma.cluster.upsert({
      where: { id: clusterId },
      create: {
        id: clusterId,
        name,
        rotations,
        cardCount: data.count,
      },
      update: {
        name,
        rotations,
        cardCount: data.count,
      },
    });

    clusterInfos.push({
      id: cluster.id,
      name: cluster.name,
      rotations: cluster.rotations,
      cardCount: cluster.cardCount,
      topics: topTopics,
    });
  }

  // Update card cluster assignments
  for (const assignment of assignments) {
    await prisma.card.update({
      where: { id: assignment.cardId },
      data: { clusterId: assignment.clusterId },
    });
  }

  return clusterInfos;
}

/**
 * Assign a single new card to the nearest cluster
 */
export async function assignCluster(cardId: string): Promise<string | null> {
  // Get card embedding
  const embedding = await prisma.$queryRaw<[{ embedding: string }] | []>`
    SELECT embedding::text
    FROM card_embeddings
    WHERE card_id = ${cardId}
  `;

  if (embedding.length === 0) {
    return null;
  }

  // Find nearest cluster centroid
  const nearestCluster = await prisma.$queryRaw<[{ cluster_id: string }] | []>`
    WITH card_emb AS (
      SELECT embedding FROM card_embeddings WHERE card_id = ${cardId}
    )
    SELECT c.id as cluster_id
    FROM "Cluster" c
    JOIN "Card" cards ON cards."clusterId" = c.id
    JOIN card_embeddings ce ON ce.card_id = cards.id
    CROSS JOIN card_emb
    GROUP BY c.id
    ORDER BY AVG(card_emb.embedding <=> ce.embedding)
    LIMIT 1
  `;

  if (nearestCluster.length === 0) {
    return null;
  }

  const clusterId = nearestCluster[0].cluster_id;

  await prisma.card.update({
    where: { id: cardId },
    data: { clusterId },
  });

  return clusterId;
}

/**
 * Get cross-rotation clusters (concepts that span multiple rotations)
 */
export async function getCrossRotationClusters(): Promise<ClusterInfo[]> {
  const clusters = await prisma.cluster.findMany({
    where: {
      rotations: {
        // Has more than one rotation
        // Prisma doesn't support array length check directly
      },
    },
  });

  return clusters
    .filter((c) => c.rotations.length > 1)
    .map((c) => ({
      id: c.id,
      name: c.name,
      rotations: c.rotations,
      cardCount: c.cardCount,
      topics: [], // Would need additional query
    }));
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

// =============================================================================
// Cluster Mastery
// =============================================================================

export interface ClusterMastery {
  clusterId: string;
  clusterName: string;
  mastery: number; // 0-1, average retrieval strength of cards
  cardCount: number;
  cardsReviewed: number;
  avgRetrieval: number;
  needsAttention: boolean; // Low mastery, high importance
}

/**
 * Get cluster mastery for a user in a rotation.
 * Reads from persisted UserClusterState, falls back to computing if stale/missing.
 */
export async function getClusterMastery(
  userId: string,
  rotation: string,
  options: { maxAgeMs?: number } = {}
): Promise<ClusterMastery[]> {
  const { maxAgeMs = 60 * 60 * 1000 } = options; // Default 1 hour cache

  // Get all clusters for this rotation
  const clusters = await prisma.cluster.findMany({
    where: {
      rotations: { has: rotation },
    },
    select: {
      id: true,
      name: true,
      cardCount: true,
    },
  });

  if (clusters.length === 0) {
    return [];
  }

  const clusterIds = clusters.map((c) => c.id);
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - maxAgeMs);

  // Try to read from persisted state
  const persistedStates = await prisma.userClusterState.findMany({
    where: {
      userId,
      clusterId: { in: clusterIds },
      lastComputedAt: { gte: staleThreshold },
    },
  });

  const persistedMap = new Map(persistedStates.map((s) => [s.clusterId, s]));

  // Check if we have fresh data for all clusters
  const missingOrStale = clusterIds.filter((id) => !persistedMap.has(id));

  if (missingOrStale.length > 0) {
    // Compute and persist for missing/stale clusters
    await refreshClusterMastery(userId, rotation, missingOrStale);

    // Re-fetch
    const refreshed = await prisma.userClusterState.findMany({
      where: {
        userId,
        clusterId: { in: missingOrStale },
      },
    });
    for (const s of refreshed) {
      persistedMap.set(s.clusterId, s);
    }
  }

  // Build mastery list from persisted state
  const masteryList: ClusterMastery[] = clusters.map((cluster) => {
    const state = persistedMap.get(cluster.id);

    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      mastery: state?.mastery ?? 0,
      cardCount: cluster.cardCount,
      cardsReviewed: state?.cardsReviewed ?? 0,
      avgRetrieval: state?.avgRetrieval ?? 0,
      needsAttention: state?.needsAttention ?? false,
    };
  });

  return masteryList.sort((a, b) => a.mastery - b.mastery);
}

/**
 * Refresh cluster mastery state for specific clusters.
 * Called when persisted state is stale or missing.
 */
async function refreshClusterMastery(
  userId: string,
  rotation: string,
  clusterIds: string[]
): Promise<void> {
  const now = new Date();

  // Get card progress for these clusters
  const progressData = await prisma.card.findMany({
    where: {
      rotation,
      deletedAt: null,
      shelvedAt: null,
      clusterId: { in: clusterIds },
    },
    select: {
      clusterId: true,
      progress: {
        where: { userId },
        select: {
          retrievalStrength: true,
          lastReview: true,
        },
      },
    },
  });

  // Aggregate by cluster
  const clusterStats = new Map<
    string,
    { totalStrength: number; reviewed: number; total: number; lastReview: Date | null }
  >();

  for (const card of progressData) {
    if (!card.clusterId) continue;

    if (!clusterStats.has(card.clusterId)) {
      clusterStats.set(card.clusterId, { totalStrength: 0, reviewed: 0, total: 0, lastReview: null });
    }

    const stats = clusterStats.get(card.clusterId)!;
    stats.total++;

    if (card.progress.length > 0) {
      const prog = card.progress[0];
      stats.reviewed++;
      stats.totalStrength += prog.retrievalStrength;
      if (prog.lastReview && (!stats.lastReview || prog.lastReview > stats.lastReview)) {
        stats.lastReview = prog.lastReview;
      }
    }
  }

  // Get cluster card counts
  const clusters = await prisma.cluster.findMany({
    where: { id: { in: clusterIds } },
    select: { id: true, cardCount: true },
  });
  const clusterCardCounts = new Map(clusters.map((c) => [c.id, c.cardCount]));

  // Upsert each cluster state
  for (const clusterId of clusterIds) {
    const stats = clusterStats.get(clusterId);
    const cardCount = clusterCardCounts.get(clusterId) ?? 0;

    const avgRetrieval = stats && stats.reviewed > 0 ? stats.totalStrength / stats.reviewed : 0;
    const coverage = stats ? stats.reviewed / Math.max(1, stats.total) : 0;
    const mastery = avgRetrieval * coverage;
    const needsAttention = mastery < 0.4 && cardCount >= 10;

    await prisma.userClusterState.upsert({
      where: {
        userId_clusterId: { userId, clusterId },
      },
      update: {
        mastery,
        avgRetrieval,
        coverage,
        cardsReviewed: stats?.reviewed ?? 0,
        cardsTotal: stats?.total ?? 0,
        needsAttention,
        lastReviewedAt: stats?.lastReview,
        lastComputedAt: now,
      },
      create: {
        userId,
        clusterId,
        mastery,
        avgRetrieval,
        coverage,
        cardsReviewed: stats?.reviewed ?? 0,
        cardsTotal: stats?.total ?? 0,
        needsAttention,
        lastReviewedAt: stats?.lastReview,
        lastComputedAt: now,
      },
    });
  }
}

/**
 * Invalidate cluster state for a user after they review a card.
 * Called from recordCardReview to mark state as needing refresh.
 */
export async function invalidateClusterState(
  userId: string,
  clusterId: string | null
): Promise<void> {
  if (!clusterId) return;

  // Set lastComputedAt to epoch to force refresh on next read
  await prisma.userClusterState.updateMany({
    where: { userId, clusterId },
    data: { lastComputedAt: new Date(0) },
  });
}

/**
 * Get weak clusters that need more practice.
 */
export async function getWeakClusters(
  userId: string,
  rotation: string,
  limit: number = 5
): Promise<ClusterMastery[]> {
  const mastery = await getClusterMastery(userId, rotation);
  return mastery.filter((c) => c.needsAttention).slice(0, limit);
}

/**
 * Get cards from weak clusters that should be prioritized.
 */
export async function getCardsFromWeakClusters(
  userId: string,
  rotation: string,
  limit: number = 10
): Promise<string[]> {
  const weakClusters = await getWeakClusters(userId, rotation, 3);

  if (weakClusters.length === 0) {
    return [];
  }

  const clusterIds = weakClusters.map((c) => c.clusterId);

  // Get due cards from weak clusters
  const now = new Date();

  const dueCards = await prisma.card.findMany({
    where: {
      rotation,
      deletedAt: null,
      clusterId: { in: clusterIds },
      progress: {
        none: {
          userId,
          nextDueAt: { gt: now },
          suppressed: true,
        },
      },
    },
    select: { id: true },
    take: limit,
  });

  return dueCards.map((c) => c.id);
}
