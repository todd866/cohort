import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * The last `todayReviewed` the server gave for this rotation set, today.
 *
 * The pill renders the session delta whenever the server figure is
 * unavailable — a fresh mount before the fetch returns, or a fetch that fails
 * its retries — and a scoped→unscoped drop is a remount. A learner saw "0
 * reviewed" after a full day of reviews and read it as a reset. A bare zero
 * is never the right thing to show someone who has reviewed today; the last
 * figure the server gave is.
 *
 * Keyed by the local calendar date because this is a display fallback, not
 * the study-day accounting (which is the server's, in the learner's tz). It
 * is per-tab sessionStorage: it never reaches another device or another
 * learner, and every access is guarded because storage can be absent or throw
 * (private windows, blocked site data, SSR).
 */
const TODAY_CACHE_PREFIX = 'md3:daily-target:today:';
function todayCacheKey(rotationsKey: string): string {
  return `${TODAY_CACHE_PREFIX}${new Date().toDateString()}:${rotationsKey}`;
}
function readCachedToday(rotationsKey: string): number | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(todayCacheKey(rotationsKey));
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
function writeCachedToday(rotationsKey: string, todayReviewed: number): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(todayCacheKey(rotationsKey), String(todayReviewed));
  } catch {
    // Losing the fallback is a degraded pill, not an error.
  }
}
import type { TrackProjection } from '@/lib/study/track-projection';
import {
  fetchWithDeadline,
  REVIEW_CONTEXT_FETCH_DEADLINE_MS,
  CLIENT_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

import type { BookedExam } from '@/lib/study/booked-exam';
import type { ProgressPoolBands } from '@/lib/study/progress-pool';

export interface RotationProgressBreakdown {
  rotation: string;
  dailyTarget: number | null;
  newPerDay: number | null;
  firstSightTarget?: number | null;
  todayFirstSight?: number;
  reviewsPerDay?: number | null;
  consolidationDays?: number | null;
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
    /** Topics met / topics with live cards; absent on responses from an older server. */
    coveredTopics?: number;
    totalTopics?: number;
    itemPercent?: number;
  };
  progressPool?: ProgressPoolBands;
  progressPoolHorizonDays?: number;
  selfPaced?: boolean;
  projection: TrackProjection | null;
}

export interface SessionProgress {
  reviewed: number;
  target: number | null;
  newPerDay: number | null;
  firstSightTarget: number | null;
  todayFirstSight: number;
  reviewsPerDay: number | null;
  progressPool?: ProgressPoolBands;
  progressPoolHorizonDays?: number;
  selfPaced?: boolean;
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
  /** The booked sitting, resolved across every active rotation rather than the
   *  ones in session scope, so the countdown survives focusing a self-paced
   *  deck. Null when nothing is booked. */
  bookedExam: BookedExam | null;
  loading: boolean;
  /** Record one graded item. Pass the item's rotation so the drawer's row for
   *  that rotation can move too; without it only the aggregate does. */
  incrementReviewed: (rotation?: string | null, firstSight?: boolean) => void;
}

interface UseSessionProgressOptions {
  /** Local offline shell: keep an in-memory count without probing the API. */
  disabled?: boolean;
}

interface DailyTargetResponse {
  dailyTarget: number | null;
  newPerDay: number | null;
  firstSightTarget?: number | null;
  todayFirstSight?: number;
  reviewsPerDay: number | null;
  consolidationDays: number | null;
  progressPool?: ProgressPoolBands;
  progressPoolHorizonDays?: number;
  selfPaced?: boolean;
  coverage: RotationProgressBreakdown['coverage'];
  daysToExam: number | null;
  examDate: string | null;
  todayReviewed: number;
  projection: TrackProjection | null;
  recentHistory?: number[];
  /** Only present in multi-rotation responses. */
  perRotation?: RotationProgressBreakdown[];
  bookedExam?: BookedExam | null;
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
  const rotationsKey = (Array.isArray(rotation) ? rotation : [rotation]).join(',');
  const rotations = useMemo(
    () => rotationsKey.split(',').filter(Boolean),
    [rotationsKey],
  );

