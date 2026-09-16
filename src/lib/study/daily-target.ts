/**
 * Daily Target — what you need to do today.
 *
 * Three pressures, take the max:
 *
 *   coverageWorkload =
 *     ceil(firstSeenNeed × learningFactor) + estimatedDailyReviews
 *     ↑ firstSeenNeed = ceil(unseen / (daysToExam − consolidationBuffer))
 *       learningFactor starts ~1.25 early in the term (cards take more than
 *       one view) and decays to 1.0 by the consolidation window.
 *       Reviews are part of the day, not free — add them explicitly.
 *
 *   paceFloor    = max(yesterday, 3-day rolling max, MIN_DAILY_TARGET)
 *     ↑ momentum. Stops the bar from dropping after one light day.
 *
 *   readinessFloor = paceFloor × (1 + K·readinessPress)
 *     ↑ "covered ≠ ready". Resists taper while genuine-testing accuracy
 *       is below the exam-comfortable band.
 *
 *   dailyTarget  = max(coverageWorkload, paceFloor, readinessFloor)
 */

const MIN_DAILY_TARGET = 20;
const ROLLING_WINDOW_DAYS = 3;
const NEW_USER_DEFAULT = 30;
/** Days before exam to stop introducing new cards (for the informational newPerDay). */
const CONSOLIDATION_BUFFER = 5;
/** Accuracy that maps to a comfortable exam pass (PAAM 2026: ~70% md3 ⇒ comfortable KAT). */
const BAND_TARGET = 0.70;
/** Max readiness top-up over recent pace, at maximum gap × full trust. */
const READINESS_MAX_MULT = 0.5;
/** Response time (ms) at/below which an answer is a "snap" — exposure, not testing. */
const SNAP_ANSWER_MS = 3000;
/** Median RT (ms) at/above which testing reads as fully deliberate. */
const DELIBERATE_RT_MS = 10000;
/** Fast-click fraction at/above which the accuracy signal is untrustworthy. */
const FAST_CLICK_CEILING = 0.30;
/** Min answered MCQs before rotation accuracy is stable enough to drive readiness. */
export const MIN_READINESS_SAMPLE = 20;
/** Min timed answers before the engagement signature is trustworthy. */
export const MIN_RT_SAMPLE = 8;
/** Extra first-seen throughput early in a block (multiple exposures to learn). */
export const LEARNING_FACTOR_EARLY = 1.25;
/** No learning margin once consolidation begins. */
export const LEARNING_FACTOR_LATE = 1.0;
/** Fallback term length when the caller has no block dates. */
const DEFAULT_TERM_LENGTH_DAYS = 46;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Early-term margin for variable learning rate: cards usually need more than
 * one view. Highest at the start of the block, 1.0 once consolidation begins.
 */
export function learningExposureFactor(input: {
  daysToExam: number;
  termLengthDays?: number | null;
}): number {
  if (!Number.isFinite(input.daysToExam) || input.daysToExam <= CONSOLIDATION_BUFFER) {
    return LEARNING_FACTOR_LATE;
  }
  const termLength = Number.isFinite(input.termLengthDays) && input.termLengthDays! > 0
    ? input.termLengthDays!
    : Math.max(input.daysToExam, DEFAULT_TERM_LENGTH_DAYS);
  const workingTerm = Math.max(termLength - CONSOLIDATION_BUFFER, 1);
  const workingRemaining = Math.max(input.daysToExam - CONSOLIDATION_BUFFER, 0);
  const remaining = clamp01(workingRemaining / workingTerm);
  return LEARNING_FACTOR_LATE
    + (LEARNING_FACTOR_EARLY - LEARNING_FACTOR_LATE) * remaining;
}

export function engagementTrust(input: { medianResponseMs: number | null; fastClickRatio: number }): number {
  const { medianResponseMs, fastClickRatio } = input;
  if (!medianResponseMs || medianResponseMs <= 0) return 0;
  const rtTrust = clamp01((medianResponseMs - SNAP_ANSWER_MS) / (DELIBERATE_RT_MS - SNAP_ANSWER_MS));
  const clickTrust = clamp01(1 - fastClickRatio / FAST_CLICK_CEILING);
  return rtTrust * clickTrust;
}

