import { useState, useEffect, useCallback, useRef } from 'react';
import { isRectObscured, FOOTER_SAFE_PX, TOP_SAFE_PX, resetScrollToTop } from './reveal-scroll';
import { useActiveModules } from '@/hooks/useActiveModules';
import { flushReviewQueue, getQueueSize } from '@/lib/review-queue';
import {
  addToPack,
  consumePackItem,
  readPack,
  restorePackItem,
} from '@/lib/offline/pack';
import {
  filterOfflineTombstones,
  offlineTombstoneExclusions,
  readOfflineReviewProgress,
  readOfflineReviewStats,
  retireOfflineTombstones,
  writeOfflineReviewStats,
} from '@/lib/offline/progress';
import {
  isOfflineOwnerCurrent,
  readOfflineOwner,
  subscribeOfflineOwner,
  type OwnerLease,
} from '@/lib/offline/owner';
import type { ReviewItem, ReviewStats } from './types';
import { buildUnifiedSessionParams } from './unified-session-params';
import type { ReviewFilter } from '@/lib/review/review-intent';
import { reviewSessionScopeKey } from '@/lib/review/session-scope';

export interface FetchSlot {
  rotation: string;
  size: number;
  mode?: 'rereview';
  difficulty?: 'easy' | 'medium' | 'hard';
  blendTier: 'primary' | 'rereview' | 'cross-rotation';
}

interface UseReviewSessionOptions {
  rotations: string[];
  week?: number;
  /** Optional per-rotation batch sizes (overrides equal split). */
  rotationSizes?: Record<string, number>;
  /** Flexible fetch slots (overrides rotations + rotationSizes when provided). */
  fetchSlots?: FetchSlot[];
  /** 'new-only' filters server response to never-seen items. Default 'mixed'. */
  feedMode?: 'mixed' | 'new-only';
  /** Typed filter carried by review deep links. */
  reviewFilter?: ReviewFilter;
  /** When set, the session is focused on this single rotation. */
  focusRotation?: string | null;
  /**
   * Account key for the on-device offline pack. Omit (or pass null) and the
   * session neither writes nor reads a pack — the safe default for a guest.
   */
  userKey?: string | null;
  /**
   * Set only by the offline fallback page, which is rendering because the
   * service worker substituted it for a navigation the network could not
   * complete. That is proof of a dead connection in a way `navigator.onLine` is
   * not — it reports `true` on hospital wifi that associates but does not route.
   */
  allowUnverifiedPack?: boolean;
  /**
   * Authenticated server-delivered first batch. Its owner and semantic scope
   * must exactly match this hook invocation; it is adopted once and suppresses
   * the otherwise-duplicate mount fetch.
   */
  initialBatch?: InitialReviewBatch | null;
}

export interface InitialReviewBatch {
  ownerKey: string;
  scopeKey: string;
  items: ReviewItem[];
  newRemaining: { cards: number; questions: number } | null;
}

/** Round-robin interleave items from multiple arrays */
function interleave<T>(arrays: T[][]): T[] {
  const result: T[] = [];
  const maxLen = Math.max(0, ...arrays.map(a => a.length));
  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrays) {
      if (i < arr.length) result.push(arr[i]);
    }
  }
  return result;
}

function reviewItemKey(item: ReviewItem): string {
  return `${item.type}:${item.id}`;
}

