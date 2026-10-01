'use client';

import { isManagedFigureSource } from '@/lib/offline/prepared-figures';
import { useBoundedPrefetch } from './useBoundedPrefetch';

/**
 * Warm the browser cache for an after-reveal card/question image while the
 * question is still on screen.
 *
 * After-reveal figures (a CXR under a cloze, a supplementary image below an MCQ
 * answer) are conditionally mounted only *after* the user reveals, so their
 * `<img>` hits the network the instant the answer appears — a visible pause
 * between pressing space and the image showing. Prefetching during the read
 * window (before reveal) means the bytes are already cached by reveal time, so
 * the real `<img>` renders from cache.
 *
 * Best-effort and side-effect-only: it issues one `new Image()` GET per URL,
 * which populates the HTTP cache. If the (short-lived signed) URL has expired,
 * the prefetch simply fails and the real image's onError re-signs as before —
 * prefetch never breaks that path. Deduped per URL so re-renders don't refetch.
 */
export function usePrefetchImage(url: string | null | undefined, enabled: boolean): void {
  useImagePrefetch([url], enabled, 'high');
}

/**
 * Warm the browser cache for figures on cards the learner has not reached yet.
 *
 * Sibling of usePrefetchImage, which covers the *current* item's after-reveal
 * figure. This covers the next few items in the delivered batch, including
 * prompt figures - the case usePrefetchImage deliberately skips, and the one
 * recorded on 2026-08-22 sitting on a collapsed blur box for seconds because
 * its bytes only began downloading when the card mounted.
 *
 * Requests go out at `fetchPriority = 'low'` so lookahead can never contend
 * with the image the learner is actually waiting on. Warmed URLs are
 * remembered by value, so the feed re-rendering (every keystroke, every
 * reveal) does not re-request them.
 */
export function usePrefetchImages(urls: readonly string[], enabled: boolean): void {
  useImagePrefetch(urls, enabled, 'low');
}

function useImagePrefetch(
  urls: readonly (string | null | undefined)[],
  enabled: boolean,
  priority: 'high' | 'low',
): void {
  useBoundedPrefetch(urls, enabled, (url, settled) => {
    // Preparation registers managed sources in an earlier effect. Checking
    // during render races that registration and downloads the images twice.
    if (typeof window === 'undefined' || isManagedFigureSource(url)) return null;
    const img = new window.Image();
    img.decoding = 'async';
    img.loading = 'eager';
    img.fetchPriority = priority;
    img.onload = () => settled(true);
    img.onerror = () => settled(false);
    img.src = url;
    return {
      cleanup: (abort: boolean) => {
        img.onload = null;
        img.onerror = null;
        if (abort) img.src = '';
      },
    };
  });
}
