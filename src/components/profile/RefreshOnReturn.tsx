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
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_MS) router.refresh();
      hiddenAt = null;
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [router]);
  return null;
}
