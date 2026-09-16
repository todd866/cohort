import type { FetchSlot } from './useReviewSession';
import type { ReviewFilter, ReviewItemType, ReviewTopic } from '@/lib/review/review-intent';

export interface UnifiedSessionParamOpts {
  week?: number | null;
  activeModules: string[];
  feedMode?: 'mixed' | 'new-only';
  /** Typed root-link filter. */
  reviewFilter?: ReviewFilter;
  /** MCQ-only review: narrow the batch to questions. */
  itemType?: ReviewItemType;
  /** Checked-in topic filters that narrow the authorized rotation. */
  topics?: readonly ReviewTopic[];
  /** One manifold cluster, from a square on the profile knowledge heatmap. */
  cluster?: string | null;
  /** When set, the session is focused on one rotation: drop module filters. */
  focusRotation?: string | null;
  excludeCards?: string;
  excludeQuestions?: string;
  /** IANA timezone used only for the server-owned 04:00 study-day boundary. */
  timezone?: string;
  /**
   * Idempotency key for this logical fetch, REUSED across its retries. Without
   * it the endpoint mints a new session per attempt and a retry duplicates the
   * delivery. See src/lib/study/serve-request-id.ts.
   */
  serveRequestId?: string;
}

/**
 * Build the query string for one /api/study/unified-session fetch.
 * Focus mode omits `modules`: the rotation is already fully scoped, and passing
 * activeModules for a rotation with no ROTATION_TO_MODULES entry (mnd/anking)
 * would force the slow manifold path and can exclude its own items. An explicit
 * week is still meaningful and remains part of the request.
 */
export function buildUnifiedSessionParams(slot: FetchSlot, opts: UnifiedSessionParamOpts): URLSearchParams {
  const params = new URLSearchParams({ rotation: slot.rotation, size: String(slot.size) });
  if (slot.mode) params.set('mode', slot.mode);
  if (slot.difficulty) params.set('difficulty', slot.difficulty);
  const focused = !!opts.focusRotation;
  if (focused) params.set('focus', '1');
  if (opts.week) params.set('week', String(opts.week));
  if (opts.activeModules.length > 0 && !focused) params.set('modules', opts.activeModules.join(','));
  if (opts.excludeCards) params.set('excludeCards', opts.excludeCards);
  if (opts.excludeQuestions) params.set('excludeQuestions', opts.excludeQuestions);
  if (opts.reviewFilter) params.set('filter', opts.reviewFilter);
  if (opts.itemType) params.set('type', opts.itemType);
  if (opts.topics?.length) params.set('topics', opts.topics.join(','));
  if (opts.cluster) params.set('cluster', opts.cluster);
  if (opts.timezone) params.set('tz', opts.timezone);
  if (opts.serveRequestId) params.set('sid', opts.serveRequestId);
  if (opts.feedMode === 'new-only' || opts.reviewFilter === 'new') {
    params.set('feedMode', 'new-only');
  }
  return params;
}
