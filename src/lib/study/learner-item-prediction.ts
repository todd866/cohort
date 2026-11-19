/**
 * `learner-item-v1`: a pre-serve P(correct) that needs no concept state.
 *
 * It combines, in log-odds, how often this learner has recently been right on
 * this kind of item (card or question) with how often the item is answered
 * correctly. It is the serve-time form of the `learner+item` baseline in
 * scripts/audit/recall-calibration-lib.ts, with three stated differences,
 * each forced by what a request can read without waiting:
 *
 *   - the learner's rate comes from their most recent answers
 *     (LEARNER_ITEM_WINDOW), not their whole history;
 *   - the item's facility is the stored column, which includes this learner's
 *     own answers; the replay excludes them;
 *   - the pooled rate is the frozen cold-start prior, not a running tally.
 *
 * The replay scores this exact form as its own row (`learner-item-v1`), so
 * the recorded number has an offline counterpart.
 *
 * Telemetry only. Nothing here may rank or gate an item.
 *
 * Pure: no I/O and no clock.
 */
import { fallbackItemFacility } from '@/lib/knowledge/item-recall-estimate';
import type { ServePrediction } from './serve-prediction';

export const LEARNER_ITEM_PREDICTOR = 'learner-item-v1';
export const LEARNER_ITEM_STATUS = 'telemetry-only-unvalidated';
/** Most recent graded answers read for the learner's rate. */
export const LEARNER_ITEM_WINDOW = 200;
/** Shrinkage strengths, in pseudo-answers. Match the replay's baseline. */
export const LEARNER_PRIOR_N = 10;
export const ITEM_PRIOR_N = 20;

const EPS = 0.01;
const clampP = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export type LearnerItemType = 'card' | 'question';

export interface AnswerTally {
  /** Successes. */
  s: number;
  /** Graded answers. */
  n: number;
}

export type LearnerAnswerTallies = Record<LearnerItemType, AnswerTally>;

export interface LearnerAnswerRow {
  sourceType: string;
  isCorrect: boolean | null;
  quality: number | null;
}

/**
 * Success by item type over the rows given. A question answer is its
 * correctness; a card is self-rated and 3+ counts as recalled. A row with
 * neither (a skip) is not an answer.
 */
export function tallyLearnerAnswers(rows: readonly LearnerAnswerRow[]): LearnerAnswerTallies {
  const tallies: LearnerAnswerTallies = { card: { s: 0, n: 0 }, question: { s: 0, n: 0 } };
  for (const row of rows) {
    if (row.sourceType !== 'card' && row.sourceType !== 'question') continue;
    const outcome = row.isCorrect !== null
      ? row.isCorrect
      : row.quality !== null ? row.quality >= 3 : null;
    if (outcome === null) continue;
    tallies[row.sourceType].n += 1;
    if (outcome) tallies[row.sourceType].s += 1;
  }
  return tallies;
}

export interface ItemFacility {
  facilityIndex: number | null;
  sampleSize: number | null;
}

export interface LearnerItemEstimate {
  p: number;
  /** `empirical` when the item's own facility was used, else `fallback`. */
  source: 'empirical' | 'fallback';
  /** Graded answers of this item type behind the learner's rate. */
  learnerN: number;
  /** Answers behind the item's facility; 0 on the fallback prior. */
  facilityN: number;
}

export function predictLearnerItem(input: {
  itemType: LearnerItemType;
  learner: AnswerTally | null | undefined;
  facility: ItemFacility | null | undefined;
}): LearnerItemEstimate {
  const pooled = fallbackItemFacility({ itemType: input.itemType });
  const learnerN = Math.max(0, input.learner?.n ?? 0);
  const learnerS = Math.min(learnerN, Math.max(0, input.learner?.s ?? 0));
  const pLearner = (learnerS + pooled * LEARNER_PRIOR_N) / (learnerN + LEARNER_PRIOR_N);

  const facilityIndex = input.facility?.facilityIndex;
  const sampleSize = input.facility?.sampleSize;
  const empirical = typeof facilityIndex === 'number' && Number.isFinite(facilityIndex)
    && facilityIndex >= 0 && facilityIndex <= 1
    && typeof sampleSize === 'number' && Number.isFinite(sampleSize) && sampleSize > 0;
  const facilityN = empirical ? sampleSize : 0;
  const pItem = empirical
    ? (facilityIndex * facilityN + pooled * ITEM_PRIOR_N) / (facilityN + ITEM_PRIOR_N)
    : pooled;

  return {
    p: clampP(sigmoid(logit(pItem) + logit(pLearner) - logit(pooled))),
    source: empirical ? 'empirical' : 'fallback',
    learnerN,
    facilityN,
  };
}

/** The estimate as a delivery-time record for `payload.predictions`. */
export function learnerItemServePrediction(
  estimate: LearnerItemEstimate,
  now: Date,
): ServePrediction {
  return {
    predictor: LEARNER_ITEM_PREDICTOR,
    p: estimate.p,
    basis: 'delivery',
    computedAt: now.toISOString(),
    ageMs: 0,
    source: estimate.source,
    status: LEARNER_ITEM_STATUS,
    inputs: {
      learnerN: estimate.learnerN,
      facilityN: estimate.facilityN,
      learnerWindow: LEARNER_ITEM_WINDOW,
    },
  };
}
