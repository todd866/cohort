'use client';

import { useEffect, useRef } from 'react';

/**
 * Start downloading clips the learner has not reached yet.
 *
 * A detached <video preload="auto"> fills the HTTP cache for the same signed
 * URL the card will mount later, and it decodes far enough that play() can
 * begin on the first frame. The elements stay referenced until canplaythrough
 * or error: a local video collected after the effect returns makes the
 * prefetch intermittent in WebKit, the same failure the image prefetcher
 * already guards against.
 *
 * Muted, and never played. Lookahead must not start sound in the background.
 */
export function usePrefetchClips(urls: readonly string[], enabled: boolean): void {
  const prefetchedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef<Set<HTMLVideoElement>>(new Set());
  const key = urls.join('\n');

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;
    for (const url of key ? key.split('\n') : []) {
      if (!url || prefetchedRef.current.has(url)) continue;
      prefetchedRef.current.add(url);
      const video = document.createElement('video');
      activeRef.current.add(video);
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('fetchpriority', 'low');
      const release = () => activeRef.current.delete(video);
      video.addEventListener('canplaythrough', release, { once: true });
      video.addEventListener('error', release, { once: true });
      video.src = url;
    }
  }, [key, enabled]);
}
