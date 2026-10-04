import type { UnifiedItem } from './unified-session-types';
import { collectItemComposition } from './unified-session-manifold-items';

/**
 * How long past validUntil the cache lane still serves a queue, as
 * cache-stale, before discarding it. The undelivered ServeDecision prune's
 * floor depends on this bound (serve-decision-retention.ts); a test there pins
 * the floor above it.
 */
export const CACHE_STALE_SERVE_MAX_MS = 24 * 60 * 60 * 1000;

export function getCacheFreshness(
  validUntil: Date,
  now: Date,
  staleMaxAgeMs: number = CACHE_STALE_SERVE_MAX_MS,
) {
  const ageMs = now.getTime() - validUntil.getTime();
  return {
    isFresh: validUntil > now,
    isTooOld: ageMs > staleMaxAgeMs,
    ageMs,
  };
}

export function filterClientExcludedCachedItems(
  items: UnifiedItem[],
  clientExcludeCardSet: Set<string>,
  clientExcludeQuestionSet: Set<string>,
): UnifiedItem[] {
  return items.filter((item) => {
    if (item.type === 'card' && clientExcludeCardSet.has(item.id)) return false;
    if (item.type === 'question' && clientExcludeQuestionSet.has(item.id)) return false;
    return true;
  });
}

/**
 * Keep the first cached card from each cloze-variant family.
 *
 * This is deliberately card-only: question variant groups can represent
 * broader topic buckets, so applying the same gate to questions would discard
 * unrelated MCQs. Items without a group keep their original position.
 */
export function filterDuplicateCardVariantGroups(items: UnifiedItem[]): UnifiedItem[] {
  const seenVariantGroups = new Set<string>();
  return items.filter((item) => {
    if (item.type !== 'card' || !item.variantGroupId) return true;
    if (seenVariantGroups.has(item.variantGroupId)) return false;
    seenVariantGroups.add(item.variantGroupId);
    return true;
  });
}

export function getCachePathLabel(isFresh: boolean): 'cache-fresh' | 'cache-stale' {
  return isFresh ? 'cache-fresh' : 'cache-stale';
}

export function buildCacheResponsePayload(
  items: UnifiedItem[],
  isFresh: boolean,
  sessionId: string,
  batchId: string,
) {
  return {
    items,
    stats: {
      totalItems: items.length,
      version: getCachePathLabel(isFresh),
      composition: collectItemComposition(items),
    },
    availableFilters: { types: [], difficulties: [], topics: [] as string[] },
    sessionId,
    batchId,
  };
}
