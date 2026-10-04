import type { ReviewChallengeLevel } from './review-challenge';
import { normalizeReviewChallengeLevel } from './review-challenge';

/** The modalities the learner-controlled policy may admit in ordinary review. */
export type LearningModality = 'card' | 'question' | 'video' | 'group';

export interface ReviewLearningPolicy {
  level: ReviewChallengeLevel;
  /** +2 is an exam-format question lane when eligible questions exist. */
  questionsOnly: boolean;
  /** -2 is a teaching/scaffold lane; ordinary hard material is excluded. */
  scaffoldsOnly: boolean;
  preferredQuestionShare: number;
  preferredCardShare: number;
}

export function hasDemonstratedLearningGap(input: {
  recallProbability?: number | null;
  recentFailure?: boolean;
  recentFailRate?: number | null;
  lastProbeAt?: Date | string | null;
  now?: Date;
  probeCount?: number | null;
  confidence?: number | null;
}): boolean {
  const probes = input.probeCount;
  if (typeof probes !== 'number' || !Number.isFinite(probes) || probes <= 0) return false;
  if (input.recentFailure === true) return true;
  const recall = input.recallProbability;
  const lowRecall = typeof recall === 'number' && Number.isFinite(recall) && recall < 0.6;
  if (lowRecall) return true;
  const lastProbe = input.lastProbeAt ? new Date(input.lastProbeAt).getTime() : NaN;
  const now = (input.now ?? new Date()).getTime();
  const recentFailureRate = typeof input.recentFailRate === 'number' && input.recentFailRate > 0;
  return recentFailureRate && Number.isFinite(lastProbe) && now - lastProbe <= 24 * 60 * 60 * 1000;
}

export function reviewLearningPolicy(level: ReviewChallengeLevel | number | null | undefined): ReviewLearningPolicy {
  const normalized = normalizeReviewChallengeLevel(level);
  return {
    level: normalized,
    questionsOnly: normalized === 2,
    scaffoldsOnly: normalized === -2,
    preferredQuestionShare: normalized === 2 ? 1 : normalized === -2 ? 0 : normalized === 1 ? 0.7 : normalized === -1 ? 0.3 : 0.4,
    preferredCardShare: normalized === 2 ? 0 : normalized === -2 ? 1 : normalized === 1 ? 0.3 : normalized === -1 ? 0.7 : 0.6,
  };
}

export function cardEligibleForReviewLearning(
  complexity: number | null | undefined,
  level: ReviewChallengeLevel | number | null | undefined,
): boolean {
  const policy = reviewLearningPolicy(level);
  if (policy.questionsOnly) return false;
  if (!policy.scaffoldsOnly) return true;
  return complexity === 1;
}

export function questionEligibleForReviewLearning(
  level: ReviewChallengeLevel | number | null | undefined,
  options: { isScaffold?: boolean; difficulty?: string | null; demonstratedGap?: boolean } = {},
): boolean {
  const policy = reviewLearningPolicy(level);
  // The current shared candidate contract has no authoritative scaffold
  // question marker. Keep -2 strictly card-only until one exists.
  if (policy.scaffoldsOnly) return false;
  if (policy.questionsOnly) return options.demonstratedGap === true && options.difficulty === 'hard' && options.isScaffold !== true;
  return true;
}

export function modalityEligibleForReviewLearning(
  modality: LearningModality,
  level: ReviewChallengeLevel | number | null | undefined,
): boolean {
  const policy = reviewLearningPolicy(level);
  if (policy.questionsOnly) return modality === 'question';
  if (policy.scaffoldsOnly) return modality === 'card';
  return true;
}

/** Prisma-friendly predicates for callers that build separate card/question queries. */
export function reviewLearningCardWhere(level: ReviewChallengeLevel | number | null | undefined): Record<string, unknown> {
  const policy = reviewLearningPolicy(level);
  if (policy.questionsOnly) return { id: { in: [] } };
  if (policy.scaffoldsOnly) return { complexity: 1 };
  return {};
}

export function reviewLearningQuestionWhere(level: ReviewChallengeLevel | number | null | undefined): Record<string, unknown> {
  const policy = reviewLearningPolicy(level);
  if (policy.scaffoldsOnly) return { id: { in: [] } };
  if (policy.questionsOnly) return { difficulty: 'hard' };
  return {};
}
