'use client';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { ensureFiguresCached, figureKeysForItems, OFFLINE_FIGURES_CHANGE_EVENT } from '@/lib/offline/figures';
import { readOfflineOwner, subscribeOfflineOwner } from '@/lib/offline/owner';
import { isOfflineImageKey } from '@/lib/offline/image-key';
import { prepareCachedFigures, registerPreparedFigureSources } from '@/lib/offline/prepared-figures';

/** Cover server bootstrap, fetched batches and offline batches through one lane. */
export function usePrepareReviewImages(
  items: readonly unknown[], currentIndex: number, userKey: string | null, offline = false,
): void {
  // The reserve can hold a thousand items. Advancing changes only the small
  // decoded window; do not rescan the entire reserve for every review action.
  const allKeys = useMemo(() => JSON.stringify(figureKeysForItems(items)), [items]);
  const windowKeys = useMemo(() => JSON.stringify(figureKeysForItems(items.slice(Math.max(0, currentIndex), Math.max(0, currentIndex) + 8))), [items, currentIndex]);
  const urls = useMemo(() => JSON.stringify(items.flatMap(item => {
    const row = item as { imageKey?: string; imageUrl?: string; imageAlternatives?: unknown } | null;
    return [row, ...(Array.isArray(row?.imageAlternatives) ? row.imageAlternatives : [])].flatMap(value => {
      const image = value as { imageKey?: string; imageUrl?: string } | null;
      return isOfflineImageKey(image?.imageKey) && image?.imageUrl ? [image.imageUrl] : [];
    });
  })), [items]);
  // Register before the views' passive URL-prefetch effects. They must not
  // duplicate this stable-key lane with signed-URL HTTP-cache requests.
  useLayoutEffect(() => {
    if (!userKey) return;
    let unregister = registerPreparedFigureSources(JSON.parse(urls), userKey);
    const unsubscribe = subscribeOfflineOwner(() => { unregister(); unregister = registerPreparedFigureSources(JSON.parse(urls), userKey); });
    return () => { unsubscribe(); unregister(); };
  }, [urls, userKey]);

  useEffect(() => {
    if (!userKey) return;
    const warm = () => { void prepareCachedFigures(JSON.parse(windowKeys), userKey); };
    warm();
    window.addEventListener(OFFLINE_FIGURES_CHANGE_EVENT, warm);
    const unsubscribe = subscribeOfflineOwner(warm);
    return () => { window.removeEventListener(OFFLINE_FIGURES_CHANGE_EVENT, warm); unsubscribe(); };
  }, [windowKeys, userKey]);

  useEffect(() => {
    if (!userKey || offline) return;
    let running = false;
    let disposed = false;
    const cache = async () => {
      if (disposed || running || navigator.onLine === false || readOfflineOwner()?.ownerKey !== userKey) return;
      running = true;
      try { await ensureFiguresCached(JSON.parse(allKeys), userKey); } catch { /* Bulk refill owns retries. */ }
      finally { running = false; }
    };
    void cache();
    const unsubscribe = subscribeOfflineOwner(() => { void cache(); });
    window.addEventListener('online', cache);
    return () => { disposed = true; unsubscribe(); window.removeEventListener('online', cache); };
  }, [allKeys, userKey, offline]);
}
