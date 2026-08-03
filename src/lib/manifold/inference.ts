/**
 * Mastery Inference
 *
 * Infers knowledge of untested cards based on semantically similar tested cards.
 * Core insight: if you know concepts A, B, C around concept D, you likely know D.
 */

import { prisma } from '@/lib/prisma';
import { USYD_ROTATION_IDS } from '@/lib/rotations';
import { getBlockExamDate } from '@/lib/rotation-context';
import {
  getConfiguredExamDateForRotation,
  parseExamDate,
  type ExamDateInput,
} from '@/lib/review/scheduler-config';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

export interface MasteryEstimate {
  cardId: string;
  directMastery: number | null; // From actual reviews
  inferredMastery: number; // From similar cards
  confidence: number; // How confident the inference is (0-1)
  basedOn: Array<{ cardId: string; mastery: number; similarity: number }>;
}

/**
 * Infer mastery of a card based on semantically similar reviewed cards
 */
export async function inferMastery(
  userId: string,
  cardId: string
): Promise<MasteryEstimate> {
  // Get direct mastery if exists
  const directProgress = await prisma.cardProgress.findUnique({
    where: {
      cardId_userId: { cardId, userId },
    },
  });

  // Get similar cards and their mastery
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { similarCards: true },
  });

  const similarCards = (card?.similarCards as Array<{
    cardId: string;
    similarity: number;
  }>) || [];

  if (similarCards.length === 0) {
    return {
      cardId,
      directMastery: directProgress?.retrievalStrength ?? null,
      inferredMastery: directProgress?.retrievalStrength ?? 0,
      confidence: directProgress ? 1 : 0,
      basedOn: [],
    };
  }

  // Get mastery of similar cards
  const similarProgress = await prisma.cardProgress.findMany({
    where: {
      userId,
      cardId: { in: similarCards.map((s) => s.cardId) },
    },
  });

  const progressMap = new Map(
    similarProgress.map((p) => [p.cardId, p.retrievalStrength])
  );

  // Calculate weighted average mastery
  const basedOn: MasteryEstimate['basedOn'] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const similar of similarCards) {
    const mastery = progressMap.get(similar.cardId);

    if (mastery !== undefined) {
      // Weight by similarity (higher similarity = more weight)
      const weight = similar.similarity ** 2; // Square to emphasize high similarity
      weightedSum += mastery * weight;
      totalWeight += weight;

      basedOn.push({
        cardId: similar.cardId,
        mastery,
        similarity: similar.similarity,
      });
    }
  }

  const inferredMastery = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Confidence based on:
  // 1. Number of similar cards with reviews
  // 2. Average similarity of those cards
  const reviewedCount = basedOn.length;
  const avgSimilarity =
    basedOn.length > 0
      ? basedOn.reduce((sum, b) => sum + b.similarity, 0) / basedOn.length
      : 0;

  // Confidence formula: saturates at 5 similar cards with high similarity
  const countFactor = Math.min(reviewedCount / 5, 1);
  const similarityFactor = avgSimilarity;
  const confidence = countFactor * similarityFactor;

  return {
    cardId,
    directMastery: directProgress?.retrievalStrength ?? null,
    inferredMastery,
    confidence,
    basedOn,
  };
}

/**
 * Batch infer mastery for all cards in a rotation
 * Returns cards sorted by "knowledge gap" (low inference confidence + low mastery)
 */
export async function findKnowledgeGaps(
  userId: string,
  rotation: string,
  limit: number = 20
): Promise<
  Array<{
    cardId: string;
    front: string;
    gapScore: number;
    estimate: MasteryEstimate;
  }>
> {
  // Get all cards in rotation
  const cardRows = await prisma.card.findMany({
    where: { rotation },
    select: {
      id: true,
      front: true,
      similarCards: true,
      progress: {
        where: { userId },
      },
    },
  });
  const cards = await filterDeliverableReinforcementCardRows(cardRows, {
    logContext: { transport: 'knowledge-gap-inference' },
  });

  const gaps: Array<{
    cardId: string;
    front: string;
    gapScore: number;
    estimate: MasteryEstimate;
  }> = [];

  for (const card of cards) {
    const estimate = await inferMastery(userId, card.id);

    // Gap score: high when mastery is low AND confidence is low
    // These are the "dark spots" in the knowledge manifold
    const masteryScore = estimate.directMastery ?? estimate.inferredMastery;
    const gapScore = (1 - masteryScore) * (1 - estimate.confidence);

    gaps.push({
      cardId: card.id,
      front: card.front,
      gapScore,
      estimate,
    });
  }

  // Sort by gap score (highest first = biggest knowledge gaps)
  gaps.sort((a, b) => b.gapScore - a.gapScore);

  return gaps.slice(0, limit);
}

