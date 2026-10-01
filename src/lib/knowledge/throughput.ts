/**
 * Throughput Estimation & Budget Computation
 *
 * Pure functions for estimating daily study throughput and computing
 * remaining budget before exam day. No DB imports.
 */

import { DECAY_PARAMS } from './types';

// =============================================================================
// Types
// =============================================================================

export interface DailyStatsRow {
  cardsReviewed: number;
  quizzesTaken: number;
}

export interface BudgetSummary {
  dailyThroughput: number;
  daysToExam: number;
  totalRemaining: number;
  sessionsRemaining: number;
}

// =============================================================================
// Throughput Estimation
// =============================================================================

/**
 * Estimate daily throughput from recent study data.
 *
 * Takes last 14 days of DailyStats (cards + questions combined).
 * Recency-weighted: last 7 days count 2x vs days 8-14.
 * Returns items/day, floored at minThroughput.
 */
export function estimateDailyThroughput(
  dailyStats: DailyStatsRow[],
  options?: { minThroughput?: number }
): number {
  const minThroughput = options?.minThroughput ?? 10;

  if (dailyStats.length === 0) return minThroughput;

  let totalWeightedItems = 0;
  let totalWeight = 0;

  for (let i = 0; i < dailyStats.length; i++) {
    const stat = dailyStats[i];
    const items = stat.cardsReviewed + stat.quizzesTaken;
    // Older half (first entries) get weight 1, recent half (last entries) get weight 2
    const isRecent = i >= dailyStats.length - 7;
    const weight = isRecent ? 2 : 1;
    totalWeightedItems += items * weight;
    totalWeight += weight;
  }

  const average = totalWeight > 0 ? totalWeightedItems / totalWeight : 0;
  return Math.max(minThroughput, average);
}

// =============================================================================
// Budget Computation
// =============================================================================

/**
 * Compute remaining study budget before exam.
 * Pure arithmetic — no DB calls.
 */
export function computeRemainingBudget(
  dailyThroughput: number,
  daysToExam: number,
  sessionSize: number
): BudgetSummary {
  const totalRemaining = dailyThroughput * daysToExam;
  const sessionsRemaining = sessionSize > 0 ? Math.floor(totalRemaining / sessionSize) : 0;

  return {
    dailyThroughput,
    daysToExam,
    totalRemaining,
    sessionsRemaining,
  };
}

// =============================================================================
// Exposure Projection
// =============================================================================

/**
 * Estimate how many exposures are needed to keep recall above target on exam day.
 *
 * Uses the decay model (half-life = baseHalfLifeDays * (1 + confidence * confidenceMultiplier))
 * to project forward. Each exposure boosts recall by a diminishing-returns gain.
 * Returns 0 if already above target. Caps at 20.
 */
export function computeExposuresNeeded(
  currentRecall: number,
  targetRecall: number,
  confidence: number,
  daysToExam: number
): number {
  const halfLife =
    DECAY_PARAMS.baseHalfLifeDays * (1 + confidence * DECAY_PARAMS.confidenceMultiplier);

  // Project current recall to exam day
  const projectedRecall = daysToExam > 0
    ? currentRecall * Math.pow(0.5, daysToExam / halfLife)
    : currentRecall;

  if (projectedRecall >= targetRecall) return 0;

  // Simulate exposures spread evenly over remaining days.
  // Each exposure boosts recall, then decays until the next one (or exam day).
  const exposureGain = 0.3; // base multiplier for card review (non-probe)
  const maxExposures = 20;

  for (let n = 1; n <= maxExposures; n++) {
    // Spread n exposures evenly: at days daysToExam*1/(n+1), 2/(n+1), etc.
    let recall = currentRecall;
    const interval = daysToExam / (n + 1);

    for (let i = 1; i <= n; i++) {
      // Decay from previous state to this exposure's time
      recall = recall * Math.pow(0.5, interval / halfLife);
      // Apply exposure (diminishing returns)
      recall = recall + exposureGain * (1 - recall);
      recall = Math.min(1, recall);
    }

    // Decay from last exposure to exam day
    recall = recall * Math.pow(0.5, interval / halfLife);

    if (recall >= targetRecall) return n;
  }

  return maxExposures;
}

