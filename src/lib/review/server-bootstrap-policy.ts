import {
  parseReviewFeedMode,
  type ReviewFeedMode,
} from './feed-mode';
import {
  REVIEW_FILTERS,
  type ReviewFilter,
} from './review-intent';

const FILTERS = new Set<string>(REVIEW_FILTERS);

interface HeaderReader {
  get(name: string): string | null;
}

export function isReviewRoutePrefetch(headers: HeaderReader): boolean {
  return headers.get('next-router-prefetch') === '1'
    || headers.get('purpose')?.toLowerCase() === 'prefetch'
    || headers.get('sec-purpose')?.toLowerCase().includes('prefetch') === true;
}

export function parseRawReviewFilter(value: string | null | undefined): ReviewFilter | null {
  return value && FILTERS.has(value) ? value as ReviewFilter : null;
}

/**
 * A server batch is allowed only when its lane is visible to both renders.
 *
 * Typed filters fully specify the lane and therefore override a stale cookie.
 * An ordinary request without a valid cookie stays on the bounded client path
 * for this migration visit; guessing "mixed" could write delivery rows for a
 * browser whose persisted preference is actually "new-only".
 */
export function resolveServerBootstrapFeedMode(args: {
  cookieValue: string | null | undefined;
  filterValue: string | null | undefined;
}): ReviewFeedMode | null {
  const filter = parseRawReviewFilter(args.filterValue);
  if (filter === 'new') return 'new-only';
  if (filter === 'due' || filter === 'at-risk') return 'mixed';
  return parseReviewFeedMode(args.cookieValue);
}