/**
 * Calculate overall manifold coverage for a user/rotation
 */
export async function getManifoldCoverage(
  userId: string,
  rotation: string
): Promise<{
  totalCards: number;
  directlyTested: number;
  inferred: number;
  gaps: number;
  overallMastery: number;
}> {
  const cards = await prisma.card.findMany({
    where: { rotation },
    select: { id: true },
  });

  const progress = await prisma.cardProgress.findMany({
    where: {
      userId,
      card: { rotation },
    },
  });

  const testedIds = new Set(progress.map((p) => p.cardId));

  let totalMastery = 0;
  let inferredCount = 0;
  let gapCount = 0;

  for (const card of cards) {
    if (testedIds.has(card.id)) {
      const p = progress.find((pr) => pr.cardId === card.id)!;
      totalMastery += p.retrievalStrength;
    } else {
      const estimate = await inferMastery(userId, card.id);

      if (estimate.confidence > 0.5) {
        // High confidence inference
        totalMastery += estimate.inferredMastery;
        inferredCount++;
      } else {
        // Gap in knowledge
        gapCount++;
        totalMastery += estimate.inferredMastery * 0.5; // Partial credit
      }
    }
  }

  return {
    totalCards: cards.length,
    directlyTested: testedIds.size,
    inferred: inferredCount,
    gaps: gapCount,
    overallMastery: cards.length > 0 ? totalMastery / cards.length : 0,
  };
}

/**
 * Calculate time-decayed retrieval strength (FSRS-style)
 * Memory decays over time following a power law
 *
 * @param strength - Current retrieval strength (0-1)
 * @param daysSinceReview - Days since last review
 * @param stability - Memory stability (higher = slower decay)
 * @returns Predicted current retrieval probability (0-1)
 */
export function calculateDecayedStrength(
  strength: number,
  daysSinceReview: number,
  stabilityDays: number = 3
): number {
  if (daysSinceReview <= 0) return strength;

  // FSRS-style power law decay: R(t) = (1 + t/S)^(-0.5) * R0
  // Where S is stability (days until 90% retention drops to ~60%)
  const decayFactor = Math.pow(1 + daysSinceReview / stabilityDays, -0.5);
  return strength * decayFactor;
}

/**
 * Get days until exam for a rotation (with buffer for one more review)
 * Exam dates derived from BLOCKS in rotation-context.ts (single source of truth)
 */
