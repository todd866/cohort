/**
 * Scoring primitives for the held-out backtest of the reliability estimator.
 * A predictor emits P(correct) for each held-out (grade, MCQ outcome) pair;
 * lower Brier and log-loss are better. Null on no pairs, never NaN.
 */

export interface ScoredPair {
  /** Predicted probability the linked MCQ was answered correctly. */
  p: number;
  correct: boolean;
}

const EPS = 1e-6;

export function brierScore(pairs: readonly ScoredPair[]): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const { p, correct } of pairs) {
    const y = correct ? 1 : 0;
    sum += (p - y) * (p - y);
  }
  return sum / pairs.length;
}

export function logLoss(pairs: readonly ScoredPair[]): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const { p, correct } of pairs) {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    sum -= correct ? Math.log(q) : Math.log(1 - q);
  }
  return sum / pairs.length;
}

export function scorePredictor(pairs: readonly ScoredPair[]): { n: number; brier: number | null; logLoss: number | null } {
  return { n: pairs.length, brier: brierScore(pairs), logLoss: logLoss(pairs) };
}
