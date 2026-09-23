/**
 * Frontier-first challenge targeting.
 *
 * The standing target is the top of the ladder. Building blocks are the
 * step-down after a high-complexity miss, not the rung a learner starts on.
 * Recall still has to be a real number: an unmeasured concept records no
 * target rather than inventing one. Item-level `predictedRecall` stays
 * telemetry-only and does not choose the rung.
 */

export const CHALLENGE_POLICY_VERSION = 'frontier-then-stepdown-v1';
export const STANDARD_CHALLENGE_RECALL = 0.6;
export const STRETCH_CHALLENGE_RECALL = 0.8;

/** Building-block rung. Used when a high-complexity miss steps the concept
 *  down, not as the standing target. */
export const SCAFFOLDING_COMPLEXITY = 1;

/**
 * Top of the complexity ladder. Raised from 3 to 5 on 2026-09-14: a ladder that
 * stops at "complex fact" tops out well below a board-style vignette, which
 * asks for a mechanism after an unscored diagnostic step and eliminates each
 * distractor on two independent axes. See docs/COMPLEXITY_LADDER.md.
 */
export const MAX_COMPLEXITY = 5;

export type ChallengeTier = 'scaffolding' | 'standard' | 'stretch';
export type ChallengeQuestionDifficulty = 'easy' | 'medium' | 'hard';

const TIER_RANK: Record<ChallengeTier, number> = {
  scaffolding: 0,
  standard: 1,
  stretch: 2,
};

export function targetChallengeTierForRecall(
  currentRecall: number | undefined,
): ChallengeTier | null {
  if (currentRecall === undefined || !Number.isFinite(currentRecall)) return null;
  return 'stretch';
}

export function targetComplexityForRecall(
  currentRecall: number | undefined,
): 1 | 2 | 3 | 4 | 5 | null {
  if (targetChallengeTierForRecall(currentRecall) == null) return null;
  return MAX_COMPLEXITY;
}

export function targetQuestionDifficultyForRecall(
  currentRecall: number | undefined,
): ChallengeQuestionDifficulty | null {
  if (targetChallengeTierForRecall(currentRecall) == null) return null;
  return 'hard';
}

export function challengeTierDistance(
  actual: ChallengeTier | null | undefined,
  target: ChallengeTier | null | undefined,
): number | null {
  if (!actual || !target) return null;
  return Math.abs(TIER_RANK[actual] - TIER_RANK[target]);
}
