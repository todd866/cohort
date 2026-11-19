import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { queuedReviewRequestIds, subscribeOutbox } from '@/lib/outbox';

/**
 * The last `todayReviewed` the server gave for this rotation set, today.
 *
 * The pill renders the session delta whenever the server figure is
 * unavailable — a fresh mount before the fetch returns, or a fetch that fails
 * its retries — and a scoped→unscoped drop is a remount. "0 reviewed" after a
 * full day of reviews reads as a reset. A bare zero
 * is never the right thing to show someone who has reviewed today; the last
 * figure the server gave is.
 *
 * Keyed by the local calendar date because this is a display fallback, not
 * the study-day accounting (which is the server's, in the learner's tz). It
 * lives in localStorage, the same store the offline shell already uses, so a
 * cold reload still has the last server total. Every access is guarded:
 * storage can be absent or throw (private windows, blocked site data, SSR),
 * and a failure degrades to the plain count with no target.
 */
const TODAY_CACHE_PREFIX = 'md3:daily-target:today:';
const subscribeClientProgress = () => () => {};
const clientProgressReady = () => true;
const serverProgressReady = () => false;
const NO_QUEUED_IDS: readonly string[] = [];
function todayCacheKey(rotationsKey: string): string {
  return `${TODAY_CACHE_PREFIX}${new Date().toDateString()}:${rotationsKey}`;
}

interface CachedDailyProgress {
  /** Last `todayReviewed` a server response reported. Null when none has arrived. */
  todayReviewed: number | null;
  dailyTarget: number | null;
  todayFirstSight: number;
  firstSightTarget: number | null;
  /**
   * Last total the pill showed. A later server snapshot replaces it once the
   * server has caught up; the grade is not added a second time.
   */
  optimisticReviewed: number;
  optimisticFirstSight: number;
  /** Queued grades already included in `optimisticReviewed`. */
  countedRequestIds: string[];
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requestIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

function parseCachedProgress(raw: string): CachedDailyProgress | null {
  if (!raw.startsWith('{')) {
    const todayReviewed = nonNegative(Number(raw));
    if (todayReviewed == null) return null;
    return {
      todayReviewed,
      dailyTarget: null,
      todayFirstSight: 0,
      firstSightTarget: null,
      optimisticReviewed: todayReviewed,
      optimisticFirstSight: 0,
      countedRequestIds: [],
    };
  }
  const parsed = JSON.parse(raw) as Partial<CachedDailyProgress>;
  const todayReviewed = parsed.todayReviewed == null ? null : nonNegative(parsed.todayReviewed);
  const optimisticReviewed = nonNegative(parsed.optimisticReviewed) ?? todayReviewed;
  if (todayReviewed == null && optimisticReviewed == null) return null;
  const todayFirstSight = nonNegative(parsed.todayFirstSight) ?? 0;
  return {
    todayReviewed,
    dailyTarget: finiteOrNull(parsed.dailyTarget),
    todayFirstSight,
    firstSightTarget: finiteOrNull(parsed.firstSightTarget),
    optimisticReviewed: optimisticReviewed ?? 0,
    optimisticFirstSight: nonNegative(parsed.optimisticFirstSight) ?? todayFirstSight,
    countedRequestIds: requestIds(parsed.countedRequestIds),
  };
}

function readStore(store: Storage | undefined, rotationsKey: string): CachedDailyProgress | null {
  try {
    if (!store) return null;
    const raw = store.getItem(todayCacheKey(rotationsKey));
    return raw == null ? null : parseCachedProgress(raw);
  } catch {
    return null;
  }
}

function readCachedProgress(rotationsKey: string): CachedDailyProgress | null {
  const local = readStore(typeof localStorage === 'undefined' ? undefined : localStorage, rotationsKey);
  if (local) return local;
  // A tab that stored the figure before this moved to the offline shell's store.
  return readStore(typeof sessionStorage === 'undefined' ? undefined : sessionStorage, rotationsKey);
}

function writeCachedProgress(rotationsKey: string, progress: CachedDailyProgress): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(todayCacheKey(rotationsKey), JSON.stringify(progress));
  } catch {
    // Losing the fallback is a degraded pill, not an error. The caller then
    // shows the plain count with no target.
  }
}

/** Grades the remembered total does not already include. */
export function pendingGradeDelta(
  sessionDelta: number,
  queuedIds: readonly string[],
  countedIds: readonly string[],
): number {
  const counted = new Set(countedIds);
  const unseen = queuedIds.filter((id) => !counted.has(id)).length;
  return Math.max(sessionDelta, unseen);
}

/**
 * Server snapshot, plus grades the snapshot does not already contain.
 * `carried` is the total shown on a previous mount. Once `server` catches
 * up with it, the grade is not added again.
 */
