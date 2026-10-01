import type { ReviewFeedMode } from './feed-mode';
import type { ReviewFilter, ReviewItemType, ReviewTopic } from './review-intent';

export interface ReviewSessionScope {
  rotations: readonly string[];
  week?: number | null;
  feedMode: ReviewFeedMode;
  reviewFilter?: ReviewFilter | null;
  itemType?: ReviewItemType | null;
  focusRotation?: string | null;
  topics?: readonly ReviewTopic[] | null;
  cluster?: string | null;
}

interface SearchParamReader {
  get(name: string): string | null;
}

export function reviewLocationKey(searchParams: SearchParamReader): string {
  const keys = ['rotation', 'week', 'filter'];
  // Preserve the pre-topic identity exactly for ordinary visits. This avoids
  // invalidating an otherwise-adoptable streamed batch merely because the new
  // contract exists; a supplied topic (valid or not) still gets its own URL
  // identity so it cannot adopt a batch from a different location.
  if (searchParams.get('topics') !== null) keys.push('topics');
  // Same reasoning as topics: an MCQ-only visit must never adopt a streamed
  // mixed batch, but an ordinary visit keeps its pre-existing identity so a
  // perfectly adoptable batch is not invalidated just because this mode exists.
  if (searchParams.get('type') !== null) keys.push('type');
  // A cluster-scoped visit must never adopt a batch streamed for the whole
  // rotation — those cards are outside the square the learner clicked.
  if (searchParams.get('cluster') !== null) keys.push('cluster');
  return keys
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
  const base = [
    scope.rotations.join(','),
    scope.week ?? 'all',
    scope.feedMode,
    scope.reviewFilter ?? '',
    scope.focusRotation ?? '',
  ].join('::');
  const scoped = scope.topics?.length ? `${base}::${scope.topics.join(',')}` : base;
  // Appended only when set, for the same identity-stability reason.
  const typed = scope.itemType ? `${scoped}::type=${scope.itemType}` : scoped;
  return scope.cluster ? `${typed}::cluster=${scope.cluster}` : typed;
}
