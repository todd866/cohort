/**
 * Knowledge State Computation
 *
 * Computes the unified knowledge state (recall probability) for a concept.
 * Uses decay modeling and exposure aggregation.
 *
 * See docs/designs/2026-01-13-unified-knowledge-state.md
 */

import { ExposureType, DECAY_PARAMS } from './types';
import { isProbeType } from './exposure';

/**
 * Apply memory decay to a probability
 *
 * Uses half-life regression model where probability decays exponentially.
 * Higher confidence = slower decay (knowledge is more stable).
 *
 * @param probability Current recall probability (0-1)
 * @param daysSinceLastExposure Days since last exposure
 * @param confidence Confidence in the estimate (0-1)
 * @returns Decayed probability
 */
export function applyDecay(
  probability: number,
  daysSinceLastExposure: number,
  confidence: number
): number {
  if (daysSinceLastExposure <= 0) return probability;

  // Half-life increases with confidence
  // At confidence=0, half-life = baseHalfLifeDays (7 days)
  // At confidence=1, half-life = baseHalfLifeDays * (1 + confidenceMultiplier) = 21 days
  const halfLife =
    DECAY_PARAMS.baseHalfLifeDays * (1 + confidence * DECAY_PARAMS.confidenceMultiplier);

  // Exponential decay: P(t) = P(0) * 0.5^(t / halfLife)
  const decayed = probability * Math.pow(0.5, daysSinceLastExposure / halfLife);

  return Math.max(0, Math.min(1, decayed));
}

/**
 * Apply an exposure to update recall probability
 *
 * Uses a learning gain model with diminishing returns at higher probabilities.
 *
 * @param currentProbability Current recall probability (0-1)
 * @param strength Exposure strength (0-1)
 * @param exposureType Type of exposure
 * @returns Updated probability
 */
export function applyExposure(
  currentProbability: number,
  strength: number,
  exposureType: ExposureType
): number {
  if (strength <= 0) return currentProbability;

  // Learning gain with diminishing returns
  // The closer to 1, the harder it is to improve
  // Formula: new = old + strength * (1 - old) * multiplier
  // This ensures we approach 1 asymptotically

  // Probe types (active recall) have higher learning multiplier
  const baseMultiplier = isProbeType(exposureType) ? 0.5 : 0.3;

  const gain = strength * (1 - currentProbability) * baseMultiplier;
  const updated = currentProbability + gain;

  return Math.max(0, Math.min(1, updated));
}

/**
 * Update confidence based on exposure
 *
 * Confidence increases with more data (exposures) and stronger signals (probes).
 *
 * @param currentConfidence Current confidence (0-1)
 * @param exposureType Type of exposure
 * @param exposureCount Total exposure count (after this exposure)
 * @returns Updated confidence
 */
export function updateConfidence(
  currentConfidence: number,
  exposureType: ExposureType,
  exposureCount: number
): number {
  // Confidence grows logarithmically with exposure count
  // More exposures = more data = more confident in our estimate
  const countFactor = Math.log10(exposureCount + 1) / 2; // Caps around 0.5 at 100 exposures

  // Probe types give stronger confidence signal
  const probeBonus = isProbeType(exposureType) ? 0.1 : 0.03;

  const updated = currentConfidence + probeBonus + countFactor * 0.1;

  return Math.max(0, Math.min(1, updated));
}

/**
 * Project recall probability to exam day
 *
 * Applies decay to estimate what probability will be on exam day.
 *
 * @param currentProbability Current recall probability
 * @param daysToExam Days until exam
 * @param confidence Confidence in the estimate
 * @returns Projected probability on exam day
 */
export function projectRecallToExamDay(
  currentProbability: number,
  daysToExam: number,
  confidence: number,
  /**
   * Cap the forward-projection horizon (days). Default Infinity = uncapped (the
   * true "recall on exam day"). The scheduler passes a bounded cap for RANKING:
   * decaying over a months-away horizon saturates every concept to ~0 and
   * destroys the mastered-vs-weak discrimination the priority score needs, while
   * examPressure already carries exam urgency separately. Capping keeps the
   * projection discriminating far from exam and is a no-op in-block
   * (daysToExam <= cap). See docs/BACKLOG.md #9 / the 12f projection-collapse.
   */
  maxHorizonDays: number = Infinity
): number {
  if (daysToExam <= 0) return currentProbability;

  // Apply decay forward to (the nearer of) exam day or the ranking horizon.
  return applyDecay(currentProbability, Math.min(daysToExam, maxHorizonDays), confidence);
}

interface ComputeStateInput {
  currentRecallProbability: number;
  confidence: number;
  exposureCount: number;
  lastExposureAt: Date | null;
  exposure: {
    strength: number;
    type: ExposureType;
  };
  examDate: Date;
}

interface ComputedState {
  recallProbability: number;
  recallOnExamDay: number;
  confidence: number;
}

/**
 * Compute the updated knowledge state after an exposure
 *
 * Full algorithm:
 * 1. Apply decay since last exposure
 * 2. Apply new exposure to decayed probability
 * 3. Update confidence
 * 4. Project to exam day
 *
 * @param input Current state and new exposure
 * @returns Updated state
 */
export function computeKnowledgeState(input: ComputeStateInput): ComputedState {
  const {
    currentRecallProbability,
    confidence,
    exposureCount,
    lastExposureAt,
    exposure,
    examDate,
  } = input;

  const now = new Date();

  // 1. Calculate days since last exposure
  const daysSinceLastExposure = lastExposureAt
    ? (now.getTime() - lastExposureAt.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  // 2. Apply decay to current probability
  const decayedProbability = applyDecay(
    currentRecallProbability,
    daysSinceLastExposure,
    confidence
  );

  // 3. Apply new exposure
  const newProbability = applyExposure(
    decayedProbability,
    exposure.strength,
    exposure.type
  );

  // 4. Update confidence
  const newConfidence = updateConfidence(
    confidence,
    exposure.type,
    exposureCount + 1
  );

  // 5. Project to exam day
  const daysToExam = Math.max(
    0,
    (examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );
  const recallOnExamDay = projectRecallToExamDay(
    newProbability,
    daysToExam,
    newConfidence
  );

  return {
    recallProbability: newProbability,
    recallOnExamDay,
    confidence: newConfidence,
  };
}
