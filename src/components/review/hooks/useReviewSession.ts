import { useState, useEffect, useCallback, useRef } from 'react';
import { isRectObscured, FOOTER_SAFE_PX, TOP_SAFE_PX, resetScrollToTop } from './reveal-scroll';
import { useActiveModules } from '@/hooks/useActiveModules';
import { usePrepareReviewImages } from '@/hooks/usePrepareReviewImages';
import { useReviewImageChoices } from '@/hooks/useReviewImageChoices';
import { flushReviewQueue, getQueueSize } from '@/lib/review-queue';
import {
  addToPack,
  consumePackItem,
  readPack,
  restorePackItem,
} from '@/lib/offline/pack';
import { ensureFiguresCached, figureKeysForItems, hasRequiredFigures } from '@/lib/offline/figures';
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
import { mergeOptimisticHead } from './optimistic-head';
import type { ReviewFilter, ReviewItemType, ReviewTopic } from '@/lib/review/review-intent';
import { reviewSessionScopeKey } from '@/lib/review/session-scope';
import {
  shouldOptimisticPaintPack,
  shouldSkipFlushBudget,
} from '@/lib/review/review-cold-start';
import type { ReviewLoadTimer } from '@/lib/review/review-load-telemetry';
import { genClientRequestId } from '@/lib/client-request-id';
import { mapStep1ItemToUnified } from '@/lib/cohort/public-review-map';
import { isOpenFigurePath } from '@/lib/figures/open-figure-access';
import {
  type Step1SessionItem,
  type Step1SessionMedia,
  type Step1SessionResult,
} from '@/lib/usmle/step1-contract';

export interface FetchSlot {
  rotation: string;
  size: number;
  mode?: 'rereview';
  difficulty?: 'easy' | 'medium' | 'hard';
  blendTier: 'primary' | 'rereview' | 'cross-rotation' | 'supplementary';
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
  /** MCQ-only review: narrow every slot to questions. */
  itemType?: ReviewItemType;
  /** Checked-in topic filters that narrow the authorized rotation. */
  topics?: readonly ReviewTopic[];
  /** One manifold cluster, from a square on the profile knowledge heatmap. */
  cluster?: string | null;
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
  /** Shared page-level cold-start timer (optional). */
  loadTimer?: ReviewLoadTimer | null;
  /**
   * Public Cohort sessions are server-decided turns: the hook playlist arrives
   * as one bounded batch, then every answer must be visible to the server
   * before it chooses the next item. Disable the ordinary low-water append
   * prefetch for that surface only; private MD3 review keeps its reserve.
   */
  singleTurn?: boolean;
  /**
   * Enables the Cohort-only idempotent POST transport. Raw search text never
   * enters this contract; only a checked-in topic id may be supplied.
   */
  cohortTurn?: {
    journeyId: string;
    searchTopicId?: string | null;
  } | null;
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

function resolvedBrowserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

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
  loadTimer?: ReviewLoadTimer | null,
  maxAttempts = 2,
): Promise<{ items?: ReviewItem[]; sessionId?: string | null; batchId?: string | null; newRemaining?: { cards: number; questions: number } | null }> {
  // One identity mint per fetch sequence; never loop on a persistent 401.
  const identityRetriedRef = { current: false };
  let lastError: Error | undefined;
  let lastStatus: number | undefined;
  const t0 = Date.now();

  const boundedAttempts = Math.max(1, Math.min(2, Math.trunc(maxAttempts)));
  for (let attempt = 0; attempt < boundedAttempts; attempt++) {
    // Combine user abort signal with per-attempt timeout
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([userSignal, timeoutSignal]);

    try {
      const res = await fetch(url, { signal });
      const serverTiming = res.headers?.get?.('Server-Timing') ?? null;
      loadTimer?.markSessionTtfb(serverTiming);
      loadTimer?.setAttempts(attempt + 1);
      if (!res.ok) {
        lastStatus = res.status;
        loadTimer?.markHttpFailure(res.status);
        // Try to extract server error detail for user-facing message
        let detail = '';
        try { const body = await res.json(); detail = body?.detail ?? ''; } catch {}
        if (res.status === 401) {
          // A 401 here is usually not "signed out" — it is "no study identity
          // yet". md3.info never minted a guest, so a first-time visitor had no
          // cookie, every study request 401'd, and this component sat on its
          // skeleton forever. Mint one and retry exactly once; a second 401 is
          // a real auth failure and still ends the attempt.
          if (!identityRetriedRef.current) {
            identityRetriedRef.current = true;
            try {
              const boot = await fetch('/api/session/bootstrap', { cache: 'no-store', signal });
              if (boot.ok) continue;
            } catch { /* fall through to the auth failure below */ }
          }
          reportClientError(url, 'session-auth-failure', {
            status: 401,
            detail,
            ua: navigator.userAgent,
          });
          throw new NonRetryableError(detail || 'Sign in to review');
        }
        if (res.status === 403) {
          reportClientError(url, 'session-access-forbidden', {
            status: 403,
            detail,
            ua: navigator.userAgent,
          });
          throw new NonRetryableError(detail || 'Review access is unavailable');
        }
        throw new Error(detail ? `${detail}` : `HTTP ${res.status}`);
      }
      loadTimer?.clearHttpFailure();
      const batch = await res.json() as {
        items?: ReviewItem[];
        sessionId?: string | null;
        batchId?: string | null;
        newRemaining?: { cards: number; questions: number } | null;
        stats?: { version?: string };
      };
      if (batch.stats?.version) {
        loadTimer?.markSessionTtfb(serverTiming, batch.stats.version);
      }
      return batch;
    } catch (err) {
      // User navigated away or auth error — bubble immediately, no retry
      if (userSignal.aborted || err instanceof NonRetryableError) throw err;

      // Classify BEFORE the message is rewritten below: the rewrite replaces a
      // TimeoutError with a plain Error, which erases the only evidence of what
      // went wrong. A status-less failure is the case worth describing.
      loadTimer?.markFailure(err);

      // Replace raw "signal timed out" DOMException with a human-readable message
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        lastError = new Error('Connection timed out');
      } else {
        lastError = err instanceof Error ? err : new Error('Failed to load');
      }

      // Don't retry after the last attempt
      if (attempt < boundedAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Check again after delay — user may have navigated away
        if (userSignal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
      }
    }
  }

  // All permitted attempts failed — report to server logs.
  const elapsed = Date.now() - t0;
  loadTimer?.setAttempts(boundedAttempts);
  reportClientError(url, lastError?.message ?? 'unknown', {
    status: lastStatus,
    elapsed,
    attempts: boundedAttempts,
    ua: navigator.userAgent,
  });

  throw lastError ?? new Error('Failed to load');
}

