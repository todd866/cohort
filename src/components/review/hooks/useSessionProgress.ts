import { useState, useEffect, useCallback } from 'react';
import type { TrackProjection } from '@/lib/study/track-projection';
import {
  fetchWithDeadline,
  REVIEW_CONTEXT_FETCH_DEADLINE_MS,
  CLIENT_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

export interface RotationProgressBreakdown {
  rotation: string;
  dailyTarget: number | null;
  newPerDay: number | null;
  todayReviewed: number;
  daysToExam: number | null;
  examDate: string | null;
  coverage: {
    seen: number;
    total: number;
    percent: number;
    seenCards: number;
    totalCards: number;
    seenQuestions: number;
    totalQuestions: number;
  };
  projection: TrackProjection | null;
}

export interface SessionProgress {
  reviewed: number;
  target: number | null;
  newPerDay: number | null;
  reviewsPerDay: number | null;
  progress: number | null;
  coveragePercent: number | null;
  daysToExam: number | null;
  examDate: string | null;
  consolidationDays: number | null;
  targetHit: boolean;
  bonusCount: number;
  coverage: { seenCards: number; totalCards: number; seenQuestions: number; totalQuestions: number } | null;
  projection: TrackProjection | null;
  /** 14-day combined activity (newest-first). */
  recentHistory: number[] | null;
  /** Per-rotation breakdown for the drawer; null while loading. */
  perRotation: RotationProgressBreakdown[] | null;
  loading: boolean;
  incrementReviewed: () => void;
}

interface UseSessionProgressOptions {
  /** Local offline shell: keep an in-memory count without probing the API. */
  disabled?: boolean;
}

interface DailyTargetResponse {
  dailyTarget: number | null;
  newPerDay: number | null;
  reviewsPerDay: number | null;
  consolidationDays: number | null;
  coverage: RotationProgressBreakdown['coverage'];
  daysToExam: number | null;
  examDate: string | null;
  todayReviewed: number;
  projection: TrackProjection | null;
  recentHistory?: number[];
  /** Only present in multi-rotation responses. */
  perRotation?: RotationProgressBreakdown[];
}

/**
 * useSessionProgress
 *
 * Single hook for the daily-progress pill + drawer. Accepts one rotation
 * (legacy) or an array of rotations (research-block users with multiple
 * upcoming exams). Makes ONE fetch — the endpoint aggregates server-side
 * via `?rotations=cah,pwh`.
 *
 * Why single fetch and not Promise.all of N fetches in the client:
 *   - One failed rotation can't blank the whole pill (server uses
 *     allSettled and includes partial results).
 *   - Half the round-trip cost on mobile networks.
 *   - The drawer needs the perRotation breakdown anyway, which the
 *     endpoint computes alongside the aggregate for free.
 */
/**
 * How many times the daily-target context fetch may be attempted.
 *
 * Two attempts: one on the tight interactive deadline, one that tolerates a
 * cold start. Bounded so a genuinely broken endpoint is not hammered.
 */
export const SESSION_PROGRESS_MAX_ATTEMPTS = 2;

/**
 * Deadline for attempt `n` (0-indexed).
 *
 * The first attempt keeps the tight REVIEW_CONTEXT_FETCH_DEADLINE_MS so a warm
 * request stays snappy. Measured against prod on 2026-07-31, this endpoint runs
 * 366-489 ms warm but tailed to 2821 ms cold — past the 2s deadline. The retry
 * therefore gets room for a cold start rather than repeating a race it already
 * lost.
 */
export function sessionProgressRetryDeadlineMs(attempt: number): number {
  return attempt === 0 ? REVIEW_CONTEXT_FETCH_DEADLINE_MS : CLIENT_FETCH_DEADLINE_MS;
}

/** True while `attempt` (already incremented) is still within budget. */
export function shouldRetrySessionProgress(attempt: number): boolean {
  return attempt > 0 && attempt < SESSION_PROGRESS_MAX_ATTEMPTS;
}

export function useSessionProgress(
  rotation: string | string[],
  { disabled = false }: UseSessionProgressOptions = {},
): SessionProgress {
  const rotations = Array.isArray(rotation) ? rotation : [rotation];
  const rotationsKey = rotations.join(',');

  const [data, setData] = useState<DailyTargetResponse | null>(null);
  const [sessionDelta, setSessionDelta] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (disabled) {
      return () => {
        cancelled = true;
      };
    }
    let attempt = 0;

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Use plural query param for multi-rotation, singular for back-compat
    // with the existing endpoint test fixtures.
    const queryParam = rotations.length > 1
      ? `rotations=${encodeURIComponent(rotationsKey)}`
      : `rotation=${encodeURIComponent(rotations[0])}`;

    const url = `/api/study/daily-target?${queryParam}&tz=${encodeURIComponent(tz)}`;

    // Retry rather than give up. A single miss used to null `data` for the rest
    // of the session: the pill lost its denominator ("32 reviewed" instead of
    // "32/61") and the drawer, gated on perRotation, could never open — so
    // tapping it did nothing. Nothing re-ran the effect except a rotation
    // change, so it stayed broken until reload.
    const run = () => {
      fetchWithDeadline(url, {}, sessionProgressRetryDeadlineMs(attempt))
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
          return res.json();
        })
        .then((resp: DailyTargetResponse) => {
          if (cancelled) return;
          setData(resp);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          attempt += 1;
          if (shouldRetrySessionProgress(attempt)) {
            run();
            return;
          }
          setData(null);
          setLoading(false);
        });
    };
    run();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, rotationsKey]);

  const incrementReviewed = useCallback(() => {
    setSessionDelta((d) => d + 1);
  }, []);

  // Loading or fetch failed: still show a usable pill (sessionDelta).
  if (disabled || loading || !data) {
    const reviewed = !disabled && data ? data.todayReviewed + sessionDelta : sessionDelta;
    return {
      reviewed,
      target: data?.dailyTarget ?? null,
      newPerDay: data?.newPerDay ?? null,
      reviewsPerDay: null,
      progress: null,
      coveragePercent: data?.coverage?.percent ?? null,
      daysToExam: data?.daysToExam ?? null,
      examDate: data?.examDate ?? null,
      consolidationDays: null,
      targetHit: false,
      bonusCount: 0,
      coverage: null,
      projection: data?.projection ?? null,
      recentHistory: data?.recentHistory ?? null,
      perRotation: data?.perRotation ?? null,
      loading: disabled ? false : loading,
      incrementReviewed,
    };
  }

  const reviewed = data.todayReviewed + sessionDelta;
  const target = data.dailyTarget;

  const progress = target != null && target > 0
    ? Math.min(100, Math.round((reviewed / target) * 100))
    : null;

  const targetHit = target != null && reviewed >= target;
  const bonusCount = targetHit ? reviewed - target! : 0;

  return {
    reviewed,
    target,
    newPerDay: data.newPerDay,
    reviewsPerDay: data.reviewsPerDay,
    progress,
    coveragePercent: data.coverage.percent,
    daysToExam: data.daysToExam,
    examDate: data.examDate,
    consolidationDays: data.consolidationDays,
    targetHit,
    bonusCount,
    coverage: {
      seenCards: data.coverage.seenCards,
      totalCards: data.coverage.totalCards,
      seenQuestions: data.coverage.seenQuestions,
      totalQuestions: data.coverage.totalQuestions,
    },
    projection: data.projection,
    recentHistory: data.recentHistory ?? null,
    perRotation: data.perRotation ?? null,
    loading,
    incrementReviewed,
  };
}
