import type { UnifiedItem } from './unified-session-types';
import { collectItemComposition } from './unified-session-manifold-items';

const DEFAULT_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getCacheFreshness(
  validUntil: Date,
  now: Date,
  staleMaxAgeMs: number = DEFAULT_STALE_MAX_AGE_MS,
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