interface CohortTurnClientBody {
  serveRequestId: string;
  journeyId: string;
  nextDrawOrdinal: number;
  previousDeliveryId?: string;
  timezone?: string;
  searchTopicId?: string;
}

class CohortTurnHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = 'CohortTurnHttpError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => key in value)
    && keys.every((key) => permitted.has(key));
}

const COHORT_SESSION_MEDIA_MODALITIES = new Set<NonNullable<Step1SessionMedia['modality']>>([
  'photo', 'cxr', 'ct', 'mri', 'ecg', 'us',
  'otoscopy', 'fundoscopy', 'derm', 'histology', 'other',
]);
const COHORT_SESSION_MEDIA_LICENSE_URLS = new Set([
  'https://creativecommons.org/licenses/by/4.0/',
  'https://creativecommons.org/licenses/by-sa/4.0/',
]);
const COHORT_PROMPT_MEDIA_PRESENTATIONS = [
  {
    attributionText: 'Wagner et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourcePageUrl: 'https://physionet.org/content/ptb-xl/1.0.3/',
  },
  {
    attributionText: 'Lehman et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourcePageUrl: null,
  },
] as const;

function parseCohortSessionMedia(value: unknown): Step1SessionMedia | null {
  if (!isPlainRecord(value) || !exactObjectKeys(
    value,
    [
      'imageUrl', 'preAnswerAlt', 'class', 'showWhen',
      'attributionText', 'licenseUrl',
    ],
    ['modality', 'sourcePageUrl'],
  )) return null;
  // Match one complete reviewed prompt presentation. A neutral source URI is
  // required; an answer-bearing source URI is forbidden from the turn JSON.
  const reviewedSourcePresentation = COHORT_PROMPT_MEDIA_PRESENTATIONS.some((presentation) => (
    value.attributionText === presentation.attributionText
    && value.licenseUrl === presentation.licenseUrl
    && (presentation.sourcePageUrl === null
      ? !('sourcePageUrl' in value)
      : value.sourcePageUrl === presentation.sourcePageUrl)
  ));
  if (
    typeof value.imageUrl !== 'string'
    || !isOpenFigurePath(value.imageUrl)
    || typeof value.preAnswerAlt !== 'string'
    || value.preAnswerAlt.trim().length === 0
    || (value.class !== 'diagnostic' && value.class !== 'diagram')
    // An after-reveal asset must never cross the prompt transport at all: even
    // answer-bearing captions never cross the prompt transport.
    || value.showWhen !== 'always'
    || typeof value.attributionText !== 'string'
    || typeof value.licenseUrl !== 'string'
    || !COHORT_SESSION_MEDIA_LICENSE_URLS.has(value.licenseUrl)
    || !reviewedSourcePresentation
    || ('modality' in value && (
      typeof value.modality !== 'string'
      || !COHORT_SESSION_MEDIA_MODALITIES.has(
        value.modality as NonNullable<Step1SessionMedia['modality']>,
      )
    ))
  ) return null;
  return value as unknown as Step1SessionMedia;
}

