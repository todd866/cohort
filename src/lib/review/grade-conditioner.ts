import { targetStrengthFor, qualityForStrength } from './grade-strength';
import { calibratedStrength, type GradeCalibration } from './grade-calibration';

/**
 * The grade conditioner: what the memory projector should hear, given what
 * the learner said and what we know about whether to believe them.
 *
 * Pure. It runs at grade time, so it may compute nothing that reads history —
 * every input is precomputed in the background and carried on the serve
 * decision, the same way predictedRecall already is. See
 * .claude/rules/hot-path-latency.md.
 *
 * Three modes:
 *
 *   pass-through  The rating is trusted, or we cannot judge it. The raw grade
 *                 goes through unchanged. This is most learners, most of the
 *                 time, and exactly today's behaviour.
 *   no-evidence   The rating is distrusted but the neighbourhood is silent —
 *                 nothing in the bank probes this card, or the learner has not
 *                 answered anything near it. The raw grade goes through, at
 *                 maximum uncertainty, so a probe policy can later see where
 *                 it was flying blind.
 *   blended       The rating is distrusted and there is evidence. The grade's
 *                 target strength is blended toward the learner's observed
 *                 accuracy on the linked questions, weighted by how much
 *                 evidence there is and how close it sits.
 *
 * Bounds, because a fluke must not destroy a card the learner knows:
 *
 *   - Weight is n / (n + EVIDENCE_HALF_WEIGHT), so one observation moves the
 *     strength at most 1/(1+K) of the way. Loose (same-topic) observations
 *     count half a tight (same-fact) one.
 *   - Below MIN_EVIDENCE_TO_CROSS_PASS_FAIL observations the result is clamped
 *     to the raw grade's side of quality 3, because the projector's stability
 *     and leech branches key on that line and one wrong answer on a linked
 *     question is not grounds to flip them.
 *
 * Uncertainty is recorded from day one even though nothing consumes it yet:
 * the later probe policy ("if unsure, serve an MCQ nearby") cannot be
 * validated without a history of where the system was unsure, and that
 * history cannot be backfilled.
 */

export type ReliabilityVerdict = 'trusted' | 'insufficient-evidence' | 'degenerate' | 'uninformative';

export interface EvidenceCount {
  /** Skip-filtered MCQ attempts on linked questions in the recent window. */
  n: number;
  correct: number;
}

export interface NeighbourhoodEvidence {
  /** Questions that probe the same fact (proximity ≥ tight floor). */
  tight: EvidenceCount;
  /** Questions on the same topic (proximity between the floors). */
  loose: EvidenceCount;
}

export interface ConditionInput {
  rawQuality: number;
  verdict: ReliabilityVerdict;
  evidence: NeighbourhoodEvidence | null;
  /**
   * The learner's own quality → strength ladder, when they have enough pairs
   * for one. The held-out backtest found the fixed ladder to be the worst
   * predictor of linked-MCQ outcome and this the best; when present it
   * replaces the fixed ladder in every mode. Its presence is itself
   * sufficient evidence — a table only exists above a minimum pair count.
   */
  calibration?: GradeCalibration | null;
}

export interface ConditionedGrade {
  effectiveQuality: number;
  /** 0 = confident in the effective grade, 1 = no idea. */
  uncertainty: number;
  provenance: {
    mode: 'pass-through' | 'calibrated' | 'no-evidence' | 'blended';
    verdict: ReliabilityVerdict;
    rawQuality: number;
    effectiveObservations: number;
    observedAccuracy: number | null;
    weight: number;
    clampedToPassFail: boolean;
  };
}

/** Observations at which the evidence carries half the weight. */
export const EVIDENCE_HALF_WEIGHT = 10;
/** A same-topic observation counts this fraction of a same-fact one. */
export const LOOSE_EVIDENCE_WEIGHT = 0.5;
/** Fewer effective observations than this may not flip pass to fail or back. */
export const MIN_EVIDENCE_TO_CROSS_PASS_FAIL = 3;

const PRIOR_UNCERTAINTY: Record<ReliabilityVerdict, number> = {
  trusted: 0.2,
  'insufficient-evidence': 0.5,
  degenerate: 0.8,
  uninformative: 0.8,
};

const PASS_FAIL_QUALITY = 3;

export function conditionGrade({ rawQuality, verdict, evidence, calibration = null }: ConditionInput): ConditionedGrade {
  const base = {
    verdict,
    rawQuality,
    effectiveObservations: 0,
    observedAccuracy: null as number | null,
    weight: 0,
    clampedToPassFail: false,
  };
  // The ladder this grade is read on: the learner's own when they have one,
  // the fixed one otherwise.
  const ladder = calibration
    ? (q: number) => calibratedStrength(calibration, q)
    : targetStrengthFor;

  if (verdict === 'trusted' || verdict === 'insufficient-evidence') {
    if (calibration) {
      return {
        effectiveQuality: clampQuality(qualityForStrength(ladder(rawQuality))),
        uncertainty: PRIOR_UNCERTAINTY[verdict],
        provenance: { ...base, mode: 'calibrated' },
      };
    }
    return {
      effectiveQuality: rawQuality,
      uncertainty: PRIOR_UNCERTAINTY[verdict],
      provenance: { ...base, mode: 'pass-through' },
    };
  }

  const tightN = evidence?.tight.n ?? 0;
  const looseN = evidence?.loose.n ?? 0;
  const nEff = tightN + LOOSE_EVIDENCE_WEIGHT * looseN;
  if (nEff <= 0) {
    return {
      effectiveQuality: rawQuality,
      uncertainty: PRIOR_UNCERTAINTY[verdict],
      provenance: { ...base, mode: 'no-evidence' },
    };
  }

  const correctEff = (evidence?.tight.correct ?? 0) + LOOSE_EVIDENCE_WEIGHT * (evidence?.loose.correct ?? 0);
  const observedAccuracy = clamp01(correctEff / nEff);
  const weight = nEff / (nEff + EVIDENCE_HALF_WEIGHT);
  const blendedStrength = (1 - weight) * ladder(rawQuality) + weight * observedAccuracy;
  let effectiveQuality = clampQuality(qualityForStrength(blendedStrength));

  let clampedToPassFail = false;
  if (nEff < MIN_EVIDENCE_TO_CROSS_PASS_FAIL) {
    const rawPasses = rawQuality >= PASS_FAIL_QUALITY;
    const effPasses = effectiveQuality >= PASS_FAIL_QUALITY;
    if (rawPasses && !effPasses) { effectiveQuality = PASS_FAIL_QUALITY; clampedToPassFail = true; }
    if (!rawPasses && effPasses) { effectiveQuality = JUST_BELOW_PASS; clampedToPassFail = true; }
  }

  return {
    effectiveQuality,
    uncertainty: clamp01(PRIOR_UNCERTAINTY[verdict] * (1 - weight)),
    provenance: {
      ...base,
      mode: 'blended',
      effectiveObservations: nEff,
      observedAccuracy,
      weight,
      clampedToPassFail,
    },
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampQuality(v: number): number {
  return Math.max(0, Math.min(5, v));
}

/** The largest quality the projector still treats as a lapse. */
const JUST_BELOW_PASS = PASS_FAIL_QUALITY - 1e-6;
