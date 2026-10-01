/**
 * Manifold Audit Metrics
 *
 * Computes metrics for evaluating the manifold-based learning system:
 * - Coverage: % of exam manifold explored
 * - Geometric distance: user → exam target
 * - Content density: sparse regions needing generation
 * - Feedback loops: probe → remediate → retest effectiveness
 */

import { prisma } from '@/lib/prisma';

// ============================================================================
// Types
// ============================================================================

export interface CoverageMetrics {
  // Overall
  totalExamPoints: number;
  userCoveredPoints: number;
  coveragePercent: number;

  // By strength tier
  strongPoints: number; // ≥ 0.7 (exam-ready)
  mediumPoints: number; // 0.4-0.7 (learning)
  weakPoints: number; // 0.1-0.4 (exposed but weak)
  coldPoints: number; // < 0.1 (never seen)

  // By week
  weekCoverage: Array<{
    week: number | null;
    total: number;
    exposed: number;
    avgStrength: number;
    cold: number;
  }>;

  // Distribution
  strengthHistogram: number[]; // 10 bins: [0-0.1, 0.1-0.2, ..., 0.9-1.0]
}

export interface GeometricMetrics {
  // Current state
  l2Distance: number;
  cosineSimilarity: number;

  // Convergence (if historical data available)
  distanceDelta7d?: number;
  convergenceRate?: number;
  daysToTarget?: number;

  // Weakest regions
  weakestRegions: Array<{
    centroid?: number[]; // Embedding (optional for now)
    description: string;
    userStrength: number;
    targetStrength: number;
    gap: number;
    contentCount: number;
    failCount?: number;
  }>;
}

export interface ContentDensityMetrics {
  // Sparse regions
  sparseRegions: Array<{
    centroid?: number[];
    description: string;
    userStrength?: number;
    contentCount: number;
    examRelevance?: number;
    priority: 'URGENT' | 'HIGH' | 'MEDIUM';
  }>;

  // Variation counts
  averageVariationsPerConcept: number;
  conceptsWithSingleCard: number;

  // Struggle regions without alternatives
  struggleRegionsWithoutAlternatives: Array<{
    cardId: string;
    failCount: number;
    alternativesWithinRadius: number;
  }>;
}

export interface FeedbackLoopMetrics {
  totalLoops: number;
  successfulLoops: number;
  failedLoops: number;
  loopSuccessRate: number;

  // Timing
  avgTimeToRetest?: number;
  avgCardsReviewedBetween?: number;

  // Recent loops
  recentLoops: Array<{
    questionId: string;
    failedAt: Date;
    cardsShown: string[];
    retestedAt: Date | null;
    retestedCorrect: boolean | null;
  }>;
}

// ============================================================================
// Coverage Metrics
// ============================================================================

/**
 * Compute coverage metrics for a user/rotation
 * Shows how much of the exam manifold they've explored
 */
export async function computeCoverageMetrics(
  userId: string,
  rotation: string
): Promise<CoverageMetrics> {
  // Get all cards in rotation
  const allCards = await prisma.card.findMany({
    where: { rotation },
    select: {
      id: true,
      week: true,
      progress: {
        where: { userId },
        select: { retrievalStrength: true },
      },
    },
  });

  const totalExamPoints = allCards.length;

  // Count by strength tier
  let strongPoints = 0;
  let mediumPoints = 0;
  let weakPoints = 0;
  let coldPoints = 0;

  // Build histogram (10 bins)
  const strengthHistogram = new Array(10).fill(0);

  // Build week breakdown
  const weekMap = new Map<
    number | null,
    {
      total: number;
      exposed: number;
      strengthSum: number;
      cold: number;
    }
  >();

  for (const card of allCards) {
    const strength =
      card.progress.length > 0 ? card.progress[0].retrievalStrength : 0;

    // Count by tier
    if (strength >= 0.7) strongPoints++;
    else if (strength >= 0.4) mediumPoints++;
    else if (strength >= 0.1) weakPoints++;
    else coldPoints++;

    // Add to histogram
    const bin = Math.min(9, Math.floor(strength * 10));
    strengthHistogram[bin]++;

    // Add to week breakdown
    if (!weekMap.has(card.week)) {
      weekMap.set(card.week, {
        total: 0,
        exposed: 0,
        strengthSum: 0,
        cold: 0,
      });
    }
    const weekData = weekMap.get(card.week)!;
    weekData.total++;
    if (strength > 0) {
      weekData.exposed++;
      weekData.strengthSum += strength;
    }
    if (strength < 0.1) {
      weekData.cold++;
    }
  }

  // Convert week map to array
  const weekCoverage = Array.from(weekMap.entries())
    .map(([week, data]) => ({
      week,
      total: data.total,
      exposed: data.exposed,
      avgStrength: data.exposed > 0 ? data.strengthSum / data.exposed : 0,
      cold: data.cold,
    }))
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0));

  const userCoveredPoints = strongPoints + mediumPoints + weakPoints;
  const coveragePercent =
    totalExamPoints > 0 ? userCoveredPoints / totalExamPoints : 0;

  return {
    totalExamPoints,
    userCoveredPoints,
    coveragePercent,
    strongPoints,
    mediumPoints,
    weakPoints,
    coldPoints,
    weekCoverage,
    strengthHistogram,
  };
}