function parseCohortSessionItem(value: unknown): Step1SessionItem | null {
  if (!isPlainRecord(value) || !exactObjectKeys(
    value,
    ['deliveryId', 'stem', 'options', 'domain', 'difficulty', 'questionType', 'attribution'],
    ['media'],
  )) return null;
  if (
    typeof value.deliveryId !== 'string'
    || value.deliveryId.length === 0
    || typeof value.stem !== 'string'
    || value.stem.length === 0
    || typeof value.domain !== 'string'
    || value.domain.length === 0
    || typeof value.difficulty !== 'string'
    || value.difficulty.length === 0
    || typeof value.questionType !== 'string'
    || value.questionType.length === 0
    || !Array.isArray(value.options)
    || value.options.length < 4
    || value.options.length > 26
    || !isPlainRecord(value.attribution)
    || !exactObjectKeys(value.attribution, ['text', 'licence'])
    || typeof value.attribution.text !== 'string'
    || value.attribution.text.length === 0
    || typeof value.attribution.licence !== 'string'
    || value.attribution.licence.length === 0
    || ('media' in value && parseCohortSessionMedia(value.media) === null)
  ) return null;
  for (let optionIndex = 0; optionIndex < value.options.length; optionIndex += 1) {
    const option = value.options[optionIndex];
    if (
      !isPlainRecord(option)
      || !exactObjectKeys(option, ['label', 'text'])
      || option.label !== String.fromCharCode(65 + optionIndex)
      || typeof option.text !== 'string'
      || option.text.length === 0
    ) return null;
  }
  return value as unknown as Step1SessionItem;
}

function parseCohortTurnResponse(value: unknown): Step1SessionResult {
  if (!isPlainRecord(value) || !exactObjectKeys(
    value,
    ['sessionId', 'mode', 'requestedSize', 'deliveredSize', 'items'],
  )) {
    throw new Error('Cohort turn response was incomplete');
  }
  if (
    typeof value.sessionId !== 'string'
    || value.mode !== 'daily'
    || !Number.isSafeInteger(value.requestedSize)
    || !Number.isSafeInteger(value.deliveredSize)
    || !Array.isArray(value.items)
    || (value.requestedSize !== 1 && value.requestedSize !== 3)
    || value.deliveredSize !== value.requestedSize
    || value.deliveredSize !== value.items.length
  ) {
    throw new Error('Cohort turn response was invalid');
  }
  const items = value.items.map(parseCohortSessionItem);
  if (items.some((item) => item === null)) {
    throw new Error('Cohort turn contained an unsafe item');
  }
  return { ...value, items } as unknown as Step1SessionResult;
}

async function postCohortTurn(
  body: CohortTurnClientBody,
  userSignal: AbortSignal,
  loadTimer?: ReviewLoadTimer | null,
): Promise<Step1SessionResult> {
  const serialized = JSON.stringify(body);
  let lastError: Error | undefined;
  const t0 = Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([userSignal, timeoutSignal]);
    try {
      const response = await fetch('/api/cohort/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
        signal,
      });
      loadTimer?.markSessionTtfb(response.headers?.get?.('Server-Timing') ?? null);
      loadTimer?.setAttempts(attempt + 1);
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const message = typeof payload?.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
        const code = typeof payload?.code === 'string' ? payload.code : null;
        const error = new CohortTurnHttpError(message, response.status, code);
        // A stable serveRequestId makes retry safe, but deterministic 4xx
        // failures need user action rather than a duplicate round trip.
        if (response.status < 500 && code !== 'serve_request_pending') throw error;
        lastError = error;
      } else {
        return parseCohortTurnResponse(payload);
      }
    } catch (error) {
      if (userSignal.aborted) throw error;
      if (error instanceof CohortTurnHttpError && error.status < 500
        && error.code !== 'serve_request_pending') throw error;
      lastError = error instanceof DOMException && error.name === 'TimeoutError'
        ? new Error('Connection timed out')
        : error instanceof Error ? error : new Error('Failed to load');
    }

    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (userSignal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
    }
  }

  reportClientError('/api/cohort/turn', lastError?.message ?? 'unknown', {
    elapsed: Date.now() - t0,
    attempts: 2,
    // Deliberately no body, query, topic alias, or learner-entered text.
  });
  throw lastError ?? new Error('Failed to load');
}

