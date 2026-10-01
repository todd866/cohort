'use client';

import { useCallback, useRef, useState } from 'react';
import type { ClipPromptData } from './clip-role';

const RECOVERY_DEADLINE_MS = 8_000;

/**
 * One fresh URL per mounted clip, fetched on the first playback error.
 *
 * The URL a clip arrives with is a 15-minute signed bearer minted when the
 * session batch was built. Sessions outlive that as a matter of course, and
 * an offline pack keeps items for a week, so the first `error` the element
 * fires is far more likely to be an expired signature than a bad file. The
 * delivery route re-runs the rights/tier gate and returns a fresh pair.
 *
 * Once, deliberately: if the fresh URL also fails the file is the problem,
 * and an element that errors on every attempt would otherwise fetch forever.
 */
export function useClipUrlRecovery(clip: ClipPromptData): {
  src: string;
  poster: string | null;
  onError: () => void;
} {
  // Keyed by the URL that failed, so a different clip in the same mounted
  // element starts over without an effect resetting state.
  const [fresh, setFresh] = useState<{ forUrl: string; url: string; posterUrl: string | null } | null>(null);
  const attemptedFor = useRef<string | null>(null);
  const failedUrl = clip.url;

  const onError = useCallback(() => {
    if (attemptedFor.current === failedUrl) return;
    attemptedFor.current = failedUrl;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), RECOVERY_DEADLINE_MS) : null;
    void fetch(`/api/clips/${encodeURIComponent(clip.id)}/delivery`, {
      cache: 'no-store',
      signal: controller?.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { url?: unknown; posterUrl?: unknown };
        if (typeof body.url !== 'string') return;
        setFresh({
          forUrl: failedUrl,
          url: body.url,
          posterUrl: typeof body.posterUrl === 'string' ? body.posterUrl : null,
        });
      })
      .catch(() => {})
      .finally(() => { if (timer) clearTimeout(timer); });
  }, [clip.id, failedUrl]);

  const recovered = fresh && fresh.forUrl === clip.url ? fresh : null;
  return {
    src: recovered?.url ?? clip.url,
    poster: recovered ? recovered.posterUrl : clip.posterUrl,
    onError,
  };
}
