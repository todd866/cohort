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
 * use plain `shuffle()` so the position bias doesn't leak across attempts.
 *
 * With displaceProb=0.75 and 5 options, P(correct at A) ≈ 0.05.
 * With displaceProb=1.0, correct is never at A.
 * With displaceProb=0, behaves identically to `shuffle()`.
 */
export function shuffleAvoidFirst<T>(
  array: T[],
  isCorrect: (item: T) => boolean,
  displaceProb: number,
): T[] {
  const result = shuffle(array);
  if (result.length < 2 || displaceProb <= 0) return result;
  if (!isCorrect(result[0])) return result;
  if (Math.random() >= displaceProb) return result;
  // Swap A with a random non-zero index.
  const j = 1 + Math.floor(Math.random() * (result.length - 1));
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
