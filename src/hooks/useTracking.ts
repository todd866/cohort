'use client';

import { useEffect, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Hook for tracking page views and scroll depth
 * Automatically tracks when mounted and sends update on unmount
 * Resets timing/scroll state on route changes
 */
export function usePageTracking() {
  const pathname = usePathname();
  // Use null initially to avoid impure Date.now() during render
  const startTime = useRef<number | null>(null);
  const maxScroll = useRef(0);
  const lastPathname = useRef(pathname);

  // Initialize start time on mount and reset on pathname change
  useEffect(() => {
    if (startTime.current === null || pathname !== lastPathname.current) {
      startTime.current = Date.now();
      maxScroll.current = 0;
      lastPathname.current = pathname;
    }
  }, [pathname]);

  // Track scroll depth
  useEffect(() => {
    // Reset scroll tracking on route change
    maxScroll.current = 0;

    const handleScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPercent = docHeight > 0 ? scrollTop / docHeight : 0;
      maxScroll.current = Math.max(maxScroll.current, scrollPercent);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [pathname]); // Re-run when pathname changes

  // Track page view on mount, update on unmount
  useEffect(() => {
    // Reset start time for this page
    const pageStartTime = Date.now();
    startTime.current = pageStartTime;

    // Record initial page view
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'pageview',
        path: pathname,
        screenSize: `${window.screen.width}x${window.screen.height}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    }).catch(() => {});

    // Update with duration and scroll depth on unmount or route change
    return () => {
      const endTime = Date.now();
      const duration = Math.round((endTime - pageStartTime) / 1000);

      // Use sendBeacon for reliable unload tracking
      const data = JSON.stringify({
        type: 'pageview',
        path: pathname,
        duration,
        scrollDepth: Math.round(maxScroll.current * 100) / 100,
        screenSize: `${window.screen.width}x${window.screen.height}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', data);
      } else {
        fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [pathname]);
}

/**
 * Hook for tracking component interactions
 */
export function useInteractionTracking() {
  const pathname = usePathname();

  const trackInteraction = useCallback(
    (
      componentType: string,
      action: string,
      componentId?: string,
      metadata?: Record<string, unknown>
    ) => {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Auth/provider interactions can immediately navigate away. keepalive
        // lets the named funnel event survive that redirect.
        keepalive: true,
        body: JSON.stringify({
          type: 'interaction',
          path: pathname,
          componentType,
          componentId,
          action,
          metadata,
          screenSize: `${window.screen.width}x${window.screen.height}`,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }).catch(() => {});
    },
    [pathname]
  );

  return { trackInteraction };
}

/**
 * Pre-built trackers for specific components
 */
export function useLearnMoreTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onExpand: () => trackInteraction('LearnMore', 'expand', id),
    onCollapse: () => trackInteraction('LearnMore', 'collapse', id),
  };
}

export function useDeepDiveTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onOpen: () => trackInteraction('DeepDive', 'open', id),
    onClose: () => trackInteraction('DeepDive', 'close', id),
  };
}

export function useVideoTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onPlay: () => trackInteraction('Video', 'play', id),
    onPause: () => trackInteraction('Video', 'pause', id),
    onComplete: () => trackInteraction('Video', 'complete', id),
  };
}

export function useQuizTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onStart: () => trackInteraction('QuizTable', 'start', id),
    onComplete: (score: number, total: number) =>
      trackInteraction('QuizTable', 'complete', id, { score, total }),
  };
}

export function useImageOcclusionTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onStart: () => trackInteraction('ImageOcclusion', 'start', id),
    onComplete: (correct: number, total: number) =>
      trackInteraction('ImageOcclusion', 'complete', id, { correct, total }),
  };
}

export function useFigureTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onOpen: () => trackInteraction('Figure', 'open', id),
    onClose: () => trackInteraction('Figure', 'close', id),
  };
}

/**
 * Image impression/reveal tracking. Powers `npm run audit:images`.
 *
 * - Identity is the canonical `imageKey` (e.g. `/figures/cah/derm/foo.jpg` or
 *   the original external URL for non-`/figures/` sources). The signed R2
 *   `imageUrl` is short-lived and would fragment metrics + leak a signature
 *   into FeedEvent rows — never stored.
 * - Fires `impression` once per imageKey per mount (deduped via ref).
 * - Returns `recordReveal()` callback to fire when the image is uncovered
 *   (e.g., MCQ answered, occlusion lifted).
 *
 * Both events land in FeedEvent with eventType `image_impression` /
 * `image_reveal`. Metadata carries `imageKey` + optional modality/condition
 * so the audit script can roll up per image.
 */
export function useImageTracking(args: {
  imageKey: string | null | undefined;
  componentId?: string;
  modality?: string | null;
  condition?: string | null;
}) {
  const { trackInteraction } = useInteractionTracking();
  const { imageKey, componentId, modality, condition } = args;
  const impressionFiredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!imageKey) return;
    if (impressionFiredRef.current === imageKey) return;
    impressionFiredRef.current = imageKey;
    trackInteraction('Image', 'impression', componentId, {
      imageKey,
      modality: modality ?? undefined,
      condition: condition ?? undefined,
    });
  }, [imageKey, componentId, modality, condition, trackInteraction]);

  const recordReveal = useCallback(() => {
    if (!imageKey) return;
    trackInteraction('Image', 'reveal', componentId, {
      imageKey,
      modality: modality ?? undefined,
      condition: condition ?? undefined,
    });
  }, [imageKey, componentId, modality, condition, trackInteraction]);

  return { recordReveal };
}

export function useMCQTracking(id?: string) {
  const { trackInteraction } = useInteractionTracking();

  return {
    onAnswer: (correct: boolean) =>
      trackInteraction('MCQ', 'answer', id, { correct }),
  };
}