function dedupeReviewItems(items: ReviewItem[], existingKeys?: Set<string>): ReviewItem[] {
  const seen = new Set(existingKeys);
  const result: ReviewItem[] = [];
  for (const item of items) {
    const key = reviewItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

const FETCH_TIMEOUT_MS = 35_000;
/** Longest the review feed will wait on the offline-write flush before loading anyway. */
const FLUSH_BUDGET_MS = 2_000;
const RETRY_DELAY_MS = 2_000;

/** Errors that should not be retried (auth failures) */
class NonRetryableError extends Error {}

/** Report client-side fetch failures to server logs (fire-and-forget) */
function reportClientError(url: string, error: string, details: Record<string, unknown>) {
  try {
    navigator.sendBeacon(
      '/api/log/client-error',
      JSON.stringify({ url, error, ...details, ts: Date.now() }),
    );
  } catch {
    // Beacon failed — nothing we can do
  }
}

/**
 * Fetch with a timeout and one automatic retry on transient failure.
 * Session requests are deliberately network-only at the service-worker
 * boundary, so this is the single timeout/retry policy for mobile and PWA use.
 * Does NOT retry 401s (auth errors) or user-initiated aborts.
 */
async function fetchWithRetry(
  url: string,
  userSignal: AbortSignal,
): Promise<{ items?: ReviewItem[]; sessionId?: string | null; batchId?: string | null }> {
  let lastError: Error | undefined;
  let lastStatus: number | undefined;
  const t0 = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    // Combine user abort signal with per-attempt timeout
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([userSignal, timeoutSignal]);

    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        lastStatus = res.status;
        // Try to extract server error detail for user-facing message
        let detail = '';
        try { const body = await res.json(); detail = body?.detail ?? ''; } catch {}
        if (res.status === 401) {
          reportClientError(url, 'session-auth-failure', {
            status: 401,
            detail,
            ua: navigator.userAgent,
          });
          throw new NonRetryableError(detail || 'Sign in to review');
        }
        throw new Error(detail ? `${detail}` : `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      // User navigated away or auth error — bubble immediately, no retry
      if (userSignal.aborted || err instanceof NonRetryableError) throw err;

      // Replace raw "signal timed out" DOMException with a human-readable message
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        lastError = new Error('Connection timed out');
      } else {
        lastError = err instanceof Error ? err : new Error('Failed to load');
      }

      // Don't retry after the last attempt
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Check again after delay — user may have navigated away
        if (userSignal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
      }
    }
  }

  // Both attempts failed — report to server logs
  const elapsed = Date.now() - t0;
  reportClientError(url, lastError?.message ?? 'unknown', {
    status: lastStatus,
    elapsed,
    attempts: 2,
    ua: navigator.userAgent,
  });

  throw lastError ?? new Error('Failed to load');
}

export function useReviewSession({ rotations, week, rotationSizes, fetchSlots, feedMode = 'mixed', reviewFilter, focusRotation = null, userKey = null, allowUnverifiedPack = false, initialBatch = null }: UseReviewSessionOptions) {
  const initialBatchMatches =
    initialBatch?.ownerKey === userKey
    && initialBatch.scopeKey === reviewSessionScopeKey({
      rotations,
      week,
      feedMode,
      reviewFilter,
      focusRotation,
    });
  const initialItems = initialBatchMatches ? initialBatch.items : [];
  const [items, setItems] = useState<ReviewItem[]>(initialItems);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(!initialBatchMatches);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStatsState] = useState<ReviewStats>({ total: 0, correct: 0 });
  const [startTime, setStartTime] = useState<number>(Date.now());
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isExhausted, setIsExhausted] = useState(false);
  const [newRemaining, setNewRemaining] = useState<{ cards: number; questions: number } | null>(
    initialBatchMatches ? initialBatch.newRemaining : null,
  );
  /** True when the items on screen came from the on-device pack, not the server. */
  const [servingOffline, setServingOffline] = useState(false);
  const [ownerRevision, setOwnerRevision] = useState(0);
  const requestedRotationsKey = rotations.join(',');
  const requestScopeKey = reviewSessionScopeKey({
    rotations,
    week,
    feedMode,
    reviewFilter,
    focusRotation,
  });
  // Updated during render, before the scope-change effect starts its replacement
  // request. A late response must prove that it still belongs to this render.
  const activeRequestScopeKeyRef = useRef(requestScopeKey);
  activeRequestScopeKeyRef.current = requestScopeKey;
  const requestGenerationRef = useRef(0);

  const { activeModules } = useActiveModules();

  // The pack is bound to an account so a shared device cannot serve one user's
  // cards to the next. The key is passed in rather than read from useSession
  // here: the caller already holds the session, and reaching for the context
  // inside this hook would make it unusable without a SessionProvider. Held in
  // a ref because fetchItems is memoised on the feed inputs, and re-creating it
  // when the session resolves would abort in-flight batches.
  const userKeyRef = useRef<string | null>(null);
  userKeyRef.current = userKey ?? null;
  // Mirror of servingOffline for the memoised fetch callback, which would
  // otherwise close over a stale value.
  const servingOfflineRef = useRef(false);
  const allowUnverifiedPackRef = useRef(false);
  allowUnverifiedPackRef.current = allowUnverifiedPack;

  const reviewTopRef = useRef<HTMLDivElement | null>(null);
  const fetchingMoreRef = useRef(false);
  const itemsRef = useRef<ReviewItem[]>(initialItems);
  /** Scope under which the held items were fetched. A prop/URL scope change
   * hides them synchronously, before the outbox flush starts the next request. */
  const itemsScopeKeyRef = useRef(requestScopeKey);
  /** Owner whose personalized rows are currently held in `items`. */
  const itemsOwnerRef = useRef<string | null | undefined>(
    initialBatchMatches ? initialBatch.ownerKey : undefined,
  );
  // IDs of items trimmed from the front of the array (already reviewed).
  // Used to build the server exclusion list so prefetch doesn't re-serve them.
  const reviewedCardIdsRef = useRef<Set<string>>(new Set());
  const reviewedQuestionIdsRef = useRef<Set<string>>(new Set());
  // Track the last suppressed item so z-to-go-back can undo it
  const lastSuppressedRef = useRef<{ id: string; type: 'card' | 'question' } | null>(null);
  // Track what rotation/week we've loaded to avoid re-fetching when only
  // activeModules ref changes (e.g., server sync returns same values).
  const loadedKeyRef = useRef<string | null>(null);
  const initialBatchRef = useRef(initialBatchMatches ? initialBatch : null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const observedOwnerChangeRef = useRef(false);

  useEffect(() => subscribeOfflineOwner(() => {
    const nextOwner = readOfflineOwner();
    if (
      nextOwner
      && !nextOwner.verified
      && itemsOwnerRef.current == null
    ) {
      // The first anonymous write establishes a device-guest partition. The
      // feed already belongs to `null` (the signed-out visitor), so this is not
      // an account switch and must not discard the card mid-grade.
      return;
    }

    // Account changes must evict data already held in React state. Clearing
    // localStorage alone leaves the old card visible until an unrelated render.
    abortControllerRef.current?.abort();
    loadedKeyRef.current = null;
    itemsOwnerRef.current = undefined;
    itemsRef.current = [];
    setItems([]);
    setCurrentIndex(0);
    setStatsState({ total: 0, correct: 0 });
    setServingOffline(false);
    servingOfflineRef.current = false;
    setLoading(true);
    observedOwnerChangeRef.current = true;
    setOwnerRevision((revision) => revision + 1);
  }), []);

  // Auto-scroll on EVERY pointer type. This used to require
  // `(pointer: coarse)`, so the post-answer scroll to the context/figure never
  // fired on desktop — where most reviewing happens (the reference learner, 2026-07-09). Motion
  // preference is honoured via `scrollBehavior()`, not by skipping the scroll.
  const shouldAutoScroll = useCallback(() => typeof window !== 'undefined', []);

  const scrollBehavior = useCallback((): ScrollBehavior => {
    if (typeof window === 'undefined') return 'auto';
    if (typeof window.matchMedia !== 'function') return 'auto';
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }, []);

  const isOffscreen = useCallback((element: HTMLElement, marginPx = TOP_SAFE_PX) => {
    if (typeof window === 'undefined') return false;
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    // Bottom margin is the fixed grading/confidence footer, not `marginPx` —
    // otherwise content behind the footer counts as visible. See reveal-scroll.ts.
    return isRectObscured(rect, viewportHeight, marginPx, FOOTER_SAFE_PX);
  }, []);

  const scrollReviewToTop = useCallback(() => {
    if (!shouldAutoScroll()) return;
    // INSTANT, not scrollBehavior() (which is 'smooth'): advanceToNext() calls
    // this synchronously and then swaps the card, so a scheduled smooth scroll
    // is superseded by the reflow and never lands on mobile — the next card
    // stays scrolled down (the reference learner, 2026-07-22). See resetScrollToTop.
    resetScrollToTop(reviewTopRef.current);
  }, [shouldAutoScroll]);

  // Callbacks registered by other hooks to reset their per-item state
  const resetCallbacksRef = useRef<Array<() => void>>([]);

  const registerResetCallback = useCallback((cb: () => void) => {
    resetCallbacksRef.current.push(cb);
    return () => {
      resetCallbacksRef.current = resetCallbacksRef.current.filter(fn => fn !== cb);
    };
  }, []);

  const resetItemState = useCallback(() => {
    for (const cb of resetCallbacksRef.current) cb();
    setStartTime(Date.now());
  }, []);

  /**
   * React's session counter is also the user-visible offline progress pill.
   * Persist updates whenever a local write is pending (or the pack is already
   * the serving source) so a cold relaunch resumes at N rather than zero.
   */
  const setStats = useCallback<React.Dispatch<React.SetStateAction<ReviewStats>>>(
    (nextState) => {
      setStatsState((previous) => {
        const next =
          typeof nextState === 'function' ? nextState(previous) : nextState;
        const ownerKey =
          typeof itemsOwnerRef.current === 'string'
            ? itemsOwnerRef.current
            : readOfflineOwner()?.ownerKey ?? null;
        const hasPendingContinuity = ownerKey
          ? (
              servingOfflineRef.current
              || getQueueSize('review', ownerKey) > 0
              || (readOfflineReviewProgress(ownerKey)?.tombstones.length ?? 0) > 0
            )
          : false;
        if (ownerKey && hasPendingContinuity) {
          writeOfflineReviewStats(ownerKey, requestScopeKey, next);
        }
        return next;
      });
    },
    [requestScopeKey],
  );

  /**
   * Last resort when the session request fails: serve the on-device pack.
   *
   * The unverified read is allowed ONLY while the browser reports itself
   * offline. A failed request with a live connection is far more likely to be a
   * 401 from a signed-out session, and serving the previous account's cards
   * there would be a real leak — so that path insists on a matching user key.
   */
  const servePackFallback = useCallback((): boolean => {
    // The pack does not carry enough scheduler state to prove due/at-risk/new.
    // Serving arbitrary cached cards under a typed filter would silently widen
    // the user's requested scope, so filtered sessions fail closed offline.
    if (reviewFilter) return false;

    const isOffline =
      allowUnverifiedPackRef.current ||
      (typeof navigator !== 'undefined' && navigator.onLine === false);
    const storedOwnerKey = readOfflineOwner()?.ownerKey ?? null;
    const sessionUserKey = userKeyRef.current;
    if (
      sessionUserKey
      && storedOwnerKey
      && sessionUserKey !== storedOwnerKey
      && (
        allowUnverifiedPackRef.current
        || observedOwnerChangeRef.current
      )
    ) {
      return false;
    }
    const userKey = allowUnverifiedPackRef.current
      ? storedOwnerKey
      : sessionUserKey ?? (isOffline ? storedOwnerKey : null);
    if (!userKey) return false;

    const pack = readPack(userKey);
    const requestedRotations = new Set(requestedRotationsKey.split(',').filter(Boolean));
    const packItems = ((pack?.items ?? []) as ReviewItem[]).filter((item) => {
      // Rotation/week are serving boundaries. Legacy rows without enough
      // metadata cannot prove membership and must fail closed.
      if (!item.rotation || !requestedRotations.has(item.rotation)) return false;
      if (week !== undefined && item.week !== week) return false;
      return true;
    });
    if (!pack || packItems.length === 0) return false;

    const deduped = dedupeReviewItems(packItems);
    itemsScopeKeyRef.current = requestScopeKey;
    itemsOwnerRef.current = pack.userKey;
    setItems(deduped);
    itemsRef.current = deduped;
    setCurrentIndex(0);
    reviewedCardIdsRef.current.clear();
    reviewedQuestionIdsRef.current.clear();
    resetItemState();
    setStatsState(
      readOfflineReviewStats(pack.userKey, requestScopeKey)
        ?? { total: 0, correct: 0 },
    );
    setIsExhausted(false);
    setError(null);
    setServingOffline(true);
    servingOfflineRef.current = true;
    return true;
  }, [requestScopeKey, resetItemState, requestedRotationsKey, reviewFilter, week]);

  const fetchItems = useCallback(async (append = false) => {
    if (!append && itemsScopeKeyRef.current !== requestScopeKey) {
      // The URL/focus changed while the outbox flush was pending. Retire the
      // previous scope before any new network work so an MND card, for example,
      // cannot remain gradeable after the user switches back to All.
      itemsScopeKeyRef.current = requestScopeKey;
      itemsRef.current = [];
      setItems([]);
      setCurrentIndex(0);
      setLoading(true);
    }

    // The service-worker fallback has already proved that this is a local-only
    // session. Do not stack a doomed RSC/API request (or its retry delay) in
    // front of the pack, and do not attempt online prefetch as it runs low.
    if (allowUnverifiedPackRef.current) {
      if (append) {
        setIsExhausted(true);
      } else {
        setLoading(true);
        servePackFallback();
        setLoading(false);
      }
      return;
    }

    if (fetchingMoreRef.current && append) return;
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const requestIsCurrent = () =>
      requestGenerationRef.current === requestGeneration
      && activeRequestScopeKeyRef.current === requestScopeKey;

    if (append) {
      fetchingMoreRef.current = true;
      setIsFetchingMore(true);
    }
    if (!append) setLoading(true);
    setError(null);

    let aborted = false;
    try {
      // Abort any in-flight request before starting a new one
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const requestUserKey = userKeyRef.current;
      const owner = readOfflineOwner();
      const requestOwnerLease: OwnerLease | null =
        requestUserKey && owner?.ownerKey === requestUserKey
          ? { ownerKey: owner.ownerKey, generation: owner.generation }
          : null;
      const requestProgressRevision = requestUserKey
        ? readOfflineReviewProgress(requestUserKey)?.revision ?? null
        : null;
      const requestBeganWithPendingReviews = requestUserKey
        ? getQueueSize('review', requestUserKey) > 0
        : false;

      // Build exclusion params (shared across all fetches). Durable tombstones
      // apply to the first reconnect batch too, not just appended pages.
      const durableExclusions = requestUserKey
        ? offlineTombstoneExclusions(requestUserKey)
        : { cards: [], questions: [] };
      const requestTombstoneKeys = new Set(
        requestUserKey
          ? (
              readOfflineReviewProgress(requestUserKey)?.tombstones
                .map((tombstone) => tombstone.key) ?? []
            )
          : [],
      );
      let excludeCardParams = durableExclusions.cards.join(',');
      let excludeQuestionParams = durableExclusions.questions.join(',');
      if (append) {
        const cardIds = [
          ...durableExclusions.cards,
          ...itemsRef.current.filter(i => i.type === 'card').map(i => i.id),
          ...reviewedCardIdsRef.current,
        ];
        const qIds = [
          ...durableExclusions.questions,
          ...itemsRef.current.filter(i => i.type === 'question').map(i => i.id),
          ...reviewedQuestionIdsRef.current,
        ];
        if (cardIds.length > 0) excludeCardParams = cardIds.join(',');
        if (qIds.length > 0) excludeQuestionParams = qIds.join(',');
      }

      // Use fetchSlots if provided, otherwise fall back to rotations-based fetch
      const slots: FetchSlot[] = fetchSlots ?? rotations.map(r => ({
        rotation: r,
        size: rotationSizes?.[r] ?? Math.ceil(15 / rotations.length),
        blendTier: 'primary' as const,
      }));

      const fetchOne = (slot: FetchSlot) => {
        if (slot.size <= 0) return Promise.resolve({ items: [], blendTier: slot.blendTier, sessionId: null as string | null, batchId: null as string | null, newRemaining: null as { cards: number; questions: number } | null });
        const params = buildUnifiedSessionParams(slot, {
          week,
          activeModules,
          feedMode,
          reviewFilter,
          focusRotation,
          excludeCards: excludeCardParams || undefined,
          excludeQuestions: excludeQuestionParams || undefined,
        });
        const url = `/api/study/unified-session?${params}`;

        // This is deliberately the only request path. A former <head> preload
        // hit this side-effecting endpoint before React knew whether it would
        // adopt the batch, creating phantom deliveries in scheduler history.
        return fetchWithRetry(url, controller.signal)
          .then((res) => {
            const batch = res as { items?: ReviewItem[]; sessionId?: string | null; batchId?: string | null; newRemaining?: { cards: number; questions: number } | null };
            return {
              items: batch.items,
              blendTier: slot.blendTier,
              sessionId: batch.sessionId ?? null,
              batchId: batch.batchId ?? null,
              newRemaining: batch.newRemaining ?? null,
            };
          });
      };

      type FetchResult = Awaited<ReturnType<typeof fetchOne>>;

      const settledResults = await Promise.allSettled(slots.map(fetchOne));
      if (!requestIsCurrent()) {
        throw new DOMException('The review scope changed.', 'AbortError');
      }
      // A response is owned by the account that initiated it. A later account
      // may have replaced the hook props while the old request was in flight;
      // never display or persist that result under the new identity.
      if (userKeyRef.current !== requestUserKey) {
        throw new DOMException('The account changed.', 'AbortError');
      }
      const results: FetchResult[] = settledResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      if (results.length === 0 && settledResults.length > 0) {
        const firstFailure = settledResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        throw firstFailure?.reason ?? new Error('Failed to load');
      }
      // Sum newRemaining across slots; null if no slot returned a count.
      const aggregatedNewRemaining = results.reduce<{ cards: number; questions: number } | null>((acc, r) => {
        if (!r.newRemaining) return acc;
        if (!acc) return { ...r.newRemaining };
        return { cards: acc.cards + r.newRemaining.cards, questions: acc.questions + r.newRemaining.questions };
      }, null);
      setNewRemaining(aggregatedNewRemaining);
      // Tag each item with its blend tier and walk-audit IDs for analytics
      const perSlotItems = results.map(r => {
        const items = r.items || [];
        return items.map((item: ReviewItem) => ({
          ...item,
          blendTier: r.blendTier,
          sessionId: r.sessionId,
          batchId: r.batchId,
        }));
      });
      const interleavedItems = perSlotItems.length > 1
        ? interleave(perSlotItems)
        : (perSlotItems[0] || []);
      // A delayed response can predate queued offline grades. Client-side
      // filtering remains authoritative even when the endpoint ignored or
      // truncated the exclusion query.
      const currentlySafeItems = requestUserKey
        ? filterOfflineTombstones(requestUserKey, interleavedItems)
        : interleavedItems;
      // Keep the request-start snapshot too. A later authoritative pack refresh
      // may retire the durable ledger while this older session request is still
      // in flight; its response must remain filtered against what was pending
      // when it began.
      const newItems = currentlySafeItems.filter(
        (item) => !requestTombstoneKeys.has(reviewItemKey(item)),
      );

      if (append) {
        if (newItems.length === 0) {
          setIsExhausted(true);
        } else {
          setItems(prev => {
            const existingIds = new Set(prev.map(reviewItemKey));
            const deduped = dedupeReviewItems(newItems, existingIds);
            if (deduped.length === 0) {
              setIsExhausted(true);
              return prev;
            }
            const updated = [...prev, ...deduped];
            itemsRef.current = updated;
            return updated;
          });
        }
      } else {
        setIsExhausted(false);
        const deduped = dedupeReviewItems(newItems);
        itemsScopeKeyRef.current = requestScopeKey;
        itemsOwnerRef.current = requestUserKey;
        setItems(deduped);
        itemsRef.current = deduped;
        setCurrentIndex(0);
        reviewedCardIdsRef.current.clear();
        reviewedQuestionIdsRef.current.clear();
        resetItemState();
        setStatsState(
          requestUserKey
            ? (
                readOfflineReviewStats(requestUserKey, requestScopeKey)
                ?? { total: 0, correct: 0 }
              )
            : { total: 0, correct: 0 },
        );
        setServingOffline(false);
        servingOfflineRef.current = false;

        // Keep the batch on the device, MERGED into the reserve rather than
        // replacing it: the bulk fill puts ~500 items there and this batch is
        // ~15, so a replace would quietly shrink a day's worth of offline study
        // down to one session's.
        if (
          requestUserKey
          && requestOwnerLease
          && isOfflineOwnerCurrent(requestOwnerLease)
          && deduped.length > 0
        ) {
          addToPack(requestUserKey, {
            rotations: slots.map(s => s.rotation),
            items: deduped,
          });
        }
      }

      // A queue-empty request that began after replay is an authoritative
      // scheduler refresh. Its batch was filtered and (for initial loads)
      // committed before this point, so the unchanged tombstones can now
      // retire promptly instead of suppressing legitimate later rereviews.
      if (
        requestUserKey
        && requestProgressRevision !== null
        && !requestBeganWithPendingReviews
        && getQueueSize('review', requestUserKey) === 0
        && requestOwnerLease
        && isOfflineOwnerCurrent(requestOwnerLease)
      ) {
        retireOfflineTombstones(requestUserKey, requestProgressRevision);
      }
    } catch (err) {
      if (
        !requestIsCurrent()
        || (err instanceof DOMException && err.name === 'AbortError')
      ) {
        aborted = true;
      } else if (!append && servePackFallback()) {
        // Offline (or the API is down) and we have a pack: study continues.
        // Grades go to the outbox and replay on reconnect, as they already did.
      } else if (append && servingOfflineRef.current) {
        // Working through the pack and it ran out. That is the end of the
        // offline session, not an error worth interrupting the user with.
        setIsExhausted(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load');
      }
    } finally {
      // A superseded request cannot mutate loading/prefetch state owned by its
      // replacement. The current request will settle those fields itself.
      if (requestIsCurrent()) {
        // Don't clear loading on abort — the skeleton should stay visible
        // until a subsequent fetch actually completes with data.
        if (!aborted) setLoading(false);
        fetchingMoreRef.current = false;
        setIsFetchingMore(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetItemState, rotations.join(','), week, activeModules, fetchSlots, feedMode, reviewFilter, focusRotation, requestScopeKey, servePackFallback]);

  // Keep a ref to fetchItems so the mount effect doesn't re-run (and abort)
  // when only activeModules changes (server sync after session resolves).
  const fetchItemsRef = useRef(fetchItems);
  fetchItemsRef.current = fetchItems;

  // Load fresh items on mount/rotation change.
  // Flush any queued offline reviews BEFORE fetching so the server sees
  // up-to-date progress and doesn't re-serve cards the user already reviewed.
  // Reset loadedKey on cleanup so React strict mode double-mount can re-fetch.
  const rotationsKey = requestScopeKey;
  const ownerLoadKey = allowUnverifiedPack
    ? `offline:${readOfflineOwner()?.ownerKey ?? 'none'}:${ownerRevision}`
    : `online:${userKey ?? 'guest'}:${ownerRevision}`;
  useEffect(() => {
    const key = `${rotationsKey}:${week ?? 'all'}:${ownerLoadKey}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;

    const serverBatch = initialBatchRef.current;
    if (
      serverBatch
      && serverBatch.ownerKey === userKey
      && serverBatch.scopeKey === requestScopeKey
    ) {
      // The server request already owns the ServeDecision/exposure writes for
      // these rows. Adopt once and never issue a duplicate initial GET.
      initialBatchRef.current = null;
      setLoading(false);
      if (serverBatch.items.length === 0) setIsExhausted(true);
      return () => {
        abortControllerRef.current?.abort();
      };
    }

    if (allowUnverifiedPack) {
      // Local shell: the pack is the primary source, not an error fallback.
      // This path intentionally does not flush or warm any API.
      const served = servePackFallback();
      setLoading(false);
      if (!served) setIsExhausted(true);
      return () => {
        loadedKeyRef.current = null;
      };
    }

    const storedOwnerKey = readOfflineOwner()?.ownerKey ?? null;
    if (
      observedOwnerChangeRef.current
      && userKey
      && storedOwnerKey
      && userKey !== storedOwnerKey
    ) {
      // The owner record changed before next-auth propagated the new session
      // into this tree. Hold the empty state instead of starting one last
      // request for the stale account.
      setLoading(true);
      return () => {
        loadedKeyRef.current = null;
      };
    }

    // Flush queued reviews first so the server sees up-to-date progress — but
    // never let that gate the feed. `loading` starts true, so if the flush
    // stalls (offline queue replayed on a flaky mobile radio) the user stares
    // at "Preparing review…" forever. Cap the wait; the flush finishes in the
    // background and the worst case is one re-served card, which the exclusion
    // list already handles.
    let fetched = false;
    const startFetch = () => {
      if (fetched) return;
      fetched = true;
      fetchItemsRef.current(false);
    };
    const flushBudget = window.setTimeout(startFetch, FLUSH_BUDGET_MS);
    flushReviewQueue(userKey)
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(flushBudget);
        startFetch();
      });

    // Warm up the record function in parallel so the first answer doesn't
    // hit a cold start
    fetch('/api/study/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"warmup"}',
    }).catch(() => {});

    return () => {
      window.clearTimeout(flushBudget);
      abortControllerRef.current?.abort();
      loadedKeyRef.current = null;
    };
  }, [allowUnverifiedPack, ownerLoadKey, requestScopeKey, rotationsKey, servePackFallback, userKey, week]);

  // Prefetch more when running low
  useEffect(() => {
    if (items.length - currentIndex <= 3 && !fetchingMoreRef.current && items.length > 0) {
      if (allowUnverifiedPack || servingOfflineRef.current) {
        setIsExhausted(true);
        return;
      }
      fetchItems(true);
    }
  }, [allowUnverifiedPack, currentIndex, items.length, fetchItems]);

  // Keep 1 reviewed item behind current for z-to-undo; trim the rest.
  const UNDO_BUFFER = 1;

  const advanceToNext = useCallback(() => {
    scrollReviewToTop();

    const advancedItem = itemsRef.current[currentIndex];
    const displayedOwner = itemsOwnerRef.current;
    if (advancedItem && typeof displayedOwner === 'string') {
      consumePackItem(displayedOwner, advancedItem, {
        // Ordinary online suppress/continue should not hide a card for seven
        // days. Protect only an offline or queued grade until the server has
        // acknowledged it and a fresh scheduler response has been adopted.
        tombstone:
          allowUnverifiedPackRef.current
          || servingOfflineRef.current
          || getQueueSize('review', displayedOwner) > 0,
      });
    }

    // Optimistically decrement newRemaining for the item we just advanced past.
    // Authoritative count comes back on the next batch fetch; this just keeps the
    // counter feeling responsive between fetches in new-only mode.
    if (feedMode === 'new-only') {
      if (advancedItem) {
        setNewRemaining((prev) => {
          if (!prev) return prev;
          if (advancedItem.type === 'card') {
            return { ...prev, cards: Math.max(0, prev.cards - 1) };
          }
          if (advancedItem.type === 'question') {
            return { ...prev, questions: Math.max(0, prev.questions - 1) };
          }
          return prev;
        });
      }
    }

    const nextIndex = currentIndex + 1;
    const trimCount = Math.max(0, nextIndex - UNDO_BUFFER);

    if (trimCount > 0) {
      // Record trimmed items so prefetch still excludes them
      for (let i = 0; i < trimCount; i++) {
        const item = itemsRef.current[i];
        if (!item) continue;
        if (item.type === 'card') reviewedCardIdsRef.current.add(item.id);
        if (item.type === 'question') reviewedQuestionIdsRef.current.add(item.id);
      }
      const trimmed = itemsRef.current.slice(trimCount);
      setItems(trimmed);
      itemsRef.current = trimmed;
      setCurrentIndex(nextIndex - trimCount);
    } else {
      setCurrentIndex(nextIndex);
    }

    resetItemState();
  }, [currentIndex, resetItemState, scrollReviewToTop, feedMode]);

  /** Called by CardFeedback when a suppress is confirmed, before advanceToNext */
  const markSuppressed = useCallback((id: string, type: 'card' | 'question') => {
    lastSuppressedRef.current = { id, type };
  }, []);

  const handleGoBack = useCallback(() => {
    if (currentIndex > 0) {
      scrollReviewToTop();

      // Check if we're going back to the item that was just suppressed
      const suppressed = lastSuppressedRef.current;
      const prevItem = items[currentIndex - 1];
      if (suppressed && prevItem && prevItem.id === suppressed.id) {
        lastSuppressedRef.current = null;
        const displayedOwner = itemsOwnerRef.current;
        if (typeof displayedOwner === 'string') {
          restorePackItem(displayedOwner, prevItem);
        }
        fetch('/api/cards/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: suppressed.type === 'question' ? 'question' : 'card',
            cardId: suppressed.id,
            action: 'unsuppress',
          }),
        }).catch(() => {});
      }

      setCurrentIndex(prev => prev - 1);
      resetItemState();
    }
  }, [currentIndex, items, resetItemState, scrollReviewToTop]);

  const expectedDisplayOwner =
    allowUnverifiedPack || servingOffline
      ? userKey ?? readOfflineOwner()?.ownerKey ?? null
      : userKey ?? null;
  const displayOwnerMatches =
    itemsOwnerRef.current === undefined ||
    itemsOwnerRef.current === expectedDisplayOwner;
  const displayScopeMatches = itemsScopeKeyRef.current === requestScopeKey;
  const visibleItems = displayOwnerMatches && displayScopeMatches ? items : [];
  const currentItem = displayOwnerMatches && displayScopeMatches
    ? (items[currentIndex] as ReviewItem | undefined)
    : undefined;

  return {
    items: visibleItems,
    currentItem,
    currentIndex,
    loading: loading || !displayOwnerMatches || !displayScopeMatches,
    error,
    stats,
    setStats,
    startTime,
    isExhausted,
    isFetchingMore,
    reviewTopRef,
    fetchItems,
    advanceToNext,
    handleGoBack,
    markSuppressed,
    registerResetCallback,
    scrollReviewToTop,
    // Scroll helpers exposed for other hooks
    shouldAutoScroll,
    scrollBehavior,
    isOffscreen,
    newRemaining,
    servingOffline,
  };
}