  const [data, setData] = useState<DailyTargetResponse | null>(null);
  const [sessionDelta, setSessionDelta] = useState(0);
  const [firstSightDelta, setFirstSightDelta] = useState(0);
  // Session grades attributed to the rotation they were graded in.
  //
  // `todayReviewed` in each per-rotation row is a SERVER value fetched once at
  // session start, so the drawer's "Today N / target" line sat frozen for the
  // whole session while the pill above it moved — two counts of the same thing
  // against the same denominator, one live and one not. A learner reported it
  // as "the today cards don't move", reasonably concluding nothing was being
  // recorded; their grades had been recording all along.
  //
  // Counting locally rather than refetching keeps this off the network
  // entirely: the client already knows what it graded and which rotation the
  // item belonged to, so a refetch would be asking the server for something we
  // just told it. See .claude/rules/hot-path-latency.md — the learner must
  // never wait for a number they generated.
  const [deltaByRotation, setDeltaByRotation] = useState<Record<string, number>>({});
  const [firstSightDeltaByRotation, setFirstSightDeltaByRotation] = useState<Record<string, number>>({});
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
          if (typeof resp?.todayReviewed === 'number') writeCachedToday(rotationsKey, resp.todayReviewed);
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

  const incrementReviewed = useCallback((rotation?: string | null, firstSight = false) => {
    if (!rotation || rotation === rotations[0]) {
      setSessionDelta((d) => d + 1);
      if (firstSight) setFirstSightDelta((d) => d + 1);
    }
    if (rotation) {
      setDeltaByRotation((m) => ({ ...m, [rotation]: (m[rotation] ?? 0) + 1 }));
      if (firstSight) {
        setFirstSightDeltaByRotation((m) => ({
          ...m,
          [rotation]: (m[rotation] ?? 0) + 1,
        }));
      }
    }
  }, [rotations]);

  /** Server rows with this session's grades folded in, so every number the
   *  drawer shows moves on the same keystroke the pill does. */
  const withSessionDelta = useCallback(
    (rows: RotationProgressBreakdown[] | null): RotationProgressBreakdown[] | null =>
      rows?.map((row) => {
        const delta = deltaByRotation[row.rotation] ?? 0;
        const noveltyDelta = firstSightDeltaByRotation[row.rotation] ?? 0;
        return delta || noveltyDelta
          ? {
              ...row,
              todayReviewed: row.todayReviewed + delta,
              todayFirstSight: (row.todayFirstSight ?? 0) + noveltyDelta,
            }
          : row;
      }) ?? null,
    [deltaByRotation, firstSightDeltaByRotation],
  );

  // Loading or fetch failed: still show a usable pill — the last figure the
  // server gave today plus this session's grades, never a bare session delta.
  const cachedToday = useMemo(
    () => (disabled ? null : readCachedToday(rotationsKey)),
    [disabled, rotationsKey],
  );
  if (disabled || loading || !data) {
    const base = !disabled && data ? data.todayReviewed : (!disabled ? (cachedToday ?? 0) : 0);
    const reviewed = base + sessionDelta;
    return {
      reviewed,
      target: data?.dailyTarget ?? null,
      newPerDay: data?.newPerDay ?? null,
      firstSightTarget: data?.firstSightTarget ?? null,
      todayFirstSight: (data?.todayFirstSight ?? 0) + firstSightDelta,
      reviewsPerDay: null,
      progressPool: data?.progressPool,
      progressPoolHorizonDays: data?.progressPoolHorizonDays,
      selfPaced: data?.selfPaced,
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
      perRotation: withSessionDelta(data?.perRotation ?? null),
      bookedExam: data?.bookedExam ?? null,
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
    firstSightTarget: data.firstSightTarget ?? null,
    todayFirstSight: (data.todayFirstSight ?? 0) + firstSightDelta,
    reviewsPerDay: data.reviewsPerDay,
    progressPool: data.progressPool,
    progressPoolHorizonDays: data.progressPoolHorizonDays,
    selfPaced: data.selfPaced,
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
    perRotation: withSessionDelta(data.perRotation ?? null),
    bookedExam: data.bookedExam ?? null,
    loading,
    incrementReviewed,
  };
}
