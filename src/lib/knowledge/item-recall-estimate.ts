/**
 * Pre-serve item outcome proxy.
 *
 * Concept recall is a useful person/concept prior, but it is not the probability
 * of answering every item on that concept correctly. This estimator blends it
 * with an item-success prior and, when available, a sample-size-shrunk empirical
 * facility. It is deliberately telemetry-only: the scheduler calls it after the
 * queue has been ordered, so it cannot perturb which items are served.
 */

export const ITEM_RECALL_MODEL_VERSION = 'item-facility-v1';
/**
 * Independent of algorithm identity: this probability-shaped proxy has not
 * cleared calibration review and is forbidden from serving decisions.
 */
export const ITEM_RECALL_MODEL_STATUS = 'telemetry-only-unvalidated' as const;

const EMPIRICAL_PRIOR_STRENGTH = 20;
const FALLBACK_ITEM_WEIGHT = 0.35;
const MAX_EMPIRICAL_WEIGHT_BONUS = 0.30;
const LOW_EXPOSURE_WEIGHT_BONUS = 0.10;
const MIN_PREDICTION = 0.05;
const MAX_PREDICTION = 0.95;

export interface ItemRecallEstimateInput {
  conceptRecall: number;
  conceptExposureCount: number;
  itemType: string;
  facilityIndex?: number | null;
  sampleSize?: number | null;
  complexity?: number | null;
  difficulty?: string | null;
}

export interface ItemRecallEstimate {
  predictedRecall: number;
  itemFacility: number;
  itemWeight: number;
  source: 'empirical' | 'fallback';
  sampleSize: number;
  model: typeof ITEM_RECALL_MODEL_VERSION;
  validationStatus: typeof ITEM_RECALL_MODEL_STATUS;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Cold-start priors rounded from pooled md3 outcomes observed on 2026-07-10.
 * They are shrinkage anchors, not claims about an individual learner:
 *
 * - cards: quality>=3 was 0.45–0.49 across C1–C3;
 * - questions: easy was ~0.71, medium/hard ~0.59 with n>=10.
 *
 * Complexity currently adds little empirical separation for cards, so the
 * fallback intentionally does not pretend C3 has a validated lower success rate.
 */
export function fallbackItemFacility(input: {
  itemType: string;
  complexity?: number | null;
  difficulty?: string | null;
}): number {
  if (input.itemType === 'card') return 0.46;
  if (input.itemType === 'question') {
    return input.difficulty?.toLowerCase() === 'easy' ? 0.71 : 0.59;
  }
  return 0.5;
}

export function estimateItemRecall(input: ItemRecallEstimateInput): ItemRecallEstimate {
  const conceptRecall = clamp01(Number.isFinite(input.conceptRecall) ? input.conceptRecall : 0);
  const conceptExposureCount = Math.max(
    0,
    Number.isFinite(input.conceptExposureCount) ? input.conceptExposureCount : 0,
  );
  const fallback = fallbackItemFacility(input);
  const validFacility =
    typeof input.facilityIndex === 'number' &&
    Number.isFinite(input.facilityIndex) &&
    input.facilityIndex >= 0 &&
    input.facilityIndex <= 1;
  const sampleSize = validFacility && typeof input.sampleSize === 'number' && Number.isFinite(input.sampleSize)
    ? Math.max(0, input.sampleSize)
    : 0;
  const evidenceWeight = sampleSize / (sampleSize + EMPIRICAL_PRIOR_STRENGTH);
  const itemFacility = validFacility && sampleSize > 0
    ? fallback + evidenceWeight * (input.facilityIndex! - fallback)
    : fallback;

  // Low concept exposure increases reliance on the item base rate because the
  // person/concept estimate is least established there. The weight remains
  // bounded and never participates in ranking.
  const conceptEvidence = conceptExposureCount / (conceptExposureCount + 3);
  const itemWeight = Math.min(
    0.75,
    FALLBACK_ITEM_WEIGHT +
      MAX_EMPIRICAL_WEIGHT_BONUS * evidenceWeight +
      LOW_EXPOSURE_WEIGHT_BONUS * (1 - conceptEvidence),
  );
  const blended = conceptRecall * (1 - itemWeight) + itemFacility * itemWeight;
  const predictedRecall = Math.max(MIN_PREDICTION, Math.min(MAX_PREDICTION, blended));

  return {
    predictedRecall,
    itemFacility,
    itemWeight,
    source: validFacility && sampleSize > 0 ? 'empirical' : 'fallback',
    sampleSize,
    model: ITEM_RECALL_MODEL_VERSION,
    validationStatus: ITEM_RECALL_MODEL_STATUS,
  };
}
