/**
 * Daily Target — what you need to do today.
 *
 * Two pressures, take the max:
 *
 *   coverageNeed = ceil(unseenItems / (daysToExam - consolidationBuffer))
 *     ↑ items/day to actually finish the curriculum before the buffer.
 *       If you're behind, this climbs.
 *
 *   paceFloor    = max(yesterday, 3-day rolling max, MIN_DAILY_TARGET)
 *     ↑ momentum. Stops the bar from dropping the moment you do one
 *       light day. Keeps the gauge achievable.
 *
 *   readinessFloor = paceFloor × (1 + K·readinessPress)   (a third, fuzzy pressure)
 *     ↑ "covered ≠ ready". Coverage/pace treat *seen once* as done, so a
 *       student who's seen every card at 50% gets told to taper. This term
 *       resists that taper while accuracy is below the exam-comfortable band.
 *
 *   dailyTarget  = max(coverageNeed, paceFloor, readinessFloor)
 *
 * The readiness term is deliberately FUZZY and self-limiting:
 *   readinessGap   = clamp((BAND_TARGET − currentAccuracy)/BAND_TARGET, 0..1)
 *   readinessPress = readinessGap × signalTrust
 * `signalTrust` (0..1, from `engagementTrust`) is the crucial weight: md3
 * accuracy only predicts the exam when md3 is used as genuine testing. A
 * fast-clicker's low accuracy is a usage artifact, not a knowledge gap.
 * Validation against held-out assessment results showed that deliberate use can
 * be predictive while rapid clicking is not. So trust→0
 * collapses the term to nothing and the estimate never over-prescribes off a
 * noisy number. Both inputs are optional; absent ⇒ the term is a no-op.
 *
 * Old behaviour was paceFloor only — a student two months out with
 * 1500 unseen items could ship 20/day forever and still fail. Adding
 * the coverage term auto-raises the bar when the curriculum demands it.
 *
 * `newPerDay` is also reported as informational ("here's the cover-
 * everything number"); it's the coverageNeed component without the
 * pace floor.
 */

const MIN_DAILY_TARGET = 20;
const ROLLING_WINDOW_DAYS = 3;
const NEW_USER_DEFAULT = 30;
/** Days before exam to stop introducing new cards (for the informational newPerDay). */
const CONSOLIDATION_BUFFER = 5;
/** Accuracy that maps to a comfortable exam pass (PAAM 2026: ~70% md3 ⇒ comfortable KAT). */
const BAND_TARGET = 0.70;
/** Max readiness top-up over recent pace, at maximum gap × full trust (a gentle, fuzzy nudge). */
const READINESS_MAX_MULT = 0.5;
/** Response time (ms) at/below which an answer is a "snap" — exposure, not testing. */
const SNAP_ANSWER_MS = 3000;
/** Median RT (ms) at/above which testing reads as fully deliberate. */
const DELIBERATE_RT_MS = 10000;
/** Fast-click fraction at/above which the accuracy signal is untrustworthy. */
const FAST_CLICK_CEILING = 0.30;
/** Min answered MCQs before rotation accuracy is stable enough to drive readiness. */
export const MIN_READINESS_SAMPLE = 20;
/**
 * Min *timed* answers before the engagement signature is trustworthy. Without
 * this, one slow answer among many untimed ones would yield median≈that answer
 * and fastClickRatio≈0 ⇒ spurious high trust off a single data point.
 */
export const MIN_RT_SAMPLE = 8;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Confidence (0..1) that a user's md3 accuracy reflects real knowledge rather
 * than fast exposure. Built from the engagement signature: a slow median
 * response time and few snap answers ⇒ genuine testing (trust→1); quick median
 * and many snap answers ⇒ skimming (trust→0). Returns 0 when there's no RT
 * signal at all (can't verify ⇒ don't trust).
 */
export function engagementTrust(input: { medianResponseMs: number | null; fastClickRatio: number }): number {
  const { medianResponseMs, fastClickRatio } = input;
  if (!medianResponseMs || medianResponseMs <= 0) return 0;
  const rtTrust = clamp01((medianResponseMs - SNAP_ANSWER_MS) / (DELIBERATE_RT_MS - SNAP_ANSWER_MS));
  const clickTrust = clamp01(1 - fastClickRatio / FAST_CLICK_CEILING);
  return rtTrust * clickTrust;
}

