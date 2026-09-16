/**
 * Difficulty rhythm — sine-wave oscillation between challenge and consolidation.
 *
 * Higher commitment tiers get longer wavelengths (sustained challenge before relief)
 * and larger amplitudes (deeper challenge peaks). This creates a natural breathing
 * pattern in study sessions:
 *
 *   Visitor:   quick easy/hard alternation (wavelength 4)
 *   Superfan:  long sustained challenge plateaus (wavelength 24)
 *
 * Applied as a POST-manifold-walk reordering pass. Only performs adjacent swaps
 * to preserve topical coherence from the manifold walk.
 */

import type { CommitmentLevel } from '@/lib/commitment';

interface RhythmParams {
  wavelength: number;  // items per full cycle
  amplitude: number;   // 0-1, how strongly to push toward challenge/relief
}

const RHYTHM_PARAMS: Record<CommitmentLevel, RhythmParams> = {
  visitor:   { wavelength: 4,  amplitude: 0.2 },
  browser:   { wavelength: 6,  amplitude: 0.3 },
  student:   { wavelength: 10, amplitude: 0.5 },
  committed: { wavelength: 16, amplitude: 0.6 },
  superfan:  { wavelength: 24, amplitude: 0.7 },
};

/** Maps difficulty strings to numeric ranks for comparison. */
const DIFFICULTY_RANK: Record<string, number> = {
  easy: 0,
  medium: 1,
  hard: 2,
};

/** Minimum amplitude to bother reordering. Below this, swaps aren't worth the coherence cost. */
const REORDER_AMPLITUDE_THRESHOLD = 0.25;

/**
 * Get the difficulty bias at a given session position.
 * Returns a value in [-amplitude, +amplitude] where:
 *   positive = prefer harder items here
 *   negative = prefer easier items here
 */
export function getDifficultyBias(sessionPosition: number, level: CommitmentLevel): number {
  const params = RHYTHM_PARAMS[level] ?? RHYTHM_PARAMS.browser;
  return params.amplitude * Math.sin((2 * Math.PI * sessionPosition) / params.wavelength);
}

/**
 * How well does a given difficulty rank fit the desired bias at this position?
 * Returns a score where higher = better fit.
 *
 * rank: 0 (easy), 1 (medium), 2 (hard)
 * bias: [-1, 1] where positive wants harder items
 *
 * We normalize rank to [-1, 1] range (easy=-1, medium=0, hard=1)
 * then score by negative distance from the bias.
 */
function fitScore(rank: number, bias: number): number {
  const normalized = rank - 1; // easy=-1, medium=0, hard=1
  return -(Math.abs(normalized - bias));
}

/**
 * Apply difficulty rhythm as a post-manifold-walk reordering pass.
 *
 * Only performs adjacent swaps — preserves topical coherence from the manifold walk
 * while nudging the difficulty curve toward a sine-wave pattern.
 *
 * Items without a difficulty field are treated as 'medium' (neutral).
 */
export function applyDifficultyRhythm<T extends { difficulty?: string }>(
  items: T[],
  level: CommitmentLevel
): T[] {
  if (items.length < 3) return [...items];

  const params = RHYTHM_PARAMS[level] ?? RHYTHM_PARAMS.browser;
  if (params.amplitude < REORDER_AMPLITUDE_THRESHOLD) return [...items];

  const result = [...items];

  // Single pass of adjacent swaps — bubble-sort-like but only one pass
  // to keep disruption minimal. Each swap is evaluated independently.
  for (let i = 0; i < result.length - 1; i++) {
    const biasHere = getDifficultyBias(i, level);
    const biasNext = getDifficultyBias(i + 1, level);

    const rankHere = DIFFICULTY_RANK[result[i].difficulty ?? 'medium'] ?? 1;
    const rankNext = DIFFICULTY_RANK[result[i + 1].difficulty ?? 'medium'] ?? 1;

    // Only swap if it improves overall fit
    const currentFit = fitScore(rankHere, biasHere) + fitScore(rankNext, biasNext);
    const swappedFit = fitScore(rankNext, biasHere) + fitScore(rankHere, biasNext);

    if (swappedFit > currentFit) {
      [result[i], result[i + 1]] = [result[i + 1], result[i]];
    }
  }

  return result;
}
