'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  REVIEW_FEED_MODE_COOKIE,
  REVIEW_FEED_MODE_STORAGE_KEY,
  resolveBrowserReviewFeedMode,
  reviewFeedModeCookie,
  type ReviewFeedMode,
} from '@/lib/review/feed-mode';
import { studyTimezoneCookie } from '@/lib/review/study-timezone-cookie';

export type { ReviewFeedMode } from '@/lib/review/feed-mode';

/**
 * Publish the browser's study-day timezone where the SERVER render can read it.
 *
 * Without it the server bootstrap cannot stream a mixed review batch — that
 * timezone gates the objective-core lane — so the daily-driver lane fell back
 * to a client round trip on every load. Written beside the feed-mode cookie
 * because they are the same contract: browser state the next navigation's
 * server render needs in order to choose the identical lane.
 */
function persistStudyTimezone(): void {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cookie = zone ? studyTimezoneCookie(zone) : null;
    if (cookie) document.cookie = cookie;
  } catch {
    // No cookie: the server keeps using the bounded client path. Never fatal.
  }
}

function readStored(): ReviewFeedMode {
  if (typeof window === 'undefined') return 'mixed';
  try {
    const cookie = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${REVIEW_FEED_MODE_COOKIE}=`))
      ?.slice(REVIEW_FEED_MODE_COOKIE.length + 1);
    return resolveBrowserReviewFeedMode(
      cookie,
      window.localStorage.getItem(REVIEW_FEED_MODE_STORAGE_KEY),
    );
  } catch {
    return 'mixed';
  }
}

function persist(mode: ReviewFeedMode): void {
  try {
    window.localStorage.setItem(REVIEW_FEED_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage unavailable — the cookie can still establish server parity.
  }
  try {
    document.cookie = reviewFeedModeCookie(mode);
  } catch {
    // Cookie unavailable — client-only review continues safely.
  }
}

export function useReviewFeedMode(initialMode?: ReviewFeedMode) {
  const [feedMode, setFeedModeState] = useState<ReviewFeedMode>(
    () => initialMode ?? readStored(),
  );

  useEffect(() => {
    // A server-delivered batch owns this first render. Preserve the mode that
    // produced its delivery rows even if stale browser state changed between
    // request and hydration; later user changes still go through setFeedMode.
    const stored = initialMode ?? readStored();
    if (stored !== feedMode) setFeedModeState(stored);
    persist(stored);
    persistStudyTimezone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFeedMode = useCallback((next: ReviewFeedMode) => {
    setFeedModeState(next);
    persist(next);
  }, []);

  return { feedMode, setFeedMode };
}
