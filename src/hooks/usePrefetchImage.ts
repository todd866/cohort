'use client';

import { useEffect, useRef } from 'react';
import { isManagedFigureSource } from '@/lib/offline/prepared-figures';

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
  const prefetchedRef = useRef<string | null>(null);
  // Keep preloaders strongly referenced until the browser finishes. A local
  // `new Image()` can be collected after the effect returns, which makes the
  // best-effort prefetch intermittent in WebKit and leaves fast reveals
  // waiting on the real post-answer <img> request.
  const activePrefetchesRef = useRef<Set<HTMLImageElement>>(new Set());
  useEffect(() => {
    if (!enabled || !url) return;
    if (isManagedFigureSource(url)) return;
    if (typeof window === 'undefined') return;
    if (prefetchedRef.current === url) return;
    prefetchedRef.current = url;
    const img = new window.Image();
    activePrefetchesRef.current.add(img);
    img.decoding = 'async';
    img.loading = 'eager';
    img.fetchPriority = 'high';
    const release = () => activePrefetchesRef.current.delete(img);
    img.onload = release;
    img.onerror = release;
    img.src = url;
  }, [url, enabled]);
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
  const prefetchedRef = useRef<Set<string>>(new Set());
  const activePrefetchesRef = useRef<Set<HTMLImageElement>>(new Set());
  // Depend on the joined value, not the array identity: the caller rebuilds
  // this list on every render.
  const key = urls.join(' ');
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    for (const url of key ? key.split(' ') : []) {
      if (!url || prefetchedRef.current.has(url)) continue;
      if (isManagedFigureSource(url)) continue;
      prefetchedRef.current.add(url);
      const img = new window.Image();
      activePrefetchesRef.current.add(img);
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = 'low';
      const release = () => activePrefetchesRef.current.delete(img);
      img.onload = release;
      img.onerror = release;
      img.src = url;
    }
  }, [key, enabled]);
}
