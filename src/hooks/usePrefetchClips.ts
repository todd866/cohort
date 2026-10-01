'use client';

import { useBoundedPrefetch } from './useBoundedPrefetch';

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
  useBoundedPrefetch(urls, enabled, (url, settled) => {
    if (typeof document === 'undefined') {
      return null;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('fetchpriority', 'low');
    const onReady = () => settled(true);
    const onError = () => settled(false);
    video.addEventListener('canplaythrough', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.src = url;
    return {
      cleanup: (abort: boolean) => {
        video.removeEventListener('canplaythrough', onReady);
        video.removeEventListener('error', onError);
        if (abort) {
          video.src = '';
          try { video.load(); } catch { /* jsdom has no media loader */ }
        }
      },
    };
  });
}
