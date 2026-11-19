import type { ReviewFeedMode } from '@/lib/review/feed-mode';
import type { ReviewFilter, ReviewItemType, ReviewMedia } from '@/lib/review/review-intent';

export type ProgressKind = 'daily' | 'new' | 'session';

/**
 * A whole-course goal must never masquerade as a filtered session goal.
 * Offline alone does not narrow the feed: the connection chip already says
 * the device is offline (owner correction, 11 Nov 2026).
 */
export function reviewProgressPresentation(input: {
  feedMode: ReviewFeedMode;
  reviewFilter?: ReviewFilter;
  itemType?: ReviewItemType;
  media?: ReviewMedia;
  scoped: boolean;
  sessionReviewed: number;
  reviewed: number;
  target: number | null;
  todayFirstSight: number;
  firstSightTarget: number | null;
}): { reviewed: number; target: number | null; kind: ProgressKind } {
  if (input.scoped || input.itemType || input.media
    || input.reviewFilter === 'due' || input.reviewFilter === 'at-risk') {
    return { reviewed: input.sessionReviewed, target: null, kind: 'session' };
  }
  if (input.feedMode === 'new-only' || input.reviewFilter === 'new') {
    return { reviewed: input.todayFirstSight, target: input.firstSightTarget, kind: 'new' };
  }
  return { reviewed: input.reviewed, target: input.target, kind: 'daily' };
}
