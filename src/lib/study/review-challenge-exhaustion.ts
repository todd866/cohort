import { REVIEW_CHALLENGE_POLICY_VERSION } from './review-challenge';
import type { ReviewChallengePreference } from './review-challenge-preference';

/** Only an explicit, current server receipt can request an automatic step down. */
export function exhaustedReviewChallenge(
  batches: readonly { items?: readonly unknown[]; reviewChallengeExhausted?: unknown }[],
  requestedBatches: number,
): ReviewChallengePreference | null {
  if (requestedBatches < 1 || batches.length !== requestedBatches) return null;
  let receipt: ReviewChallengePreference | null = null;
  for (const batch of batches) {
    if (!Array.isArray(batch.items) || batch.items.length !== 0) return null;
    const value = batch.reviewChallengeExhausted;
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<ReviewChallengePreference>;
    if (candidate.level !== 2 || candidate.policy !== REVIEW_CHALLENGE_POLICY_VERSION
      || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0) return null;
    if (receipt && receipt.revision !== candidate.revision) return null;
    receipt = candidate as ReviewChallengePreference;
  }
  return receipt;
}