// ============================================================================
// Geometric Metrics
// ============================================================================

/**
 * Compute geometric distance metrics
 * Measures how far the user is from exam-ready state
 */
export async function computeGeometricMetrics(
  userId: string,
  rotation: string
): Promise<GeometricMetrics> {
  // Get all cards with user progress
  const cards = await prisma.card.findMany({
    where: { rotation },
    select: {
      id: true,
      week: true,
      clusterId: true,
      progress: {
        where: { userId },
        select: { retrievalStrength: true },
      },
    },
  });

  // Target strength (exam-ready = 0.7 across all cards)
  const targetStrength = 0.7;

  // Compute L2 distance (Euclidean)
  let sumSquaredDiff = 0;
  let dotProduct = 0;
  let userMagnitude = 0;
  let targetMagnitude = 0;

  for (const card of cards) {
    const userStr =
      card.progress.length > 0 ? card.progress[0].retrievalStrength : 0;
    const diff = targetStrength - userStr;

    sumSquaredDiff += diff * diff;
    dotProduct += userStr * targetStrength;
    userMagnitude += userStr * userStr;
    targetMagnitude += targetStrength * targetStrength;
  }

  const l2Distance = Math.sqrt(sumSquaredDiff);

  // Compute cosine similarity
  const cosineSimilarity =
    userMagnitude > 0 && targetMagnitude > 0
      ? dotProduct / (Math.sqrt(userMagnitude) * Math.sqrt(targetMagnitude))
      : 0;

  // Find weakest regions (group by week, find largest gaps)
  const weekGaps = new Map<
    number | null,
    {
      userStrengthSum: number;
      count: number;
      cardIds: string[];
    }
  >();

  for (const card of cards) {
    const userStr =
      card.progress.length > 0 ? card.progress[0].retrievalStrength : 0;

    if (!weekGaps.has(card.week)) {
      weekGaps.set(card.week, {
        userStrengthSum: 0,
        count: 0,
        cardIds: [],
      });
    }
    const weekData = weekGaps.get(card.week)!;
    weekData.userStrengthSum += userStr;
    weekData.count++;
    weekData.cardIds.push(card.id);
  }

  const weakestRegions = Array.from(weekGaps.entries())
    .map(([week, data]) => ({
      description: `Week ${week}`,
      userStrength: data.count > 0 ? data.userStrengthSum / data.count : 0,
      targetStrength,
      gap:
        targetStrength -
        (data.count > 0 ? data.userStrengthSum / data.count : 0),
      contentCount: data.count,
    }))
    .filter((r) => r.gap > 0.2) // Only include significant gaps
    .sort((a, b) => b.gap - a.gap) // Largest gap first
    .slice(0, 5); // Top 5 weakest regions

  return {
    l2Distance,
    cosineSimilarity,
    weakestRegions,
  };
}

// ============================================================================
// Content Density Metrics
// ============================================================================

/**
 * Compute content density metrics
 * Identifies sparse regions that need content generation
 */
