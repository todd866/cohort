/**
 * Struggle Region Logic
 *
 * Tracks WHERE in embedding space users are struggling (not just which cards).
 * Uses pgvector for fast similarity operations to find "bridge cards" -
 * cards near the struggle region that the user already knows well.
 *
 * This is local intelligence: embeddings + pgvector, no LLM API calls needed.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

// =============================================================================
// Types
// =============================================================================

export interface StruggleRegion {
  id: string;
  userId: string;
  rotation: string;
  failedCardIds: string[];
  totalFailCount: number;
  avgFailsPerCard: number;
  avgResponseMs: number | null;
  activeSince: Date;
  resolvedAt: Date | null;
}

export interface BridgeCard {
  id: string;
  front: string;
  similarity: number;
  retrievalStrength: number;
  complexity: number;
}

export interface StruggleState {
  isStuck: boolean;
  failCount: number;
  windowStart: Date | null;
}

// =============================================================================
// Constants
// =============================================================================

const STRUGGLE_THRESHOLD = 3; // Fails in window to trigger stuck state
const STRUGGLE_WINDOW_HOURS = 24;

// Chronic-stuck detection — uses lifetime stats so cards that fail
// repeatedly across many days (rather than within one 24h window) still
// trigger the intervention pipeline. These patterns are missed by a 24h
// window when failures are spaced too far apart.
export const CHRONIC_STUCK_MIN_REVIEWS = 3;
export const CHRONIC_STUCK_MAX_ACCURACY = 0.3;
/**
 * Acute-stuck band — broader than chronic. Mirrors the no-scaffolding-on-fail
 * audit pathology threshold (≥3 misses, accuracy < 50%). Cards/MCQs in this band
 * still need scaffolding even though they don't qualify as chronic-stuck.
 * Co-located with walk-pathologies.ts SCAFFOLDING_MIN_MISSES so the two stay
 * in lockstep — see scheduler-side handling in struggle-interventions.ts.
 */
export const ACUTE_STUCK_MIN_REVIEWS = 3;
export const ACUTE_STUCK_MAX_ACCURACY = 0.5;
/** Min retrieval strength for bridge cards (lower = accept weaker cards as scaffolds) */
export const BRIDGE_CARD_MIN_MASTERY = 0.3;
/** Max distance in embedding space (1 - similarity). Lower = require closer match. */
export const BRIDGE_CARD_MAX_DISTANCE = 0.3;

const LEECH_MIN_REVIEWS = 5;
const LEECH_BASE_SUPPRESSION_HOURS = 72;
const LEECH_MAX_SUPPRESSION_HOURS = 336; // 14 days

/**
 * Cumulative leech detection — catches cards that fail slowly over days.
 * Unlike isCardStuck (24h window), this checks lifetime stats.
 */
export function isLeech(totalReviews: number, correctCount: number): boolean {
  return totalReviews >= LEECH_MIN_REVIEWS && correctCount === 0;
}

/**
 * Compute suppression window with exponential backoff.
 * First suppression: 72h, then doubles, capped at 14 days.
 */
export function computeLeechSuppressionHours(suppressionCount: number): number {
  const hours = LEECH_BASE_SUPPRESSION_HOURS * Math.pow(2, suppressionCount);
  return Math.min(hours, LEECH_MAX_SUPPRESSION_HOURS);
}

// =============================================================================
// Struggle Detection
// =============================================================================

/**
 * Check if a card is *chronically* stuck — repeated failure across the
 * card's lifetime, regardless of when those failures occurred.
 *
 * Used alongside the 24h-window `isCardStuck` so the intervention
 * pipeline fires both for "today they keep missing it" and for "they've
 * been missing this for weeks at low accuracy."
 */
export function isCardChronicallyStuck(totalReviews: number, correctCount: number): boolean {
  if (totalReviews < CHRONIC_STUCK_MIN_REVIEWS) return false;
  const accuracy = correctCount / totalReviews;
  return accuracy <= CHRONIC_STUCK_MAX_ACCURACY;
}

