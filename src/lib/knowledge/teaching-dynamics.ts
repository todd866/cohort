/**
 * Teaching Dynamics — Prediction Recording (Phase 1)
 *
 * Every item shown is both intervention and measurement.
 * By recording predictions BEFORE outcomes, we can learn
 * teaching dynamics: which interventions produce the largest
 * mastery deltas for this student.
 *
 * Phase 1: Record predictions and outcomes (no behavior change).
 * Phase 2+: Use collected data to adapt teaching policy.
 *
 * See docs/designs/2026-02-07-teaching-dynamics.md
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

// =============================================================================
// Types
// =============================================================================

type InterventionType = 'probe' | 'remediate' | 'reinforce' | 'scaffold' | 'context' | 'retreat';

type InterventionReason =
  | 'low_confidence'
  | 'weak_recall'
  | 'needs_retest'
  | 'reinforcement'
  | 'stuck_intervention'
  | 'pre_teach'
  | 'pre_teach_naive'
  | 'chronic_stuck_mcq'
  | 'mcq_bridge_card'
  | 'preemptive_scaffold'
  // Concept-boost tags (added with D failure-escalation + E strong-pristine
  // analytics wiring). Kept in sync with UnifiedItem.interventionReason in
  // unified-session-types.ts — search both when adding new variants.
  | 'failure_escalation'
  | 'strong_pristine';

export interface PredictionResult {
  predictedMasteryDelta: number;
  predictedOutcome: 'correct' | 'incorrect' | null;
}

export interface RecordPredictionInput {
  userId: string;
  rotation: string;
  itemType: 'card' | 'question' | 'snippet';
  itemId: string;
  interventionType: InterventionType;
  conceptIds: string[];
  primaryConceptId: string | null;
  preRecallProbability: number;
  preConfidence: number;
  preExposureCount: number;
  sessionPosition?: number;
  daysToExam?: number;
}

export interface RecordOutcomeInput {
  signalId: string | null | undefined;
  userId: string;
  quality?: number;
  isCorrect?: boolean;
  responseTimeMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

// Base mastery deltas per intervention type (will be replaced by learned rates in Phase 3)
const BASE_DELTAS: Record<InterventionType, number> = {
  probe: 0.12,      // Testing strengthens memory (testing effect)
  remediate: 0.18,  // Strongest — directly targets weakness
  reinforce: 0.06,  // Maintenance — smaller delta
  scaffold: 0.10,   // Bridge from known → unknown
  context: 0.08,    // Comprehension exposure, weaker than active recall
  retreat: 0.04,    // Parking — minimal delta, avoids frustration
};

// Interventions that produce a testable correct/incorrect outcome
const TESTABLE_INTERVENTIONS = new Set<InterventionType>(['probe', 'remediate', 'reinforce', 'retreat']);

// =============================================================================
// Pure Functions
// =============================================================================

/**
 * Compute predicted mastery delta and outcome for an intervention.
 *
 * Uses base deltas per intervention type, scaled by:
 * 1. Room-to-grow: (1 - preRecall) — diminishing returns at high recall
 * 2. Exposure fatigue: 1 / (1 + log2(1 + exposureCount)) — diminishing returns with repetition
 */
export function computePrediction(
  interventionType: InterventionType,
  preRecallProbability: number,
  preConfidence: number,
  exposureCount: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _daysToExam: number | null | undefined
): PredictionResult {
  const baseDelta = BASE_DELTAS[interventionType] ?? 0.06;

  // Room-to-grow factor: more room = bigger delta
  const roomToGrow = Math.max(0, 1 - preRecallProbability);

  // Exposure fatigue: diminishing returns with repeated exposures
  const fatigueFactor = 1 / (1 + Math.log2(1 + exposureCount));

  const predictedMasteryDelta = baseDelta * roomToGrow * fatigueFactor;

  // Predict outcome for testable interventions
  let predictedOutcome: 'correct' | 'incorrect' | null = null;
  if (TESTABLE_INTERVENTIONS.has(interventionType)) {
    if (preRecallProbability > 0.7) {
      predictedOutcome = 'correct';
    } else if (preRecallProbability < 0.3) {
      predictedOutcome = 'incorrect';
    } else {
      // Uncertain zone — predict based on which side of 0.5
      predictedOutcome = preRecallProbability >= 0.5 ? 'correct' : 'incorrect';
    }
  }

  return { predictedMasteryDelta, predictedOutcome };
}

/**
 * Compute actual mastery delta from pre/post recall probabilities.
 */
export function computeActualDelta(
  preRecallProbability: number,
  postRecallProbability: number
): number {
  return postRecallProbability - preRecallProbability;
}

/**
 * Map scheduler's interventionReason to teaching signal's interventionType.
 */