export async function computeContentDensityMetrics(
  rotation: string,
  userId?: string
): Promise<ContentDensityMetrics> {
  // Get cluster distribution
  const clusters = await prisma.cluster.findMany({
    where: {
      rotations: { has: rotation },
    },
    include: {
      cards: {
        where: { rotation },
        select: {
          id: true,
          clusterId: true,
          progress: userId
            ? {
                where: { userId },
                select: { retrievalStrength: true },
              }
            : false,
        },
      },
    },
  });

  // Sparse regions (< 3 cards in cluster)
  const sparseRegions: ContentDensityMetrics['sparseRegions'] = [];

  for (const cluster of clusters) {
    const contentCount = cluster.cards.length;

    if (contentCount < 3) {
      // Calculate avg user strength if userId provided
      let userStrength: number | undefined;
      if (userId) {
        const strengths = cluster.cards
          .map((c) =>
            c.progress && c.progress.length > 0
              ? c.progress[0].retrievalStrength
              : 0
          )
          .filter((s) => s > 0);
        userStrength =
          strengths.length > 0
            ? strengths.reduce((a, b) => a + b, 0) / strengths.length
            : 0;
      }

      // Priority: URGENT if user weak + very sparse, HIGH if just sparse, MEDIUM otherwise
      let priority: 'URGENT' | 'HIGH' | 'MEDIUM' = 'MEDIUM';
      if (contentCount === 1) {
        priority = userStrength && userStrength < 0.3 ? 'URGENT' : 'HIGH';
      } else if (contentCount === 2) {
        priority = userStrength && userStrength < 0.4 ? 'HIGH' : 'MEDIUM';
      }

      sparseRegions.push({
        description: cluster.name || `Cluster ${cluster.id.slice(0, 8)}`,
        contentCount,
        userStrength,
        priority,
      });
    }
  }

  // Sort by priority then by content count
  sparseRegions.sort((a, b) => {
    const priorityOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2 };
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }
    return a.contentCount - b.contentCount;
  });

  // Calculate average variations per concept (use cluster as proxy for concept)
  const totalClusters = clusters.length;
  const totalCards = clusters.reduce((sum, c) => sum + c.cards.length, 0);
  const averageVariationsPerConcept =
    totalClusters > 0 ? totalCards / totalClusters : 0;

  // Concepts with single card
  const conceptsWithSingleCard = clusters.filter(
    (c) => c.cards.length === 1
  ).length;

  // Struggle regions without alternatives (if userId provided)
  const struggleRegionsWithoutAlternatives: ContentDensityMetrics['struggleRegionsWithoutAlternatives'] =
    [];

  if (userId) {
    // Find cards with high fail count and few cluster alternatives
    // Since we don't have individual review records, use aggregated CardProgress data
    const failedCards = await prisma.cardProgress.findMany({
      where: {
        userId,
        card: { rotation, deletedAt: null },
        totalReviews: { gte: 3 }, // At least 3 reviews
      },
      include: {
        card: {
          select: {
            id: true,
            clusterId: true,
          },
        },
      },
    });

    for (const progress of failedCards) {
      // Estimate failures based on totalReviews - correctCount
      const failCount = progress.totalReviews - progress.correctCount;
      const failRate = progress.totalReviews > 0 ? failCount / progress.totalReviews : 0;

      // High fail rate (>50%) indicates struggle
      if (failRate > 0.5 && failCount >= 3) {
        // Count alternatives in same cluster
        const cluster = progress.card.clusterId
          ? clusters.find((c) => c.id === progress.card.clusterId)
          : null;
        const alternativesWithinRadius = cluster
          ? cluster.cards.length - 1
          : 0; // -1 to exclude the card itself

        if (alternativesWithinRadius < 2) {
          struggleRegionsWithoutAlternatives.push({
            cardId: progress.cardId,
            failCount,
            alternativesWithinRadius,
          });
        }
      }
    }
  }

  return {
    sparseRegions,
    averageVariationsPerConcept,
    conceptsWithSingleCard,
    struggleRegionsWithoutAlternatives,
  };
}

// ============================================================================
// Feedback Loop Metrics
// ============================================================================

/**
 * Compute feedback loop metrics
 * Tracks probe → remediate → retest effectiveness
 */
export async function computeFeedbackLoopMetrics(
  userId: string,
  rotation: string
): Promise<FeedbackLoopMetrics> {
  // Get question responses for this user/rotation
  const responses = await prisma.questionResponse.findMany({
    where: {
      userId,
      question: { rotation },
    },
    include: {
      question: {
        select: {
          id: true,
          stem: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Track loops: incorrect answer → potential remediation → retest
  const loops: FeedbackLoopMetrics['recentLoops'] = [];
  const questionMap = new Map<
    string,
    Array<{ timestamp: Date; correct: boolean }>
  >();

  // Group responses by question
  for (const response of responses) {
    if (!questionMap.has(response.questionId)) {
      questionMap.set(response.questionId, []);
    }
    questionMap.get(response.questionId)!.push({
      timestamp: response.createdAt,
      correct: response.isCorrect,
    });
  }

  let successfulLoops = 0;
  let failedLoops = 0;

  // Detect loops: fail then retest
  for (const [questionId, attempts] of questionMap.entries()) {
    // Sort by timestamp (oldest first)
    attempts.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    for (let i = 0; i < attempts.length - 1; i++) {
      const current = attempts[i];
      const next = attempts[i + 1];

      if (!current.correct) {
        // This is a fail
        const failedAt = current.timestamp;
        const retestedAt = next.timestamp;
        const retestedCorrect = next.correct;

        // Cards shown between fail and retest cannot be resolved here because
        // CardProgress stores aggregated counts, not per-review timestamps.
        // Populating cardsShown requires a per-review log table (e.g., ReviewEvent)
        // that records each card review with a timestamp.
        const loop = {
          questionId,
          failedAt,
          cardsShown: [] as string[],
          retestedAt,
          retestedCorrect,
        };

        loops.push(loop);

        if (retestedCorrect) {
          successfulLoops++;
        } else {
          failedLoops++;
        }
      }
    }
  }

  const totalLoops = successfulLoops + failedLoops;
  const loopSuccessRate =
    totalLoops > 0 ? successfulLoops / totalLoops : 0;

  // Keep only recent loops (last 10)
  const recentLoops = loops.slice(0, 10);

  return {
    totalLoops,
    successfulLoops,
    failedLoops,
    loopSuccessRate,
    recentLoops,
  };
}
