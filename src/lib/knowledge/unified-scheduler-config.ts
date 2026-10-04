/**
 * Unified scheduler: configuration
 *
 * Scheduler defaults, the recall-ranking horizon, and the seeded-random and
 * shuffle helpers shared by the session builder, the cluster fallback and the
 * diagnostics. Moved out of unified-scheduler.ts unchanged.
 */

import { createHash } from 'node:crypto';

import { shuffle, shuffleWithSeed } from '@/lib/utils/shuffle';
import type { UnifiedSessionSelectionDeterminism } from './unified-scheduler-types';

// =============================================================================
// Configuration
// =============================================================================

export const DEFAULTS = {
  size: 20,
  cardRatio: 0.7,
  interferenceThreshold: 0.85,
  // Per-session diversity (soft caps; may be exceeded if not enough concepts)
  maxCardsPerConcept: 1,
  maxQuestionsPerConcept: 1,
  // Thresholds for intervention decisions
  confidenceThreshold: 0.3, // Below this = need to probe
  recallThreshold: 0.6, // Below this = weak
  targetRecall: 0.8, // Above this = strong
  daysSinceProbeThreshold: 3, // Above this = should retest
};

export function stableTargetRandom(seed: string | undefined, key: string): number {
  if (!seed || !/^[a-f0-9]{64}$/.test(seed)) return Math.random();
  const digest = createHash('sha256').update(seed).update('\0').update(key).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function shuffleForSelection<T>(
  items: T[],
  selectionDeterminism: UnifiedSessionSelectionDeterminism | undefined,
  scope: string,
): T[] {
  return selectionDeterminism
    ? shuffleWithSeed(
        items,
        `${selectionDeterminism.seed}\0unified-scheduler\0${scope}`,
      )
    : shuffle(items);
}

/**
 * Horizon cap (days) for the recall projection used in concept RANKING.
 *
 * Without it, forward-decaying recall over a months-away exam horizon
 * (research block: CAH ≈72d, PWH ≈127d) saturates every concept's
 * recallOnExamDay to ~0, so gapScore ≈ targetRecall for all and the scheduler
 * can no longer separate a mastered concept from a weak one (the 12f
 * projection-collapse / BACKLOG #9). examPressure already carries exam urgency
 * separately, so ranking only needs a bounded-horizon recall to stay
 * discriminating. This is a no-op in-block (daysToExam <= cap), so it changes
 * behaviour ONLY in the far-from-exam regime that is currently degenerate.
 */
export const RECALL_RANKING_HORIZON_DAYS = 21;
