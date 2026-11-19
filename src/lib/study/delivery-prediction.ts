/**
 * Delivery-time prediction for a batch about to be handed to a learner (the
 * record format is in serve-prediction.ts).
 *
 * The predictor is the scheduler's own item/concept proxy
 * (item-recall-estimate.ts) fed with the learner's current concept state. The
 * state read is one indexed lookup by (userId, conceptId) for the concepts in
 * the batch. It reads current state, not history, and callers issue it beside
 * a read they already make. A failed or absent read records no prediction.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { applyDecay } from '@/lib/knowledge/state';
import { estimateItemRecall } from '@/lib/knowledge/item-recall-estimate';
import { isCalibratedReviewItem } from '@/lib/knowledge/unified-scheduler-scoring';
import { isSyntheticConceptAttribution } from '@/lib/knowledge/synthetic-concept';
import { isProbability } from './serve-prediction';
import type { UnifiedItem } from './unified-session-types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeliveryConceptState {
  recallProbability: number;
  confidence: number;
  exposureCount: number;
  lastExposureAt: Date | null;
}

export type DeliveryConceptStates = Map<string, DeliveryConceptState>;

function predictableConceptId(item: UnifiedItem): string | null {
  if (item.type !== 'card' && item.type !== 'question') return null;
  if (!isCalibratedReviewItem(item)) return null;
  const conceptId = item.conceptId;
  if (!conceptId || isSyntheticConceptAttribution(conceptId)) return null;
  return conceptId;
}

/**
 * Current concept state for the concepts in one batch.
 *
 * Null means "no signal": a guest, no predictable item, or a failed read. An
 * empty map is different: the read succeeded and the learner has no state for
 * these concepts yet, which the estimator treats as an untested concept.
 */
export async function loadDeliveryConceptStates(
  userId: string,
  items: readonly UnifiedItem[],
  options: { isGuest?: boolean } = {},
): Promise<DeliveryConceptStates | null> {
  if (options.isGuest) return null;
  const conceptIds = [...new Set(items.flatMap((item) => {
    const conceptId = predictableConceptId(item);
    return conceptId ? [conceptId] : [];
  }))];
  if (conceptIds.length === 0) return null;
  try {
    const rows = await prisma.conceptState.findMany({
      where: { userId, conceptId: { in: conceptIds } },
      select: {
        conceptId: true,
        recallProbability: true,
        confidence: true,
        exposureCount: true,
        lastExposureAt: true,
      },
    });
    return new Map(rows.map((row) => [row.conceptId, {
      recallProbability: row.recallProbability,
      confidence: row.confidence,
      exposureCount: row.exposureCount,
      lastExposureAt: row.lastExposureAt,
    }]));
  } catch (error) {
    logger.warn('Delivery concept-state read failed; no delivery prediction recorded', {
      userId,
      concepts: conceptIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Concept recall decayed to `now`, the way the scheduler reads it at selection. */
function currentConceptRecall(state: DeliveryConceptState | undefined, now: Date): number {
  if (!state?.lastExposureAt) return 0;
  const days = Math.max(0, now.getTime() - state.lastExposureAt.getTime()) / DAY_MS;
  return applyDecay(state.recallProbability, days, state.confidence);
}

/**
 * Stamp a delivery-time prediction on every item that can carry one and does
 * not already have one. The queue's order and membership are not touched.
 *
 * Item facility is not on a delivered item, so the estimator uses its labelled
 * fallback prior (`predictedRecallSource: 'fallback'`).
 */
export function stampDeliveryPredictions(
  items: UnifiedItem[],
  states: DeliveryConceptStates | null,
  now: Date,
): UnifiedItem[] {
  if (!states) return items;
  return items.map((item) => {
    if (isProbability(item.predictedRecall)) return item;
    const conceptId = predictableConceptId(item);
    if (!conceptId) return item;
    const state = states.get(conceptId);
    const estimate = estimateItemRecall({
      conceptRecall: currentConceptRecall(state, now),
      conceptExposureCount: state?.exposureCount ?? 0,
      itemType: item.type,
      complexity: item.type === 'card' ? item.complexity ?? null : null,
      difficulty: item.type === 'question' ? item.difficulty ?? null : null,
    });
    return {
      ...item,
      predictedRecall: estimate.predictedRecall,
      predictedRecallModel: estimate.model,
      predictedRecallSource: estimate.source,
      predictedRecallStatus: estimate.validationStatus,
    } as UnifiedItem;
  });
}