export function getDaysUntilExam(
  rotation: string | undefined,
  now: Date = new Date(),
  examDateOverride?: ExamDateInput
): number {
  const examDate =
    parseExamDate(examDateOverride)
    ?? getConfiguredExamDateForRotation(rotation)
    ?? (rotation ? getBlockExamDate(rotation) : null);
  if (!examDate) return 60; // Default cap if no exam date

  const daysUntil = (examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  // Leave 7 days buffer before exam for final review cycle
  // But never less than 3 days (cards should still cycle during exam week)
  return Math.max(3, daysUntil - 7);
}

/**
 * Update stability (half-life-ish) after a review.
 * This is intentionally simple and non-SM-2: we track a single stability scalar
 * that grows with successful reviews and shrinks on failures.
 *
 * IMPORTANT: Stability is capped relative to exam date - no card should
 * have stability longer than time-until-exam. This ensures every card
 * gets reviewed at least once more before the exam.
 */
export function updateStabilityDays(
  currentStabilityDays: number,
  quality: number, // 0-5
  rotation?: string, // Optional: if provided, cap to exam timeline
  now?: Date,
  maxIntervalOverride?: number, // Optional: core skill cap (e.g., 21 days for ECG)
  examDateOverride?: ExamDateInput
): number {
  const minDays = 0.5;

  // Exam-aware cap: either time until exam OR 60 days (whichever is smaller)
  const examCap = (rotation || examDateOverride)
    ? getDaysUntilExam(rotation, now, examDateOverride)
    : 60;
  const moduleCap = maxIntervalOverride ?? 60;
  const maxDays = Math.min(moduleCap, examCap);

  const baseline = Number.isFinite(currentStabilityDays) && currentStabilityDays > 0
    ? currentStabilityDays
    : 3;

  if (quality < 3) {
    return Math.max(minDays, baseline * 0.8);
  }

  const multiplier = 1.4 + 0.1 * Math.max(0, quality - 3); // 3→1.4, 4→1.5, 5→1.6
  return Math.min(maxDays, baseline * multiplier);
}

function qualityToTargetStrength(quality: number): number {
  if (quality >= 5) return 1.0;
  if (quality === 4) return 0.9;
  if (quality === 3) return 0.8;
  if (quality === 2) return 0.5;
  return 0.3; // wrong but seen — exposure still counts
}

/**
 * Update retrieval strength after a review
 * Uses exponential moving average with recency weighting + time decay.
 *
 * First review uses high alpha (0.9) so strength immediately reflects the
 * review outcome — there's no prior to blend with. Subsequent reviews use
 * a shrinking alpha (floor 0.3) for stability while remaining responsive.
 */
export function updateRetrievalStrength(
  storedStrength: number,
  quality: number, // 0-5
  totalReviews: number,
  daysSinceLastReview: number = 0,
  stabilityDays: number = 3
): number {
  // First, apply time decay to current strength
  const decayedStrength = calculateDecayedStrength(storedStrength, daysSinceLastReview, stabilityDays);

  const targetStrength = qualityToTargetStrength(quality);

  // First review: nearly direct write (no meaningful prior to blend with).
  // Subsequent reviews: shrinking alpha but with a higher floor so late
  // reviews still move the needle and strength can actually reach targets.
  const alpha = totalReviews === 0
    ? 0.9
    : Math.min(
        0.7,
        Math.max(0.3, 0.7 / Math.sqrt(Math.max(1, totalReviews)))
      );

  return decayedStrength + (targetStrength - decayedStrength) * alpha;
}

/**
 * Get the current (decayed) retrieval strength for a card
 * Call this to estimate exam-day recall probability
 */
export function getCurrentRetrievalStrength(
  storedStrength: number,
  lastReviewDate: Date | null,
  stabilityDays: number
): number {
  if (!lastReviewDate) return 0;

  const daysSinceReview = Math.max(
    0,
    (Date.now() - lastReviewDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  return calculateDecayedStrength(storedStrength, daysSinceReview, stabilityDays);
}

/**
 * Predict retrieval strength on a future date (e.g., exam day)
 */
export function predictRetrievalStrengthOnDate(
  storedStrength: number,
  lastReviewDate: Date | null,
  targetDate: Date,
  stabilityDays: number
): number {
  if (!lastReviewDate) return 0;

  const daysBetween = Math.max(
    0,
    (targetDate.getTime() - lastReviewDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  return calculateDecayedStrength(storedStrength, daysBetween, stabilityDays);
}

/**
 * Compute the next due date for a card given its post-review strength and stability.
 *
 * For power-law decay: R(t) = R0 * (1 + t/S)^(-0.5)
 * Solve for t when R(t)=threshold:
 *   t = S * ((R0/threshold)^2 - 1)
 */
export function computeNextDueAt(
  strength: number,
  lastReviewDate: Date,
  stabilityDays: number,
  threshold: number,
  now: Date = new Date()
): Date {
  if (!Number.isFinite(strength) || strength <= 0) return now;
  if (!Number.isFinite(stabilityDays) || stabilityDays <= 0) return now;
  if (!Number.isFinite(threshold) || threshold <= 0) return now;
  if (strength <= threshold) return now;

  const ratio = strength / threshold;
  const daysUntilDue = stabilityDays * (ratio * ratio - 1);
  if (!Number.isFinite(daysUntilDue) || daysUntilDue <= 0) return now;

  return new Date(lastReviewDate.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
}

/**
 * Cross-rotation knowledge transfer
 * When you learn something in one rotation, infer knowledge boost in related rotations
 */
export async function getCrossRotationTransfer(
  userId: string,
  cardId: string
): Promise<Array<{
  rotation: string;
  relatedCardId: string;
  similarity: number;
  transferredMastery: number;
}>> {
  // Find cards in OTHER rotations that are semantically similar
  const crossRotationCards = await prisma.$queryRaw<
    Array<{
      card_id: string;
      rotation: string;
      similarity: number;
    }>
  >`
    SELECT card_id, rotation, similarity
    FROM find_cross_rotation_cards(${cardId}, 5)
  `;

  if (crossRotationCards.length === 0) {
    return [];
  }

  // Get the source card's mastery
  const sourceProgress = await prisma.cardProgress.findUnique({
    where: {
      cardId_userId: { cardId, userId },
    },
  });

  const sourceMastery = sourceProgress?.retrievalStrength ?? 0;

  // Calculate transferred mastery (discounted by similarity)
  return crossRotationCards.map((related) => ({
    rotation: related.rotation,
    relatedCardId: related.card_id,
    similarity: related.similarity,
    // Transfer is proportional to similarity and source mastery
    transferredMastery: sourceMastery * related.similarity * 0.7, // 70% transfer max
  }));
}

/**
 * Get overall knowledge state across ALL rotations
 * Shows how knowledge from each rotation supports others
 */
export async function getGlobalKnowledgeState(
  userId: string
): Promise<{
  rotations: Array<{
    id: string;
    directMastery: number;
    inferredFromOthers: number;
    totalEstimate: number;
    cardCount: number;
    testedCount: number;
  }>;
  crossRotationStrength: number; // How well knowledge transfers between rotations
  overallReadiness: number;
}> {
  const rotations = USYD_ROTATION_IDS;
  const results: Array<{
    id: string;
    directMastery: number;
    inferredFromOthers: number;
    totalEstimate: number;
    cardCount: number;
    testedCount: number;
  }> = [];

  let totalCrossTransfer = 0;
  let crossTransferCount = 0;

  for (const rotation of rotations) {
    // Get direct mastery in this rotation
    const cards = await prisma.card.findMany({
      where: { rotation },
      select: { id: true },
    });

    const progress = await prisma.cardProgress.findMany({
      where: {
        userId,
        card: { rotation },
      },
    });

    const directMastery =
      progress.length > 0
        ? progress.reduce((sum, p) => sum + p.retrievalStrength, 0) / cards.length
        : 0;

    // Calculate inferred mastery from other rotations
    let inferredFromOthers = 0;
    let inferCount = 0;

    for (const card of cards) {
      const hasDirectProgress = progress.some((p) => p.cardId === card.id);

      if (!hasDirectProgress) {
        // Check for cross-rotation knowledge transfer
        const transfers = await getCrossRotationTransfer(userId, card.id);
        if (transfers.length > 0) {
          const avgTransfer =
            transfers.reduce((sum, t) => sum + t.transferredMastery, 0) /
            transfers.length;
          inferredFromOthers += avgTransfer;
          inferCount++;
          totalCrossTransfer += avgTransfer;
          crossTransferCount++;
        }
      }
    }

    const inferredAvg = inferCount > 0 ? inferredFromOthers / cards.length : 0;

    results.push({
      id: rotation,
      directMastery,
      inferredFromOthers: inferredAvg,
      totalEstimate: directMastery + inferredAvg * 0.5, // Inferred counts for 50%
      cardCount: cards.length,
      testedCount: progress.length,
    });
  }

  // Cross-rotation strength: average transfer effectiveness
  const crossRotationStrength =
    crossTransferCount > 0 ? totalCrossTransfer / crossTransferCount : 0;

  // Overall readiness: weighted by card count
  const totalCards = results.reduce((sum, r) => sum + r.cardCount, 0);
  const overallReadiness =
    totalCards > 0
      ? results.reduce((sum, r) => sum + r.totalEstimate * r.cardCount, 0) /
        totalCards
      : 0;

  return {
    rotations: results,
    crossRotationStrength,
    overallReadiness,
  };
}
