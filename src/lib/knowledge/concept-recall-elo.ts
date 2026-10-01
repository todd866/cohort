/**
 * Calibrated concept recall: a per-(learner, concept) ability on the log-odds
 * scale, measured as an OFFSET from the learner's own success rate.
 *
 * Why this exists. ConceptState.recallProbability starts every concept at 0,
 * adds a fixed step for every event (passive exposure included) and decays
 * toward 0. Replayed against the answer log by `audit:recall-calibration`, that
 * produces a number that predicts the next answer worse than the pooled
 * average, saturates near 1 for most answered concepts, and carries almost no
 * ranking information on objectively graded MCQs. This model was tuned and
 * tested on the same log (older half to tune, newer half held out) and beats
 * both the current update and a learner-plus-item-difficulty baseline.
 *
 * The three differences that matter, in order of measured effect:
 *
 *   1. A concept the learner has not been tested on starts at the LEARNER's
 *      rate, not at zero. Most of the old model's error was cold concepts.
 *   2. Evidence moves the estimate by prediction error, so an expected success
 *      teaches little and a surprise teaches a lot. Nothing saturates.
 *   3. Evidence fades toward the learner's rate, not toward zero, with a short
 *      half-life: a concept not probed recently is best predicted by how the
 *      learner does in general.
 *
 * Only graded answers update it. Passive exposure is not evidence of recall.
 *
 * Pure: no I/O and no clock. Callers supply the learner prior and item facility.
 */

export const CONCEPT_RECALL_ELO_VERSION = 'concept-elo-v1';

/**
 * Tuned by grid search on the older half of a 28-day window and confirmed on
 * the newer half, where the optimum was interior and the held-out score was
 * flat across neighbouring settings. Re-tune with the audit, not by feel.
 */
export const CONCEPT_ELO_PARAMS = {
  /** Days for a concept's offset from the learner prior to halve. */
  halfLifeDays: 2,
  /** Learning rate on the log-odds scale. */
  k: 0.15,
} as const;

const DAY_MS = 86_400_000;
const EPS = 0.01;

export type ConceptEloParams = { halfLifeDays: number; k: number };

export interface ConceptEloState {
  /** Log-odds offset of this concept from the learner prior, as of updatedAt. */
  offset: number;
  updatedAt: Date;
}

const clampP = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** The stored offset, faded to `now`. */
export function fadedOffset(
  state: ConceptEloState | null,
  now: Date,
  params: ConceptEloParams = CONCEPT_ELO_PARAMS,
): number {
  if (!state) return 0;
  const elapsedDays = Math.max(0, now.getTime() - state.updatedAt.getTime()) / DAY_MS;
  return state.offset * 0.5 ** (elapsedDays / params.halfLifeDays);
}

/** P(the learner answers an average item on this concept correctly, now). */
export function conceptRecall(input: {
  learnerPrior: number;
  state: ConceptEloState | null;
  now: Date;
  params?: ConceptEloParams;
}): number {
  return sigmoid(logit(input.learnerPrior) + fadedOffset(input.state, input.now, input.params));
}

/**
 * P(correct) on a specific item: the concept estimate shifted by how much
 * easier (itemFacility above globalFacility) or harder the item is.
 */
export function forecastItem(input: {
  learnerPrior: number;
  state: ConceptEloState | null;
  now: Date;
  itemFacility: number;
  globalFacility: number;
  params?: ConceptEloParams;
}): number {
  return sigmoid(
    logit(input.learnerPrior)
      + fadedOffset(input.state, input.now, input.params)
      + logit(input.itemFacility)
      - logit(input.globalFacility),
  );
}

/** Apply one graded answer on this concept. */
export function updateConceptElo(input: {
  learnerPrior: number;
  state: ConceptEloState | null;
  now: Date;
  itemFacility: number;
  globalFacility: number;
  success: boolean;
  params?: ConceptEloParams;
}): ConceptEloState {
  const params = input.params ?? CONCEPT_ELO_PARAMS;
  const offset = fadedOffset(input.state, input.now, params);
  const predicted = forecastItem({ ...input, params });
  return {
    offset: offset + params.k * ((input.success ? 1 : 0) - predicted),
    updatedAt: input.now,
  };
}