/**
 * Check if a card or MCQ is *acutely* stuck — ≥3 reviews at <50% accuracy.
 *
 * This is broader than chronic-stuck (which is ≤30%) so we catch the
 * 31-49% accuracy band that walk-audit's no-scaffolding-on-fail pathology
 * cares about. Used to expand the population of items that get bridge
 * cards / scaffold interventions, so the scheduler responds to misses
 * instead of just retesting the same items.
 *
 * Note: chronic-stuck items are by definition also acute-stuck. Caller
 * should branch on chronic first if behaviour differs (e.g. severity).
 */
export function isItemAcutelyStuck(totalReviews: number, correctCount: number): boolean {
  if (totalReviews < ACUTE_STUCK_MIN_REVIEWS) return false;
  const accuracy = correctCount / totalReviews;
  return accuracy < ACUTE_STUCK_MAX_ACCURACY;
}

/**
 * Check if a card is in "stuck" state based on recent fail pattern
 */
export function isCardStuck(
  recentFailCount: number,
  recentFailWindowStart: Date | null,
  now: Date = new Date()
): StruggleState {
  if (!recentFailWindowStart || recentFailCount < STRUGGLE_THRESHOLD) {
    return { isStuck: false, failCount: recentFailCount, windowStart: recentFailWindowStart };
  }

  const windowAgeHours = (now.getTime() - recentFailWindowStart.getTime()) / (1000 * 60 * 60);

  if (windowAgeHours > STRUGGLE_WINDOW_HOURS) {
    // Window expired, not stuck
    return { isStuck: false, failCount: 0, windowStart: null };
  }

  return {
    isStuck: true,
    failCount: recentFailCount,
    windowStart: recentFailWindowStart,
  };
}

/**
 * Update struggle tracking after a card review
 * Returns new values for recentFailCount and recentFailWindowStart
 */
export function updateStruggleTracking(
  quality: number,
  currentFailCount: number,
  currentWindowStart: Date | null,
  now: Date = new Date()
): { recentFailCount: number; recentFailWindowStart: Date | null; lastFailedAt: Date | null } {
  const isFailure = quality < 3;

  if (!isFailure) {
    // Success clears the fail window
    return {
      recentFailCount: 0,
      recentFailWindowStart: null,
      lastFailedAt: null,
    };
  }

  // It's a failure - update the window
  if (!currentWindowStart) {
    // Start new window
    return {
      recentFailCount: 1,
      recentFailWindowStart: now,
      lastFailedAt: now,
    };
  }

  const windowAgeHours = (now.getTime() - currentWindowStart.getTime()) / (1000 * 60 * 60);

  if (windowAgeHours > STRUGGLE_WINDOW_HOURS) {
    // Window expired, start fresh
    return {
      recentFailCount: 1,
      recentFailWindowStart: now,
      lastFailedAt: now,
    };
  }

  // Within window, increment
  return {
    recentFailCount: currentFailCount + 1,
    recentFailWindowStart: currentWindowStart,
    lastFailedAt: now,
  };
}

// =============================================================================
// Struggle Region Management
// =============================================================================

/**
 * Add a card to the user's struggle region (or create one)
 * Called when a card enters stuck state
 */
export async function addToStruggleRegion(
  userId: string,
  cardId: string,
  rotation: string,
  failCount: number,
  responseTimeMs?: number
): Promise<StruggleRegion> {
  const existing = await prisma.userStruggleRegion.findUnique({
    where: { userId_rotation: { userId, rotation } },
  });

  if (!existing) {
    // Create new region
    const region = await prisma.userStruggleRegion.create({
      data: {
        userId,
        rotation,
        failedCardIds: [cardId],
        totalFailCount: failCount,
        avgFailsPerCard: failCount,
        avgResponseMs: responseTimeMs ?? null,
      },
    });

    // Update centroid embedding
    await updateRegionCentroid(region.id, [cardId]);

    return region;
  }

  // Update existing region
  const alreadyHasCard = existing.failedCardIds.includes(cardId);
  const newFailedCardIds = alreadyHasCard
    ? existing.failedCardIds
    : [...existing.failedCardIds, cardId];

  const newTotalFailCount = existing.totalFailCount + (alreadyHasCard ? 1 : failCount);
  const newAvgFailsPerCard = newTotalFailCount / newFailedCardIds.length;

  // Update avg response time (exponential moving average)
  let newAvgResponseMs = existing.avgResponseMs;
  if (responseTimeMs) {
    if (newAvgResponseMs === null) {
      newAvgResponseMs = responseTimeMs;
    } else {
      newAvgResponseMs = 0.3 * responseTimeMs + 0.7 * newAvgResponseMs;
    }
  }

  const region = await prisma.userStruggleRegion.update({
    where: { id: existing.id },
    data: {
      failedCardIds: newFailedCardIds,
      totalFailCount: newTotalFailCount,
      avgFailsPerCard: newAvgFailsPerCard,
      avgResponseMs: newAvgResponseMs,
    },
  });

  // Update centroid if we added a new card
  if (!alreadyHasCard) {
    await updateRegionCentroid(region.id, newFailedCardIds);
  }

  return region;
}