export function useReviewSession({ rotations, week, rotationSizes, fetchSlots, feedMode = 'mixed', reviewFilter, itemType, topics, cluster = null, focusRotation = null, userKey = null, allowUnverifiedPack = false, initialBatch = null, loadTimer = null, singleTurn = false, cohortTurn = null }: UseReviewSessionOptions) {
  const hasCohortTurn = cohortTurn !== null;
  const cohortJourneyId = cohortTurn?.journeyId ?? null;
  const cohortSearchTopicId = cohortTurn?.searchTopicId ?? null;
  const baseRequestScopeKey = reviewSessionScopeKey({
    rotations,
    week,
    feedMode,
    reviewFilter,
    itemType,
    focusRotation,
    topics,
    cluster,
  });
  const requestScopeKey = cohortJourneyId
    ? `${baseRequestScopeKey}:cohort:${cohortJourneyId}`
    : baseRequestScopeKey;
  const initialBatchMatches =
    initialBatch?.ownerKey === userKey
    && initialBatch.scopeKey === requestScopeKey;
  const initialItems = initialBatchMatches ? initialBatch.items : [];
  const [items, setItems] = useState<ReviewItem[]>(initialItems);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Mirrored for the offline-owner subscription, which is a stable closure and
  // would otherwise read a stale index when capturing the card on screen.
  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;
  const [loading, setLoading] = useState(!initialBatchMatches);
  const [error, setError] = useState<string | null>(null);
  const [cohortTurnErrorCode, setCohortTurnErrorCode] = useState<string | null>(null);
  const [cohortTurnPending, setCohortTurnPending] = useState(false);
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
  const requestedTopicsKey = topics?.join(',') ?? '';
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
  /**
   * The pack item painted optimistically for the first frame, held until the
   * live batch lands so it can lead that batch instead of being yanked out
   * from under the reader. Cleared the moment they advance past it.
   */
  const optimisticHeadRef = useRef<ReviewItem | null>(null);
  /**
   * The card on screen when a refetch is triggered by something the READER did
   * not do — currently a same-account lease/generation bump, which re-keys the
   * load effect via ownerRevision. The replacement batch must lead with this
   * item, or the reader is yanked onto a different card mid-read.
   *
   * Distinct from optimisticHeadRef, which only ever covered the on-device pack
   * paint. A card already on screen from a live or adopted batch had nothing
   * holding it, which is why the swap survived two earlier fixes.
   */
  const involuntaryReloadHeadRef = useRef<ReviewItem | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const initialBatchRef = useRef(initialBatchMatches ? initialBatch : null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cohortJourneyRef = useRef(cohortJourneyId);
  const cohortOwnerKeyRef = useRef(userKey ?? null);
  const cohortSearchTopicIdRef = useRef(cohortSearchTopicId);
  const cohortNextDrawOrdinalRef = useRef(0);
  const cohortPreviousDeliveryIdRef = useRef<string | null>(null);
  const pendingCohortTurnRef = useRef<CohortTurnClientBody | null>(null);
  const observedOwnerChangeRef = useRef(false);
  const loadTimerRef = useRef(loadTimer);
  loadTimerRef.current = loadTimer;
  cohortSearchTopicIdRef.current = cohortSearchTopicId;

  useEffect(() => {
    if (cohortJourneyRef.current === cohortJourneyId) return;
    cohortJourneyRef.current = cohortJourneyId;
    cohortNextDrawOrdinalRef.current = 0;
    cohortPreviousDeliveryIdRef.current = null;
    pendingCohortTurnRef.current = null;
    setCohortTurnPending(false);
    setCohortTurnErrorCode(null);
  }, [cohortJourneyId]);

  useEffect(() => {
    const nextOwnerKey = userKey ?? null;
    if (cohortOwnerKeyRef.current === nextOwnerKey) return;
    cohortOwnerKeyRef.current = nextOwnerKey;
    cohortNextDrawOrdinalRef.current = 0;
    cohortPreviousDeliveryIdRef.current = null;
    pendingCohortTurnRef.current = null;
    cohortSearchTopicIdRef.current = null;
    setCohortTurnPending(false);
    setCohortTurnErrorCode(null);
  }, [userKey]);

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

    const previousOwnerKey = itemsOwnerRef.current;
    const nextOwnerKey = nextOwner?.ownerKey ?? null;
    // Authenticated feed already showing this account's cards: a device-guest →
    // verified bind (or same-key generation bump) must not blank the screen.
    // Refetch under the new lease, holding the card the reader is looking at:
    // the account did not change and neither did the scope, so nothing about
    // this reload justifies moving them.
    if (
      nextOwnerKey
      && userKeyRef.current === nextOwnerKey
      && itemsRef.current.length > 0
    ) {
      observedOwnerChangeRef.current = true;
      involuntaryReloadHeadRef.current = itemsRef.current[currentIndexRef.current] ?? null;
      setOwnerRevision((revision) => revision + 1);
      return;
    }
    if (
      previousOwnerKey
      && nextOwnerKey
      && previousOwnerKey === nextOwnerKey
    ) {
      observedOwnerChangeRef.current = true;
      involuntaryReloadHeadRef.current = itemsRef.current[currentIndexRef.current] ?? null;
      setOwnerRevision((revision) => revision + 1);
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
  const resolveScopedPackItems = useCallback((): {
    userKey: string;
    packUserKey: string;
    items: ReviewItem[];
  } | null => {
    // A Cohort turn is valid only with its server-issued journey/delivery
    // receipt. The generic MD3 pack is scoped by owner + rotation/week, so it
    // cannot prove that relationship and must never paint or rescue a Cohort
    // request. Cohort intentionally remains network-required until it has a
    // receipt-bound offline format of its own.
    if (hasCohortTurn) return null;
    // The pack is a mixed queue: it can prove neither a typed filter nor an
    // MCQ-only request, so it must not rescue either. A cluster is the third
    // member of that list and the one a learner notices: a heatmap square asks
    // for ONE topic, pack rows carry no clusterId, and rescuing a failed
    // scoped request with rotation-wide cards looks exactly like the square
    // doing nothing. Reported as that on 2026-09-16.
    if (reviewFilter || itemType || cluster) return null;

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
      return null;
    }
    const resolvedUserKey = allowUnverifiedPackRef.current
      ? storedOwnerKey
      : sessionUserKey ?? (isOffline ? storedOwnerKey : null);
    if (!resolvedUserKey) return null;

    const pack = readPack(resolvedUserKey);
    const requestedRotations = new Set(requestedRotationsKey.split(',').filter(Boolean));
    const requestedTopics = new Set(
      requestedTopicsKey.split(',').filter(Boolean).map((topic) => topic.toLowerCase()),
    );
    const packItems = ((pack?.items ?? []) as ReviewItem[]).filter((item) => {
      if (!item.rotation || !requestedRotations.has(item.rotation)) return false;
      if (week !== undefined && item.week !== week) return false;
      if (
        requestedTopics.size > 0
        && !item.topics?.some((topic) => requestedTopics.has(topic.toLowerCase()))
      ) return false;
      return true;
    });
    if (!pack || packItems.length === 0) return null;
    return {
      userKey: resolvedUserKey,
      packUserKey: pack.userKey,
      items: dedupeReviewItems(packItems),
    };
  }, [hasCohortTurn, requestedRotationsKey, requestedTopicsKey, reviewFilter, itemType, cluster, week]);

  const servePackFallback = useCallback((): boolean => {
    const scoped = resolveScopedPackItems();
    if (!scoped) return false;

    itemsScopeKeyRef.current = requestScopeKey;
    itemsOwnerRef.current = scoped.packUserKey;
    setItems(scoped.items);
    itemsRef.current = scoped.items;
    setCurrentIndex(0);
    reviewedCardIdsRef.current.clear();
    reviewedQuestionIdsRef.current.clear();
    resetItemState();
    setStatsState(
      readOfflineReviewStats(scoped.packUserKey, requestScopeKey)
        ?? { total: 0, correct: 0 },
    );
    setIsExhausted(false);
    setError(null);
    setServingOffline(true);
    servingOfflineRef.current = true;
    return true;
  }, [requestScopeKey, resetItemState, resolveScopedPackItems]);

  /** Paint pack immediately while the live session request continues. */
  const paintOptimisticPack = useCallback((): boolean => {
    const queueSize = userKeyRef.current
      ? getQueueSize('review', userKeyRef.current)
      : 0;
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const scoped = resolveScopedPackItems();
    if (!shouldOptimisticPaintPack({
      queueSize,
      reviewFilter,
      itemType,
      online,
      packItemCount: scoped?.items.length ?? 0,
    }) || !scoped) {
      return false;
    }

    itemsScopeKeyRef.current = requestScopeKey;
    itemsOwnerRef.current = scoped.packUserKey;
    setItems(scoped.items);
    itemsRef.current = scoped.items;
    setCurrentIndex(0);
    reviewedCardIdsRef.current.clear();
    reviewedQuestionIdsRef.current.clear();
    resetItemState();
    setStatsState(
      readOfflineReviewStats(scoped.packUserKey, requestScopeKey)
        ?? { total: 0, correct: 0 },
    );
    setIsExhausted(false);
    setError(null);
    optimisticHeadRef.current = scoped.items[0] ?? null;
    // Keep servingOffline false so the live batch can replace this paint.
    setServingOffline(false);
    servingOfflineRef.current = false;
    setLoading(false);
    loadTimerRef.current?.markFirstCard();
    return true;
  }, [requestScopeKey, resetItemState, resolveScopedPackItems, reviewFilter, itemType]);

  const fetchItems = useCallback(async (
    append = false,
    preserveSessionState = false,
    cohortSearchTopicOverride?: string | null,
  ) => {
    const pendingCohortTurn = pendingCohortTurnRef.current;
    if (
      cohortJourneyId
      && pendingCohortTurn
      && cohortSearchTopicOverride !== undefined
      && (pendingCohortTurn.searchTopicId ?? null) !== cohortSearchTopicOverride
    ) {
      // A timed-out POST may already have committed. Changing its fingerprint
      // at the same ordinal would either conflict with the idempotency key or
      // mint a second delivery. Resolve/replay the pending turn first; the new
      // focus can safely apply after that displayed item is answered.
      setCohortTurnErrorCode('serve_request_pending');
      setCohortTurnPending(true);
      setError('Retry the pending turn before changing topics');
      if (!append) setLoading(false);
      return;
    }
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
    // Keep an optimistic pack paint visible while the live batch loads.
    if (!append && itemsRef.current.length === 0) setLoading(true);
    setError(null);

    if (!append) loadTimerRef.current?.markFetchStart();

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
      const slots: FetchSlot[] = cohortJourneyId
        ? [{
            rotation: rotations[0] ?? 'usmle-step1-open',
            size: 1,
            blendTier: 'primary' as const,
          }]
        : fetchSlots ?? rotations.map(r => ({
            rotation: r,
            size: rotationSizes?.[r] ?? Math.ceil(15 / rotations.length),
            blendTier: 'primary' as const,
          }));

      const fetchOne = (slot: FetchSlot) => {
        if (slot.size <= 0) return Promise.resolve({ items: [], blendTier: slot.blendTier, sessionId: null as string | null, batchId: null as string | null, newRemaining: null as { cards: number; questions: number } | null });
        if (cohortJourneyId) {
          let pending = pendingCohortTurnRef.current;
          if (!pending) {
            const previousDeliveryId = cohortPreviousDeliveryIdRef.current;
            const searchTopicId = cohortSearchTopicOverride === undefined
              ? cohortSearchTopicIdRef.current
              : cohortSearchTopicOverride;
            const timezone = resolvedBrowserTimezone();
            pending = {
              serveRequestId: genClientRequestId(),
              journeyId: cohortJourneyId,
              nextDrawOrdinal: cohortNextDrawOrdinalRef.current,
              ...(previousDeliveryId ? { previousDeliveryId } : {}),
              ...(timezone ? { timezone } : {}),
              ...(searchTopicId ? { searchTopicId } : {}),
            };
            pendingCohortTurnRef.current = pending;
            setCohortTurnPending(true);
          }
          return postCohortTurn(pending, controller.signal, loadTimerRef.current)
            .then((result) => {
              if (
                !requestIsCurrent()
                || userKeyRef.current !== requestUserKey
                || cohortJourneyRef.current !== pending.journeyId
                || pendingCohortTurnRef.current !== pending
              ) {
                throw new DOMException('The Cohort journey changed.', 'AbortError');
              }
              if (result.sessionId !== pending.journeyId) {
                throw new Error('Cohort turn belonged to a different journey');
              }
              const hook = pending.nextDrawOrdinal === 0
                && result.requestedSize === 3
                && result.deliveredSize === 3;
              const mapped: ReviewItem[] = result.items.map((item) => (
                mapStep1ItemToUnified(item, {
                  rotation: slot.rotation,
                  sessionId: result.sessionId,
                  hook,
                }) as unknown as ReviewItem
              ));
              cohortNextDrawOrdinalRef.current = pending.nextDrawOrdinal + result.deliveredSize;
              // Identity comparison above makes this a compare-and-clear: a
              // late response can never erase a newer journey's retry body.
              pendingCohortTurnRef.current = null;
              setCohortTurnPending(false);
              setCohortTurnErrorCode(null);
              return {
                items: mapped,
                blendTier: slot.blendTier,
                sessionId: result.sessionId,
                batchId: result.sessionId,
                newRemaining: null as { cards: number; questions: number } | null,
              };
            });
        }
        const params = buildUnifiedSessionParams(slot, {
          week,
          activeModules,
          feedMode,
          reviewFilter,
          itemType,
          focusRotation,
          topics,
          cluster,
          excludeCards: excludeCardParams || undefined,
          excludeQuestions: excludeQuestionParams || undefined,
          timezone: resolvedBrowserTimezone(),
          // Minted HERE, outside fetchWithRetry, so every attempt for this one
          // logical fetch carries the same key and the second attempt updates
          // the first delivery rather than duplicating it.
          serveRequestId: genClientRequestId(),
        });
        const url = `/api/study/unified-session?${params}`;

        // This is deliberately the only request path. A former <head> preload
        // hit this side-effecting endpoint before React knew whether it would
        // adopt the batch, creating phantom deliveries in scheduler history.
        // Ordinary MD3 keeps its established transient retry behavior. A
        // single-turn non-Cohort caller still receives only one attempt because
        // this legacy GET mints a delivery and has no serve-request idempotency.
        return fetchWithRetry(
          url,
          controller.signal,
          loadTimerRef.current,
          singleTurn ? 1 : 2,
        )
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
          sessionId: item.sessionId ?? r.sessionId,
          batchId: item.batchId !== undefined ? item.batchId : r.batchId,
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

      const persistLiveBatch = (batch: ReviewItem[]) => {
        if (hasCohortTurn || !requestUserKey || !requestOwnerLease
          || !isOfflineOwnerCurrent(requestOwnerLease) || batch.length === 0) return;
        const input = {
          rotations: slots.map((slot) => slot.rotation),
          explicitFocus: focusRotation !== null,
        };
        const noCachedFigures = new Set<string>();
        // Text and supplementary-image rows are usable immediately. A prompt
        // requires both its primary and reveal pictures before durable admission.
        addToPack(requestUserKey, {
          ...input,
          items: batch.filter((item) => hasRequiredFigures(item, noCachedFigures)),
        });
        const keys = figureKeysForItems(batch);
        if (keys.length === 0) return;
        void ensureFiguresCached(keys, requestUserKey).then(({ availableKeys }) => {
          if (controller.signal.aborted || !isOfflineOwnerCurrent(requestOwnerLease)
            || userKeyRef.current !== requestUserKey
            || activeRequestScopeKeyRef.current !== requestScopeKey) return;
          // Picture downloads can finish after the reader advances. Never
          // reinsert an already-consumed live item, even after its grade synced.
          const remainingKeys = new Set(
            itemsRef.current.slice(currentIndexRef.current).map(reviewItemKey),
          );
          const ready = batch.filter((item) => remainingKeys.has(reviewItemKey(item))
            && hasRequiredFigures(item, availableKeys));
          if (ready.length > 0) addToPack(requestUserKey, { ...input, items: ready });
        }).catch(() => {});
      };

      if (append) {
        if (newItems.length === 0) {
          setIsExhausted(true);
        } else {
          const existingIds = new Set(itemsRef.current.map(reviewItemKey));
          const deduped = dedupeReviewItems(newItems, existingIds);
          if (deduped.length === 0) {
            setIsExhausted(true);
          } else {
            const updated = [...itemsRef.current, ...deduped];
            itemsRef.current = updated;
            setItems(updated);
            persistLiveBatch(deduped);
          }
        }
      } else {
        setIsExhausted(false);
        // A live batch must not yank the card the reader is mid-way through.
        // The optimistic pack paint exists to make the first frame fast; before
        // this, that frame was replaced by a different question a moment later.
        const painted = optimisticHeadRef.current;
        optimisticHeadRef.current = null;
        // A reload the READER did not ask for (same-account lease bump) must
        // keep them exactly where they are, whatever the card came from. The
        // pack-paint guard below cannot cover this: it only ever tracked the
        // optimistic paint, so a card from a live or adopted batch was
        // unprotected — the swap that survived two earlier fixes.
        const involuntaryHead = involuntaryReloadHeadRef.current;
        involuntaryReloadHeadRef.current = null;
        const deduped = mergeOptimisticHead({
          paintedHead: painted ?? involuntaryHead,
          incoming: dedupeReviewItems(newItems),
          readerHasAdvanced: involuntaryHead && !painted
            // They did not advance; the lease did. Position is irrelevant here,
            // and requiring index 0 would leave anyone mid-batch unprotected.
            ? false
            : reviewedCardIdsRef.current.size > 0
              || reviewedQuestionIdsRef.current.size > 0
              // Skips trim from the front, so a head that is no longer the head
              // means they moved on and the paint is stale.
              || (itemsRef.current[0] !== undefined && itemsRef.current[0] !== painted),
          excludedKeys: requestTombstoneKeys,
          key: reviewItemKey,
        });
        itemsScopeKeyRef.current = requestScopeKey;
        itemsOwnerRef.current = requestUserKey;
        setItems(deduped);
        itemsRef.current = deduped;
        setCurrentIndex(0);
        if (!preserveSessionState) {
          reviewedCardIdsRef.current.clear();
          reviewedQuestionIdsRef.current.clear();
        }
        resetItemState();
        if (!preserveSessionState) {
          setStatsState(
            requestUserKey
              ? (
                  readOfflineReviewStats(requestUserKey, requestScopeKey)
                  ?? { total: 0, correct: 0 }
                )
              : { total: 0, correct: 0 },
          );
        }
        setServingOffline(false);
        servingOfflineRef.current = false;

        // Both initial and appended batches merge into the durable reserve.
        // Cohort stays excluded because this pack cannot preserve its receipt.
        persistLiveBatch(deduped);
        if (deduped.length > 0) {
          loadTimerRef.current?.report('first_card');
        } else {
          loadTimerRef.current?.report('exhausted');
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
        loadTimerRef.current?.report('first_card');
      } else if (append && servingOfflineRef.current) {
        // Working through the pack and it ran out. That is the end of the
        // offline session, not an error worth interrupting the user with.
        setIsExhausted(true);
      } else {
        if (
          err instanceof CohortTurnHttpError
          && err.status < 500
          && err.code !== 'serve_request_pending'
        ) {
          // The server definitively rejected the request before delivery. A
          // changed/cleared focus may safely create a fresh key at this same
          // ordinal; ambiguous network and 5xx failures retain the old key.
          pendingCohortTurnRef.current = null;
          setCohortTurnPending(false);
        }
        setCohortTurnErrorCode(
          err instanceof CohortTurnHttpError ? err.code : null,
        );
        setError(err instanceof Error ? err.message : 'Failed to load');
        if (!append) {
          loadTimerRef.current?.markFailure(err);
          loadTimerRef.current?.report('failed');
        }
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
  }, [resetItemState, rotations.join(','), week, activeModules, fetchSlots, feedMode, reviewFilter, itemType, requestedTopicsKey, focusRotation, requestScopeKey, servePackFallback, singleTurn, cohortJourneyId, hasCohortTurn]);

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
      //
      // Local continuity (queued offline grades) is a reason to FILTER this
      // batch, not to discard it. Discarding meant the streamed first card was
      // painted, thrown away on hydration and replaced a second later by a
      // different question — a visible swap on essentially every load, since an
      // active user almost always holds tombstones. It also burned a full
      // delivery: 86% of instant-lane serves were never answered.
      initialBatchRef.current = null;
      const usableItems = userKey
        ? filterOfflineTombstones(userKey, serverBatch.items)
        : serverBatch.items;
      // Only a batch consumed *entirely* by local progress is unusable; fall
      // through to a normal fetch in that case.
      if (usableItems.length > 0 || serverBatch.items.length === 0) {
        if (usableItems.length !== serverBatch.items.length) {
          setItems(usableItems);
          itemsRef.current = usableItems;
        }
        setLoading(false);
        if (usableItems.length === 0) {
          setIsExhausted(true);
          loadTimerRef.current?.report('exhausted');
        } else {
          loadTimerRef.current?.report('first_card');
        }
        return () => {
          abortControllerRef.current?.abort();
        };
      }
      // Every item was consumed by local progress, so drop the batch and hold
      // the loading state the unmatched-batch path starts in. Both are needed:
      // leaving the emptied list in place lets the low-water prefetch effect
      // fire and APPEND the replacement batch behind items the user has
      // already graded.
      setItems([]);
      itemsRef.current = [];
      setLoading(true);
    }

    if (allowUnverifiedPack) {
      // Local shell: the pack is the primary source, not an error fallback.
      // This path intentionally does not flush or warm any API.
      const served = servePackFallback();
      setLoading(false);
      if (!served) {
        setIsExhausted(true);
        loadTimerRef.current?.report('exhausted');
      } else {
        loadTimerRef.current?.report('first_card');
      }
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

    const queueSize = userKey ? getQueueSize('review', userKey) : 0;
    let flushBudget: number | undefined;
    if (shouldSkipFlushBudget(queueSize)) {
      paintOptimisticPack();
      startFetch();
    } else {
      flushBudget = window.setTimeout(startFetch, FLUSH_BUDGET_MS);
      flushReviewQueue(userKey)
        .catch(() => {})
        .finally(() => {
          if (flushBudget !== undefined) window.clearTimeout(flushBudget);
          startFetch();
        });
    }

    // Warm up the record function in parallel so the first answer doesn't
    // hit a cold start
    fetch('/api/study/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"warmup"}',
    }).catch(() => {});

    return () => {
      if (flushBudget !== undefined) window.clearTimeout(flushBudget);
      abortControllerRef.current?.abort();
      loadedKeyRef.current = null;
    };
  }, [allowUnverifiedPack, ownerLoadKey, paintOptimisticPack, requestScopeKey, rotationsKey, servePackFallback, userKey, week]);

  // Prefetch more when running low
  useEffect(() => {
    if (singleTurn) return;
    if (items.length - currentIndex <= 3 && !fetchingMoreRef.current && items.length > 0) {
      if (allowUnverifiedPack || servingOfflineRef.current) {
        setIsExhausted(true);
        return;
      }
      fetchItems(true);
    }
  }, [allowUnverifiedPack, currentIndex, items.length, fetchItems, singleTurn]);

  // Keep 1 reviewed item behind current for z-to-undo; trim the rest.
  const UNDO_BUFFER = 1;

  const advanceToNext = useCallback(() => {
    scrollReviewToTop();

    const advancedItem = itemsRef.current[currentIndex];
    const displayedOwner = itemsOwnerRef.current;
    if (!hasCohortTurn && advancedItem && typeof displayedOwner === 'string') {
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
      currentIndexRef.current = nextIndex - trimCount;
      setCurrentIndex(nextIndex - trimCount);
    } else {
      currentIndexRef.current = nextIndex;
      setCurrentIndex(nextIndex);
    }

    resetItemState();
  }, [currentIndex, feedMode, hasCohortTurn, resetItemState, scrollReviewToTop]);

  /**
   * Complete the displayed turn, retire every preselected remainder, and ask
   * the server to choose again from the newly persisted learner state.
   *
   * This is intentionally opt-in. Ordinary MD3 review advances through its
   * prefetched batch; Cohort calls this after an answered public delivery so
   * the next item can react to that answer (and to onboarding choices).
   */
  const advanceAndRefresh = useCallback(async () => {
    const completedItem = itemsRef.current[currentIndex];
    if (cohortJourneyId && completedItem?.deliveryId) {
      cohortPreviousDeliveryIdRef.current = completedItem.deliveryId;
    }
    advanceToNext();
    itemsRef.current = [];
    setItems([]);
    setCurrentIndex(0);
    setIsExhausted(false);
    setError(null);
    setLoading(true);
    await fetchItems(false, true);
  }, [advanceToNext, cohortJourneyId, currentIndex, fetchItems]);

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
        if (!hasCohortTurn && typeof displayedOwner === 'string') {
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
  }, [currentIndex, hasCohortTurn, items, resetItemState, scrollReviewToTop]);

  const expectedDisplayOwner =
    allowUnverifiedPack || servingOffline
      ? userKey ?? readOfflineOwner()?.ownerKey ?? null
      : userKey ?? null;
  const displayOwnerMatches =
    itemsOwnerRef.current === undefined ||
    itemsOwnerRef.current === expectedDisplayOwner;
  const displayScopeMatches = itemsScopeKeyRef.current === requestScopeKey;
  const visibleItems = displayOwnerMatches && displayScopeMatches ? items : [];
  usePrepareReviewImages(visibleItems, currentIndex, expectedDisplayOwner, allowUnverifiedPack);
  const displayItems = useReviewImageChoices(visibleItems, currentIndex, expectedDisplayOwner);
  const currentItem = displayOwnerMatches && displayScopeMatches
    ? (displayItems[currentIndex] as ReviewItem | undefined)
    : undefined;

  return {
    items: displayItems,
    currentItem,
    currentIndex,
    loading: loading || !displayOwnerMatches || !displayScopeMatches,
    error,
    cohortTurnErrorCode,
    cohortTurnPending,
    stats,
    setStats,
    startTime,
    isExhausted,
    isFetchingMore,
    reviewTopRef,
    fetchItems,
    advanceToNext,
    advanceAndRefresh,
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
