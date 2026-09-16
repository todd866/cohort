/**
 * Shared shuffle utilities.
 *
 * shuffle()         — Fisher-Yates with Math.random()
 * shuffleWithSeed() — deterministic Fisher-Yates using mulberry32 PRNG
 */

import { hashString } from './hash';

/** Mulberry32 PRNG — fast, high-quality 32-bit generator */
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle. Returns a new array. */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Fisher-Yates then conditionally displace the correct answer from index 0.
 *
 * Used for pedagogic anti-A bias on first-look questions: a learner who
 * clicks A without engaging the option set should not be rewarded with
 * uniform 20% accuracy. Subsequent attempts of the same question should
 * Displace a correct answer off position A with probability `displaceProb`.
 *
 * A TEACHING intervention, not a fairness one: an answer sitting at A rewards
 * stopping at the first option. Applied on every encounter, because the reason
 * to read past the first line does not expire on second sight.
 *
 * Pass `avoidPosition` when a previous step has already moved the answer off the
 * slot the learner last saw, so this step does not undo it.
 *
 * With displaceProb=0.75 and 5 options, P(correct at A) ~ 0.05.
 * With displaceProb=1.0, correct is never at A.
 * With displaceProb=0, returns the input order unchanged.
 */
export function displaceCorrectFromFirst<T>(
  array: T[],
  isCorrect: (item: T) => boolean,
  displaceProb: number,
  avoidPosition?: number | null,
): T[] {
  const result = [...array];
  if (result.length < 2 || displaceProb <= 0) return result;
  if (!isCorrect(result[0])) return result;
  if (Math.random() >= displaceProb) return result;
  // Destinations are every slot except A, minus the position the caller is
  // already avoiding — otherwise this step can undo the "don't repeat the last
  // position" step that ran before it, and the answer lands where the learner
  // just saw it. If that leaves nothing (a 2-option item avoiding slot 1), fall
  // back to any non-A slot: not repeating a position matters less than not
  // parking the answer on A.
  const all = Array.from({ length: result.length - 1 }, (_, i) => i + 1);
  const eligible = all.filter((i) => i !== avoidPosition);
  const pool = eligible.length > 0 ? eligible : all;
  const j = pool[Math.floor(Math.random() * pool.length)];
  [result[0], result[j]] = [result[j], result[0]];
  return result;
}

/**
 * Deterministic seeded shuffle using mulberry32 PRNG.
 * Same seed always produces the same order.
 */
export function shuffleWithSeed<T>(array: T[], seed: string): T[] {
  const rng = mulberry32(hashString(seed));
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