/**
 * Remove a card from struggle region (on success)
 * If region becomes empty, mark as resolved
 */
export async function removeFromStruggleRegion(
  userId: string,
  cardId: string,
  rotation: string
): Promise<void> {
  const region = await prisma.userStruggleRegion.findUnique({
    where: { userId_rotation: { userId, rotation } },
  });

  if (!region || !region.failedCardIds.includes(cardId)) {
    return;
  }

  const newFailedCardIds = region.failedCardIds.filter((id) => id !== cardId);

  if (newFailedCardIds.length === 0) {
    // Region fully resolved — clear centroid via raw SQL (Prisma client can't
    // address Unsupported("halfvec") fields directly).
    await prisma.userStruggleRegion.update({
      where: { id: region.id },
      data: {
        failedCardIds: [],
        resolvedAt: new Date(),
      },
    });
    await prisma.$executeRaw`
      UPDATE "UserStruggleRegion" SET "centroidEmbedding" = NULL WHERE id = ${region.id}
    `;
  } else {
    // Update region
    await prisma.userStruggleRegion.update({
      where: { id: region.id },
      data: {
        failedCardIds: newFailedCardIds,
        avgFailsPerCard: region.totalFailCount / newFailedCardIds.length,
      },
    });

    // Update centroid
    await updateRegionCentroid(region.id, newFailedCardIds);
  }
}

/**
 * Get active struggle region for a user/rotation
 */
export async function getStruggleRegion(
  userId: string,
  rotation: string
): Promise<StruggleRegion | null> {
  return prisma.userStruggleRegion.findFirst({
    where: {
      userId,
      rotation,
      resolvedAt: null,
      failedCardIds: { isEmpty: false },
    },
  });
}

// =============================================================================
// Centroid Computation (pgvector)
// =============================================================================

/**
 * Update the centroid embedding for a struggle region.
 *
 * Uses pgvector AVG to compute the mean of card embeddings entirely
 * inside Postgres. The centroid bytes never traverse the wire — the
 * SQL UPDATE selects AVG and writes it to the row in one statement.
 * Skips the row update when no card embeddings exist for the input
 * (rather than silently writing NULL).
 */
async function updateRegionCentroid(regionId: string, cardIds: string[]): Promise<void> {
  if (cardIds.length === 0) {
    await prisma.$executeRaw`
      UPDATE "UserStruggleRegion" SET "centroidEmbedding" = NULL WHERE id = ${regionId}
    `;
    return;
  }

  try {
    await prisma.$executeRaw`
      UPDATE "UserStruggleRegion"
      SET "centroidEmbedding" = (
        SELECT AVG(embedding::vector)::halfvec
        FROM card_embeddings
        WHERE card_id = ANY(${cardIds}::text[])
      )
      WHERE id = ${regionId}
        AND EXISTS (
          SELECT 1 FROM card_embeddings WHERE card_id = ANY(${cardIds}::text[])
        )
    `;
  } catch (error) {
    logger.warn('Failed to compute struggle region centroid', { error: String(error) });
  }
}

// =============================================================================
// Bridge Card Finding (Manifold-aware scaffolding)
// =============================================================================

/**
 * Find bridge cards: cards NEAR the struggle region that the user KNOWS WELL
 * These are the scaffolding path from known → unknown territory
 */