export function mapInterventionReason(reason: InterventionReason): InterventionType {
  switch (reason) {
    case 'low_confidence':
      return 'probe';
    case 'weak_recall':
      return 'remediate';
    case 'needs_retest':
      return 'probe';
    case 'reinforcement':
      return 'reinforce';
    case 'stuck_intervention':
      return 'retreat';
    case 'pre_teach':
      return 'context';
    // Naive-concept pre-teach: same teaching role as 'pre_teach' but fires
    // specifically on zero-exposure concepts via the dedicated 7a-naive
    // section in unified-scheduler.ts.
    case 'pre_teach_naive':
      return 'context';
    // Chronic-stuck MCQ: surface the question again so the user re-attempts
    // after seeing the bridge — same role as a `remediate` event.
    case 'chronic_stuck_mcq':
      return 'remediate';
    // Bridge cards inserted before stuck MCQs are teaching context, the
    // same role pre_teach plays for cards.
    case 'mcq_bridge_card':
      return 'context';
    // Preemptive scaffolds paired AFTER high-test-pressure questions are
    // also teaching context — same role as pre_teach / mcq_bridge_card,
    // just positioned differently in the trajectory.
    case 'preemptive_scaffold':
      return 'context';
    // Failure-escalation serves are remediation — the user just got the
    // concept wrong, and the boost surfaced this item to re-teach it.
    case 'failure_escalation':
      return 'remediate';
    // Strong-pristine serves are reinforcement of an already-strong concept
    // that just happens to still have unseen cards in the pool — the role
    // is to extend coverage, not to remediate weakness.
    case 'strong_pristine':
      return 'reinforce';
    default:
      return 'probe';
  }
}

// =============================================================================
// DB Functions
// =============================================================================

/**
 * Record a prediction for a session item.
 * Returns the signalId, or null if recording fails.
 */
export async function recordPrediction(input: RecordPredictionInput): Promise<string | null> {
  try {
    const prediction = computePrediction(
      input.interventionType as InterventionType,
      input.preRecallProbability,
      input.preConfidence,
      input.preExposureCount,
      input.daysToExam ?? null
    );

    const signal = await prisma.teachingSignal.create({
      data: {
        userId: input.userId,
        rotation: input.rotation,
        itemType: input.itemType,
        itemId: input.itemId,
        interventionType: input.interventionType,
        conceptIds: input.conceptIds,
        primaryConceptId: input.primaryConceptId,
        preRecallProbability: input.preRecallProbability,
        preConfidence: input.preConfidence,
        preExposureCount: input.preExposureCount,
        predictedMasteryDelta: prediction.predictedMasteryDelta,
        predictedOutcome: prediction.predictedOutcome,
        sessionPosition: input.sessionPosition ?? null,
        daysToExam: input.daysToExam ?? null,
      },
      select: { id: true },
    });

    return signal.id;
  } catch (err) {
    logger.error('Failed to record teaching signal prediction', {
      userId: input.userId,
      itemId: input.itemId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Record the outcome for a previously recorded prediction.
 * Looks up post-ConceptState to compute actual mastery delta.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
  if (!input.signalId) return;

  try {
    // Find the pending signal
    const signal = await prisma.teachingSignal.findFirst({
      where: { id: input.signalId, userId: input.userId, resolvedAt: null },
      select: {
        id: true,
        primaryConceptId: true,
        preRecallProbability: true,
        predictedMasteryDelta: true,
      },
    });

    if (!signal) return;

    // Look up post-intervention concept state
    let postRecallProbability: number | null = null;
    let postConfidence: number | null = null;
    let actualMasteryDelta: number | null = null;
    let predictionError: number | null = null;

    if (signal.primaryConceptId) {
      const postState = await prisma.conceptState.findUnique({
        where: {
          userId_conceptId: {
            userId: input.userId,
            conceptId: signal.primaryConceptId,
          },
        },
        select: { recallProbability: true, confidence: true },
      });

      if (postState) {
        postRecallProbability = postState.recallProbability;
        postConfidence = postState.confidence;
        actualMasteryDelta = computeActualDelta(
          signal.preRecallProbability,
          postState.recallProbability
        );
        predictionError = actualMasteryDelta - signal.predictedMasteryDelta;
      }
    }

    // Determine actual outcome
    let actualOutcome: string | null = null;
    if (input.isCorrect !== undefined) {
      actualOutcome = input.isCorrect ? 'correct' : 'incorrect';
    } else if (input.quality !== undefined) {
      actualOutcome = input.quality >= 3 ? 'correct' : 'incorrect';
    }

    await prisma.teachingSignal.update({
      where: { id: signal.id },
      data: {
        actualMasteryDelta,
        actualOutcome,
        quality: input.quality ?? null,
        isCorrect: input.isCorrect ?? null,
        responseTimeMs: input.responseTimeMs ?? null,
        predictionError,
        postRecallProbability,
        postConfidence,
        resolvedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error('Failed to record teaching signal outcome', {
      signalId: input.signalId,
      userId: input.userId,
      error: String(err),
    });
  }
}
