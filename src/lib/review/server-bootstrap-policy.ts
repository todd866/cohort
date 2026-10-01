import {
  parseReviewFeedMode,
  type ReviewFeedMode,
} from './feed-mode';
import { parseStudyTimezone } from './study-timezone-cookie';
import {
  REVIEW_FILTERS,
  type ReviewFilter,
} from './review-intent';

const FILTERS = new Set<string>(REVIEW_FILTERS);

interface HeaderReader {
  get(name: string): string | null;
}

export function isReviewRoutePrefetch(headers: HeaderReader): boolean {
  // Next uses 1 for loading-boundary prefetch and 2 for runtime prefetch.
  const routerPrefetch = headers.get('next-router-prefetch');
  return routerPrefetch === '1' || routerPrefetch === '2'
    || headers.get('purpose')?.toLowerCase() === 'prefetch'
    || headers.get('sec-purpose')?.toLowerCase().includes('prefetch') === true;
}

/**
 * Next strips its Flight/prefetch headers before exposing headers() to server
 * components, and full router.prefetch requests may omit those flags entirely.
 * Only a document navigation may issue a server batch. Client navigations and
 * speculative RSC requests use the client-owned delivery path after mounting.
 */
export function isReviewDocumentNavigation(headers: HeaderReader): boolean {
  return headers.get('sec-fetch-mode') === 'navigate'
    && headers.get('sec-fetch-dest') === 'document'
    && !isReviewRoutePrefetch(headers);
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
/**
 * Whether a MIXED review batch may be streamed from the server render.
 *
 * Mixed is the daily-driver lane, and excluding it left the fast path (batch
 * in the HTML, first card ~50ms) firing on roughly a fifth of loads while
 * everyone else paid a client round trip.
 *
 * The original block cited the 30/60/90 mixed allocation, but that reason had
 * gone stale: `computeFetchSlots` deprecated `todayReviewed` and ignores it,
 * and the bootstrap hardcodes `reviewed = 0`. The dependency that is REAL is
 * the study-day timezone — it gates the objective-core lane
 * (`nativeAnswersToday` and the adaptive daily target,
 * unified-session-service.ts:509-529), and a server batch computed without it
 * could disagree with the lane the browser's own request would produce.
 *
 * So the gate becomes exactly that condition, and a visit with no proven
 * timezone still takes the bounded client path rather than guessing.
 */
export function canServerStreamMixedReview(
  studyTimezone: string | null | undefined,
): boolean {
  return parseStudyTimezone(studyTimezone) !== null;
}

export function resolveServerBootstrapFeedMode(args: {
  cookieValue: string | null | undefined;
  filterValue: string | null | undefined;
}): ReviewFeedMode | null {
  const filter = parseRawReviewFilter(args.filterValue);
  if (filter === 'new') return 'new-only';
  if (filter === 'due' || filter === 'at-risk') return 'mixed';
  return parseReviewFeedMode(args.cookieValue);
}