export function readinessSignal(
  mcqs: ReadonlyArray<{ isCorrect: boolean | null; responseMs: number | null }>,
): { currentAccuracy: number | null; signalTrust: number } {
  const answered = mcqs.filter((m) => m.isCorrect !== null);
  const currentAccuracy =
    answered.length >= MIN_READINESS_SAMPLE
      ? answered.filter((m) => m.isCorrect).length / answered.length
      : null;

  const rts = mcqs
    .map((m) => m.responseMs)
    .filter((n): n is number => n !== null && n > 0)
    .sort((a, b) => a - b);
  if (rts.length < MIN_RT_SAMPLE) return { currentAccuracy, signalTrust: 0 };

  const medianResponseMs = rts[Math.floor(rts.length / 2)];
  const fastClickRatio = rts.filter((n) => n < SNAP_ANSWER_MS).length / rts.length;
  return { currentAccuracy, signalTrust: engagementTrust({ medianResponseMs, fastClickRatio }) };
}

interface DailyTargetInput {
  recentHistory?: number[];
  unseenItems: number;
  daysToExam: number | null;
  /** Block length in days (start→exam). Drives the early learning margin. */
  termLengthDays?: number | null;
  /** Due/relearn burden estimate — part of the primary day target. */
  estimatedDailyReviews?: number;
  currentAccuracy?: number | null;
  signalTrust?: number;
}

export interface DailyTargetResult {
  /** Primary displayed goal — coverage workload vs pace vs readiness. */
  dailyTarget: number;
  /** Informational: first-seen items/day needed before consolidation. */
  newPerDay: number;
  /** Informational: estimated daily review burden (also folded into dailyTarget). */
  reviewsPerDay: number;
  /** Early-term learning margin applied to first-seen need. */
  learningFactor: number;
  consolidationDays: number;
  adaptiveReason: 'new_user' | 'yesterday' | 'rolling_max' | 'floor' | 'coverage' | 'readiness';
}

export function computeDailyTarget(input: DailyTargetInput): DailyTargetResult | null {
  const {
    unseenItems,
    daysToExam,
    termLengthDays = null,
    estimatedDailyReviews = 0,
    recentHistory = [],
    currentAccuracy = null,
    signalTrust = 0,
  } = input;
  if (daysToExam === null || daysToExam <= 0) return null;

  const effectiveDays = Math.max(daysToExam - CONSOLIDATION_BUFFER, 1);
  const newPerDay = Math.ceil(unseenItems / effectiveDays);
  const reviewsPerDay = Math.max(0, Math.round(estimatedDailyReviews));
  const learningFactor = learningExposureFactor({ daysToExam, termLengthDays });
  const coverageWorkload = Math.ceil(newPerDay * learningFactor) + reviewsPerDay;

  const yesterday = recentHistory[1] ?? 0;
  const rollingWindow = recentHistory.slice(1, 1 + ROLLING_WINDOW_DAYS);
  const rollingMax = rollingWindow.length > 0 ? Math.max(0, ...rollingWindow) : 0;
  const activeDaysInHistory = recentHistory.slice(1).filter((n) => n > 0).length;

  let paceFloor: number;
  let paceReason: 'new_user' | 'yesterday' | 'rolling_max' | 'floor';
  if (activeDaysInHistory < 2) {
    paceFloor = NEW_USER_DEFAULT;
    paceReason = 'new_user';
  } else {
    const candidate = Math.max(yesterday, rollingMax);
    if (candidate < MIN_DAILY_TARGET) {
      paceFloor = MIN_DAILY_TARGET;
      paceReason = 'floor';
    } else if (yesterday >= rollingMax) {
      paceFloor = yesterday;
      paceReason = 'yesterday';
    } else {
      paceFloor = rollingMax;
      paceReason = 'rolling_max';
    }
  }

  let readinessFloor = 0;
  if (currentAccuracy !== null && currentAccuracy < BAND_TARGET) {
    const readinessGap = clamp01((BAND_TARGET - currentAccuracy) / BAND_TARGET);
    const readinessPress = readinessGap * clamp01(signalTrust);
    if (readinessPress > 0) {
      readinessFloor = Math.round(paceFloor * (1 + READINESS_MAX_MULT * readinessPress));
    }
  }

  const dailyTarget = Math.max(coverageWorkload, paceFloor, readinessFloor);
  let adaptiveReason: DailyTargetResult['adaptiveReason'];
  if (coverageWorkload > paceFloor && coverageWorkload >= readinessFloor) {
    adaptiveReason = 'coverage';
  } else if (readinessFloor > paceFloor) {
    adaptiveReason = 'readiness';
  } else {
    adaptiveReason = paceReason;
  }

  return {
    dailyTarget,
    newPerDay,
    reviewsPerDay,
    learningFactor,
    consolidationDays: Math.min(CONSOLIDATION_BUFFER, daysToExam),
    adaptiveReason,
  };
}