export function shownDailyCount(server: number | null, carried: number | null, delta: number): number {
  const base = server ?? carried ?? 0;
  const local = (carried ?? base) + delta;
  return Math.max(base, local);
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
  // The first hydration render must match SSR, which has no browser cache or
  // outbox. Ordinary client remounts can still use cached progress immediately.
  const clientReady = useSyncExternalStore(subscribeClientProgress, clientProgressReady, serverProgressReady);
  const rotationsKey = (Array.isArray(rotation) ? rotation : [rotation]).join(',');
  const rotations = useMemo(
    () => rotationsKey.split(',').filter(Boolean),
    [rotationsKey],
  );

  const [data, setData] = useState<DailyTargetResponse | null>(null);
  const [sessionDelta, setSessionDelta] = useState(0);
  const [firstSightDelta, setFirstSightDelta] = useState(0);
  const sessionDeltaRef = useRef(0);
  const firstSightDeltaRef = useRef(0);
  // Totals captured once per rotation key. Later writes of the optimistic
  // count must not feed back into this mount or a grade is counted twice.
  const carriedKeyRef = useRef<string | null>(null);
  const carriedReviewedRef = useRef<number | null>(null);
  const carriedFirstRef = useRef<number | null>(null);
  const serverTodayRef = useRef<number | null>(null);
  const serverFirstRef = useRef<number | null>(null);
  if (clientReady && carriedKeyRef.current !== rotationsKey) {
    carriedKeyRef.current = rotationsKey;
    const cached = readCachedProgress(rotationsKey);
    carriedReviewedRef.current = cached?.optimisticReviewed ?? null;
    carriedFirstRef.current = cached?.optimisticFirstSight ?? null;
  }
  // Session grades attributed to the rotation they were graded in.
  //
  // `todayReviewed` in each per-rotation row is a SERVER value fetched once at
  // session start, so the drawer's "Today N / target" line sat frozen for the
  // whole session while the pill above it moved — two counts of the same thing
  // against the same denominator, one live and one not. A frozen count reads
  // as grades not being recorded, when they had been recording all along.
  //
  // Counting locally rather than refetching keeps this off the network
  // entirely: the client already knows what it graded and which rotation the
  // item belonged to, so a refetch would be asking the server for something we
  // just told it. See .claude/rules/hot-path-latency.md — the learner must
  // never wait for a number they generated.
  const [deltaByRotation, setDeltaByRotation] = useState<Record<string, number>>({});
  const [firstSightDeltaByRotation, setFirstSightDeltaByRotation] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [, setQueueVersion] = useState(0);
  const queueGenerationRef = useRef(0);
  useEffect(() => subscribeOutbox(() => {
    // Capture changes synchronously, including enqueue→ack inside one render.
    queueGenerationRef.current += 1;
    setQueueVersion((version) => version + 1);
  }), []);
  const queuedIds = clientReady ? queuedReviewRequestIds() : NO_QUEUED_IDS;

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
    // of the session: the pill lost its denominator ("N reviewed" instead of
    // "N/target") and the drawer, gated on perRotation, could never open — so
    // tapping it did nothing. Nothing re-ran the effect except a rotation
    // change, so it stayed broken until reload.
    const run = () => {
      const queuedAtRequestStart = queuedReviewRequestIds();
      const queueGenerationAtRequestStart = queueGenerationRef.current;
      fetchWithDeadline(url, {}, sessionProgressRetryDeadlineMs(attempt))
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
          return res.json();
        })
        .then((resp: DailyTargetResponse) => {
          if (cancelled) return;
          if (typeof resp?.todayReviewed === 'number') {
            const previous = readCachedProgress(rotationsKey);
            const todayReviewed = resp.todayReviewed;
            const todayFirstSight = nonNegative(resp.todayFirstSight) ?? 0;
            // A quiet request can heal an inflated saved total. An empty queue
            // only at response time is insufficient: this snapshot may have
            // been computed before a queued grade was acknowledged in flight.
            const settled = queuedAtRequestStart.length === 0
              && queueGenerationAtRequestStart === queueGenerationRef.current
              && queuedReviewRequestIds().length === 0
              && sessionDeltaRef.current === 0 && firstSightDeltaRef.current === 0;
            if (settled) {
              carriedReviewedRef.current = todayReviewed;
              carriedFirstRef.current = todayFirstSight;
            }
            writeCachedProgress(rotationsKey, {
              todayReviewed,
              dailyTarget: finiteOrNull(resp.dailyTarget),
              todayFirstSight,
              firstSightTarget: finiteOrNull(resp.firstSightTarget),
              // Otherwise keep a higher local total: an answer still in the
              // outbox is not in the snapshot yet. A snapshot that has caught
              // up replaces it, so the grade is not added on top.
              optimisticReviewed: settled ? todayReviewed : Math.max(previous?.optimisticReviewed ?? todayReviewed, todayReviewed),
              optimisticFirstSight: settled ? todayFirstSight : Math.max(previous?.optimisticFirstSight ?? todayFirstSight, todayFirstSight),
              countedRequestIds: previous?.countedRequestIds ?? [],
            });
          }
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
      sessionDeltaRef.current += 1;
      setSessionDelta(sessionDeltaRef.current);
      if (firstSight) {
        firstSightDeltaRef.current += 1;
        setFirstSightDelta(firstSightDeltaRef.current);
      }
      const cached = readCachedProgress(rotationsKey);
      const serverToday = serverTodayRef.current ?? cached?.todayReviewed ?? null;
      const serverFirst = serverFirstRef.current ?? cached?.todayFirstSight ?? null;
      const queuedIds = queuedReviewRequestIds();
      // Persist even when no server snapshot exists yet, so a cold reload
      // still shows the grades. Ids already in the outbox are marked counted
      // so the next mount does not add them on top of this total.
      writeCachedProgress(rotationsKey, {
        todayReviewed: serverToday,
        dailyTarget: cached?.dailyTarget ?? null,
        todayFirstSight: serverFirst ?? cached?.todayFirstSight ?? 0,
        firstSightTarget: cached?.firstSightTarget ?? null,
        optimisticReviewed: shownDailyCount(serverToday, carriedReviewedRef.current, sessionDeltaRef.current),
        optimisticFirstSight: shownDailyCount(
          serverFirst,
          carriedFirstRef.current,
          firstSightDeltaRef.current,
        ),
        countedRequestIds: [...new Set([...(cached?.countedRequestIds ?? []), ...queuedIds])],
      });
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
  }, [rotations, rotationsKey]);

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

  // Last server snapshot for this rotation set. Read on mount; later optimistic
  // writes stay in the carried refs so they are not added twice. Counted
  // queue ids are read on each render so a grade recorded after mount is not
  // added on top of the total that already includes it.
  const cachedProgress = useMemo(
    () => clientReady ? readCachedProgress(rotationsKey) : null,
    [rotationsKey, clientReady],
  );
  const countedRequestIds = clientReady ? readCachedProgress(rotationsKey)?.countedRequestIds ?? [] : [];
  serverTodayRef.current = data?.todayReviewed ?? cachedProgress?.todayReviewed ?? null;
  serverFirstRef.current = data?.todayFirstSight ?? cachedProgress?.todayFirstSight ?? null;
  const reviewed = shownDailyCount(
    serverTodayRef.current,
    carriedReviewedRef.current,
    pendingGradeDelta(sessionDelta, queuedIds, countedRequestIds),
  );
  const todayFirstSight = shownDailyCount(
    data ? (data.todayFirstSight ?? 0) : (cachedProgress?.todayFirstSight ?? null),
    carriedFirstRef.current,
    firstSightDelta,
  );
  const target = data ? (data.dailyTarget ?? null) : (cachedProgress?.dailyTarget ?? null);
  const firstSightTarget = data ? (data.firstSightTarget ?? null) : (cachedProgress?.firstSightTarget ?? null);

  useEffect(() => {
    if (queuedIds.length === 0) return;
    const cached = readCachedProgress(rotationsKey);
    const counted = new Set(cached?.countedRequestIds ?? []);
    if (queuedIds.every((id) => counted.has(id))) return;
    const serverToday = serverTodayRef.current ?? cached?.todayReviewed ?? null;
    writeCachedProgress(rotationsKey, {
      todayReviewed: serverToday,
      dailyTarget: cached?.dailyTarget ?? null,
      todayFirstSight: serverFirstRef.current ?? cached?.todayFirstSight ?? 0,
      firstSightTarget: cached?.firstSightTarget ?? null,
      // The same figure the pill renders: the total carried in at mount plus
      // this mount's grades. The saved total already includes those grades
      // (incrementReviewed writes it), so building on it counted them twice
      // whenever an entry that is not a grade, such as a question's confidence
      // rating, reached the outbox (pill 204 against a server 141, 17 Nov 2026).
      optimisticReviewed: shownDailyCount(
        serverToday,
        carriedReviewedRef.current,
        pendingGradeDelta(sessionDeltaRef.current, queuedIds, cached?.countedRequestIds ?? []),
      ),
      optimisticFirstSight: cached?.optimisticFirstSight ?? carriedFirstRef.current ?? 0,
      countedRequestIds: [...new Set([...counted, ...queuedIds])],
    });
  }, [queuedIds, rotationsKey]);

  if (disabled || loading || !data) {
    return {
      reviewed,
      target,
      newPerDay: data?.newPerDay ?? null,
      firstSightTarget,
      todayFirstSight,
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


  const progress = target != null && target > 0
    ? Math.min(100, Math.round((reviewed / target) * 100))
    : null;

  const targetHit = target != null && reviewed >= target;
  const bonusCount = targetHit ? reviewed - target! : 0;

  return {
    reviewed,
    target,
    newPerDay: data.newPerDay,
    firstSightTarget,
    todayFirstSight,
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
