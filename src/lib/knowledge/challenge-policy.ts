/**
 * Conservative learner-level challenge targeting.
 *
 * This policy deliberately uses the scheduler's already-trusted, decayed
 * concept recall rather than `predictedRecall`, whose item-level estimator is
 * still telemetry-only. It moves through all three authored rungs instead of
 * jumping directly from scaffolding to stretch.
 */

export const CHALLENGE_POLICY_VERSION = 'concept-recall-rungs-v1';
export const STANDARD_CHALLENGE_RECALL = 0.6;
export const STRETCH_CHALLENGE_RECALL = 0.8;

/** The rung a learner starts on: the scaffolded tier that `targetComplexityForRecall`
 *  returns for the weakest known recall. Named so callers that must choose a rung
 *  for an unmeasured concept pick the same one the policy already gives a
 *  struggling learner, instead of inventing a literal. */
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
  if (currentRecall < STANDARD_CHALLENGE_RECALL) return 'scaffolding';
  if (currentRecall < STRETCH_CHALLENGE_RECALL) return 'standard';
  return 'stretch';
}

export function targetComplexityForRecall(
  currentRecall: number | undefined,
): 1 | 2 | 3 | null {
  const tier = targetChallengeTierForRecall(currentRecall);
  if (tier === 'scaffolding') return 1;
  if (tier === 'standard') return 2;
  if (tier === 'stretch') return 3;
  return null;
}

export function targetQuestionDifficultyForRecall(
  currentRecall: number | undefined,
): ChallengeQuestionDifficulty | null {
  const tier = targetChallengeTierForRecall(currentRecall);
  if (tier === 'scaffolding') return 'easy';
  if (tier === 'standard') return 'medium';
  if (tier === 'stretch') return 'hard';
  return null;
}

export function challengeTierDistance(
  actual: ChallengeTier | null | undefined,
  target: ChallengeTier | null | undefined,
): number | null {
  if (!actual || !target) return null;
  return Math.abs(TIER_RANK[actual] - TIER_RANK[target]);
}
