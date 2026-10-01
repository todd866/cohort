/**
 * Quality ↔ target retrieval strength, continuous.
 *
 * The projector has always mapped a 0-5 self-rating to a target strength
 * through a five-point ladder: 5 → 1.0, 4 → 0.9, 3 → 0.8, 2 → 0.5, ≤1 → 0.3.
 * That ladder is the only place quality is used as a magnitude (the rest is
 * `>= 3` pass/fail branches), which makes it the seam where objective
 * evidence can enter: an observed MCQ accuracy IS a retrieval probability on
 * the same 0-1 axis. Routing it through the integer ladder would round a
 * real 0.64 into a bucket sixteen points away, because the rung below is 0.5
 * and the rung above is 0.8.
 *
 * So the ladder becomes piecewise-linear. It returns EXACTLY the legacy value
 * at every integer — asserted by test — so nothing that grades today changes.
 * Only a fractional quality lands between the rungs, and nothing produces one
 * until the grade conditioner does.
 */

const RUNGS: ReadonlyArray<readonly [quality: number, strength: number]> = [
  [1, 0.3],
  [2, 0.5],
  [3, 0.8],
  [4, 0.9],
  [5, 1.0],
];

/** The projector's original branch, kept as the oracle the test checks against. */
export function LEGACY_TARGET_STRENGTH(quality: number): number {
  return quality >= 5 ? 1 : quality === 4 ? 0.9 : quality === 3 ? 0.8 : quality === 2 ? 0.5 : 0.3;
}

export function targetStrengthFor(quality: number): number {
  if (!Number.isFinite(quality) || quality <= RUNGS[0][0]) return RUNGS[0][1];
  const last = RUNGS[RUNGS.length - 1];
  if (quality >= last[0]) return last[1];
  for (let i = 1; i < RUNGS.length; i += 1) {
    const [q1, s1] = RUNGS[i];
    if (quality <= q1) {
      const [q0, s0] = RUNGS[i - 1];
      if (quality === q1) return s1;
      return s0 + ((quality - q0) / (q1 - q0)) * (s1 - s0);
    }
  }
  return last[1];
}

/**
 * Inverse of targetStrengthFor. A strength at or below the floor maps to
 * quality 1, not 0 — both share 0.3, and 1 is the fail rung the projector's
 * `< 3` branches treat identically.
 */
export function qualityForStrength(strength: number): number {
  if (!Number.isFinite(strength) || strength <= RUNGS[0][1]) return RUNGS[0][0];
  const last = RUNGS[RUNGS.length - 1];
  if (strength >= last[1]) return last[0];
  for (let i = 1; i < RUNGS.length; i += 1) {
    const [q1, s1] = RUNGS[i];
    if (strength <= s1) {
      const [q0, s0] = RUNGS[i - 1];
      if (strength === s1) return q1;
      return q0 + ((strength - s0) / (s1 - s0)) * (q1 - q0);
    }
  }
  return last[0];
}
