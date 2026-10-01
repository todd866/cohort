import type { ReviewItem } from './types';

/** Public build has no private practice-exam follow-up delivery lane. */
export function isPracticeFollowUpTurn(_item: ReviewItem | undefined): boolean {
  return false;
}

export function isProtectedPracticeItem(_item: ReviewItem | undefined): boolean {
  return false;
}
