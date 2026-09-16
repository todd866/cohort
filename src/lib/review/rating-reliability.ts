/**
 * Tier 1 of the self-rating reliability estimator: DEGENERACY.
 *
 * The memory projector reads a learner's 0-5 self-rating and nothing else. A
 * self-rating may carry information or may carry none, and the scheduler
 * currently cannot tell which. The cheapest test needs no MCQ evidence, no
 * pairing and no linkage: does the rating VARY at all? A learner who returns
 * one value has given zero bits, and no correlation analysis is needed to say
 * so. Measured 2026-09-15: one high-volume learner rated every one of several
 * thousand consecutive reviews at a single value while their objective MCQ
 * accuracy sat mid-pack; the scheduler believed they had perfect retention.
 *
 * Verdicts are deliberately conservative in the trusting direction:
 * - `insufficient-evidence` below RELIABILITY_MIN_GRADES — nobody is scheduled
 *   worse than today on a short series.
 * - `degenerate` when the series carries less than DEGENERATE_MAX_BITS of
 *   entropy. Not "exactly one value": 2,000 Good and 8 Again is still ~zero
 *   bits, and treating the eight as a signal would let a stray keypress launder
 *   a whole history.
 * - `varied` otherwise. A conservative rater who only ever presses Again or
 *   Good, with real mass in both, is using one bit — a signal, not degeneracy.
 *
 * Tier 2 (does the variation PREDICT anything?) lives with the proximity
 * overlay; this tier is the one that fires on the worst cases and needs none
 * of it. Both are computed on a ROLLING window so a verdict is escapable — a
 * learner flagged here who starts rating honestly earns trust back.
 */

export const RELIABILITY_MIN_GRADES = 100;
/** Below this many bits the series is treated as carrying no information. */
export const DEGENERATE_MAX_BITS = 0.1;

export type DegeneracyVerdict = 'degenerate' | 'varied' | 'insufficient-evidence';

/** Shannon entropy of the grade distribution, in bits. 0 for an empty series. */
export function gradeEntropyBits(grades: readonly number[]): number {
  const n = grades.length;
  if (n === 0) return 0;
  const counts = new Map<number, number>();
  for (const g of grades) counts.set(g, (counts.get(g) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / n;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function degeneracyVerdict(grades: readonly number[]): DegeneracyVerdict {
  if (grades.length < RELIABILITY_MIN_GRADES) return 'insufficient-evidence';
  return gradeEntropyBits(grades) < DEGENERATE_MAX_BITS ? 'degenerate' : 'varied';
}

/**
 * Tier 1 decides whether tier 2 is even worth asking. A rating that never
 * varies cannot predict anything, whatever an AUC over its pairs would say;
 * and while tier 1 has too few grades, tier 2 has fewer pairs still. Only a
 * rating known to vary hands the verdict to discrimination.
 */
export function combineReliabilityVerdicts(
  tier1: DegeneracyVerdict,
  tier2: 'trusted' | 'uninformative' | 'insufficient-evidence',
): 'trusted' | 'insufficient-evidence' | 'degenerate' | 'uninformative' {
  if (tier1 === 'degenerate') return 'degenerate';
  if (tier1 === 'insufficient-evidence') return 'insufficient-evidence';
  return tier2;
}