/**
 * Turn a window of recent rotation MCQ answers into the readiness inputs:
 * `currentAccuracy` (null until ≥ MIN_READINESS_SAMPLE answered) and
 * `signalTrust` (0 until ≥ MIN_RT_SAMPLE *timed* answers — guards against
 * over-trusting sparse timing data). Pure, so the over-trust logic is unit
 * tested rather than buried in a prisma-heavy caller.
 */
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
  // Too few timed answers ⇒ the engagement signature is unreliable ⇒ don't
  // trust the accuracy (trust 0 ⇒ readiness no-op), even if accuracy is defined.
  if (rts.length < MIN_RT_SAMPLE) return { currentAccuracy, signalTrust: 0 };

  const medianResponseMs = rts[Math.floor(rts.length / 2)];
  const fastClickRatio = rts.filter((n) => n < SNAP_ANSWER_MS).length / rts.length;
  return { currentAccuracy, signalTrust: engagementTrust({ medianResponseMs, fastClickRatio }) };
}

interface DailyTargetInput {
  /**
   * Rotation-specific daily completion counts for the last ~14 days,
   * newest-first. Index 0 = today (so far), 1 = yesterday, 2 = day-before, ...
   */
  recentHistory?: number[];
  unseenItems: number;
  daysToExam: number | null;
  /** Optional review-burden estimate (used in the cover-everything secondary numbers only). */
  estimatedDailyReviews?: number;
  /**
   * Recent rotation MCQ accuracy (0..1). Drives the readiness pressure. Omit
   * when unknown — the readiness term is then a no-op.
   */
  currentAccuracy?: number | null;
  /**
   * Confidence (0..1) that `currentAccuracy` is a genuine-testing signal — from
   * `engagementTrust`. Omit (or 0) to disable the readiness term.
   */
  signalTrust?: number;
}

export interface DailyTargetResult {
  /** Primary displayed goal — `max(coverageNeed, paceFloor)`. */
  dailyTarget: number;
  /** Informational: items/day needed to cover every unseen item before exam. */
  newPerDay: number;
  /** Informational: estimated daily review burden. */
  reviewsPerDay: number;
  /** Days reserved for pure consolidation before exam. */
  consolidationDays: number;
  /**
   * Which pressure set the target.
   *   coverage  — coverageNeed > paceFloor; you're behind, target climbed
   *   readiness — covered, but genuine-testing accuracy below the exam band
   *   yesterday / rolling_max — paceFloor wins via recent activity
   *   floor     — paceFloor wins via MIN_DAILY_TARGET
   *   new_user  — too little history; default 30
   */
  adaptiveReason: 'new_user' | 'yesterday' | 'rolling_max' | 'floor' | 'coverage' | 'readiness';
}

export function computeDailyTarget(input: DailyTargetInput): DailyTargetResult | null {
  const {
    unseenItems,
    daysToExam,
    estimatedDailyReviews = 0,
    recentHistory = [],
    currentAccuracy = null,
    signalTrust = 0,
  } = input;
  if (daysToExam === null || daysToExam <= 0) return null;

  // Secondary cover-everything numbers (not used as the displayed goal)
  const effectiveDays = Math.max(daysToExam - CONSOLIDATION_BUFFER, 1);
  const newPerDay = Math.ceil(unseenItems / effectiveDays);
  const reviewsPerDay = Math.round(estimatedDailyReviews);

  // recentHistory[0] = today so far, [1] = yesterday. Use yesterday onward.
  const yesterday = recentHistory[1] ?? 0;
  const rollingWindow = recentHistory.slice(1, 1 + ROLLING_WINDOW_DAYS);
  const rollingMax = rollingWindow.length > 0 ? Math.max(0, ...rollingWindow) : 0;
  const activeDaysInHistory = recentHistory.slice(1).filter((n) => n > 0).length;

  // paceFloor: momentum. Stops the gauge from collapsing after one slow day.
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

  // readinessFloor: "covered ≠ ready". Resists the taper while genuine-testing
  // accuracy is below the exam band. Fuzzy + self-limiting via signalTrust.
  let readinessFloor = 0;
  if (currentAccuracy !== null && currentAccuracy < BAND_TARGET) {
    const readinessGap = clamp01((BAND_TARGET - currentAccuracy) / BAND_TARGET);
    const readinessPress = readinessGap * clamp01(signalTrust);
    if (readinessPress > 0) {
      readinessFloor = Math.round(paceFloor * (1 + READINESS_MAX_MULT * readinessPress));
    }
  }

  // coverageNeed wins when the curriculum demands more than recent pace;
  // readiness wins over pace (but yields to coverage — see new material first).
  const dailyTarget = Math.max(newPerDay, paceFloor, readinessFloor);
  let adaptiveReason: DailyTargetResult['adaptiveReason'];
  if (newPerDay > paceFloor && newPerDay >= readinessFloor) {
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
    consolidationDays: Math.min(CONSOLIDATION_BUFFER, daysToExam),
    adaptiveReason,
  };
}
