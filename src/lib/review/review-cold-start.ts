import type { ReviewFilter, ReviewItemType } from './review-intent';

/** Empty outbox → do not pay the 2s flush budget before the session fetch. */
export function shouldSkipFlushBudget(queueSize: number): boolean {
  return queueSize <= 0;
}

/**
 * Paint the on-device pack immediately while the live session request is in
 * flight. Not used for typed filters (pack cannot prove due/at-risk/new), for
 * MCQ-only (the pack is a mixed queue, so painting it would put cards in a
 * card-free mode), or when offline grades still need to flush first.
 */
export function shouldOptimisticPaintPack(args: {
  queueSize: number;
  reviewFilter: ReviewFilter | undefined;
  itemType?: ReviewItemType | undefined;
  online: boolean;
  packItemCount: number;
}): boolean {
  if (args.reviewFilter || args.itemType) return false;
  if (!args.online) return false;
  if (args.queueSize > 0) return false;
  return args.packItemCount > 0;
}
