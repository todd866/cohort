'use client';

import { useSyncExternalStore } from 'react';

/** Remembered across cards. Absent or `on` means the next clip starts by itself. */
export const CLIP_AUTOPLAY_KEY = 'md3.clipAutoplay';
const AUTOPLAY_EVENT = 'md3-clip-autoplay';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeAutoplay(onChange: () => void): () => void {
  window.addEventListener(AUTOPLAY_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(AUTOPLAY_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function autoplayEnabled(): boolean {
  try {
    const stored = localStorage.getItem(CLIP_AUTOPLAY_KEY)
      ?? localStorage.getItem('md3.clipAudibleAutoplay');
    return stored !== 'off';
  } catch {
    return true;
  }
}

export function writeAutoplay(on: boolean): void {
  try {
    localStorage.setItem(CLIP_AUTOPLAY_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode can refuse the write. The in-memory store update still
    // applies for this page.
  }
  window.dispatchEvent(new Event(AUTOPLAY_EVENT));
}

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof matchMedia !== 'function') return null;
  try {
    return matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

/**
 * Read as an external store rather than an effect-plus-setState. The preference
 * is browser state that can change while the page is open, and a synchronous
 * setState in an effect re-renders every mount of this component for a value
 * that is usually false. The server snapshot is false so the first paint agrees
 * with the markup; a viewer who does prefer reduced motion gets one correction
 * on hydration, before the clip has loaded enough to play anyway.
 */
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function getReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

export function useClipPlaybackPreferences() {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);
  const autoplay = useSyncExternalStore(subscribeAutoplay, autoplayEnabled, () => true);
  return { reducedMotion, autoplay };
}
