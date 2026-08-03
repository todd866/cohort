import type { ReviewFeedMode } from './feed-mode';
import type { ReviewFilter } from './review-intent';

export interface ReviewSessionScope {
  rotations: readonly string[];
  week?: number | null;
  feedMode: ReviewFeedMode;
  reviewFilter?: ReviewFilter | null;
  focusRotation?: string | null;
}

interface SearchParamReader {
  get(name: string): string | null;
}

export function reviewLocationKey(searchParams: SearchParamReader): string {
  return ['rotation', 'week', 'filter']
    .map((key) => `${key}=${searchParams.get(key) ?? ''}`)
    .join('&');
}

/**
 * Semantic identity of the visible review visit.
 *
 * Fetch-slot sizes are deliberately absent: progress arriving after an initial
 * batch may change the allocation for the next page, but must not retire cards
 * already delivered under the same user-visible scope.
 */
export function reviewSessionScopeKey(scope: ReviewSessionScope): string {
  return [
    scope.rotations.join(','),
    scope.week ?? 'all',
    scope.feedMode,
    scope.reviewFilter ?? '',
    scope.focusRotation ?? '',
  ].join('::');
}
