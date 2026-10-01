export type ReviewFeedMode = 'mixed' | 'new-only';

export const REVIEW_FEED_MODE_STORAGE_KEY = 'md3:reviewFeedMode';
export const REVIEW_FEED_MODE_COOKIE = 'md3_review_feed_mode';
export const REVIEW_FEED_MODE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function parseReviewFeedMode(value: string | null | undefined): ReviewFeedMode | null {
  return value === 'mixed' || value === 'new-only' ? value : null;
}

/**
 * Once present, the cookie is the cross-render contract: the server and first
 * client render must choose the same lane or a streamed batch could be rejected
 * after its delivery rows were written. localStorage remains the migration
 * source only until the cookie is established.
 */
export function resolveBrowserReviewFeedMode(
  cookieValue: string | null | undefined,
  storedValue: string | null | undefined,
): ReviewFeedMode {
  return parseReviewFeedMode(cookieValue)
    ?? parseReviewFeedMode(storedValue)
    ?? 'mixed';
}

export function reviewFeedModeCookie(mode: ReviewFeedMode): string {
  return [
    `${REVIEW_FEED_MODE_COOKIE}=${mode}`,
    'Path=/',
    `Max-Age=${REVIEW_FEED_MODE_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ].join('; ');
}
