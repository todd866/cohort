import type { FetchSlot } from './useReviewSession';
import type { ReviewFilter } from '@/lib/review/review-intent';

export interface UnifiedSessionParamOpts {
  week?: number | null;
  activeModules: string[];
  feedMode?: 'mixed' | 'new-only';
  /** Typed root-link filter. */
  reviewFilter?: ReviewFilter;
  /** When set, the session is focused on one rotation: drop module filters. */
  focusRotation?: string | null;
  excludeCards?: string;
  excludeQuestions?: string;
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
  if (opts.week) params.set('week', String(opts.week));
  if (opts.activeModules.length > 0 && !focused) params.set('modules', opts.activeModules.join(','));
  if (opts.excludeCards) params.set('excludeCards', opts.excludeCards);
  if (opts.excludeQuestions) params.set('excludeQuestions', opts.excludeQuestions);
  if (opts.reviewFilter) params.set('filter', opts.reviewFilter);
  if (opts.feedMode === 'new-only' || opts.reviewFilter === 'new') {
    params.set('feedMode', 'new-only');
  }
  return params;
}
