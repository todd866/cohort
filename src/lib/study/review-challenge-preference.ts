import {
  normalizeReviewChallengeLevel,
  REVIEW_CHALLENGE_POLICY_VERSION,
  type ReviewChallengeLevel,
} from './review-challenge';

export interface ReviewChallengePreference {
  level: ReviewChallengeLevel;
  revision: number;
  policy: string;
}

export const DEFAULT_REVIEW_CHALLENGE_PREFERENCE: ReviewChallengePreference = {
  level: 0,
  revision: 0,
  policy: REVIEW_CHALLENGE_POLICY_VERSION,
};

export function reviewChallengePreference(
  userScope: { reviewChallenge?: number | null; reviewChallengeRevision?: number | null } | null,
): ReviewChallengePreference {
  return normalizeReviewChallengePreference({
    level: userScope?.reviewChallenge,
    revision: userScope?.reviewChallengeRevision,
    policy: REVIEW_CHALLENGE_POLICY_VERSION,
  });
}

export function normalizeReviewChallengePreference(value: unknown): ReviewChallengePreference {
  if (!value || typeof value !== 'object') return DEFAULT_REVIEW_CHALLENGE_PREFERENCE;
  const candidate = value as Partial<ReviewChallengePreference>;
  return {
    level: normalizeReviewChallengeLevel(candidate.level),
    revision: typeof candidate.revision === 'number' && Number.isInteger(candidate.revision)
      ? Math.max(0, candidate.revision)
      : 0,
    policy: typeof candidate.policy === 'string' && candidate.policy.length > 0
      ? candidate.policy
      : REVIEW_CHALLENGE_POLICY_VERSION,
  };
}

export function reviewChallengePreferencesEqual(
  a: ReviewChallengePreference,
  b: ReviewChallengePreference,
): boolean {
  return a.level === b.level && a.revision === b.revision && a.policy === b.policy;
}

export function matchesReviewChallenge(
  actual: ReviewChallengePreference | null | undefined,
  expected: ReviewChallengePreference,
): boolean {
  if (!actual) return false;
  return reviewChallengePreferencesEqual(
    normalizeReviewChallengePreference(actual),
    normalizeReviewChallengePreference(expected),
  );
}

/** Policy changes invalidate even unstamped legacy Auto queues. */
export function cacheItemsMatchReviewChallenge(
  items: Array<Record<string, unknown>>,
  preference: ReviewChallengePreference,
): boolean {
  const expected = normalizeReviewChallengePreference(preference);
  return items.every((item) => {
    const receipt = item.reviewChallenge;
    if (receipt === undefined || receipt === null) {
      return false;
    }
    if (!receipt || typeof receipt !== 'object') return false;
    const value = receipt as Partial<ReviewChallengePreference>;
    if (typeof value.level !== 'number' || !Number.isInteger(value.level) || value.level < -2 || value.level > 2
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.policy !== 'string') return false;
    return reviewChallengePreferencesEqual(
      normalizeReviewChallengePreference(receipt),
      expected,
    );
  });
}
