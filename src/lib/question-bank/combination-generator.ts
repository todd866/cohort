import type { OptionCombination } from './types';

/**
 * Target combo count by option pool size.
 * Questions with <= 5 options don't need combinations (they show all options).
 */
export function getTargetComboCount(optionCount: number): number {
  if (optionCount <= 5) return 0;
  if (optionCount === 6) return 5; // C(5,4) = 5 — use all possible
  if (optionCount === 7) return 8;
  if (optionCount === 8) return 10;
  if (optionCount === 9) return 11;
  return 12; // 10+
}

/**
 * Simple seeded PRNG (mulberry32) for deterministic shuffling.
 */
function seededRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert a string to a numeric seed.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Enumerate all valid C(n-1, 4) distractor subsets, then prepend index 0.
 * Each combo is [0, d1, d2, d3, d4] — 5 options with correct answer always included.
 */
function enumerateAllCombos(optionCount: number): OptionCombination[] {
  const distractors = Array.from({ length: optionCount - 1 }, (_, i) => i + 1);
  const result: OptionCombination[] = [];

  // Generate all 4-element subsets of distractors
  const n = distractors.length;
  for (let a = 0; a < n - 3; a++) {
    for (let b = a + 1; b < n - 2; b++) {
      for (let c = b + 1; c < n - 1; c++) {
        for (let d = c + 1; d < n; d++) {
          result.push([0, distractors[a], distractors[b], distractors[c], distractors[d]]);
        }
      }
    }
  }

  return result;
}

/**
 * Generate optimal combination sets using greedy max-min distractor coverage.
 *
 * Algorithm:
 * 1. Enumerate all valid C(n-1, 4) combos (index 0 always included)
 * 2. Greedily select combos that maximize the minimum distractor appearance count
 * 3. Deterministic via seeded PRNG based on questionId
 *
 * Returns empty array for questions with <= 5 options (no expansion needed).
 */
export function generateCombinations(
  optionCount: number,
  questionId: string
): OptionCombination[] {
  const target = getTargetComboCount(optionCount);
  if (target === 0) return [];

  const allCombos = enumerateAllCombos(optionCount);

  // If we want all possible combos (e.g., 6 options → 5 combos = all of C(5,4))
  if (target >= allCombos.length) {
    return allCombos;
  }

  const rng = seededRng(hashString(questionId));

  // Track how many times each distractor has been selected
  const coverage = new Array(optionCount).fill(0);
  const selected: OptionCombination[] = [];
  const used = new Set<number>();

  for (let round = 0; round < target; round++) {
    let bestIdx = -1;
    let bestMinCoverage = -1;
    let bestTiebreaker = -1;

    for (let i = 0; i < allCombos.length; i++) {
      if (used.has(i)) continue;

      const combo = allCombos[i];
      // Calculate what min coverage would be if we added this combo
      let minCov = Infinity;
      for (let d = 1; d < optionCount; d++) {
        const count = coverage[d] + (combo.includes(d) ? 1 : 0);
        if (count < minCov) minCov = count;
      }

      // Greedy: pick combo that maximizes the minimum distractor coverage
      // Tie-break with deterministic random
      const tiebreaker = rng();
      if (
        minCov > bestMinCoverage ||
        (minCov === bestMinCoverage && tiebreaker > bestTiebreaker)
      ) {
        bestIdx = i;
        bestMinCoverage = minCov;
        bestTiebreaker = tiebreaker;
      }
    }

    if (bestIdx === -1) break; // Should never happen

    const chosen = allCombos[bestIdx];
    selected.push(chosen);
    used.add(bestIdx);

    // Update coverage counts
    for (const idx of chosen) {
      coverage[idx]++;
    }
  }

  return selected;
}