export async function findBridgeCards(
  userId: string,
  rotation: string,
  options: {
    maxCount?: number;
    maxDistance?: number;
    minMastery?: number;
  } = {}
): Promise<BridgeCard[]> {
  const {
    maxCount = 3,
    maxDistance = BRIDGE_CARD_MAX_DISTANCE,
    minMastery = BRIDGE_CARD_MIN_MASTERY,
  } = options;

  // centroidEmbedding is Unsupported("halfvec(3072)") so Prisma client omits it
  // — the entire bridge query reads from UserStruggleRegion via raw SQL.
  try {
    const bridges = await prisma.$queryRaw<BridgeCard[]>`
      WITH region AS (
        SELECT "centroidEmbedding" AS v, "failedCardIds" AS failed
        FROM "UserStruggleRegion"
        WHERE "userId" = ${userId}
          AND rotation = ${rotation}
          AND "centroidEmbedding" IS NOT NULL
          AND array_length("failedCardIds", 1) > 0
      )
      SELECT
        c.id,
        c.front,
        c.complexity,
        1 - (ce.embedding <=> region.v) as similarity,
        COALESCE(cp."retrievalStrength", 0) as "retrievalStrength"
      FROM region
      JOIN "Card" c ON c.rotation = ${rotation}
      JOIN card_embeddings ce ON ce.card_id = c.id
      LEFT JOIN "CardProgress" cp ON cp."cardId" = c.id AND cp."userId" = ${userId}
      WHERE c.id != ALL(region.failed)
        AND 1 - (ce.embedding <=> region.v) > ${1 - maxDistance}
        AND COALESCE(cp."retrievalStrength", 0) >= ${minMastery}
      ORDER BY
        -- Prefer: high mastery, close to struggle region, simpler
        COALESCE(cp."retrievalStrength", 0) DESC,
        1 - (ce.embedding <=> region.v) DESC,
        c.complexity ASC
      LIMIT ${maxCount}
    `;

    return bridges;
  } catch (error) {
    logger.warn('Failed to find bridge cards', { error: String(error) });
    return [];
  }
}

/**
 * Find cards in the struggle region that user hasn't seen recently
 * Useful for the "continue" strategy to get more signal
 */
export async function getStruggleCardsToRetest(
  userId: string,
  rotation: string,
  maxCount: number = 3
): Promise<string[]> {
  const region = await getStruggleRegion(userId, rotation);
  if (!region || region.failedCardIds.length === 0) {
    return [];
  }

  // Get cards ordered by least recently reviewed
  const cards = await prisma.cardProgress.findMany({
    where: {
      userId,
      cardId: { in: region.failedCardIds },
    },
    orderBy: { lastReview: 'asc' },
    take: maxCount,
    select: { cardId: true },
  });

  return cards.map((c) => c.cardId);
}

// =============================================================================
// Resolution Tracking
// =============================================================================

/**
 * Compute resolution confidence based on how the struggle was resolved
 * Higher = more solid, Lower = still fragile
 */
export function computeResolutionConfidence(
  attemptsToResolve: number,
  responseTimeMs: number | null,
  avgResponseMs: number | null
): number {
  let confidence = 1.0;

  // Penalize for many attempts to resolve
  // 1 attempt = no penalty, 5+ attempts = 50% penalty
  const attemptPenalty = Math.min(0.5, (attemptsToResolve - 1) * 0.1);
  confidence -= attemptPenalty;

  // Penalize for slow response (if we have data)
  if (responseTimeMs && avgResponseMs) {
    const speedRatio = responseTimeMs / avgResponseMs;
    if (speedRatio > 1.5) {
      // Slower than average = less confident
      confidence -= Math.min(0.3, (speedRatio - 1) * 0.15);
    }
  }

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Check if knowledge is still fragile (needs continued scaffolding)
 */
export function isStillFragile(
  resolutionConfidence: number,
  subsequentSuccessCount: number = 0
): boolean {
  // Fragile if: low confidence AND haven't proven it with subsequent successes
  if (resolutionConfidence >= 0.7) {
    return false;
  }

  // Can "prove" solidity with 2+ subsequent successes
  if (subsequentSuccessCount >= 2) {
    return false;
  }

  return true;
}
