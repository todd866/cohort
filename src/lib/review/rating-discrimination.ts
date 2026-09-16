/**
 * Tier 2 of the self-rating reliability estimator: DISCRIMINATION.
 *
 * Tier 1 asks whether a learner's rating varies at all. This tier asks the
 * question that remains for a learner whose rating does vary: does the
 * variation PREDICT anything? Each pair is one cloze self-rating and the
 * objective outcome of an MCQ that probes the same fact — a tight link in the
 * card ↔ question proximity overlay — with skips excluded, because a skip is
 * stored as isCorrect false and is not an answer (42% of recorded wrong
 * answers were skips when this was measured).
 *
 * The statistic is the rank AUC of grade → correct, ties counted as half. It
 * is the probability that a randomly chosen correct outcome carried a higher
 * self-rating than a randomly chosen incorrect one: 0.5 is no information,
 * 1 is perfect, below 0.5 is inverse calibration. It needs no assumption about
 * the shape of the 0-5 scale, which matters because most learners use two or
 * three of its values.
 *
 * The verdict comes from the CONFIDENCE INTERVAL, not the point estimate
 * (Hanley & McNeil 1982 standard error). Pairs are scarce: an upper bound on
 * pairable evidence over thirty days ran to the low thousands for three
 * learners, about a hundred for the next, under thirty for everyone else, and
 * that is before the proximity floor. So insufficient-evidence is the common
 * verdict, not the exception, and it resolves to trusting the rating — nobody
 * is scheduled worse than today on a thin sample.
 *
 *   lower bound > 0.5            → trusted
 *   upper bound < NOISE_CEILING  → uninformative (includes inverse calibration)
 *   otherwise                    → insufficient-evidence
 *
 * The noise ceiling keeps "uninformative" honest: a wide interval that merely
 * happens to include 0.5 is not evidence of no information, only of not enough
 * pairs. The interval has to sit close to 0.5 AND be narrow.
 */

export interface GradeOutcomePair {
  /** Self-rated cloze grade, 0-5. */
  grade: number;
  /** Objective outcome of the linked MCQ. Skips must already be excluded. */
  correct: boolean;
}

export const DISCRIMINATION_MIN_PAIRS = 60;
/** The interval's upper bound must sit below this for "uninformative". */
export const DISCRIMINATION_NOISE_CEILING = 0.58;
const Z_95 = 1.96;

export type DiscriminationVerdict = 'trusted' | 'uninformative' | 'insufficient-evidence';

/**
 * Mann–Whitney rank AUC of grade → correct, ties as half. Null when either
 * outcome class is empty — there is then no pair to rank and any number would
 * be invented.
 */
export function rankAuc(pairs: readonly GradeOutcomePair[]): number | null {
  const byGrade = new Map<number, { pos: number; neg: number }>();
  let nPos = 0;
  let nNeg = 0;
  for (const p of pairs) {
    const cell = byGrade.get(p.grade) ?? { pos: 0, neg: 0 };
    if (p.correct) { cell.pos += 1; nPos += 1; } else { cell.neg += 1; nNeg += 1; }
    byGrade.set(p.grade, cell);
  }
  if (nPos === 0 || nNeg === 0) return null;
  let wins = 0;
  let negBelow = 0;
  for (const grade of [...byGrade.keys()].sort((a, b) => a - b)) {
    const { pos, neg } = byGrade.get(grade)!;
    wins += pos * negBelow + 0.5 * pos * neg;
    negBelow += neg;
  }
  return wins / (nPos * nNeg);
}

/** Hanley–McNeil standard error of an AUC estimate. */
export function aucStandardError(auc: number, nPos: number, nNeg: number): number {
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const variance =
    (auc * (1 - auc) + (nPos - 1) * (q1 - auc * auc) + (nNeg - 1) * (q2 - auc * auc)) / (nPos * nNeg);
  return Math.sqrt(Math.max(0, variance));
}

export function discriminationVerdict(pairs: readonly GradeOutcomePair[]): DiscriminationVerdict {
  if (pairs.length < DISCRIMINATION_MIN_PAIRS) return 'insufficient-evidence';
  const auc = rankAuc(pairs);
  if (auc === null) return 'insufficient-evidence';
  let nPos = 0;
  for (const p of pairs) if (p.correct) nPos += 1;
  const nNeg = pairs.length - nPos;
  const se = aucStandardError(auc, nPos, nNeg);
  const lower = auc - Z_95 * se;
  const upper = auc + Z_95 * se;
  if (lower > 0.5) return 'trusted';
  if (upper < DISCRIMINATION_NOISE_CEILING) return 'uninformative';
  return 'insufficient-evidence';
}
