'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Away longer than this and the counts on the page are probably out of date. */
const STALE_AFTER_MS = 60_000;

/**
 * An installed app resumed from the background, or a page restored from the
 * back-forward cache, shows its last render without asking the server again.
 * On the profile and stats pages that means today's counts stop moving while
 * the learner reviews elsewhere. Re-fetch the server data when they return.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let lastRefreshAt = Date.now();
    const refresh = () => {
      lastRefreshAt = Date.now();
      router.refresh();
    };
    const refreshIfStale = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefreshAt >= STALE_AFTER_MS) refresh();
    };
    // Client navigation can restore cached server props without a pageshow or
    // visibility event. Refresh once on mount. Live panels own their polling.
    refresh();
    const onVisibility = () => refreshIfStale();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [router]);
  return null;
}