// =============================================================================
// Study-Aware Strength Projection
// =============================================================================

/**
 * Project card strength on exam day assuming continued study.
 *
 * Uses power-law decay: R(t) = R0 * (1 + t/S)^(-0.5)
 * (matching inference.ts / exam-readiness route).
 *
 * Spreads expectedExposures evenly over daysToExam. Each exposure
 * boosts strength by gain * (ceiling - current).
 *
 * @param currentStrength - Already-decayed strength at this moment
 * @param stabilityDays   - Card stability (power-law S parameter)
 * @param daysToExam      - Days from now to exam
 * @param expectedExposures - How many reviews this card is expected to get
 */
export function projectStrengthWithStudy(
  currentStrength: number,
  stabilityDays: number,
  daysToExam: number,
  expectedExposures: number,
): number {
  const gain = 0.3;
  const ceiling = 0.85;
  const safeStability = Math.max(0.5, stabilityDays);

  let strength = currentStrength;

  if (daysToExam <= 0) return strength;

  const n = Math.min(Math.round(expectedExposures), 20);

  if (n <= 0) {
    // Pure decay to exam day
    return strength * Math.pow(1 + daysToExam / safeStability, -0.5);
  }

  const interval = daysToExam / (n + 1);

  for (let i = 0; i < n; i++) {
    // Decay from previous point to this exposure
    strength = strength * Math.pow(1 + interval / safeStability, -0.5);
    // Apply exposure gain (diminishing returns toward ceiling)
    strength = strength + gain * (ceiling - strength);
    strength = Math.min(1, Math.max(0, strength));
  }

  // Decay from last exposure to exam day
  strength = strength * Math.pow(1 + interval / safeStability, -0.5);

  return Math.min(1, Math.max(0, strength));
}

// =============================================================================
// Required Daily Reviews for Target
// =============================================================================

/**
 * Compute how many reviews/day are needed to reach a target average strength
 * on exam day.
 *
 * For each card, binary-searches the number of exposures (0→20) needed to
 * reach targetStrength using projectStrengthWithStudy. Sums all required
 * exposures across cards and divides by daysToExam.
 */
export function computeRequiredDailyReviews(
  cards: Array<{ currentStrength: number; stabilityDays: number }>,
  daysToExam: number,
  targetStrength: number = 0.7,
): number {
  if (cards.length === 0 || daysToExam <= 0) return 0;

  let totalExposures = 0;

  for (const card of cards) {
    const maxExposures = 20;
    let needed = 0;

    for (let n = 0; n <= maxExposures; n++) {
      const projected = projectStrengthWithStudy(
        card.currentStrength,
        card.stabilityDays,
        daysToExam,
        n,
      );
      if (projected >= targetStrength) {
        needed = n;
        break;
      }
      if (n === maxExposures) {
        needed = maxExposures;
      }
    }

    totalExposures += needed;
  }

  return Math.ceil(totalExposures / daysToExam);
}

// =============================================================================
// Daily Progress & Exam Prediction
// =============================================================================

/**
 * Compute daily progress toward a dynamic review target.
 * Returns 0-100. Returns 100 when target is 0 (all mastered).
 */
export function computeDailyProgress(
  todayReviewed: number,
  requiredDailyReviews: number,
): number {
  if (requiredDailyReviews <= 0) return 100;
  return Math.min(100, (todayReviewed / requiredDailyReviews) * 100);
}

/**
 * Compute exam score prediction blending coverage and retention.
 *
 * coverage * retention + (1 - coverage) * baseline
 *
 * Includes ALL cards in denominator — rewards both coverage and retention.
 * Returns 0-1.
 */
export function computeExamPrediction(
  reviewedCards: number,
  totalCards: number,
  avgRetention: number,
  baseline: number = 0.25,
): number {
  if (totalCards <= 0) return 0;
  const coverage = reviewedCards / totalCards;
  return coverage * avgRetention + (1 - coverage) * baseline;
}
