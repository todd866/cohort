/**
 * Per-learner calibration of quality → target retrieval strength.
 *
 * The projector's ladder maps Good to 0.8 for everyone. The held-out backtest
 * of 2026-09-16 found that to be the worst predictor of linked-MCQ outcome of
 * four tried, because learners who rate a card Good score nearer 0.65 on the
 * question that probes it; and it found P(correct | grade), fitted per learner
 * and shrunk toward the learner's own base rate, to be the best. The gap the
 * fixed ladder opens is five times the gap the grade itself closes — every
 * learner is over-promised by the scale, not just the one whose rating never
 * varies.
 *
 * This is that table. It is fitted in the background from the same (grade,
 * linked-MCQ outcome) pairs the discrimination tier uses, stored on the
 * learner's reliability record, carried on the serve decision, and used by the
 * grade conditioner as THAT learner's ladder in place of the fixed one.
 *
 * Shrinkage: each grade's estimate is weighted n / (n + K) against the base
 * rate, so two lucky Easy grades do not become certainty. Grades the learner
 * has never given fall back to the base rate. Fractional grades interpolate
 * between their calibrated neighbours. Below CALIBRATION_MIN_PAIRS there is no
 * table at all and the fixed ladder stays in force — nobody gets a
 * personalised scale on a handful of observations.
 */

export const GRADE_CALIBRATION_VERSION = 1 as const;
export const CALIBRATION_HALF_WEIGHT = 20;
export const CALIBRATION_MIN_PAIRS = 40;

export interface GradeCalibration {
  version: typeof GRADE_CALIBRATION_VERSION;
  /** The learner's answered-MCQ accuracy on the fitting window. */
  baseRate: number;
  /** Per integer grade: pairs seen and pairs correct. */
  byGrade: Record<string, { n: number; correct: number }>;
  pairs: number;
}

export function fitGradeCalibration(
  pairs: ReadonlyArray<{ grade: number; correct: boolean }>,
  baseRate: number,
): GradeCalibration | null {
  if (pairs.length < CALIBRATION_MIN_PAIRS) return null;
  const byGrade: GradeCalibration['byGrade'] = {};
  for (const p of pairs) {
    const key = String(Math.round(p.grade));
    const cell = byGrade[key] ?? { n: 0, correct: 0 };
    cell.n += 1;
    if (p.correct) cell.correct += 1;
    byGrade[key] = cell;
  }
  return { version: GRADE_CALIBRATION_VERSION, baseRate: clamp01(baseRate), byGrade, pairs: pairs.length };
}

function strengthAtInteger(cal: GradeCalibration, grade: number): number {
  const cell = cal.byGrade[String(grade)];
  if (!cell || cell.n === 0) return cal.baseRate;
  const w = cell.n / (cell.n + CALIBRATION_HALF_WEIGHT);
  return clamp01((1 - w) * cal.baseRate + w * (cell.correct / cell.n));
}

/** The learner's own strength for a grade; fractional grades interpolate. */
export function calibratedStrength(cal: GradeCalibration, grade: number): number {
  if (!Number.isFinite(grade)) return cal.baseRate;
  const q = Math.max(0, Math.min(5, grade));
  const lo = Math.floor(q);
  const hi = Math.ceil(q);
  if (lo === hi) return strengthAtInteger(cal, lo);
  const sLo = strengthAtInteger(cal, lo);
  const sHi = strengthAtInteger(cal, hi);
  return sLo + (q - lo) * (sHi - sLo);
}

export function parseGradeCalibration(value: unknown): GradeCalibration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== GRADE_CALIBRATION_VERSION) return null;
  if (typeof v.baseRate !== 'number' || !Number.isFinite(v.baseRate)) return null;
  const raw = v.byGrade;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const byGrade: GradeCalibration['byGrade'] = {};
  for (const [k, cell] of Object.entries(raw as Record<string, unknown>)) {
    const c = (cell && typeof cell === 'object' ? cell : {}) as Record<string, unknown>;
    byGrade[k] = { n: Number(c.n ?? 0) || 0, correct: Number(c.correct ?? 0) || 0 };
  }
  return { version: GRADE_CALIBRATION_VERSION, baseRate: clamp01(v.baseRate), byGrade, pairs: Number(v.pairs ?? 0) || 0 };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
